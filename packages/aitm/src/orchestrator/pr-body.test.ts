import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { PrGroup } from '../domain/pr-group.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import {
  assertPrBodySections,
  buildFallbackComposition,
  compositionOutcome,
  describeSubmitPayload,
  fallbackCommitSubject,
  normalizePrBodyHeadings,
  PR_BODY_GUIDE,
  PR_BODY_SECTIONS,
  prBodyGuideFor,
  recoverComposition,
  repairPrBody,
  resolveCommitMessage,
  resolvePrBodySections,
  SUBMIT_PAYLOAD_PREVIEW_CHARS,
  submitToolInput,
  submittedComposition,
  truncateAtWord,
} from './pr-body.ts';

// A PR body that satisfies the section contract (assertPrBodySections), reused across tests.
const COMPLIANT_BODY =
  '## Summary\nDid the thing.\n\n## Changes\n- a.ts: added\n\n## Testing\n- ran tests\n\n## Evidence\n- `bun test` exited 0';

// A composition the composer would produce, plus its plain JSON encoding.
const RECOVERABLE = { title: 'feat: core — add a', body: COMPLIANT_BODY };
const RECOVERABLE_JSON = JSON.stringify(RECOVERABLE);

function baseGroup(): PrGroup {
  return {
    id: 'core',
    title: 'Core',
    tasks: [
      { id: 'task-a', text: 'task A', complexity: 'normal', done: false },
      { id: 'task-b', text: 'task B', complexity: 'normal', done: false },
    ],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
  };
}

function baseDelivery(): WorkerDelivery {
  return {
    branch: 'aitm/core',
    draftCommitMessage: 'feat: add a',
    changes: [
      { path: 'src/a.ts', kind: 'create', summary: 'created a' },
      { path: 'src/b.ts', kind: 'modify', summary: 'fixed b' },
    ],
    progressEntries: ['- task A', '- task B'],
  };
}

test('PR_BODY_GUIDE defines the standard Summary/Changes/Testing/Evidence sections', () => {
  for (const heading of PR_BODY_SECTIONS) {
    assert.ok(PR_BODY_GUIDE.includes(heading), `expected guide to mention ${heading}`);
  }
});

test('resolvePrBodySections: undefined/empty → default set', () => {
  assert.deepEqual(resolvePrBodySections(undefined), PR_BODY_SECTIONS);
  assert.deepEqual(resolvePrBodySections([]), PR_BODY_SECTIONS);
});

test('resolvePrBodySections: valid custom headings are used verbatim', () => {
  const custom = ['## What', '## Why', '## Changes', '## Verification'];
  assert.deepEqual(resolvePrBodySections(custom), custom);
});

test('resolvePrBodySections: any malformed heading falls back to default', () => {
  assert.deepEqual(resolvePrBodySections(['## What', 'Why']), PR_BODY_SECTIONS);
  assert.deepEqual(resolvePrBodySections(['##NoSpace']), PR_BODY_SECTIONS);
});

test('prBodyGuideFor: default set returns the bespoke guide', () => {
  assert.equal(prBodyGuideFor(PR_BODY_SECTIONS), PR_BODY_GUIDE);
});

test('prBodyGuideFor: custom set lists each heading verbatim', () => {
  const custom = ['## What', '## Why', '## Verification'];
  const guide = prBodyGuideFor(custom);
  for (const heading of custom) assert.ok(guide.includes(heading), `missing ${heading}`);
  assert.ok(guide.includes('3 sections'));
});

test('assertPrBodySections: enforces a custom section set', () => {
  const custom = ['## What', '## Why'];
  assert.doesNotThrow(() => assertPrBodySections('## What\nx\n\n## Why\ny', custom));
  assert.throws(() => assertPrBodySections('## Summary\nx', custom), /What/);
});

test('assertPrBodySections: accepts a body with all sections in order', () => {
  assert.doesNotThrow(() => assertPrBodySections(COMPLIANT_BODY));
});

