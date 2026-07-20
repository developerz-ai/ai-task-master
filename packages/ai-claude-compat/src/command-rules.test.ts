import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CommandRule, evaluateCommand } from './command-rules.ts';

// The built-in destructive-push/merge defaults (aitm appends these after any configured rules).
const DEFAULTS: CommandRule[] = [
  { pattern: 'git push --force*', action: 'deny' },
  { pattern: 'git push -f', action: 'deny' },
  { pattern: 'git push +*', action: 'deny' },
  { pattern: 'gh pr merge', action: 'deny' },
  { pattern: 'git reset --hard', action: 'deny' },
];

test('evaluateCommand: allows a command that matches no rule (default-allow)', () => {
  assert.deepEqual(evaluateCommand('git status', DEFAULTS), { denied: false });
  assert.deepEqual(evaluateCommand('git push origin main', DEFAULTS), { denied: false });
  assert.deepEqual(evaluateCommand('', DEFAULTS), { denied: false });
});

test('evaluateCommand: denies a direct match and reports the pattern', () => {
  assert.deepEqual(evaluateCommand('git push --force', DEFAULTS), {
    denied: true,
    pattern: 'git push --force*',
  });
  assert.deepEqual(evaluateCommand('gh pr merge 42', DEFAULTS), {
    denied: true,
    pattern: 'gh pr merge',
  });
  assert.deepEqual(evaluateCommand('git reset --hard HEAD~1', DEFAULTS), {
    denied: true,
    pattern: 'git reset --hard',
  });
});

test('evaluateCommand: flag reordering does not evade (subsequence match anchored at token 0)', () => {
  assert.equal(evaluateCommand('git push origin main --force', DEFAULTS).denied, true);
});

test('evaluateCommand: --force* also catches --force-with-lease on the model-facing side', () => {
  assert.equal(evaluateCommand('git push --force-with-lease', DEFAULTS).denied, true);
});

test('evaluateCommand: a leading env-assignment prefix is skipped before matching', () => {
  assert.equal(evaluateCommand('GIT_TRACE=1 git push --force', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('A=1 B=2 git push -f', DEFAULTS).denied, true);
});

test('evaluateCommand: the env / command builtins do not evade a deny rule (#191)', () => {
  assert.equal(evaluateCommand('env git push --force', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('command git push --force', DEFAULTS).denied, true);
  // env-assignment after the builtin is still skipped.
  assert.equal(evaluateCommand('env GIT_TRACE=1 git push -f', DEFAULTS).denied, true);
  // The POSIX `--` end-of-options separator after a wrapper still resolves the real command.
  assert.equal(evaluateCommand('env -- git push --force', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('command -- git push --force', DEFAULTS).denied, true);
  // A bare env/command with no real command matches nothing (default-allow).
  assert.equal(evaluateCommand('env', DEFAULTS).denied, false);
  assert.equal(evaluateCommand('command', DEFAULTS).denied, false);
});

test('evaluateCommand: an absolute or relative path to the command does not evade (#191)', () => {
  assert.deepEqual(evaluateCommand('/usr/bin/git push --force', DEFAULTS), {
    denied: true,
    pattern: 'git push --force*',
  });
  assert.equal(evaluateCommand('./git push -f', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('/usr/local/bin/gh pr merge 42', DEFAULTS).denied, true);
  // Only the command token is basename-normalized: a path-prefixed benign subcommand still runs.
  assert.equal(evaluateCommand('/usr/bin/git status', DEFAULTS).denied, false);
});

test('evaluateCommand: a denied subcommand anywhere in a compound denies the whole call', () => {
  assert.equal(evaluateCommand('echo ok && git push --force', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('git status; git push -f', DEFAULTS).denied, true);
  assert.equal(evaluateCommand('cat x | gh pr merge', DEFAULTS).denied, true);
  // Both benign → allowed.
  assert.equal(evaluateCommand('git add -A && git commit -m x', DEFAULTS).denied, false);
});

test('evaluateCommand: a +refspec push is denied by the +* default', () => {
  assert.deepEqual(evaluateCommand('git push origin +main', DEFAULTS), {
    denied: true,
    pattern: 'git push +*',
  });
});

test('evaluateCommand: first-match-wins — an earlier allow overrides a later default deny', () => {
  const rules: CommandRule[] = [
    { pattern: 'git push --force-with-lease', action: 'allow' },
    ...DEFAULTS,
  ];
  // The allow matches first, so the --force* deny never fires.
  assert.deepEqual(evaluateCommand('git push --force-with-lease', rules), { denied: false });
  // A plain --force still hits the deny (the allow doesn't match it).
  assert.equal(evaluateCommand('git push --force', rules).denied, true);
});

test('evaluateCommand: matching is case-sensitive', () => {
  assert.equal(evaluateCommand('GIT PUSH --force', DEFAULTS).denied, false);
});

test('evaluateCommand: a dangerous string quoted as one argument does not match', () => {
  // The quoted span is a single token, so `push --force` here is an argument to `commit`, not a
  // `git push`. Guardrail semantics: the token sequence, not substring, is what matches.
  assert.equal(evaluateCommand('git commit -m "push --force"', DEFAULTS).denied, false);
});

test('evaluateCommand: command substitution is matched literally, not expanded (honesty clause)', () => {
  // `$(…)` is not a compound operator and is not expanded — a documented evasion limit.
  assert.equal(evaluateCommand('echo $(git push --force)', DEFAULTS).denied, false);
});
