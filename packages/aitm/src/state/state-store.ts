// docs/state.md
// Only module that reads or writes .ai-task-master/. Atomic writes via temp file + fsync + rename.

import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { atomicWrite } from '../fs/atomic-write.ts';
import { type PlanMarkdownGroup, renderPlanMarkdown } from '../plan/plan-markdown.ts';
import { acquireRunLock, RUN_LOCK_FILE, type RunLockHandle } from './run-lock.ts';
import { type GroupStage, type RunState, RunStateSchema, type Task } from './schema.ts';
import { TranscriptStore } from './transcript-store.ts';

const STATE_FILE = 'state.json';
const GOAL_FILE = 'goal.txt';
const CRITERIA_FILE = 'criteria.txt';
const PLAN_FILE = 'plan.md';
const PROGRESS_FILE = 'progress.md';
const CONTEXT_FILE = 'context.md';
const CODING_STYLE_FILE = 'coding-style.md';
const LOGS_DIR = 'logs';
// Durable cross-run memory (issue #118). Like logs/, it survives cleanupOnSuccess() — the one place
// under .ai-task-master/ that outlives the run whose knowledge it holds.
const MEMORY_DIR = 'memory';

export type StateInitOptions = {
  // Discard an existing state.json instead of refusing. Only for callers that decided the prior run
  // is superseded (finished, corrupt, or explicitly ignored) — never as a way past the check.
  force?: boolean;
};

// Raised at run entry like RunLockHeld and DirtyWorkingTree: a precondition the operator resolves,
// not a failure of the work itself.
export class StateAlreadyInitialized extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      [
        `Refusing to initialize: ${path} already holds a run.`,
        'Overwriting it would discard that run: its plan, group stages and PR numbers.',
        'Continue it with `aitm resume`, or start over with `aitm clean` first.',
      ].join('\n'),
    );
    this.name = 'StateAlreadyInitialized';
    this.path = path;
  }
}

export class StateStore {
  // Chained promise serializes concurrent update() calls so they observe linear semantics.
  // Each caller awaits the prior in-flight update before its read → mutate → write runs,
  // preventing lost updates when callers race via Promise.all.
  private updateChain: Promise<unknown> = Promise.resolve();

  // Serializes concurrent appendProgress() calls: bare appendFile per call races on the file offset,
  // risking interleaved lines and non-deterministic order. Chaining keeps entries intact and in
  // submission order. Separate from updateChain — progress writes a different file, so they needn't
  // block state updates (or vice versa).
  private progressChain: Promise<unknown> = Promise.resolve();

  // Last RunState this store persisted. update() mutates from here instead of re-reading state.json:
  // the store is the sole writer and update()s serialize on updateChain, so the cache never lags disk.
  // Null until the first successful write — the first update after construction still reads to seed it.
  private cached: RunState | null = null;

  constructor(private readonly stateDir: string) {}

  // Exclusive hold on this state dir for the lifetime of a run (see run-lock.ts). Taken at run
  // entry and released in a finally, so a second `aitm` over the same dir fails fast instead of
  // racing this store's write-behind cache.
  async acquireRunLock(): Promise<RunLockHandle> {
    return acquireRunLock(this.stateDir);
  }

