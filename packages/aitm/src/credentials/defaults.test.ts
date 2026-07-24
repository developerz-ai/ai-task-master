import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_PRESETS } from '../config/provider-presets.ts';
import { isOpenRouterEndpoint, OPENROUTER_API_BASE_URL } from './defaults.ts';

test('isOpenRouterEndpoint: unset / blank baseURL → the default OpenRouter endpoint', () => {
  assert.equal(isOpenRouterEndpoint(undefined), true, 'unset → provider default (OpenRouter)');
  assert.equal(isOpenRouterEndpoint(''), true);
  assert.equal(isOpenRouterEndpoint('   '), true, 'whitespace-only is treated as unset');
});

test('isOpenRouterEndpoint: the OpenRouter endpoint constant and the `openrouter` preset are recognized', () => {
  assert.equal(isOpenRouterEndpoint(OPENROUTER_API_BASE_URL), true);
  // The exact baseURL `aitm profile add … --preset openrouter` writes must be recognized as
  // OpenRouter — a presence check misread it as a custom endpoint and stripped every OpenRouter
  // directive (the bug this guards against).
  assert.equal(isOpenRouterEndpoint(PROVIDER_PRESETS.openrouter.baseURL), true);
});

test('isOpenRouterEndpoint: exact host and real subdomains are OpenRouter', () => {
  assert.equal(isOpenRouterEndpoint('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouterEndpoint('http://openrouter.ai/api/v1'), true, 'scheme is irrelevant');
  assert.equal(isOpenRouterEndpoint('https://gateway.openrouter.ai/v1'), true, 'real subdomain');
  assert.equal(
    isOpenRouterEndpoint('https://OPENROUTER.AI/api/v1'),
    true,
    'host compared case-insensitively',
  );
});

test('isOpenRouterEndpoint: custom OpenAI-compatible endpoints are NOT OpenRouter', () => {
  assert.equal(isOpenRouterEndpoint('https://api.z.ai/api/coding/paas/v4'), false);
  assert.equal(isOpenRouterEndpoint('https://api.moonshot.ai/v1'), false);
  assert.equal(isOpenRouterEndpoint('http://localhost:8080/v1'), false, 'self-hosted gateway');
  // Every non-default preset is a custom endpoint → correctly not OpenRouter, so those profiles keep
  // stripping OpenRouter-only directives as before.
  assert.equal(isOpenRouterEndpoint(PROVIDER_PRESETS.zai.baseURL), false);
  assert.equal(isOpenRouterEndpoint(PROVIDER_PRESETS.moonshot.baseURL), false);
});

test('isOpenRouterEndpoint: lookalike hosts are rejected (no bare endsWith)', () => {
  assert.equal(isOpenRouterEndpoint('https://notopenrouter.ai/api/v1'), false);
  assert.equal(
    isOpenRouterEndpoint('https://openrouter.ai.evil.com/api/v1'),
    false,
    'suffix-collision host rejected',
  );
});

test('isOpenRouterEndpoint: a malformed baseURL fails closed (treated as non-OpenRouter)', () => {
  assert.equal(isOpenRouterEndpoint('not a url'), false);
  assert.equal(
    isOpenRouterEndpoint('openrouter.ai/api/v1'),
    false,
    'no scheme → not a parseable absolute URL',
  );
});