test('assertPrBodySections: rejects a missing section', () => {
  assert.throws(() => assertPrBodySections('## Summary\nx\n\n## Changes\n- a'), /Testing/);
});

test('assertPrBodySections: rejects out-of-order sections', () => {
  const reordered = '## Changes\n- a\n\n## Summary\nx\n\n## Testing\n- t';
  assert.throws(() => assertPrBodySections(reordered), /in order/);
});

test('assertPrBodySections: a section name in prose is not a heading', () => {
  // "## Testing" appears only inside Summary prose, not as its own heading line.
  const body = '## Summary\nSee `## Changes` and ## Testing notes inline.\n\n## Changes\n- a';
  assert.throws(() => assertPrBodySections(body), /Testing/);
});

test('PR_BODY_GUIDE: the Evidence section forbids unearned claims', () => {
  assert.match(PR_BODY_GUIDE, /## Evidence/);
  assert.match(PR_BODY_GUIDE, /acceptance/i);
  assert.match(PR_BODY_GUIDE, /thrown away/i);
  assert.match(PR_BODY_GUIDE, /ONLY what the/);
  assert.match(PR_BODY_GUIDE, /Nothing was run to verify this/);
  assert.match(PR_BODY_GUIDE, /never evidence/);
});

test('buildFallbackComposition: Evidence claims nothing was run and flags the check undemonstrated', () => {
  const { body } = buildFallbackComposition(
    { ...baseGroup(), acceptance: 'POST /login sets a session cookie' },
    baseDelivery(),
    PR_BODY_SECTIONS,
  );
  const evidence = body.slice(body.indexOf('## Evidence'));
  assert.match(evidence, /No verification output was captured/);
  assert.match(evidence, /POST \/login sets a session cookie/);
  assert.match(evidence, /NOT demonstrated/);
  assert.doesNotMatch(evidence, /passed|green|verified successfully/i);
});

test('buildFallbackComposition: Evidence says so when the group has no acceptance check', () => {
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  const evidence = body.slice(body.indexOf('## Evidence'));
  assert.match(evidence, /no recorded acceptance check/);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
});

function stepsWith(input: unknown) {
  return { steps: [{ toolCalls: [{ toolName: 'submit', input }] }] };
}
test('submitToolInput: returns the raw submit input, undefined when the model never submitted', () => {
  assert.equal(submitToolInput(stepsWith('"{}"')), '"{}"');
  assert.deepEqual(submitToolInput(stepsWith({ title: 't' })), { title: 't' });
  assert.equal(submitToolInput({ steps: [{ toolCalls: [] }] }), undefined);
  assert.equal(
    submitToolInput({ steps: [{ toolCalls: [{ toolName: 'other', input: 'x' }] }] }),
    undefined,
  );
});

test('recoverComposition: peels nested JSON-string envelopes up to the bound', () => {
  assert.deepEqual(recoverComposition(RECOVERABLE_JSON), RECOVERABLE);
  assert.deepEqual(recoverComposition(JSON.stringify(RECOVERABLE_JSON)), RECOVERABLE);
  assert.deepEqual(
    recoverComposition(JSON.stringify(JSON.stringify(RECOVERABLE_JSON))),
    RECOVERABLE,
  );
  // A fourth layer is past MAX_JSON_PEELS — bounded, never an unbounded unwrap loop.
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify(JSON.stringify(RECOVERABLE_JSON)))),
    undefined,
  );
});

test('recoverComposition: unwraps a ```-fenced payload with or without a trailing newline', () => {
  assert.deepEqual(recoverComposition(`\`\`\`json\n${RECOVERABLE_JSON}\n\`\`\``), RECOVERABLE);
  assert.deepEqual(recoverComposition(`\`\`\`json\n${RECOVERABLE_JSON}\`\`\``), RECOVERABLE);
  assert.deepEqual(recoverComposition(`\`\`\`\n${RECOVERABLE_JSON}\n\`\`\`\ndone!`), RECOVERABLE);
});

