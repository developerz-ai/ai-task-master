// Integration: a worker-shaped bash command spills >30k chars of output to the ToolOutputStore
// (PR4/slice-02), and a follow-up readFile call pages the spill file directly — the same recovery
// path a real worker takes after seeing the "[output truncated: ... Full output: <path>]" notice.
// Real temp git repo (makeTempRepo), tools driven directly — no LLM in the loop.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type BashInput,
  bashTool,
  FileStateTracker,
  MAX_BASH_OUTPUT_CHARS,
  type ReadFileInput,
  readFileTool,
  ToolOutputStore,
} from '@developerz.ai/ai-claude-compat';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { runTool } from '../../src/testing/tool-harness.ts';

test('tool-output-spill: worker command over the bash cap spills, readFile pages the spill file', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const store = new ToolOutputStore(join(repo.path, '.ai-task-master', 'tool-output'));

    const bash = bashTool({ cwd: repo.path, outputStore: store });

    // `seq 1 20000` produces ~108k chars — comfortably over MAX_BASH_OUTPUT_CHARS (30k) — a stand-in
    // for a verbose worker command (e.g. a full test run) that would otherwise blow the context cap.
    const bashOut = await runTool<BashInput, { stdout: string; stderr: string; exitCode: number }>(
      bash,
      { command: 'seq 1 20000', description: 'produce 100k+ chars of output' },
    );

    assert.equal(bashOut.exitCode, 0);
    assert.ok(
      bashOut.stdout.length <= MAX_BASH_OUTPUT_CHARS,
      'in-context stdout stays within the cap',
    );

    const notice = bashOut.stdout.match(
      /Full output: (\S+) — page with readFile\(offset\/limit\) or grep\]/,
    );
    assert.ok(notice, `expected a spill notice with a path, got: ${bashOut.stdout.slice(-300)}`);
    const spillPath = notice?.[1] ?? '';
    assert.ok(spillPath.length > 0, 'spill notice must carry a path');

    // Line 10000 sits in the middle of the stream — omitted from the in-context head+tail view —
    // so recovering it proves the follow-up readFile is reaching content bash itself dropped.
    assert.ok(!bashOut.stdout.includes('\n10000\n'), 'the omitted middle is not in the bash view');

    // Follow-up: page the spill file with readFile, exactly as a worker would after reading the notice.
    const fileState = new FileStateTracker();
    const read = readFileTool({ cwd: repo.path, fileState });

    const page = await runTool<ReadFileInput, { content: string }>(read, {
      path: spillPath,
      offset: 9995,
      limit: 10,
    });

    // The spilled file is `cat -n` numbered, 1-based, so line 10000 (content "10000") lands here.
    assert.match(page.content, /^9995\t9995$/m, 'window starts at the requested offset');
    assert.match(
      page.content,
      /^10000\t10000$/m,
      'the omitted middle line is recoverable via readFile',
    );
    assert.match(
      page.content,
      /more remain — continue with offset: 10005/,
      'continuation hint present',
    );

    // Paging to the end of the spill file confirms nothing beyond the middle was lost either.
    const tail = await runTool<ReadFileInput, { content: string }>(read, {
      path: spillPath,
      offset: 19995,
      limit: 10,
    });

    assert.match(tail.content, /^20000\t20000$/m, 'the final line survived the spill');
    assert.ok(!tail.content.includes('more remain'), 'no continuation hint past the last line');
  } finally {
    await repo.cleanup();
  }
});
