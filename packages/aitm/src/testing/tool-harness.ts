// Calling a `Tool`'s `execute` from a test (issue #132).
//
// Two things make the raw call awkward, and every tool test was working around them by hand — or
// not working around them at all, which is where ~74 of the suite's type errors came from:
//
//   1. `execute` takes (input, ToolCallOptions). Tests care about the input and nothing else, but
//      the second argument is not optional.
//   2. Its return is `O | AsyncIterable<O>` — a tool may stream. Every aitm tool resolves a single
//      value, so a test that reaches straight for `.someField` is reading a union member that does
//      not have it.
//
// `runTool` supplies throwaway call options and asserts the single-value shape, so a tool that
// unexpectedly starts streaming fails loudly here instead of silently at a property read.

import assert from 'node:assert/strict';
import type { Tool } from 'ai';

type ExecuteOptions = Parameters<NonNullable<Tool<unknown, unknown>['execute']>>[1];

// Minimal shape the SDK requires; aitm's tools read none of it.
const CALL_OPTIONS: ExecuteOptions = { toolCallId: 'aitm-test-call', messages: [] };

function isAsyncIterable<O>(value: O | AsyncIterable<O>): value is AsyncIterable<O> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export async function runTool<I, O>(t: Tool<I, O>, input: I): Promise<O> {
  const execute = t.execute;
  assert.ok(execute, 'tool has no execute');
  const out = await execute(input, CALL_OPTIONS);
  assert.ok(!isAsyncIterable(out), 'tool streamed; this helper is for single-value tools');
  return out;
}

// `Tool.inputSchema` is a `FlexibleSchema` — a Zod schema OR the SDK's own `Schema` wrapper, which
// has no `parseAsync`. aitm declares every tool with Zod, so the narrowing below always succeeds;
// it exists so a tool that stops doing that fails with this sentence rather than at a missing method.
export async function parseToolInput<I, O>(t: Tool<I, O>, value: unknown): Promise<I> {
  const schema = t.inputSchema;
  assert.ok(schema && 'parseAsync' in schema, 'tool inputSchema is not a Zod schema');
  return await schema.parseAsync(value);
}