test('recoverComposition: extracts a JSON object embedded in narration', () => {
  assert.deepEqual(recoverComposition(`Here you go:\n${RECOVERABLE_JSON}\nThanks!`), RECOVERABLE);
});

test('recoverComposition: braces inside the body string do not truncate the object', () => {
  const braced = {
    title: 'feat: core',
    body: `${COMPLIANT_BODY}\n\nSee \`fn() { return "}"; }\`.`,
  };
  const recovered = recoverComposition(JSON.stringify(JSON.stringify(braced)));
  assert.deepEqual(recovered, braced);
});

test('recoverComposition: prose, non-strings, and schema-invalid payloads stay unrecovered', () => {
  assert.equal(recoverComposition('I could not compose this'), undefined);
  assert.equal(recoverComposition(''), undefined);
  assert.equal(recoverComposition(undefined), undefined);
  assert.equal(recoverComposition({ title: 't', body: 'b' }), undefined, 'objects are not re-read');
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify({ title: 'x'.repeat(80), body: 'b' }))),
    undefined,
    'a parsing envelope around an invalid composition is still rejected',
  );
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify({ title: 'only a title' }))),
    undefined,
    'a missing field is not filled in',
  );
});

test('submittedComposition: a valid object submission and a no-submission are passed through', () => {
  assert.deepEqual(submittedComposition(stepsWith(RECOVERABLE)), { ok: true, value: RECOVERABLE });
  assert.deepEqual(submittedComposition({ steps: [{ toolCalls: [] }] }), {
    ok: false,
    reason: 'no-submission',
  });
});

test('submittedComposition: a string envelope is recovered, a genuinely bad payload stays invalid', () => {
  assert.deepEqual(submittedComposition(stepsWith(JSON.stringify(RECOVERABLE_JSON))), {
    ok: true,
    value: RECOVERABLE,
  });
  const bad = submittedComposition(stepsWith('nothing json about this'));
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error('unreachable');
  assert.equal(bad.reason, 'invalid');
});

test('describeSubmitPayload: names the payload kind and size, truncating a long one', () => {
  assert.equal(describeSubmitPayload(undefined), '', 'no payload → no suffix');
  assert.match(
    describeSubmitPayload('prose here'),
    /^; submitted string \(10 chars\): prose here$/,
  );
  // Newlines are collapsed so the notice stays one line.
  assert.match(describeSubmitPayload('a\nb'), /: a b$/);
  const long = describeSubmitPayload('x'.repeat(SUBMIT_PAYLOAD_PREVIEW_CHARS + 50));
  assert.ok(long.endsWith('…'), 'an over-long payload is truncated');
  assert.ok(!long.includes('x'.repeat(SUBMIT_PAYLOAD_PREVIEW_CHARS + 1)));
  assert.match(
    describeSubmitPayload({ title: 't' }),
    /^; submitted object \(\d+ chars\): \{"title/,
  );
});

test('compositionOutcome: the schema-failure reason quotes the offending payload when given', () => {
  const parsed = z.object({ title: z.string() }).safeParse('a string, not an object');
  if (parsed.success) throw new Error('expected a validation failure');
  const withPayload = compositionOutcome(
    { ok: false, reason: 'invalid', issues: parsed.error.issues },
    PR_BODY_SECTIONS,
    'a string, not an object',
  );
  assert.equal(withPayload.ok, false);
  if (withPayload.ok) throw new Error('unreachable');
  assert.match(withPayload.reason, /failed schema validation/);
  assert.match(withPayload.reason, /submitted string \(23 chars\): a string, not an object/);
  // The model-facing correction already restates the issues — it must not grow the payload echo.
  assert.doesNotMatch(withPayload.correction, /submitted string/);
});

test('compositionOutcome: a no-submission reason is never decorated with a payload', () => {
  const outcome = compositionOutcome({ ok: false, reason: 'no-submission' }, PR_BODY_SECTIONS, 'x');
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.doesNotMatch(outcome.reason, /submitted string/);
});

test('compositionOutcome: valid submission with a compliant body → ok', () => {
  const outcome = compositionOutcome(
    { ok: true, value: { title: 'feat: core', body: COMPLIANT_BODY } },
    PR_BODY_SECTIONS,
  );
  assert.deepEqual(outcome, { ok: true, value: { title: 'feat: core', body: COMPLIANT_BODY } });
});

test('compositionOutcome: no-submission → reason + a submit corrective', () => {
  const outcome = compositionOutcome({ ok: false, reason: 'no-submission' }, PR_BODY_SECTIONS);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /did not submit a PR composition/);
  assert.match(outcome.correction, /submit/i);
});

