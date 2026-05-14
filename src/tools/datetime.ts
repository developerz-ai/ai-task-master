// Local datetime tool — implemented as a Vercel AI SDK function tool, NOT as
// `openrouter:datetime` (server tool). Local is faster (no round-trip), free, and
// not subject to the server-tool beta API. The server-tool variant offers zero
// capability beyond `new Date()` + `Intl.DateTimeFormat`.
//
// SDK ref: docs/vendor/ai-sdk/chunk-02.md §"Tool Calling" — tool({ description, inputSchema, execute }).

import type { Tool } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';

// Reject empty string and invalid IANA tz strings; allow `undefined` from `.optional()`.
// `toLocaleString` throws on both empty and unknown timezones, so we validate upfront.
function isValidTimezone(tz: string | undefined): boolean {
  if (tz === undefined) return true;
  if (tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const datetimeInputSchema = z.object({
  timezone: z.string().optional().refine(isValidTimezone, { message: 'Invalid IANA timezone' }),
});

export type DatetimeInput = z.infer<typeof datetimeInputSchema>;

export type DatetimeOutput = {
  datetime: string;
  timezone: string;
};

export function datetimeTool(): Tool {
  return tool({
    description: 'Get the current date and time, optionally formatted for a specific timezone',
    inputSchema: datetimeInputSchema,
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
