// Manifest-prompt interpolation caps (issue: prompt compression + injected-value fencing, slice 06).
// `group.title`/`task.text`/each subtask/`file.purpose` are short labels in the common case, but they
// originate from the Planner's (or a prior run's) structured output, not a fixed harness string — an
// unbounded field lets a runaway plan or a hostile task description blow up the manifest/editor prompt.
// Shared by worker.ts's own manifest prompt and editor-fanout.ts's team brief / editor prompts, so both
// slice-cap interpolated fields the same way without one importing the other's internals.
export const MANIFEST_FIELD_MAX = 500;
// `rollingContext` accumulates one summary per prior PR group across the whole run, so it grows with
// run length rather than staying label-sized; capped at an order of magnitude above MANIFEST_FIELD_MAX.
export const ROLLING_CONTEXT_MAX = 4000;

const TRUNCATION_MARKER = ' […truncated]';

// Slice-cap a raw interpolated field to `max` chars, appending a marker so truncation is visible
// rather than silently cutting off mid-sentence with no signal to the model or a reader of the prompt.
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = Math.max(0, max - TRUNCATION_MARKER.length);
  return text.slice(0, budget) + TRUNCATION_MARKER;
}