test('compositionOutcome: schema-invalid → reason quotes issues, corrective asks for a resubmit', () => {
  const issues = z.string().max(72).safeParse('x'.repeat(80));
  if (issues.success) throw new Error('expected a validation failure');
  const outcome = compositionOutcome(
    { ok: false, reason: 'invalid', issues: issues.error.issues },
    PR_BODY_SECTIONS,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /failed schema validation/);
  assert.match(outcome.correction, /failed schema validation/);
});

test('compositionOutcome: valid submission with a non-compliant body → section corrective', () => {
  const outcome = compositionOutcome(
    { ok: true, value: { title: 'feat: core', body: '## Summary\nonly this' } },
    PR_BODY_SECTIONS,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /heading lines/);
  assert.match(outcome.correction, /submit/i);
});

test('truncateAtWord: input at or under max is returned unchanged', () => {
  assert.equal(truncateAtWord('feat: core', 72), 'feat: core');
  assert.equal(truncateAtWord('x'.repeat(72), 72), 'x'.repeat(72));
});

test('truncateAtWord: retreats to the last word boundary, never mid-word, result ≤ max', () => {
  const out = truncateAtWord('feat: add the observability and caching subsystems today', 30);
  assert.ok(out.length <= 30, 'result respects max');
  assert.ok(!out.endsWith(' '), 'no trailing space');
  assert.equal(out, 'feat: add the observability');
});

test('truncateAtWord: a single word longer than max is hard-sliced to max', () => {
  const out = truncateAtWord('x'.repeat(100), 72);
  assert.equal(out.length, 72);
  assert.equal(out, 'x'.repeat(72));
});

test('buildFallbackComposition: title is feat:<group.title>, capped ≤72 on a word boundary', () => {
  const { title } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  assert.equal(title, 'feat: Core');
  const longTitleGroup = { ...baseGroup(), title: 'add '.repeat(40).trim() };
  const long = buildFallbackComposition(longTitleGroup, baseDelivery(), PR_BODY_SECTIONS);
  assert.ok(long.title.length <= 72, 'a long group title is capped to 72');
  assert.ok(long.title.startsWith('feat: add'), 'the title keeps the feat: prefix and subject');
});

test('buildFallbackComposition: empty group.title falls back to the group id', () => {
  const { title } = buildFallbackComposition(
    { ...baseGroup(), title: '   ' },
    baseDelivery(),
    PR_BODY_SECTIONS,
  );
  assert.equal(title, 'feat: core');
});

test('fallbackCommitSubject: feat:<group.title>, id when blank, capped ≤72 on a word boundary', () => {
  assert.equal(fallbackCommitSubject(baseGroup()), 'feat: Core');
  assert.equal(fallbackCommitSubject({ ...baseGroup(), title: '   ' }), 'feat: core');
  const long = fallbackCommitSubject({ ...baseGroup(), title: 'add '.repeat(40).trim() });
  assert.ok(long.length <= 72, 'a long title is capped to 72');
  assert.ok(long.startsWith('feat: add'), 'the feat: prefix and subject survive the cap');
});

