// docs/state.md §"Schema versions"
// Lifts an on-disk state.json to CURRENT_SCHEMA_VERSION before RunStateSchema validates it. One step
// per version, keyed by the version it reads, so a persisted-shape change adds a row here instead of
// another read-time coercion pass in state-store.

import { CURRENT_SCHEMA_VERSION, type GroupStage, type Task } from './schema.ts';

type StateRecord = Record<string, unknown>;

// Reads a run at version N, returns the same run at N+1. Steps must tolerate data that already
// carries the later shape: update() re-parses in-memory state on every write, and a mutator that
// rebuilds the object from scratch drops the version stamp back to 0.
type MigrationStep = (state: StateRecord) => StateRecord;

const MIGRATIONS: ReadonlyMap<number, MigrationStep> = new Map<number, MigrationStep>([
  [0, v0ToV1],
]);

// A state file this build cannot read: written by a newer aitm, or carrying a version that is not a
// version at all. Refusing is deliberate — the alternative, treating it as corrupt, would let an
// older aitm force-init over a run it merely does not understand.
export class UnsupportedSchemaVersion extends Error {
  readonly path: string;
  readonly found: unknown;

  constructor(path: string, found: unknown) {
    super(unsupportedMessage(path, found));
    this.name = 'UnsupportedSchemaVersion';
    this.path = path;
    this.found = found;
  }
}

export function migrateState(value: unknown, path: string): unknown {
  if (!isRecord(value)) return value;
  let version = readVersion(value, path);
  let state = value;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.get(version);
    // Unreachable while the table is contiguous — a gap must fail loudly, not spin.
    if (step === undefined) throw new UnsupportedSchemaVersion(path, version);
    state = step(state);
    version += 1;
  }
  return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION };
}

// Absent means v0: every state.json written before versioning existed. Anything else that is not a
// plain non-negative integer is refused rather than guessed at.
function readVersion(state: StateRecord, path: string): number {
  const found = state.schemaVersion;
  if (found === undefined) return 0;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    throw new UnsupportedSchemaVersion(path, found);
  }
  if (found > CURRENT_SCHEMA_VERSION) throw new UnsupportedSchemaVersion(path, found);
  return found;
}

// v0 → v1: prGroups[].tasks was a bare string[], and PrGroup had no `stage`.
function v0ToV1(state: StateRecord): StateRecord {
  if (!Array.isArray(state.prGroups)) return state;
  return { ...state, prGroups: state.prGroups.map(liftGroupV0) };
}

function liftGroupV0(group: unknown): unknown {
  if (!isRecord(group)) return group;
  const lifted: StateRecord = { ...group };
  if (Array.isArray(group.tasks)) {
    lifted.tasks = group.tasks.map((task, index) =>
      typeof task === 'string' ? legacyTask(task, index) : task,
    );
  }
  if (!('stage' in group)) lifted.stage = inferStage(group);
  return lifted;
}

function legacyTask(text: string, index: number): Task {
  return { id: slugify(text) || `task-${index + 1}`, text, complexity: 'normal', done: false };
}

// A v0 group carries no stage, so infer one from the signal it does carry — otherwise a paused run
// restarts instead of resuming: a merged group stays merged, one with an open PR resumes at
// waiting-ci, everything else starts at pending. The schema's default('pending') alone would discard
// that signal. A terminal `blocked` group must stay blocked, or it falls through to
// 'waiting-ci'/'pending' and becomes runnable again, re-entering the work it was halted on.
function inferStage(group: StateRecord): GroupStage {
  if (group.status === 'merged') return 'merged';
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

// Must not start with `${path}:` — callers read that prefix as "corrupt state, safe to discard",
// which is exactly the wrong verdict for a run written by a newer aitm.
function unsupportedMessage(path: string, found: unknown): string {
  const head = isVersionNumber(found)
    ? `Refusing to read a run written by a newer aitm: ${path} is schema v${found}, and this build understands up to v${CURRENT_SCHEMA_VERSION}.`
    : `Refusing to read a run with an unreadable schema version: ${path} has schemaVersion ${describe(found)}, expected an integer from 0 to ${CURRENT_SCHEMA_VERSION}.`;
  return `${head}\nUpgrade aitm to read it, or discard the run with \`aitm clean\`.`;
}

function isVersionNumber(found: unknown): found is number {
  return typeof found === 'number' && Number.isInteger(found) && found >= 0;
}

function describe(found: unknown): string {
  if (typeof found === 'number') return String(found);
  // JSON.stringify yields undefined for undefined/functions/symbols.
  return JSON.stringify(found) ?? String(found);
}

function isRecord(value: unknown): value is StateRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
