import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillToolInput, SkillToolOutput } from './skill-tool.ts';
import { SKILL_INVOCATION_CONTRACT, skillIndexBlock, skillTool } from './skill-tool.ts';
import type { SkillDefinition } from './skills-loader.ts';

function skill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    name: partial.name,
    description: partial.description ?? `desc for ${partial.name}`,
    body: partial.body ?? `body for ${partial.name}`,
    path: partial.path ?? `/repo/.claude/skills/${partial.name}/SKILL.md`,
    extra: partial.extra ?? {},
  };
}

function runExec(t: { execute?: unknown }, input: SkillToolInput): SkillToolOutput {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (
    exec as (i: SkillToolInput, o: { toolCallId: string; messages: never[] }) => SkillToolOutput
  )(input, { toolCallId: 'c', messages: [] });
}

function textOf(
  t: { toModelOutput?: unknown },
  input: SkillToolInput,
  output: SkillToolOutput,
): string {
  const fn = t.toModelOutput;
  if (typeof fn !== 'function') throw new Error('tool has no toModelOutput');
  const part = (
    fn as (o: { toolCallId: string; input: SkillToolInput; output: SkillToolOutput }) => {
      type: string;
      value: string;
    }
  )({ toolCallId: 'c', input, output });
  assert.equal(part.type, 'text');
  return part.value;
}

test('skillIndexBlock: contract preamble + one line per invocable skill; disabled excluded (issue #120)', () => {
  const block = skillIndexBlock([
    skill({ name: 'repo-recon', description: 'map a repo before editing' }),
    skill({
      name: 'secret',
      description: 'hidden',
      extra: { 'disable-model-invocation': 'true' },
    }),
  ]);
  assert.ok(block.startsWith(SKILL_INVOCATION_CONTRACT), 'the invocation contract is the preamble');
  assert.match(block, /<skills>\nrepo-recon: map a repo before editing\n<\/skills>/);
  assert.equal(block.includes('secret'), false, 'disable-model-invocation excludes from the index');
});

test('skillIndexBlock: collapses a multi-line description to a single index line (issue #120)', () => {
  const block = skillIndexBlock([skill({ name: 'x', description: 'line one\nline two' })]);
  assert.match(block, /x: line one line two/);
  assert.equal(
    block.split('\n').filter((l) => l.startsWith('x:')).length,
    1,
    'exactly one line for the skill',
  );
});

test('skillIndexBlock: empty or all-disabled input renders nothing (issue #120)', () => {
  assert.equal(skillIndexBlock([]), '');
  assert.equal(
    skillIndexBlock([skill({ name: 'z', extra: { 'disable-model-invocation': 'true' } })]),
    '',
  );
});

test('skillTool: a valid name returns the skill body and path, rendered as plain text (issue #120)', () => {
  const t = skillTool([
    skill({
      name: 'triage',
      body: 'read logs bottom-up',
      path: '/r/.claude/skills/triage/SKILL.md',
    }),
  ]);
  const out = runExec(t, { skill: 'triage' });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.body, 'read logs bottom-up');
  assert.equal(out.path, '/r/.claude/skills/triage/SKILL.md');
  const text = textOf(t, { skill: 'triage' }, out);
  assert.match(text, /^Skill: triage/);
  assert.match(text, /read logs bottom-up/);
  assert.ok(text.includes('/r/.claude/skills/triage/SKILL.md'), 'result carries the path');
  assert.match(text, /read them on demand with the Read tool/);
});

test('skillTool: an unknown name returns an error naming the available skills — never throws (issue #120)', () => {
  const t = skillTool([skill({ name: 'a' }), skill({ name: 'b' })]);
  const out = runExec(t, { skill: 'nope' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /Unknown skill "nope"/);
  assert.match(out.error, /Available skills: a, b/);
  assert.equal(
    textOf(t, { skill: 'nope' }, out),
    out.error,
    'the error text is what the model sees',
  );
});

test('skillTool: a disabled skill is not in the matchable set (issue #120)', () => {
  const t = skillTool([skill({ name: 'secret', extra: { 'disable-model-invocation': 'true' } })]);
  const out = runExec(t, { skill: 'secret' });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /Available skills: \(none available\)/);
});

test('skillTool: args are echoed into the result and its rendering (issue #120)', () => {
  const t = skillTool([skill({ name: 'triage', body: 'B' })]);
  const input = { skill: 'triage', args: 'job=e2e' };
  const out = runExec(t, input);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.args, 'job=e2e');
  assert.match(textOf(t, input, out), /Arguments: job=e2e/);
});
