// docs/agent-config-detection.md, docs/coding-style.md
// Style signal only — never selects a provider. Prefer CLAUDE.md over AGENTS.md when both exist.
//
// Layered discovery (issue #117), general → specific: user-global ~/.claude/CLAUDE.md, then the
// project-level pick (root CLAUDE.md/AGENTS.md or an explicit stylePath), then nested per-directory
// files. Blocks are concatenated with the deepest last so more-specific conventions win on conflict.
// Import expansion (#87) runs per file with a per-file containment root, so the user-global file can
// never read the target repo and vice versa.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandImports } from './expand-imports.ts';

export type AgentConfigFlavor = 'claude' | 'agents' | 'custom';

export type ConfigScope = 'user' | 'project' | 'nested';

export type AgentConfig = {
  // flavor + path describe the PROJECT-level pick, so the state.json agentConfigFile derivation is
  // unchanged; the layered detail lives in `sources`.
  flavor: AgentConfigFlavor;
  path: string;
  contents: string;
  // Every layer that contributed, general → specific (user → project → nested).
  sources: Array<{ path: string; scope: ConfigScope }>;
};

export type DetectOptions = {
  stylePath?: string | null;
  prefer?: 'claude' | 'agents';
  // Directory holding the user-global CLAUDE.md (e.g. ~/.claude). Injected from the CLI's homeDir
  // seam so tests never touch the real $HOME. Unset → no user-global layer.
  userConfigDir?: string;
  // Notified when the nested-file byte budget is exceeded (remaining files skipped). CLI → stderr.
  onWarn?: (message: string) => void;
};

// Total raw-byte budget across nested files, guarding monorepo blowup so the distiller never
// receives unbounded input. Past it, remaining nested files are skipped and onWarn fires.
const NESTED_BYTE_BUDGET = 64 * 1024;

const SKIP_DIRS = new Set(['node_modules']);

type Layer = { path: string; scope: ConfigScope; contents: string };
type ProjectLayer = Layer & { flavor: AgentConfigFlavor };
type FilePick = { flavor: AgentConfigFlavor; path: string };

export class AgentConfigDetector {
  constructor(private readonly repoRoot: string) {}

  async detect(options: DetectOptions): Promise<AgentConfig | null> {
    // The project layer is the gate: no project-level file → no config at all (user-global is
    // additive only, so the CLI's "no style file" error paths are unchanged).
    const project = await this.detectProject(options);
    if (project === null) return null;

    const layers: Layer[] = [];

    // Layer 1 — user-global (additive), expanded within its own directory only.
    if (options.userConfigDir) {
      const user = await detectUser(options.userConfigDir);
      if (user) layers.push(user);
    }
    // Layer 2 — the project pick.
    layers.push(project);
    // Layer 3 — nested subtree files, deepest last.
    for (const nested of await this.discoverNested(options, project.path)) {
      layers.push(nested);
    }

    return {
      flavor: project.flavor,
      path: project.path,
      contents: renderLayers(layers, this.repoRoot),
      sources: layers.map((l) => ({ path: l.path, scope: l.scope })),
    };
  }

