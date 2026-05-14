// Local datetime tool — implemented as a Vercel AI SDK function tool, NOT as
// `openrouter:datetime` (server tool). Local is faster (no round-trip), free, and
// not subject to the server-tool beta API. The server-tool variant offers zero
// capability beyond `new Date()` + `Intl.DateTimeFormat`.
//
// SDK ref: docs/vendor/ai-sdk/chunk-02.md §"Tool Calling" — tool({ description, inputSchema, execute }).

import type { Tool } from 'ai';
import { type FlexibleSchema, tool } from 'ai';
import { z } from 'zod';

export type DatetimeInput = {
  timezone?: string;
};

export type DatetimeOutput = {
  datetime: string;
  timezone: string;
};

export function datetimeTool(): Tool {
  return tool({
    description: 'Get the current date and time, optionally formatted for a specific timezone',
    inputSchema: z.object({
      timezone: z.string().optional(),
    }) as unknown as FlexibleSchema<DatetimeInput>,
    execute: async (input: DatetimeInput): Promise<DatetimeOutput> => {
      const datetime = new Date().toLocaleString('en-US', {
        timeZone: input.timezone,
      });
      return {
        datetime,
        timezone: input.timezone ?? '',
      };
    },
  });
}
