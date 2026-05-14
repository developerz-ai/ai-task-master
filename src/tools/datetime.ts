// Local datetime tool — implemented as a Vercel AI SDK function tool, NOT as
// `openrouter:datetime` (server tool). Local is faster (no round-trip), free, and
// not subject to the server-tool beta API. The server-tool variant offers zero
// capability beyond `new Date()` + `Intl.DateTimeFormat`.
//
// SDK ref: docs/vendor/ai-sdk/chunk-02.md §"Tool Calling" — tool({ description, inputSchema, execute }).

import type { Tool } from 'ai';

export type DatetimeInput = {
  timezone?: string;
};

export type DatetimeOutput = {
  datetime: string;
  timezone: string;
};

export function datetimeTool(): Tool {
  throw new Error('not implemented');
}
