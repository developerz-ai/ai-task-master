import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PlanMarkdownGroup, parsePlanMarkdown, renderPlanMarkdown } from './plan-markdown.ts';

const SAMPLE: PlanMarkdownGroup[] = [
  {
    title: 'models',
    tasks: [
      { text: 'add User', complexity: 'normal', done: true },
      { text: 'add Session', complexity: 'complex', done: false },
    ],
  },
  {
    title: 'routes',
    tasks: [{ text: 'POST /login', complexity: 'simple', done: false }],
  },
];

test('plan-markdown: render then parse → identical groups', () => {
  const result = parsePlanMarkdown(renderPlanMarkdown(SAMPLE));
  assert.deepEqual(result.groups, SAMPLE);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: render emits Group headers with checkbox + uppercase complexity', () => {
  assert.equal(
    renderPlanMarkdown(SAMPLE),
    [
      '## Group: models',
      '- [x] [NORMAL] add User',
      '- [ ] [COMPLEX] add Session',
      '',
      '## Group: routes',
      '- [ ] [SIMPLE] POST /login',
    ].join('\n'),
  );
});

test('plan-markdown: parse defaults a missing complexity tag to normal', () => {
  const result = parsePlanMarkdown('## Group: g\n- [ ] do a thing');
  assert.deepEqual(result.groups, [
    { title: 'g', tasks: [{ text: 'do a thing', complexity: 'normal', done: false }] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: parse reads [x] as done', () => {
  const result = parsePlanMarkdown('## Group: g\n- [x] [SIMPLE] shipped');
  assert.equal(result.groups[0]?.tasks[0]?.done, true);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: parse lowercases complexity case-insensitively', () => {
  const result = parsePlanMarkdown('## Group: g\n- [ ] [Complex] big one');
  assert.equal(result.groups[0]?.tasks[0]?.complexity, 'complex');
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: parse falls back to normal on an unknown complexity tag', () => {
  const result = parsePlanMarkdown('## Group: g\n- [ ] [HUGE] mystery');
  assert.equal(result.groups[0]?.tasks[0]?.complexity, 'normal');
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]?.message ?? '', /unknown complexity tag/);
});

test('plan-markdown: parse ignores blank lines and non-task prose', () => {
  const md = ['## Group: g', '', 'some prose', '- [ ] [NORMAL] real task', ''].join('\n');
  const result = parsePlanMarkdown(md);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0]?.tasks, [
    { text: 'real task', complexity: 'normal', done: false },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: round-trips task text containing brackets', () => {
  const groups: PlanMarkdownGroup[] = [
    { title: 'g', tasks: [{ text: 'fix [bug] in parser', complexity: 'normal', done: false }] },
  ];
  const result = parsePlanMarkdown(renderPlanMarkdown(groups));
  assert.deepEqual(result.groups, groups);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: round-trips an empty list and an empty group', () => {
  const result1 = parsePlanMarkdown(renderPlanMarkdown([]));
  assert.deepEqual(result1.groups, []);
  assert.deepEqual(result1.diagnostics, []);
  const emptyGroup: PlanMarkdownGroup[] = [{ title: 'later', tasks: [] }];
  const result2 = parsePlanMarkdown(renderPlanMarkdown(emptyGroup));
  assert.deepEqual(result2.groups, emptyGroup);
  assert.deepEqual(result2.diagnostics, []);
});

test('plan-markdown: parse tolerates a trailing newline from the file write', () => {
  const result = parsePlanMarkdown(`${renderPlanMarkdown(SAMPLE)}\n`);
  assert.deepEqual(result.groups, SAMPLE);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: parse tolerates CRLF line endings', () => {
  const result = parsePlanMarkdown('## Group: g\r\n- [x] [NORMAL] done it\r\n');
  assert.deepEqual(result.groups, [
    { title: 'g', tasks: [{ text: 'done it', complexity: 'normal', done: true }] },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('plan-markdown: surfaces orphaned tasks appearing before any group', () => {
  const result = parsePlanMarkdown('- [ ] [NORMAL] orphan task\n## Group: g\n- [ ] real task');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.tasks.length, 1);
  assert.equal(result.groups[0]?.tasks[0]?.text, 'real task');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.line, 1);
  assert.match(result.diagnostics[0]?.message ?? '', /task appears before any group heading/);
});

test('plan-markdown: surfaces multiple orphaned tasks', () => {
  const md = ['- [ ] orphan 1', '- [ ] orphan 2', '## Group: g', '- [ ] real task'].join('\n');
  const result = parsePlanMarkdown(md);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.tasks.length, 1);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0]?.line, 1);
  assert.equal(result.diagnostics[1]?.line, 2);
});

test('plan-markdown: surfaces unknown complexity tag with diagnostic', () => {
  const result = parsePlanMarkdown('## Group: g\n- [ ] [MASSIVE] big task');
  assert.equal(result.groups[0]?.tasks[0]?.complexity, 'normal');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.line, 2);
  assert.match(result.diagnostics[0]?.message ?? '', /unknown complexity tag.*MASSIVE/);
  assert.match(result.diagnostics[0]?.message ?? '', /fell back to "normal"/);
});

test('plan-markdown: does not diagnose known complexity tags', () => {
  const md = [
    '## Group: g',
    '- [ ] [simple] task 1',
    '- [ ] [NORMAL] task 2',
    '- [ ] [Complex] task 3',
  ].join('\n');
  const result = parsePlanMarkdown(md);
  assert.equal(result.groups[0]?.tasks.length, 3);
  assert.deepEqual(result.diagnostics, []);
});
