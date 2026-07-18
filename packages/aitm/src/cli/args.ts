// docs/commands/start.md §Signature, docs/commands/merge-pr.md §Signature, docs/commands/config.md,
// docs/commands/profile.md §Signature. Tiny argv parser. Pure function — easy to unit-test.

import { isPresetName, type PresetName } from '../config/provider-presets.ts';

export type StartArgs = {
  kind: 'start';
  goal: string;
  criteria?: string;
  maxPrs?: number;
  maxSessions?: number | null;
  autoMerge?: boolean;
  // Force-merge past base-branch protection via `gh pr merge --admin`. From `--admin`.
  adminMerge?: boolean;
  prPerTask?: boolean;
  stylePath?: string | null;
  model?: string;
  concurrency?: number;
  // Cap on CI-fix passes per PR group before it blocks for a human. From `--max-fix-attempts`. #128.
  maxFixAttempts?: number;
  // Caller-specified branch for the PR(s). When the plan yields a single group it is used
  // verbatim; with multiple groups it becomes a prefix (`<branch>/<group-id>`) so the
  // groups' branches don't collide. When absent, branches default to `aitm/<group-id>`.
  branch?: string;
};

export type MergePrArgs = {
  kind: 'merge-pr';
  pr?: number;
  resume: boolean;
  // Cap on CI-wait/fix iterations before giving up. Parsed from `--max-iterations`; when absent the
  // merge flow defaults to DEFAULT_MAX_ITERATIONS (30).
  maxIterations?: number;
  // Force-merge past base-branch protection via `gh pr merge --admin`. From `--admin`.
  adminMerge?: boolean;
};

export type ConfigArgs =
  | { kind: 'config-set'; scope: 'global' | 'project'; key: string; value: string }
  | { kind: 'config-unset'; scope: 'global' | 'project'; key: string }
  | { kind: 'config-get'; scope: 'global' | 'project'; key: string }
  | { kind: 'config-list'; scope: 'global' | 'project' };

export type ProfileArgs =
  | { kind: 'profile-list' }
  | { kind: 'profile-use'; name: string }
  | {
      kind: 'profile-add';
      name: string;
      preset?: PresetName;
      baseURL?: string;
      apiKey?: string;
      apiKeyStdin?: boolean;
    }
  | { kind: 'profile-set'; name: string; key: string; value: string }
  | { kind: 'profile-get'; name: string; key: string }
  | { kind: 'profile-remove'; name: string }
  | { kind: 'profile-show'; name?: string };

export type ParsedArgs =
  | StartArgs
  | MergePrArgs
  | ConfigArgs
  | ProfileArgs
  | { kind: 'help' }
  | { kind: 'usage-error' };

const HELP: ParsedArgs = { kind: 'help' };
// Malformed input (bad flag value, unknown flag, missing required arg): distinct from
// explicitly-requested help so the CLI can exit nonzero and print to stderr instead of
// masking a CI-wrapper typo behind exit 0.
const USAGE_ERROR: ParsedArgs = { kind: 'usage-error' };

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined) return HELP;
  if (command === 'help' || command === '--help' || command === '-h') return HELP;
  switch (command) {
    case 'start':
      return parseStart(rest);
    case 'merge-pr':
      return parseMergePr(rest);
    case 'config':
      return parseConfig(rest);
    case 'profile':
      return parseProfile(rest);
    default:
      return USAGE_ERROR;
  }
}

