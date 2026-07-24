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
  // Wall-clock time rendered in `timezone`. `iso` carries the same instant as an unambiguous UTC
  // stamp — returning both keeps the localized value honest instead of labeling UTC as the zone.
  datetime: string;
  iso: string;
  timezone: string;
};

export function datetimeTool(): Tool<DatetimeInput, DatetimeOutput> {
  return tool({
    description: 'Get the current date and time, optionally formatted for a specific timezone',
    inputSchema: datetimeInputSchema,
    execute: async (input: DatetimeInput): Promise<DatetimeOutput> => {
      const date = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: input.timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      });
      return {
        datetime: formatter.format(date),
        iso: date.toISOString(),
        timezone: formatter.resolvedOptions().timeZone,
      };
    },
  });
}
