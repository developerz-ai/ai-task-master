import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ParsedArgs, parseArgs } from './args.ts';

type Case = { name: string; argv: string[]; expected: ParsedArgs };

const startCases: Case[] = [
  {
    name: 'start: bare goal',
    argv: ['start', 'add jwt auth'],
    expected: { kind: 'start', goal: 'add jwt auth' },
  },
  {
    name: 'start: all flags',
    argv: [
      'start',
      'big goal',
      '--criteria',
      'all tests pass',
      '--max-prs',
      '7',
      '--max-sessions',
      '3',
      '--no-automerge',
      '--style',
      'docs/STYLE.md',
      '--model',
      'anthropic/claude-opus-4.7',
      '--concurrency',
      '2',
    ],
    expected: {
      kind: 'start',
      goal: 'big goal',
      criteria: 'all tests pass',
      maxPrs: 7,
      maxSessions: 3,
      autoMerge: false,
      stylePath: 'docs/STYLE.md',
      model: 'anthropic/claude-opus-4.7',
      concurrency: 2,
    },
  },
  {
    name: 'start: flag before goal',
    argv: ['start', '--max-prs', '4', 'ship the thing'],
    expected: { kind: 'start', goal: 'ship the thing', maxPrs: 4 },
  },
  {
    name: 'start: zero is valid for numeric flag',
    argv: ['start', 'goal', '--max-sessions', '0'],
    expected: { kind: 'start', goal: 'goal', maxSessions: 0 },
  },
  {
    name: 'start: --max-prs=N inline form',
    argv: ['start', 'goal', '--max-prs=4'],
    expected: { kind: 'start', goal: 'goal', maxPrs: 4 },
  },
  {
    name: 'start: --max-sessions=0 inline form',
    argv: ['start', 'goal', '--max-sessions=0'],
    expected: { kind: 'start', goal: 'goal', maxSessions: 0 },
  },
  {
    name: 'start: --criteria= with value containing =',
    argv: ['start', 'goal', '--criteria=foo=bar'],
    expected: { kind: 'start', goal: 'goal', criteria: 'foo=bar' },
  },
  {
    name: 'start: --model=anthropic/claude inline',
    argv: ['start', 'goal', '--model=anthropic/claude-opus-4.7'],
    expected: { kind: 'start', goal: 'goal', model: 'anthropic/claude-opus-4.7' },
  },
  {
    name: 'start: mix of inline and two-token flags',
    argv: ['start', '--max-prs=2', 'goal', '--concurrency', '3'],
    expected: { kind: 'start', goal: 'goal', maxPrs: 2, concurrency: 3 },
  },
];

const mergeCases: Case[] = [
  {
    name: 'merge-pr: bare',
    argv: ['merge-pr'],
    expected: { kind: 'merge-pr', resume: true },
  },
  {
    name: 'merge-pr: --pr',
    argv: ['merge-pr', '--pr', '42'],
    expected: { kind: 'merge-pr', resume: true, pr: 42 },
  },
  {
    name: 'merge-pr: --no-resume',
    argv: ['merge-pr', '--no-resume'],
    expected: { kind: 'merge-pr', resume: false },
  },
  {
    name: 'merge-pr: both flags',
    argv: ['merge-pr', '--pr', '7', '--no-resume'],
    expected: { kind: 'merge-pr', resume: false, pr: 7 },
  },
  {
    name: 'merge-pr: --pr=N inline form',
    argv: ['merge-pr', '--pr=42'],
    expected: { kind: 'merge-pr', resume: true, pr: 42 },
  },
];

const configCases: Case[] = [
  {
    name: 'config set global',
    argv: ['config', 'set', 'models.smart', 'anthropic/claude-opus-4.7'],
    expected: {
      kind: 'config-set',
      scope: 'global',
      key: 'models.smart',
      value: 'anthropic/claude-opus-4.7',
    },
  },
  {
    name: 'config set --project',
    argv: ['config', 'set', 'autoMerge', 'true', '--project'],
    expected: { kind: 'config-set', scope: 'project', key: 'autoMerge', value: 'true' },
  },
  {
    name: 'config unset global',
    argv: ['config', 'unset', 'openrouterApiKey'],
    expected: { kind: 'config-unset', scope: 'global', key: 'openrouterApiKey' },
  },
  {
    name: 'config unset --project',
    argv: ['config', 'unset', 'concurrency', '--project'],
    expected: { kind: 'config-unset', scope: 'project', key: 'concurrency' },
  },
  {
    name: 'config get global',
    argv: ['config', 'get', 'models.coding'],
    expected: { kind: 'config-get', scope: 'global', key: 'models.coding' },
  },
  {
    name: 'config get --project',
    argv: ['config', 'get', 'maxPrs', '--project'],
    expected: { kind: 'config-get', scope: 'project', key: 'maxPrs' },
  },
  {
    name: 'config list global',
    argv: ['config', 'list'],
    expected: { kind: 'config-list', scope: 'global' },
  },
  {
    name: 'config list --project',
    argv: ['config', 'list', '--project'],
    expected: { kind: 'config-list', scope: 'project' },
  },
];

