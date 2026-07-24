import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed, GhCliMissing, GhCommandFailed, MergeConflict } from './errors.ts';

test('errors: the marker errors are Error subclasses carrying their own name → instanceof + name', () => {
  for (const [make, name] of [
    [(m?: string) => new CiFailed(m), 'CiFailed'],
    [(m?: string) => new GhCliMissing(m), 'GhCliMissing'],
    [(m?: string) => new MergeConflict(m), 'MergeConflict'],
  ] as const) {
    const err = make('boom');
    assert.ok(err instanceof Error, `${name} is an Error`);
    assert.equal(err.name, name);
    assert.equal(err.message, 'boom');
  }
});

test('errors: marker error name is a fixed own property, not overwritable via message → name unchanged', () => {
  // `name` is declared `override readonly` so a throw is always identifiable by class; a message can
  // never masquerade as a different error name.
  const err = new CiFailed('MergeConflict: nope');
  assert.equal(err.name, 'CiFailed');
});

test('errors: GhCommandFailed formats `<command> failed: <stderr>` and carries structured fields', () => {
  const err = new GhCommandFailed('gh pr view', {
    stderr: 'HTTP 404',
    stdout: '',
    exitCode: 1,
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'GhCommandFailed');
  assert.equal(err.message, 'gh pr view failed: HTTP 404');
  assert.equal(err.command, 'gh pr view');
  assert.equal(err.exitCode, 1);
  assert.equal(err.stderr, 'HTTP 404');
});

test('errors: GhCommandFailed falls back to stdout when stderr is blank → message uses stdout', () => {
  // gh writes some failure detail to stdout (e.g. a JSON error body) with an empty stderr; the
  // message must still name a reason rather than trail off after `failed:`.
  const err = new GhCommandFailed('gh pr checks', {
    stderr: '   ',
    stdout: 'no checks reported',
    exitCode: 8,
  });
  assert.equal(err.message, 'gh pr checks failed: no checks reported');
  assert.equal(err.exitCode, 8);
  // The raw (untrimmed) stderr is preserved on the field even though the message trims for display.
  assert.equal(err.stderr, '   ');
});

test('errors: GhCommandFailed trims stderr for the message but keeps the raw field', () => {
  const err = new GhCommandFailed('git rev-parse', {
    stderr: '  fatal: not a git repository\n',
    stdout: '',
    exitCode: 128,
  });
  assert.equal(err.message, 'git rev-parse failed: fatal: not a git repository');
  assert.equal(err.stderr, '  fatal: not a git repository\n');
  assert.equal(err.command, 'git rev-parse');
});

test('errors: GhCommandFailed with no output → message ends after `failed:` and stderr is empty', () => {
  const err = new GhCommandFailed('gh api user', { stderr: '', stdout: '', exitCode: 1 });
  assert.equal(err.message, 'gh api user failed: ');
  assert.equal(err.stderr, '');
});
