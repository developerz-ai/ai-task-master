// The shared abort-driven stall stub for the per-step-deadline tests (issue #129): a
// MockLanguageModelV3 whose doGenerate never resolves and only rejects once its abortSignal fires, so
// a test can prove a generate site actually arms the per-step deadline. Test-support module in
// src/testing/ (like temp-repo.ts) — consumed only by *.test.ts, so it ships no paired test.

import { MockLanguageModelV3 } from 'ai/test';

export function stallingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
}
