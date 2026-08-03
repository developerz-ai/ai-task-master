import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogModel } from '../testing/domain-fixtures.ts';
import type { OpenRouterModel } from './client.ts';
import {
  matchReferenceModel,
  OPENROUTER_REFERENCE_URL,
  OpenRouterReferenceCatalog,
} from './reference-catalog.ts';

// Shaped like the real catalog: org-qualified ids, one `~` alias, one near-miss family member.
const CATALOG: OpenRouterModel[] = [
  catalogModel({ id: 'z-ai/glm-5.2' }),
  catalogModel({ id: 'z-ai/glm-5' }),
  catalogModel({ id: 'z-ai/glm-5-turbo' }),
  catalogModel({ id: 'z-ai/glm-5v-turbo' }),
  catalogModel({ id: 'moonshotai/kimi-k3' }),
  catalogModel({ id: '~moonshotai/kimi-latest' }),
  catalogModel({ id: 'openai/gpt-5' }),
];

test('matchReferenceModel: an org-stripped id finds its org-qualified entry', () => {
  // The subscription case: the endpoint calls the model `glm-5.2`, OpenRouter files it under z-ai/.
  assert.equal(matchReferenceModel('glm-5.2', CATALOG)?.id, 'z-ai/glm-5.2');
  assert.equal(matchReferenceModel('glm-5-turbo', CATALOG)?.id, 'z-ai/glm-5-turbo');
});

test('matchReferenceModel: a fully-qualified id matches verbatim', () => {
  assert.equal(matchReferenceModel('z-ai/glm-5.2', CATALOG)?.id, 'z-ai/glm-5.2');
});

test('matchReferenceModel: exact beats a longer sibling in the same family', () => {
  // `glm-5` must not be answered with `glm-5.2`'s window and price just because it is a prefix.
  assert.equal(matchReferenceModel('glm-5', CATALOG)?.id, 'z-ai/glm-5');
});

test('matchReferenceModel: a hyphen-boundary suffix matches, a bare substring does not', () => {
  // kimi's endpoint calls it `k3`; OpenRouter calls it `moonshotai/kimi-k3`.
  assert.equal(matchReferenceModel('k3', CATALOG)?.id, 'moonshotai/kimi-k3');
  // `5-turbo` is a substring of two ids but a boundary suffix of neither's local name — and even if
  // it were, two candidates is an ambiguity, not a match.
  assert.equal(matchReferenceModel('turbo', CATALOG), undefined);
});

test('matchReferenceModel: `~` aliases never win a tier', () => {
  // `kimi-latest` exists only as an alias; borrowing its price would price a model the user is not
  // running.
  assert.equal(matchReferenceModel('kimi-latest', CATALOG), undefined);
});

test('matchReferenceModel: an unknown id and a blank id both yield nothing', () => {
  assert.equal(matchReferenceModel('nothing-like-this', CATALOG), undefined);
  assert.equal(matchReferenceModel('   ', CATALOG), undefined);
});

test('matchReferenceModel: an ambiguous tier gives up rather than guessing', () => {
  // Two orgs publishing the same local name: mispricing a run is worse than not pricing it.
  const ambiguous: OpenRouterModel[] = [
    catalogModel({ id: 'a/shared-model' }),
    catalogModel({ id: 'b/shared-model' }),
  ];
  assert.equal(matchReferenceModel('shared-model', ambiguous), undefined);
});

test('reference catalog: the keyless fetch is time-boxed too', async () => {
  // Same startup path as OpenRouterClient.listModels — a stalled public catalog must not hang the run.
  const realFetch = globalThis.fetch;
  let seen: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    seen = init?.signal ?? undefined;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    await new OpenRouterReferenceCatalog().listModels();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, false);
});

test('reference catalog: the run signal cancels the keyless fetch too', async () => {
  const realFetch = globalThis.fetch;
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    await new OpenRouterReferenceCatalog(OPENROUTER_REFERENCE_URL, controller.signal).listModels();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, true, 'the run signal reaches fetch, not just the deadline');
});
