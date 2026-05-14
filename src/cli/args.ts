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

export function parseArgs(_argv: ReadonlyArray<string>): ParsedArgs {
  throw new Error('not implemented');
}
