// docs/commands/start.md §Signature, docs/commands/merge-pr.md §Signature, docs/commands/config.md
// Tiny dependency-free argv parser. Pure function — easy to unit-test.

export type StartArgs = {
  kind: 'start';
  goal: string;
  criteria?: string;
  maxPrs?: number;
  maxSessions?: number | null;
  autoMerge?: boolean;
  stylePath?: string | null;
  model?: string;
  concurrency?: number;
};

export type MergePrArgs = {
  kind: 'merge-pr';
  pr?: number;
  resume: boolean;
};

export type ConfigArgs =
  | { kind: 'config-set'; scope: 'global' | 'project'; key: string; value: string }
  | { kind: 'config-unset'; scope: 'global' | 'project'; key: string }
  | { kind: 'config-get'; scope: 'global' | 'project'; key: string }
  | { kind: 'config-list'; scope: 'global' | 'project' };

export type ParsedArgs = StartArgs | MergePrArgs | ConfigArgs | { kind: 'help' };

const HELP: ParsedArgs = { kind: 'help' };

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
    default:
      return HELP;
  }
}

function parseStart(args: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  let criteria: string | undefined;
  let maxPrs: number | undefined;
  let maxSessions: number | undefined;
  let autoMerge: boolean | undefined;
  let stylePath: string | undefined;
  let model: string | undefined;
  let concurrency: number | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === '--criteria') {
      const v = args[i + 1];
      if (v === undefined) return HELP;
      criteria = v;
      i += 2;
    } else if (arg === '--max-prs') {
      const n = parseNonNegativeInt(args[i + 1]);
      if (n === null) return HELP;
      maxPrs = n;
      i += 2;
    } else if (arg === '--max-sessions') {
      const n = parseNonNegativeInt(args[i + 1]);
      if (n === null) return HELP;
      maxSessions = n;
      i += 2;
    } else if (arg === '--concurrency') {
      const n = parseNonNegativeInt(args[i + 1]);
      if (n === null) return HELP;
      concurrency = n;
      i += 2;
    } else if (arg === '--no-automerge') {
      autoMerge = false;
      i += 1;
    } else if (arg === '--style') {
      const v = args[i + 1];
      if (v === undefined) return HELP;
      stylePath = v;
      i += 2;
    } else if (arg === '--model') {
      const v = args[i + 1];
      if (v === undefined) return HELP;
      model = v;
      i += 2;
    } else if (arg.startsWith('--')) {
      return HELP;
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  const goal = positionals[0];
  if (goal === undefined || positionals.length > 1) return HELP;

  const out: StartArgs = { kind: 'start', goal };
  if (criteria !== undefined) out.criteria = criteria;
  if (maxPrs !== undefined) out.maxPrs = maxPrs;
  if (maxSessions !== undefined) out.maxSessions = maxSessions;
  if (autoMerge !== undefined) out.autoMerge = autoMerge;
  if (stylePath !== undefined) out.stylePath = stylePath;
  if (model !== undefined) out.model = model;
  if (concurrency !== undefined) out.concurrency = concurrency;
  return out;
}

function parseMergePr(args: ReadonlyArray<string>): ParsedArgs {
  let pr: number | undefined;
  let resume = true;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === '--pr') {
      const n = parseNonNegativeInt(args[i + 1]);
      if (n === null) return HELP;
      pr = n;
      i += 2;
    } else if (arg === '--no-resume') {
      resume = false;
      i += 1;
    } else {
      return HELP;
    }
  }
  const out: MergePrArgs = { kind: 'merge-pr', resume };
  if (pr !== undefined) out.pr = pr;
  return out;
}

function parseConfig(args: ReadonlyArray<string>): ParsedArgs {
  const sub = args[0];
  if (sub === undefined) return HELP;
  const tail = args.slice(1);
  const positionals: string[] = [];
  let scope: 'global' | 'project' = 'global';
  for (const arg of tail) {
    if (arg === '--project') {
      scope = 'project';
    } else if (arg.startsWith('--')) {
      return HELP;
    } else {
      positionals.push(arg);
    }
  }
  switch (sub) {
    case 'set': {
      if (positionals.length !== 2) return HELP;
      const [key, value] = positionals;
      if (key === undefined || value === undefined) return HELP;
      return { kind: 'config-set', scope, key, value };
    }
    case 'unset': {
      if (positionals.length !== 1) return HELP;
      const [key] = positionals;
      if (key === undefined) return HELP;
      return { kind: 'config-unset', scope, key };
    }
    case 'get': {
      if (positionals.length !== 1) return HELP;
      const [key] = positionals;
      if (key === undefined) return HELP;
      return { kind: 'config-get', scope, key };
    }
    case 'list': {
      if (positionals.length !== 0) return HELP;
      return { kind: 'config-list', scope };
    }
    default:
      return HELP;
  }
}

function parseNonNegativeInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