test('resolveCommitMessage: a non-empty refined message is used verbatim', () => {
  const msg = 'feat(core): add module a\n\nAdds a and fixes b.';
  assert.equal(resolveCommitMessage(msg, baseGroup(), baseDelivery()), msg);
});

test('resolveCommitMessage: a wrapping code fence is stripped from the refined message', () => {
  const fenced = '```\nfeat(core): add module a\n```';
  assert.equal(
    resolveCommitMessage(fenced, baseGroup(), baseDelivery()),
    'feat(core): add module a',
  );
  const tagged = '```text\nfeat(core): add module a\n```';
  assert.equal(
    resolveCommitMessage(tagged, baseGroup(), baseDelivery()),
    'feat(core): add module a',
  );
});

test('resolveCommitMessage: an empty or whitespace-only refined message falls back to the draft', () => {
  const delivery = { ...baseDelivery(), draftCommitMessage: 'feat: add a' };
  assert.equal(resolveCommitMessage('', baseGroup(), delivery), 'feat: add a');
  assert.equal(resolveCommitMessage('   \n\t', baseGroup(), delivery), 'feat: add a');
});

test('resolveCommitMessage: a fence with an empty body falls back to the draft', () => {
  const delivery = { ...baseDelivery(), draftCommitMessage: 'feat: add a' };
  assert.equal(resolveCommitMessage('```\n\n```', baseGroup(), delivery), 'feat: add a');
});

test('resolveCommitMessage: empty refined AND empty draft falls back to the deterministic subject', () => {
  const delivery = { ...baseDelivery(), draftCommitMessage: '   ' };
  assert.equal(resolveCommitMessage('', baseGroup(), delivery), 'feat: Core');
  // Never empty — the whole point of the total fallback (no `git commit --amend -m ''`).
  assert.notEqual(resolveCommitMessage('', baseGroup(), delivery).trim(), '');
});

test('buildFallbackComposition: body passes assertPrBodySections for the default section set', () => {
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
  // The Changes section groups paths by directory and lists the change-kind — it never echoes the
  // raw (often noisy) editor summaries.
  assert.match(body, /- \*\*src\/\*\* — create a\.ts; modify b\.ts/);
});

test('buildFallbackComposition: body passes assertPrBodySections for a custom section set', () => {
  const custom = ['## What', '## Why', '## Verification'];
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), custom);
  assert.doesNotThrow(() => assertPrBodySections(body, custom));
});

