// Filesystem + shell tools for Worker / Reviewer subagents. Every tool is scoped to a
// `cwd` — the active worktree — and rejects paths that escape it. Output shapes match
// the WorkerTools / ReviewerTools type contracts in src/subagents/{worker,reviewer}.ts
// so these tools drop straight into both subagent factories.
//
// Why scope to cwd: the Worker tool surface is exposed to a fallible LLM, and the
// merge-pr take-over flow runs against the user's actual repo (not a sandbox). A
// missing path check is an arbitrary-write primitive — same severity as a path-traversal
// CVE in a web app. The escape check uses both pre-resolve string inspection (cheap, fast)
// and post-resolve realpath (defeats symlink trickery once the file exists).

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { type Tool, tool } from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import type {
  BashInput,
  BashOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from '../subagents/worker.ts';

const readFileInputSchema = z.object({ path: z.string().min(1) });
const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const bashInputSchema = z.object({
  command: z.string().min(1),
  // Optional: per-call timeout in ms. Falls back to the tool-level default.
  timeoutMs: z.number().int().positive().optional(),
});

export type FsToolInit = {
  // The root the tool is scoped to. Everything is resolved against this and must stay
  // inside it. Pass an absolute path; the tool resolves it to a realpath once on init
  // so the parent directory's symlink shape doesn't change escape-check semantics.
  cwd: string;
};

export type BashToolInit = FsToolInit & {
  // Tool-level default timeout. Per-call overrides via `timeoutMs` in the input. Default
  // 60s — enough for `git push`, `git fetch`, `npm install` on small projects.
  defaultTimeoutMs?: number;
  // Test seam — swap out execa to record argv without spawning.
  exec?: typeof execa;
};

const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export function readFileTool(init: FsToolInit): Tool<ReadFileInput, ReadFileOutput> {
  return tool({
    description:
      'Read a UTF-8 text file from the current worktree. Path may be relative (resolved against the worktree root) or absolute (must still be inside the worktree).',
    inputSchema: readFileInputSchema,
    execute: async (input: ReadFileInput): Promise<ReadFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      const content = await fsReadFile(safe, 'utf8');
      return { content };
    },
  });
}

export function writeFileTool(init: FsToolInit): Tool<WriteFileInput, WriteFileOutput> {
  return tool({
    description:
      'Write a UTF-8 text file inside the current worktree. Creates parent directories. Path must stay inside the worktree.',
    inputSchema: writeFileInputSchema,
    execute: async (input: WriteFileInput): Promise<WriteFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      await mkdir(dirname(safe), { recursive: true });
      await fsWriteFile(safe, input.content, 'utf8');
      return { ok: true };
    },
  });
}

export function bashTool(init: BashToolInit): Tool<BashInput, BashOutput> {
  const exec = init.exec ?? execa;
  const defaultTimeout = init.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  return tool({
    description:
      'Run a shell command inside the current worktree. Returns stdout, stderr, and exit code. The command is executed via `bash -lc` with cwd locked to the worktree.',
    inputSchema: bashInputSchema,
    execute: async (input): Promise<BashOutput> => {
      const timeout = input.timeoutMs ?? defaultTimeout;
      try {
        const r = await exec('bash', ['-lc', input.command], {
          cwd: init.cwd,
          timeout,
        });
        return {
          stdout: typeof r.stdout === 'string' ? r.stdout : '',
          stderr: typeof r.stderr === 'string' ? r.stderr : '',
          exitCode: r.exitCode ?? 0,
        };
      } catch (err) {
        if (err instanceof ExecaError) {
          return {
            stdout: typeof err.stdout === 'string' ? err.stdout : '',
            stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
            exitCode: err.exitCode ?? 1,
          };
        }
        // Unknown failure (timeout, ENOENT on bash, etc.): surface as a non-zero exit
        // with the error message in stderr so the LLM can read it and react.
        return {
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  });
}

// Resolve `requested` against `root` and assert the result is inside `root`. Uses two
// guards: (1) `path.relative` rejects `../`-style escapes by string, (2) realpath of
// the closest existing ancestor catches symlinks pointing outside. We can't realpath
// the target itself (it may not exist for writeFile), so we realpath the parent and
// re-check the relative path from there.
async function resolveInside(root: string, requested: string): Promise<string> {
  const absRoot = resolve(root);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(absRoot, requested);
  if (escapesRoot(absRoot, target)) {
    throw new Error(`path escapes worktree: ${requested}`);
  }
  // Realpath each existing ancestor to catch symlink-based escapes. Walk up from the
  // target until an ancestor exists, realpath it, then verify the original target's
  // path-relative-to-realpath stays inside.
  const realRoot = await safeRealpath(absRoot);
  const realTarget = await realpathOfExisting(target);
  if (escapesRoot(realRoot, realTarget)) {
    throw new Error(`path escapes worktree via symlink: ${requested}`);
  }
  return target;
}

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return false;
  if (rel.startsWith('..')) return true;
  if (isAbsolute(rel)) return true;
  return false;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

// Walk up `target`'s ancestors until one exists, realpath it, then re-attach the
// non-existing suffix. Lets us safely check would-be-created paths.
async function realpathOfExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    const realParent = await realpathOfExisting(parent);
    const suffix = relative(parent, target);
    return resolve(realParent, suffix);
  }
}
