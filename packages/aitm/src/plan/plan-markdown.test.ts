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
  assert.deepEqual(parsePlanMarkdown(renderPlanMarkdown(SAMPLE)), SAMPLE);
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
  assert.deepEqual(parsePlanMarkdown('## Group: g\n- [ ] do a thing'), [
    { title: 'g', tasks: [{ text: 'do a thing', complexity: 'normal', done: false }] },
  ]);
});

test('plan-markdown: parse reads [x] as done', () => {
  const groups = parsePlanMarkdown('## Group: g\n- [x] [SIMPLE] shipped');
  assert.equal(groups[0]?.tasks[0]?.done, true);
});

test('plan-markdown: parse lowercases complexity case-insensitively', () => {
  const groups = parsePlanMarkdown('## Group: g\n- [ ] [Complex] big one');
  assert.equal(groups[0]?.tasks[0]?.complexity, 'complex');
});

test('plan-markdown: parse falls back to normal on an unknown complexity tag', () => {
  const groups = parsePlanMarkdown('## Group: g\n- [ ] [HUGE] mystery');
  assert.equal(groups[0]?.tasks[0]?.complexity, 'normal');
});

test('plan-markdown: parse ignores blank lines and non-task prose', () => {
  const md = ['## Group: g', '', 'some prose', '- [ ] [NORMAL] real task', ''].join('\n');
  const groups = parsePlanMarkdown(md);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.tasks, [{ text: 'real task', complexity: 'normal', done: false }]);
});

test('plan-markdown: round-trips task text containing brackets', () => {
  const groups: PlanMarkdownGroup[] = [
    { title: 'g', tasks: [{ text: 'fix [bug] in parser', complexity: 'normal', done: false }] },
  ];
  assert.deepEqual(parsePlanMarkdown(renderPlanMarkdown(groups)), groups);
});

test('plan-markdown: round-trips an empty list and an empty group', () => {
  assert.deepEqual(parsePlanMarkdown(renderPlanMarkdown([])), []);
  const emptyGroup: PlanMarkdownGroup[] = [{ title: 'later', tasks: [] }];
  assert.deepEqual(parsePlanMarkdown(renderPlanMarkdown(emptyGroup)), emptyGroup);
});

test('plan-markdown: parse tolerates a trailing newline from the file write', () => {
  assert.deepEqual(parsePlanMarkdown(`${renderPlanMarkdown(SAMPLE)}\n`), SAMPLE);
});

test('plan-markdown: parse tolerates CRLF line endings', () => {
  assert.deepEqual(parsePlanMarkdown('## Group: g\r\n- [x] [NORMAL] done it\r\n'), [
    { title: 'g', tasks: [{ text: 'done it', complexity: 'normal', done: true }] },
  ]);
});
