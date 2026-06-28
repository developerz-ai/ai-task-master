import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { AgentConfig } from './agent-config-detector.ts';
import { StyleDistiller } from './coding-style.ts';

function claudeConfig(path: string, contents: string): AgentConfig {
  return { flavor: 'claude', path, contents };
}

// MockLanguageModelV3 driving the one-shot generateText call. Captures the rendered user prompt
// so tests can assert which signals reached the model.
function modelReturning(text: string): { model: MockLanguageModelV3; prompt: () => string } {
  const seen: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      for (const message of options.prompt) {
        if (message.role !== 'user') continue;
        const parts = Array.isArray(message.content) ? message.content : [];
        for (const part of parts) {
          if (part.type === 'text') seen.push(part.text);
        }
      }
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  return { model, prompt: () => seen.join('\n') };
}

function throwingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('model unavailable');
    },
  });
}

test('StyleDistiller is constructible', () => {
  const d = new StyleDistiller({ model: new MockLanguageModelV3() });
  assert.ok(d instanceof StyleDistiller);
});

test('StyleDistiller: prompt embeds style contents + test globs → returns cleaned digest', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const { model, prompt } = modelReturning('# Coding Style\n\n- use tabs\nCODING_STYLE_COMPLETE');
    const config = claudeConfig(
      join(repo.path, 'CLAUDE.md'),
      '# CLAUDE house style\n- single quotes only\n',
    );
    const digest = await new StyleDistiller({ model }).distill({ config, repoRoot: repo.path });

    assert.equal(digest, '# Coding Style\n\n- use tabs');
    const sent = prompt();
    assert.match(sent, /single quotes only/);
    assert.ok(sent.includes('**/*.test.ts'), 'prompt must surface the test globs');
    assert.ok(sent.includes('test/integration/**'), 'prompt must surface the integration glob');
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: strips marker and slices from the canonical header', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const { model } = modelReturning(
      'chatty preamble\n# Coding Style\n\nbody line\nCODING_STYLE_COMPLETE',
    );
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# x\n');
    const digest = await new StyleDistiller({ model }).distill({ config, repoRoot: repo.path });

    assert.equal(digest, '# Coding Style\n\nbody line');
    assert.ok(!digest.includes('preamble'));
    assert.ok(!digest.includes('CODING_STYLE_COMPLETE'));
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: wraps headerless output under the canonical header', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const { model } = modelReturning('just some loose notes');
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# x\n');
    const digest = await new StyleDistiller({ model }).distill({ config, repoRoot: repo.path });

    assert.equal(digest, '# Coding Style\n\njust some loose notes');
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: model error → falls back to raw config contents', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# raw fallback contents\n- rule\n');
    const digest = await new StyleDistiller({ model: throwingModel() }).distill({
      config,
      repoRoot: repo.path,
    });

    assert.equal(digest, '# raw fallback contents\n- rule\n');
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: no config and no signals → empty string without an LLM call', async () => {
  const repo = await makeTempRepo();
  try {
    // throwingModel would reject if reached; an empty bare repo has no signals, so it must not be.
    const digest = await new StyleDistiller({ model: throwingModel() }).distill({
      config: null,
      repoRoot: repo.path,
    });
    assert.equal(digest, '');
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: gathers config files + package.json scripts even with no style file', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'biome.json'), '{ "formatter": { "lineWidth": 100 } }\n');
    await writeFile(
      join(repo.path, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true } }\n',
    );
    await writeFile(
      join(repo.path, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'biome check .' } }),
    );
    const { model, prompt } = modelReturning('# Coding Style\n\n- ok\nCODING_STYLE_COMPLETE');
    const digest = await new StyleDistiller({ model }).distill({
      config: null,
      repoRoot: repo.path,
    });

    assert.equal(digest, '# Coding Style\n\n- ok');
    const sent = prompt();
    assert.match(sent, /biome\.json/);
    assert.match(sent, /tsconfig\.json/);
    assert.match(sent, /package\.json scripts/);
    assert.match(sent, /biome check \./);
    assert.ok(
      !sent.includes('"name"'),
      'only scripts are extracted from package.json, not the whole file',
    );
  } finally {
    await repo.cleanup();
  }
});