function parseStart(args: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  let criteria: string | undefined;
  let maxPrs: number | undefined;
  let maxSessions: number | undefined;
  let autoMerge: boolean | undefined;
  let adminMerge: boolean | undefined;
  let prPerTask: boolean | undefined;
  let stylePath: string | undefined;
  let model: string | undefined;
  let concurrency: number | undefined;
  let maxFixAttempts: number | undefined;
  let branch: string | undefined;

  let i = 0;
  while (i < args.length) {
    const raw = args[i];
    if (raw === undefined) break;
    const { flag, inlineValue, consumed } = splitFlag(raw);
    if (flag === '--criteria') {
      const v = takeValue(args, i, inlineValue);
      if (v === null || (inlineValue === null && v.startsWith('--'))) return USAGE_ERROR;
      criteria = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-prs') {
      const v = takeValue(args, i, inlineValue);
      const n = parseNonNegativeInt(v);
      if (n === null) return USAGE_ERROR;
      maxPrs = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-sessions') {
      const v = takeValue(args, i, inlineValue);
      const n = parseNonNegativeInt(v);
      if (n === null) return USAGE_ERROR;
      maxSessions = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--concurrency') {
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return USAGE_ERROR;
      concurrency = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-fix-attempts') {
      // Positive int (not parseNonNegativeInt): 0 CI-fix passes is nonsensical, unlike
      // --max-sessions where 0 means unlimited.
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return USAGE_ERROR;
      maxFixAttempts = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--no-automerge') {
      // Boolean flag rejects any inline value: `--no-automerge=true` is a usage error,
      // not silently treated as the boolean.
      if (inlineValue !== null) return USAGE_ERROR;
      autoMerge = false;
      i += 1;
    } else if (flag === '--admin') {
      // Boolean flag: force-merge past base-branch policy. Rejects inline values.
      if (inlineValue !== null) return USAGE_ERROR;
      adminMerge = true;
      i += 1;
    } else if (flag === '--pr-per-task') {
      // Boolean flag rejects any inline value: `--pr-per-task=true` is a usage error,
      // not silently treated as the boolean.
      if (inlineValue !== null) return USAGE_ERROR;
      prPerTask = true;
      i += 1;
    } else if (flag === '--style') {
      const v = takeValue(args, i, inlineValue);
      if (v === null || (inlineValue === null && v.startsWith('--'))) return USAGE_ERROR;
      stylePath = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--model') {
      const v = takeValue(args, i, inlineValue);
      if (v === null || (inlineValue === null && v.startsWith('--'))) return USAGE_ERROR;
      model = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--branch') {
      const v = takeValue(args, i, inlineValue);
      if (v === null || (inlineValue === null && v.startsWith('--')) || !isValidBranchName(v))
        return USAGE_ERROR;
      branch = v;
      i += consumed(inlineValue !== null);
    } else if (raw.startsWith('--')) {
      return USAGE_ERROR;
    } else if (raw.startsWith('-')) {
      return USAGE_ERROR;
    } else {
      positionals.push(raw);
      i += 1;
    }
  }

  const goal = positionals[0];
  if (goal === undefined || positionals.length > 1) return USAGE_ERROR;

  const out: StartArgs = { kind: 'start', goal };
  if (criteria !== undefined) out.criteria = criteria;
  if (maxPrs !== undefined) out.maxPrs = maxPrs;
  if (maxSessions !== undefined) out.maxSessions = maxSessions;
  if (autoMerge !== undefined) out.autoMerge = autoMerge;
  if (adminMerge !== undefined) out.adminMerge = adminMerge;
  if (prPerTask !== undefined) out.prPerTask = prPerTask;
  if (stylePath !== undefined) out.stylePath = stylePath;
  if (model !== undefined) out.model = model;
  if (concurrency !== undefined) out.concurrency = concurrency;
  if (maxFixAttempts !== undefined) out.maxFixAttempts = maxFixAttempts;
  if (branch !== undefined) out.branch = branch;
  return out;
}