test('buildFallbackComposition: an empty change set still yields a valid, non-empty Changes section', () => {
  const delivery = { ...baseDelivery(), changes: [] };
  const { body } = buildFallbackComposition(baseGroup(), delivery, PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
});

test('buildFallbackComposition: a noisy change summary is dropped, never echoed or able to inject a heading', () => {
  // The fallback builds the Changes list from path + kind only; the raw summary (which can carry
  // newlines, agent self-talk, or a smuggled `##` heading) is never placed in the body.
  const delivery = {
    ...baseDelivery(),
    changes: [{ path: 'src/a.ts', kind: 'modify' as const, summary: 'line1\n## Testing\nline2' }],
  };
  const { body } = buildFallbackComposition(baseGroup(), delivery, PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
  const testingHeadings = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l === '## Testing');
  assert.equal(testingHeadings.length, 1, 'no smuggled heading from the summary');
  assert.ok(!body.includes('line1'), 'the raw summary text is dropped, not echoed');
});

test('normalizePrBodyHeadings: near-miss markup is rewritten to the canonical heading', () => {
  // Models get the SECTIONS right and the markup wrong. Rejecting `### Changes` used to discard an
  // otherwise good body in favour of a generated stub — a far worse PR than a fixed `#`.
  const body = [
    '# Summary',
    's',
    '### Changes:',
    'c',
    '## **Testing**',
    't',
    '## Evidence',
    'e',
  ].join('\n');
  const out = normalizePrBodyHeadings(body, PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(out, PR_BODY_SECTIONS));
});

test('normalizePrBodyHeadings: a non-heading line naming a section is left alone', () => {
  // Only heading lines are rewritten, so prose mentioning "Changes" cannot fabricate a section.
  const body = 'We discuss Changes here.\n## Summary\ns';
  assert.match(normalizePrBodyHeadings(body, PR_BODY_SECTIONS), /^We discuss Changes here\./);
});

test('repairPrBody: keeps the model prose and fills only the missing section', () => {
  // The failure this exists for: a real run where 2 of 2 PR bodies were thrown away because one
  // heading of four was absent, and both PRs shipped a generated stub instead.
  const body = ['## Summary', 'Adds the todo route.', '## Testing', 'bun test — 45 pass'].join(
    '\n',
  );
  const repaired = repairPrBody(body, PR_BODY_SECTIONS, baseGroup(), baseDelivery());
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  assert.match(repaired, /Adds the todo route\./, "the model's Summary survives");
  assert.match(repaired, /bun test — 45 pass/, "the model's Testing survives");
});

test('repairPrBody: reorders sections the model emitted out of order', () => {
  const body = ['## Testing', 't', '## Summary', 's', '## Evidence', 'e', '## Changes', 'c'].join(
    '\n',
  );
  const repaired = repairPrBody(body, PR_BODY_SECTIONS, baseGroup(), baseDelivery());
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  const order = repaired
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .slice(0, 4);
  assert.deepEqual(order, [...PR_BODY_SECTIONS]);
});

test('repairPrBody: prose before the first heading is folded in, never dropped', () => {
  const repaired = repairPrBody(
    'An intro the model wrote first.\n## Changes\nc',
    PR_BODY_SECTIONS,
    baseGroup(),
    baseDelivery(),
  );
  assert.match(repaired, /An intro the model wrote first\./);
});

test('repairPrBody: an unrequested section is folded in, not appended as a duplicate tail', () => {
  // An unrecognized heading's content is kept — folded into the section before it — rather than
  // re-emitted as a trailing block. The trailing-block behavior was the doubled-PR-body bug: a model
  // that mashed content onto every heading line made every section read as "unrecognized", so the
  // whole body was dumped after the deterministic fill. Content is preserved once, never duplicated.
  const body = ['## Summary', 's', '## Risks', 'this ships behind a flag'].join('\n');
  const repaired = repairPrBody(body, PR_BODY_SECTIONS, baseGroup(), baseDelivery());
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  assert.match(repaired, /this ships behind a flag/, 'the extra content survives');
  // "Risks" folds into a required section; the body has exactly the required `## `-level headings.
  const h2 = repaired
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^## \S/.test(l));
  assert.deepEqual(h2, [...PR_BODY_SECTIONS]);
});

test('repairPrBody: an empty section gets generated content, never a bare heading', () => {
  const repaired = repairPrBody(
    '## Summary\n\n## Changes\n\n',
    PR_BODY_SECTIONS,
    baseGroup(),
    baseDelivery(),
  );
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  for (const heading of PR_BODY_SECTIONS) {
    const after = repaired.slice(repaired.indexOf(heading) + heading.length).trimStart();
    assert.ok(after !== '' && !after.startsWith('## '), `${heading} has content`);
  }
});

test('compositionOutcome: a body that is only mis-marked passes without a retry', () => {
  const submitted = {
    ok: true as const,
    value: {
      title: 'feat: x',
      body: ['### Summary', 's', '### Changes', 'c', '### Testing', 't', '### Evidence', 'e'].join(
        '\n',
      ),
    },
  };
  const outcome = compositionOutcome(submitted, PR_BODY_SECTIONS);
  assert.equal(outcome.ok, true);
});

test('compositionOutcome: a section-contract failure still carries the body forward for repair', () => {
  // Without this the composePr retry loop has nothing to repair at exhaustion and falls back to the
  // stub, which is exactly the behaviour being replaced.
  const submitted = {
    ok: true as const,
    value: { title: 'feat: x', body: '## Summary\ns' },
  };
  const outcome = compositionOutcome(submitted, PR_BODY_SECTIONS);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.submitted?.body, '## Summary\ns');
});