  // Writes the starting state, refusing to overwrite a run that is already here: a mistaken second
  // `aitm start` in a directory holding a resumable run would otherwise lose its plan at the store
  // layer, whatever the CLI's own resume detection concluded. A caller that means to discard the
  // prior run says so with `force`.
  //
  // The probe is not mutual exclusion — run.lock is (see acquireRunLock). It guards the operator
  // mistake, so it stays a plain check-then-atomicWrite: a run that dies mid-init leaves no
  // state.json at all, where a claim-first scheme would leave an empty one blocking the next start.
  async init(initial: RunState, opts: StateInitOptions = {}): Promise<void> {
    const validated = RunStateSchema.parse(initial);
    const path = this.path(STATE_FILE);
    if (opts.force !== true && (await fileExists(path))) {
      throw new StateAlreadyInitialized(path);
    }
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(join(this.stateDir, LOGS_DIR), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`);
  }

  async read(): Promise<RunState> {
    const path = this.path(STATE_FILE);
    const raw = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: invalid JSON — ${msg}`);
    }
    return parseState(parsed, path);
  }

  async update(mutator: (s: RunState) => RunState): Promise<RunState> {
    const next = this.updateChain.then(async (): Promise<RunState> => {
      const current = this.cached ?? (await this.read());
      const draft = mutator(current);
      const updated: RunState = { ...draft, updatedAt: new Date().toISOString() };
      const validated = parseState(updated, this.path(STATE_FILE));
      await atomicWrite(this.path(STATE_FILE), `${JSON.stringify(validated, null, 2)}\n`);
      this.cached = validated;
      return validated;
    });
    // Swallow rejection on the chain so a failed update doesn't poison subsequent callers.
    // The original `next` promise still rejects for the caller that owns this update.
    this.updateChain = next.catch(() => undefined);
    return next;
  }

  async writeGoal(goal: string, criteria?: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await atomicWrite(this.path(GOAL_FILE), ensureTrailingNewline(goal));
    if (criteria !== undefined) {
      await atomicWrite(this.path(CRITERIA_FILE), ensureTrailingNewline(criteria));
    }
  }

  // The goal (and criteria) a previous `aitm start` persisted, or null when this directory has never
  // been started. `aitm resume` reads it so an operator never has to retype the original goal
  // verbatim to continue a run — retyping it differently would silently start a different run
  // against the same state.
  async readGoal(): Promise<{ goal: string; criteria?: string } | null> {
    const goal = (await readFileOrNull(this.path(GOAL_FILE)))?.trim();
    if (goal === undefined || goal === '') return null;
    const criteria = (await readFileOrNull(this.path(CRITERIA_FILE)))?.trim();
    return criteria ? { goal, criteria } : { goal };
  }

  // Render the PR groups through plan-markdown so plan.md carries per-task checkbox state
  // ([ ] / [x]) — the on-disk source of truth claudetm parity expects.
  async writePlan(groups: readonly PlanMarkdownGroup[]): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await atomicWrite(this.path(PLAN_FILE), ensureTrailingNewline(renderPlanMarkdown(groups)));
  }

  async appendProgress(entry: string): Promise<void> {
    const next = this.progressChain.then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      await appendFile(this.path(PROGRESS_FILE), ensureTrailingNewline(entry));
    });
    // Swallow rejection on the chain so a failed append doesn't poison subsequent callers.
    // The original `next` still rejects for the caller that owns this append.
    this.progressChain = next.catch(() => undefined);
    return next;
  }

  async writeContext(summary: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await atomicWrite(this.path(CONTEXT_FILE), ensureTrailingNewline(summary));
  }

  async readContext(): Promise<string | null> {
    try {
      return await readFile(this.path(CONTEXT_FILE), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeCodingStyle(md: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await atomicWrite(this.path(CODING_STYLE_FILE), ensureTrailingNewline(md));
  }

  async readCodingStyle(): Promise<string | null> {
    try {
      return await readFile(this.path(CODING_STYLE_FILE), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async cleanupOnSuccess(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.stateDir);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const entry of entries) {
      // run.lock is not this run's output but its claim on the dir — the holder releases it, and
      // deleting it here would let a peer start on top of a run that is still finishing.
      if (entry === LOGS_DIR || entry === MEMORY_DIR || entry === RUN_LOCK_FILE) continue;
      await rm(this.path(entry), { recursive: true, force: true });
    }
  }

  // True when the state dir exists — `aitm clean`'s pre-confirmation probe, so a repo with no
  // state gets the friendly no-op instead of a pointless confirmation prompt.
  async exists(): Promise<boolean> {
    try {
      await readdir(this.stateDir);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  // `aitm clean`: remove the ENTIRE state dir — logs/ and memory/ included, unlike
  // cleanupOnSuccess (claudetm-clean parity: an explicit fresh start abandons everything).
  // Returns false when there was nothing to delete so the CLI can say so instead of
  // pretending it cleaned something.
  async deleteAll(): Promise<boolean> {
    if (!(await this.exists())) return false;
    await rm(this.stateDir, { recursive: true, force: true });
    return true;
  }

  // The per-repo memory directory (issue #118). Handed out here so nothing rebuilds the path ad hoc;
  // the memory-loader (compat) reads/writes under it. Not created until the first memory write.
  memoryDir(): string {
    return this.path(MEMORY_DIR);
  }

  // Per-subagent conversation transcripts (issue #108), scoped to this run's state dir. Wiped by
  // cleanupOnSuccess along with the rest of the dir (not exempted, unlike memory/logs).
  transcripts(): TranscriptStore {
    return new TranscriptStore(this.stateDir);
  }

  private path(name: string): string {
    return join(this.stateDir, name);
  }
}

function parseState(value: unknown, path: string): RunState {
  try {
    return RunStateSchema.parse(coerceLegacyStage(coerceLegacyTasks(value)));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`${path}: ${formatZodError(err)}`);
    }
    throw err;
  }
}

// Legacy state.json (pre Task[] migration) stored prGroups[].tasks as a bare string[].
// There's no migration framework, so coerce on read: a string task becomes a structured
// Task with a slug id, default complexity, and not-done. Idempotent — structured tasks
// (and any non-legacy shape) pass through untouched for RunStateSchema.parse to validate.
function coerceLegacyTasks(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.prGroups)) return value;
  const prGroups = value.prGroups.map((group) => {
    if (!isRecord(group) || !Array.isArray(group.tasks)) return group;
    const tasks = group.tasks.map((task, index) =>
      typeof task === 'string' ? legacyTask(task, index) : task,
    );
    return { ...group, tasks };
  });
  return { ...value, prGroups };
}

function legacyTask(text: string, index: number): Task {
  return { id: slugify(text) || `task-${index + 1}`, text, complexity: 'normal', done: false };
}

// Legacy state.json (pre stage-machine) had no PrGroup.stage. Infer one on read so a paused run
// resumes at the right lifecycle point instead of restarting: a merged group stays merged, a group
// with an open PR resumes at waiting-ci, everything else starts at pending. The schema's
// default('pending') alone would discard the status/pr signal a non-pending group needs.
function coerceLegacyStage(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.prGroups)) return value;
  const prGroups = value.prGroups.map((group) => {
    if (!isRecord(group) || 'stage' in group) return group;
    return { ...group, stage: inferStage(group) };
  });
  return { ...value, prGroups };
}

function inferStage(group: Record<string, unknown>): GroupStage {
  if (group.status === 'merged') return 'merged';
  // A legacy terminal `blocked` group must stay blocked — otherwise it falls through to
  // 'waiting-ci'/'pending' and becomes runnable again on resume, re-entering work it was halted on.
  if (group.status === 'blocked') return 'blocked';
  if (group.pr != null) return 'waiting-ci';
  return 'pending';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
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

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// Read a state file, or null when it does not exist. A missing goal.txt is the ordinary
// "never started here" case; anything else (EACCES, an I/O fault, a directory where a file should
// be) is a real failure and must reach the caller — swallowing it would report "nothing to resume"
// for a run that exists and cannot be read, and would make runResume's error branch unreachable.
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