  private async detectProject(options: DetectOptions): Promise<ProjectLayer | null> {
    if (options.stylePath) {
      const path = isAbsolute(options.stylePath)
        ? options.stylePath
        : resolve(this.repoRoot, options.stylePath);
      if (!isAbsolute(options.stylePath)) {
        const rel = relative(this.repoRoot, path);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`stylePath must remain within repoRoot: ${options.stylePath}`);
        }
      }
      const raw = await readFile(path, 'utf8');
      const contents = await expandImports(raw, dirname(path), {
        root: this.repoRoot,
        sourcePath: path,
      });
      return { flavor: 'custom', path, scope: 'project', contents };
    }

    const picked = await pickInDir(this.repoRoot, options.prefer);
    if (picked === null) return null;
    const raw = await readFile(picked.path, 'utf8');
    const contents = await expandImports(raw, this.repoRoot, {
      root: this.repoRoot,
      sourcePath: picked.path,
    });
    return { flavor: picked.flavor, path: picked.path, scope: 'project', contents };
  }

  // Discover nested per-directory picks (depth ≥ 1), deepest last, deterministic (depth then path).
  // Skips .git/node_modules/hidden/.ai-task-master and symlinks. The walk collects PATHS only (an
  // existence check, no content read); files are then read + expanded one at a time and the budget
  // is enforced on the EXPANDED size (what the distiller actually receives, so a small file that
  // @-imports large content still counts). A raw-size pre-gate skips a file whose raw text alone
  // overflows without reading it, bounding I/O and memory to roughly the budget. On overflow the
  // rest are skipped and onWarn fires. (A per-@-import output cap is expand-imports' domain, #87.)
  private async discoverNested(options: DetectOptions, projectPath: string): Promise<Layer[]> {
    const picks: Array<FilePick & { depth: number }> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (entries === null) return;
      if (depth > 0) {
        const pick = await pickInDir(dir, options.prefer);
        if (pick !== null && pick.path !== projectPath) picks.push({ ...pick, depth });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        // isDirectory() is false for a symlink (its own type), so this also drops symlinked dirs.
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name), depth + 1);
      }
    };
    await walk(this.repoRoot, 0);
    picks.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const layers: Layer[] = [];
    let used = 0;
    const skip = (path: string): void =>
      options.onWarn?.(
        `nested CLAUDE.md budget (${NESTED_BYTE_BUDGET} bytes) exceeded; skipping ${relative(this.repoRoot, path)} and any further nested files`,
      );
    for (const pick of picks) {
      // Raw-size pre-gate: expansion only ever adds bytes, so a file whose raw text already overflows
      // can be dropped without reading or expanding it.
      const rawSize = await fileSize(pick.path);
      if (rawSize === null) continue; // vanished between discovery and read — skip it
      if (used + rawSize > NESTED_BYTE_BUDGET) {
        skip(pick.path);
        break;
      }
      const raw = await readFile(pick.path, 'utf8');
      const contents = await expandImports(raw, dirname(pick.path), {
        root: this.repoRoot,
        sourcePath: pick.path,
      });
      const size = byteLength(contents);
      if (used + size > NESTED_BYTE_BUDGET) {
        skip(pick.path);
        break;
      }
      used += size;
      layers.push({ path: pick.path, scope: 'nested', contents });
    }
    return layers;
  }
}

// Read the user-global CLAUDE.md, expanded within its OWN directory only (never repo-rooted) so its
// imports can never reach the target repo. Absent → null (the layer is skipped).
async function detectUser(userConfigDir: string): Promise<Layer | null> {
  const path = join(userConfigDir, 'CLAUDE.md');
  const raw = await readIfExists(path);
  if (raw === null) return null;
  const contents = await expandImports(raw, userConfigDir, {
    root: userConfigDir,
    sourcePath: path,
  });
  return { path, scope: 'user', contents };
}

// The per-directory pick: CLAUDE.md over AGENTS.md, honoring `prefer` when both exist. Existence
// only (no content read) — callers read the picked path lazily, so a big subtree never buffers every
// candidate's content at once.
async function pickInDir(
  dir: string,
  prefer: 'claude' | 'agents' | undefined,
): Promise<FilePick | null> {
  const claudePath = join(dir, 'CLAUDE.md');
  const agentsPath = join(dir, 'AGENTS.md');
  const hasClaude = await fileExists(claudePath);
  const hasAgents = await fileExists(agentsPath);
  if (hasClaude && hasAgents) {
    return prefer === 'agents'
      ? { flavor: 'agents', path: agentsPath }
      : { flavor: 'claude', path: claudePath };
  }
  if (hasClaude) return { flavor: 'claude', path: claudePath };
  if (hasAgents) return { flavor: 'agents', path: agentsPath };
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// Raw byte size, or null if the file vanished/errored between discovery and read (skip it).
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

// Concatenate layers. With exactly one source, the output is byte-identical to the un-layered
// single file (no label) — so existing callers and the cached digest are unaffected. With more,
// each block is prefixed `Contents of <path>:` (repo-relative for repo files, absolute for user).
function renderLayers(layers: Layer[], repoRoot: string): string {
  if (layers.length === 1) return layers[0]?.contents ?? '';
  return layers.map((l) => `Contents of ${labelPath(l, repoRoot)}:\n${l.contents}`).join('\n\n');
}

function labelPath(layer: Layer, repoRoot: string): string {
  return layer.scope === 'user' ? layer.path : relative(repoRoot, layer.path);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