test('normalizePrBodyHeadings: a heading quoted inside a code fence is left untouched', () => {
  // This project's own docs PR quotes `## Testing` inside a fenced block; that must not be rewritten
  // or promoted to a real section.
  const body = ['## Summary', 's', '```md', '## Changes', 'not a real heading', '```'].join('\n');
  const out = normalizePrBodyHeadings(body, PR_BODY_SECTIONS);
  assert.match(out, /```md\n## Changes\nnot a real heading\n```/, 'fenced heading is verbatim');
});

test('assertPrBodySections: a fenced ## line does not satisfy the section contract', () => {
  // A body whose only "Changes" is inside a code block is genuinely missing the section.
  const body = [
    '## Summary',
    's',
    '```',
    '## Changes',
    '```',
    '## Testing',
    't',
    '## Evidence',
    'e',
  ].join('\n');
  assert.throws(
    () => assertPrBodySections(body, PR_BODY_SECTIONS),
    /missing or misordered: ## Changes/,
  );
});

test('repairPrBody: a fenced ## line stays inside its section, never splits it', () => {
  // The Changes section legitimately contains a diff that quotes `## Testing`; splitBodyBlocks must
  // keep that fragment in Changes rather than routing it into the real Testing bucket.
  const body = [
    '## Summary',
    's',
    '## Changes',
    'Rewrote the docs, e.g.:',
    '```diff',
    '+## Testing',
    '+run bun test',
    '```',
    '## Testing',
    'the real testing note',
    '## Evidence',
    'e',
  ].join('\n');
  const repaired = repairPrBody(body, PR_BODY_SECTIONS, baseGroup(), baseDelivery());
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  // The quoted diff stays under Changes; the real Testing content is the one the model wrote.
  const changesIdx = repaired.indexOf('## Changes');
  const testingIdx = repaired.indexOf('## Testing');
  const fencedIdx = repaired.indexOf('+## Testing');
  assert.ok(changesIdx < fencedIdx && fencedIdx < testingIdx, 'fenced heading stays in Changes');
  assert.match(repaired, /## Testing\nthe real testing note/);
});

test('repairPrBody: a body with content mashed onto every heading line is not doubled (PR #6 regression)', () => {
  // Observed on a real run: glm-5.2 ran each section's content onto its heading line
  // (`## Summary Adds cookie auth`, `## Changes### Domain`). Every heading then read as unrecognized,
  // and the old repair re-emitted the whole body after the deterministic fill — a doubled PR body
  // with the generated stub AND the model's prose. The run-on split now recovers the real sections.
  const body = [
    '## Summary Adds full cookie-based session authentication with argon2id.',
    '## Changes### Domain & DB- add User and Session types- add users/sessions tables',
    '## Testing All changes verified via bun test.',
    '## Evidence bun test — all unit tests pass.',
  ].join('\n');
  const repaired = repairPrBody(body, PR_BODY_SECTIONS, baseGroup(), baseDelivery());
  assert.doesNotThrow(() => assertPrBodySections(repaired, PR_BODY_SECTIONS));
  // Each required heading appears exactly once — no duplicate, no generated-stub cruft.
  for (const heading of PR_BODY_SECTIONS) {
    const count = repaired.split('\n').filter((l) => l.trim() === heading).length;
    assert.equal(count, 1, `${heading} appears exactly once, got ${count}`);
  }
  assert.doesNotMatch(repaired, /Auto-generated composition/, 'no fallback stub leaked in');
  assert.match(
    repaired,
    /Adds full cookie-based session authentication/,
    "the model's summary survives",
  );
  assert.match(repaired, /add User and Session types/, "the model's changes survive under Changes");
});

// The `git commit --amend` seam is a chokepoint like GitHubClient's: without a deadline a wedged
// index lock stalls the group forever, and without the run signal a SIGINT orphans the child.