const helpCases: Case[] = [
  { name: 'no args', argv: [], expected: { kind: 'help' } },
  { name: 'help command', argv: ['help'], expected: { kind: 'help' } },
  { name: '--help flag', argv: ['--help'], expected: { kind: 'help' } },
  { name: '-h flag', argv: ['-h'], expected: { kind: 'help' } },
  { name: 'unknown command', argv: ['nope'], expected: { kind: 'help' } },
  { name: 'start: missing goal', argv: ['start'], expected: { kind: 'help' } },
  {
    name: 'start: missing goal with only flags',
    argv: ['start', '--max-prs', '3'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: extra positional',
    argv: ['start', 'goal', 'extra'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: bad --max-prs (non-numeric)',
    argv: ['start', 'g', '--max-prs', 'abc'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: bad --max-prs (float)',
    argv: ['start', 'g', '--max-prs', '1.5'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: bad --max-prs (negative)',
    argv: ['start', 'g', '--max-prs', '-1'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: bad --max-sessions',
    argv: ['start', 'g', '--max-sessions', 'inf'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: bad --concurrency',
    argv: ['start', 'g', '--concurrency', ''],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --concurrency zero rejected',
    argv: ['start', 'g', '--concurrency', '0'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --criteria without value',
    argv: ['start', 'g', '--criteria'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --style without value',
    argv: ['start', 'g', '--style'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --model without value',
    argv: ['start', 'g', '--model'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: unknown flag',
    argv: ['start', 'g', '--bogus'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --no-automerge=true rejected (boolean flag, no value allowed)',
    argv: ['start', 'g', '--no-automerge=true'],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --max-prs= with empty value',
    argv: ['start', 'g', '--max-prs='],
    expected: { kind: 'help' },
  },
  {
    name: 'start: --max-prs=abc inline rejected',
    argv: ['start', 'g', '--max-prs=abc'],
    expected: { kind: 'help' },
  },
  {
    name: 'merge-pr: bad --pr',
    argv: ['merge-pr', '--pr', 'abc'],
    expected: { kind: 'help' },
  },
  {
    name: 'merge-pr: --pr zero rejected',
    argv: ['merge-pr', '--pr', '0'],
    expected: { kind: 'help' },
  },
  {
    name: 'merge-pr: --pr without value',
    argv: ['merge-pr', '--pr'],
    expected: { kind: 'help' },
  },
  {
    name: 'merge-pr: unknown flag',
    argv: ['merge-pr', '--weird'],
    expected: { kind: 'help' },
  },
  {
    name: 'merge-pr: stray positional',
    argv: ['merge-pr', 'foo'],
    expected: { kind: 'help' },
  },
  { name: 'config: no subcommand', argv: ['config'], expected: { kind: 'help' } },
  {
    name: 'config: unknown sub',
    argv: ['config', 'wat'],
    expected: { kind: 'help' },
  },
  {
    name: 'config set: missing value',
    argv: ['config', 'set', 'foo'],
    expected: { kind: 'help' },
  },
  {
    name: 'config set: missing both',
    argv: ['config', 'set'],
    expected: { kind: 'help' },
  },
  {
    name: 'config set: extra positional',
    argv: ['config', 'set', 'a', 'b', 'c'],
    expected: { kind: 'help' },
  },
  {
    name: 'config unset: missing key',
    argv: ['config', 'unset'],
    expected: { kind: 'help' },
  },
  {
    name: 'config get: missing key',
    argv: ['config', 'get'],
    expected: { kind: 'help' },
  },
  {
    name: 'config list: stray positional',
    argv: ['config', 'list', 'oops'],
    expected: { kind: 'help' },
  },
  {
    name: 'config: unknown flag',
    argv: ['config', 'set', 'k', 'v', '--global'],
    expected: { kind: 'help' },
  },
];

for (const c of [...startCases, ...mergeCases, ...configCases, ...helpCases]) {
  test(c.name, () => {
    assert.deepEqual(parseArgs(c.argv), c.expected);
  });
}