// Git ref-name check that mirrors the component rules `git check-ref-format --branch` enforces,
// so an invalid `--branch` is rejected up front instead of failing later at `git checkout -B`.
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('-')) return false;
  // Whole-ref forbidden sequences: range/reflog syntax, empty path segments.
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  // No whitespace, control chars, or the special chars git forbids anywhere in a ref.
  if (/[\s~^:?*[\\]/.test(name)) return false;
  // Per-component rules: a slash-separated component may not be empty, start with '.', or end
  // with '.' or '.lock' (covers leading/trailing slash via empty components).
  for (const part of name.split('/')) {
    if (part.length === 0) return false;
    if (part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

function parseMergePr(args: ReadonlyArray<string>): ParsedArgs {
  let pr: number | undefined;
  let maxIterations: number | undefined;
  let resume = true;
  let adminMerge: boolean | undefined;
  let i = 0;
  while (i < args.length) {
    const raw = args[i];
    if (raw === undefined) break;
    const { flag, inlineValue, consumed } = splitFlag(raw);
    if (flag === '--pr') {
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return USAGE_ERROR;
      pr = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-iterations') {
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return USAGE_ERROR;
      maxIterations = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--no-resume') {
      if (inlineValue !== null) return USAGE_ERROR;
      resume = false;
      i += 1;
    } else if (flag === '--admin') {
      if (inlineValue !== null) return USAGE_ERROR;
      adminMerge = true;
      i += 1;
    } else {
      return USAGE_ERROR;
    }
  }
  const out: MergePrArgs = { kind: 'merge-pr', resume };
  if (pr !== undefined) out.pr = pr;
  if (maxIterations !== undefined) out.maxIterations = maxIterations;
  if (adminMerge !== undefined) out.adminMerge = adminMerge;
  return out;
}

function parseConfig(args: ReadonlyArray<string>): ParsedArgs {
  const sub = args[0];
  if (sub === undefined) return USAGE_ERROR;
  const tail = args.slice(1);
  const positionals: string[] = [];
  let scope: 'global' | 'project' = 'global';
  for (const arg of tail) {
    if (arg === '--project') {
      scope = 'project';
    } else if (arg.startsWith('--')) {
      // `--project=anything` is a usage error: --project is a boolean flag.
      return USAGE_ERROR;
    } else {
      positionals.push(arg);
    }
  }
  switch (sub) {
    case 'set': {
      if (positionals.length !== 2) return USAGE_ERROR;
      const [key, value] = positionals;
      if (key === undefined || value === undefined) return USAGE_ERROR;
      return { kind: 'config-set', scope, key, value };
    }
    case 'unset': {
      if (positionals.length !== 1) return USAGE_ERROR;
      const [key] = positionals;
      if (key === undefined) return USAGE_ERROR;
      return { kind: 'config-unset', scope, key };
    }
    case 'get': {
      if (positionals.length !== 1) return USAGE_ERROR;
      const [key] = positionals;
      if (key === undefined) return USAGE_ERROR;
      return { kind: 'config-get', scope, key };
    }
    case 'list': {
      if (positionals.length !== 0) return USAGE_ERROR;
      return { kind: 'config-list', scope };
    }
    default:
      return USAGE_ERROR;
  }
}

function parseProfile(args: ReadonlyArray<string>): ParsedArgs {
  const sub = args[0];
  if (sub === undefined) return USAGE_ERROR;
  const tail = args.slice(1);
  switch (sub) {
    case 'list':
      return tail.length === 0 ? { kind: 'profile-list' } : USAGE_ERROR;
    case 'use': {
      const name = onlyName(tail);
      return name === null ? USAGE_ERROR : { kind: 'profile-use', name };
    }
    case 'remove': {
      const name = onlyName(tail);
      return name === null ? USAGE_ERROR : { kind: 'profile-remove', name };
    }
    case 'show': {
      if (tail.length === 0) return { kind: 'profile-show' };
      const name = onlyName(tail);
      return name === null ? USAGE_ERROR : { kind: 'profile-show', name };
    }
    case 'get': {
      if (tail.length !== 2) return USAGE_ERROR;
      const [name, key] = tail;
      if (
        name === undefined ||
        key === undefined ||
        name.startsWith('--') ||
        key.startsWith('--')
      ) {
        return USAGE_ERROR;
      }
      return { kind: 'profile-get', name, key };
    }
    case 'set': {
      if (tail.length !== 3) return USAGE_ERROR;
      const [name, key, value] = tail;
      if (name === undefined || key === undefined || value === undefined) return USAGE_ERROR;
      if (name.startsWith('--') || key.startsWith('--')) return USAGE_ERROR;
      return { kind: 'profile-set', name, key, value };
    }
    case 'add':
      return parseProfileAdd(tail);
    default:
      return USAGE_ERROR;
  }
}

function parseProfileAdd(tail: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  let preset: PresetName | undefined;
  let baseURL: string | undefined;
  let apiKey: string | undefined;
  let apiKeyStdin = false;
  let i = 0;
  while (i < tail.length) {
    const raw = tail[i];
    if (raw === undefined) break;
    const { flag, inlineValue, consumed } = splitFlag(raw);
    if (flag === '--preset') {
      const v = takeValue(tail, i, inlineValue);
      if (v === null || !isPresetName(v)) return USAGE_ERROR;
      preset = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--base-url') {
      const v = takeValue(tail, i, inlineValue);
      // Reject a following flag-like token (`--base-url --api-key`) as a missing value.
      if (v === null || (inlineValue === null && v.startsWith('--'))) return USAGE_ERROR;
      baseURL = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--api-key') {
      const v = takeValue(tail, i, inlineValue);
      if (v === null || (inlineValue === null && v.startsWith('--'))) return USAGE_ERROR;
      apiKey = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--api-key-stdin') {
      // Boolean flag — read the secret from stdin, never argv. An inline value is a usage error.
      if (inlineValue !== null) return USAGE_ERROR;
      apiKeyStdin = true;
      i += 1;
    } else if (raw.startsWith('--')) {
      return USAGE_ERROR;
    } else {
      positionals.push(raw);
      i += 1;
    }
  }
  const name = positionals[0];
  if (name === undefined || positionals.length > 1) return USAGE_ERROR;
  // --api-key and --api-key-stdin are mutually exclusive: one source for the secret.
  if (apiKey !== undefined && apiKeyStdin) return USAGE_ERROR;
  const out: ProfileArgs = { kind: 'profile-add', name };
  if (preset !== undefined) out.preset = preset;
  if (baseURL !== undefined) out.baseURL = baseURL;
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (apiKeyStdin) out.apiKeyStdin = true;
  return out;
}

// Exactly one positional name, no flags. Returns null on any deviation (→ usage-error).
function onlyName(tail: ReadonlyArray<string>): string | null {
  if (tail.length !== 1) return null;
  const name = tail[0];
  if (name === undefined || name.startsWith('--')) return null;
  return name;
}

function parseNonNegativeInt(s: string | null | undefined): number | null {
  if (s === undefined || s === null) return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function parsePositiveInt(s: string | null | undefined): number | null {
  const n = parseNonNegativeInt(s);
  return n !== null && n > 0 ? n : null;
}

// Split `--key=value` into flag + inline value. For `--key` alone, inlineValue is null
// and the caller must read args[i+1] for the value (two-token form).
function splitFlag(raw: string): {
  flag: string;
  inlineValue: string | null;
  consumed: (inline: boolean) => number;
} {
  if (!raw.startsWith('--')) {
    return { flag: raw, inlineValue: null, consumed: () => 1 };
  }
  const eq = raw.indexOf('=');
  if (eq === -1) {
    return { flag: raw, inlineValue: null, consumed: (inline) => (inline ? 1 : 2) };
  }
  return {
    flag: raw.slice(0, eq),
    inlineValue: raw.slice(eq + 1),
    consumed: (inline) => (inline ? 1 : 2),
  };
}

// Resolve the value for a flag: prefer the inline form (--key=value); fall back to the
// next argv token (--key value). Returns null when neither is present.
function takeValue(
  args: ReadonlyArray<string>,
  i: number,
  inlineValue: string | null,
): string | null {
  if (inlineValue !== null) return inlineValue;
  const next = args[i + 1];
  return next ?? null;
}
