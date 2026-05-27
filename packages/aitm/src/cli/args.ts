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
    const raw = args[i];
    if (raw === undefined) break;
    const { flag, inlineValue, consumed } = splitFlag(raw);
    if (flag === '--criteria') {
      const v = takeValue(args, i, inlineValue);
      if (v === null) return HELP;
      criteria = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-prs') {
      const v = takeValue(args, i, inlineValue);
      const n = parseNonNegativeInt(v);
      if (n === null) return HELP;
      maxPrs = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--max-sessions') {
      const v = takeValue(args, i, inlineValue);
      const n = parseNonNegativeInt(v);
      if (n === null) return HELP;
      maxSessions = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--concurrency') {
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return HELP;
      concurrency = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--no-automerge') {
      // Boolean flag rejects any inline value: `--no-automerge=true` is a usage error,
      // not silently treated as the boolean.
      if (inlineValue !== null) return HELP;
      autoMerge = false;
      i += 1;
    } else if (flag === '--style') {
      const v = takeValue(args, i, inlineValue);
      if (v === null) return HELP;
      stylePath = v;
      i += consumed(inlineValue !== null);
    } else if (flag === '--model') {
      const v = takeValue(args, i, inlineValue);
      if (v === null) return HELP;
      model = v;
      i += consumed(inlineValue !== null);
    } else if (raw.startsWith('--')) {
      return HELP;
    } else {
      positionals.push(raw);
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
    const raw = args[i];
    if (raw === undefined) break;
    const { flag, inlineValue, consumed } = splitFlag(raw);
    if (flag === '--pr') {
      const v = takeValue(args, i, inlineValue);
      const n = parsePositiveInt(v);
      if (n === null) return HELP;
      pr = n;
      i += consumed(inlineValue !== null);
    } else if (flag === '--no-resume') {
      if (inlineValue !== null) return HELP;
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
      // `--project=anything` is a usage error: --project is a boolean flag.
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
