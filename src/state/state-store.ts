// docs/state.md
// Only module that reads or writes .ai-task-master/. Atomic writes via temp file + fsync + rename.

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { atomicWrite } from '../fs/atomic-write.ts';
import { type RunState, RunStateSchema } from './schema.ts';

const STATE_FILE = 'state.json';
const GOAL_FILE = 'goal.txt';
const CRITERIA_FILE = 'criteria.txt';
const PLAN_FILE = 'plan.md';
const PROGRESS_FILE = 'progress.md';
const CONTEXT_FILE = 'context.md';
const LOGS_DIR = 'logs';

export class StateStore {
  // Chained promise serializes concurrent update() calls so they observe linear semantics.
  // Each caller awaits the prior in-flight update before its read → mutate → write runs,
  // preventing lost updates when callers race via Promise.all.
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string) {}

  async init(initial: RunState): Promise<void> {
    const validated = RunStateSchema.parse(initial);
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(join(this.stateDir, LOGS_DIR), { recursive: true });
    await atomicWrite(this.path(STATE_FILE), `${JSON.stringify(validated, null, 2)}\n`);
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
      const current = await this.read();
      const draft = mutator(current);
      const updated: RunState = { ...draft, updatedAt: new Date().toISOString() };
      const validated = parseState(updated, this.path(STATE_FILE));
      await atomicWrite(this.path(STATE_FILE), `${JSON.stringify(validated, null, 2)}\n`);
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

  async writePlan(plan: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await atomicWrite(this.path(PLAN_FILE), ensureTrailingNewline(plan));
  }

  async appendProgress(entry: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(this.path(PROGRESS_FILE), ensureTrailingNewline(entry));
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

  async cleanupOnSuccess(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.stateDir);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (entry === LOGS_DIR) continue;
      await rm(this.path(entry), { recursive: true, force: true });
    }
  }

  private path(name: string): string {
    return join(this.stateDir, name);
  }
}

function parseState(value: unknown, path: string): RunState {
  try {
    return RunStateSchema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`${path}: ${formatZodError(err)}`);
    }
    throw err;
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
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
