import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { stallingModel } from '../testing/stalling-model.ts';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { AgentConfig } from './agent-config-detector.ts';
import { composeStyleGuide, isTestPath, StyleDistiller } from './coding-style.ts';

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

test('StyleDistiller: prompt embeds style contents + real source, and returns a cleaned digest', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    // Real files, not a guessed glob: the digest's whole job is the conventions the style file does
    // not state, and those are only visible in the code.
    await writeFile(join(repo.path, 'router.ts'), 'export const ROUTE_MARKER = 1;\n');
    await writeFile(join(repo.path, 'router.test.ts'), 'test("TEST_MARKER", () => {});\n');
    const { model, prompt } = modelReturning('# Coding Style\n\n- use tabs\nCODING_STYLE_COMPLETE');
    const config = claudeConfig(
      join(repo.path, 'CLAUDE.md'),
      '# CLAUDE house style\n- single quotes only\n',
    );
    const digest = await new StyleDistiller({ model }).distill({ config, repoRoot: repo.path });

    assert.equal(digest, '# Coding Style\n\n- use tabs');
    const sent = prompt();
    assert.match(sent, /single quotes only/);
    assert.match(sent, /ROUTE_MARKER/, 'real source reaches the prompt');
    assert.match(sent, /TEST_MARKER/, 'a real test file reaches the prompt');
    assert.match(sent, /source samples/);
    assert.match(sent, /test samples/);
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: a repo with no JS tooling at all still yields signals (Rust)', async () => {
  // The JS-only signal set (biome/tsconfig/package.json) produced an EMPTY digest for Rust, Python,
  // and Go repos — distill() returned '' before even calling the model.
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'Cargo.toml'), '[package]\nname = "engine"\n');
    await writeFile(join(repo.path, 'main.rs'), 'pub fn RUST_MARKER() {}\n');
    const { model, prompt } = modelReturning('# Coding Style\n\n- rust\nCODING_STYLE_COMPLETE');
    const digest = await new StyleDistiller({ model }).distill({
      config: null,
      repoRoot: repo.path,
    });

    assert.notEqual(digest, '', 'a Rust repo gets a digest instead of nothing');
    assert.match(prompt(), /Cargo\.toml/);
    assert.match(prompt(), /RUST_MARKER/);
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: vendor directories are never sampled', async () => {
  const repo = await makeTempRepo();
  try {
    await mkdir(join(repo.path, 'node_modules'), { recursive: true });
    await writeFile(join(repo.path, 'node_modules', 'dep.ts'), 'export const VENDOR_MARKER = 1;\n');
    await writeFile(join(repo.path, 'app.ts'), 'export const APP_MARKER = 1;\n');
    const { model, prompt } = modelReturning('# Coding Style\n\n- x\nCODING_STYLE_COMPLETE');
    await new StyleDistiller({ model }).distill({ config: null, repoRoot: repo.path });

    assert.match(prompt(), /APP_MARKER/);
    assert.doesNotMatch(prompt(), /VENDOR_MARKER/, 'node_modules must never reach the prompt');
  } finally {
    await repo.cleanup();
  }
});

test('isTestPath recognizes the conventions each ecosystem actually uses', () => {
  for (const p of [
    'src/router.test.ts',
    'src/router_test.go',
    'tests/test_router.py',
    'spec/router_spec.rb',
    'test/router.ts',
  ]) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['src/router.ts', 'src/latest.ts', 'src/contest.rs']) {
    assert.equal(isTestPath(p), false, p);
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

test('StyleDistiller: model error → empty digest (the verbatim half still reaches prompts)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# raw fallback contents\n- rule\n');
    const digest = await new StyleDistiller({ model: throwingModel() }).distill({
      config,
      repoRoot: repo.path,
    });

    assert.equal(digest, '');
    assert.match(composeStyleGuide(config, digest), /# raw fallback contents/);
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: a stalled step is aborted at the deadline and degrades to an empty digest (issue #129)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    // A summarizer that never settles on its own; the armed { stepMs: 40 } deadline aborts it, and
    // distill's never-throws contract degrades to '' rather than hanging.
    const stalling = stallingModel();
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# raw fallback\n- rule\n');
    const digest = await new StyleDistiller({ model: stalling, timeout: { stepMs: 40 } }).distill({
      config,
      repoRoot: repo.path,
    });
    assert.equal(digest, '');
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

test('StyleDistiller: onProgress fires once, naming every gathered signal (slice 01b)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await writeFile(join(repo.path, 'CONTRIBUTING.md'), '# Contributing\n');
    const { model } = modelReturning('# Coding Style\n\n- ok\nCODING_STYLE_COMPLETE');
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# x\n');
    const messages: string[] = [];
    await new StyleDistiller({ model, onProgress: (m) => messages.push(m) }).distill({
      config,
      repoRoot: repo.path,
    });

    assert.equal(messages.length, 1, 'one coarse line, no per-signal-file steps');
    assert.match(messages[0] ?? '', /^coding style: distilling from /);
    assert.match(messages[0] ?? '', /CLAUDE\.md/);
    assert.match(messages[0] ?? '', /CONTRIBUTING\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: no signals → onProgress never fires', async () => {
  const repo = await makeTempRepo();
  try {
    const messages: string[] = [];
    await new StyleDistiller({
      model: throwingModel(),
      onProgress: (m) => messages.push(m),
    }).distill({ config: null, repoRoot: repo.path });
    assert.deepEqual(messages, []);
  } finally {
    await repo.cleanup();
  }
});

test('StyleDistiller: a throwing onProgress never breaks distillation', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const { model } = modelReturning('# Coding Style\n\n- ok\nCODING_STYLE_COMPLETE');
    const config = claudeConfig(join(repo.path, 'CLAUDE.md'), '# x\n');
    const digest = await new StyleDistiller({
      model,
      onProgress: () => {
        throw new Error('sink boom');
      },
    }).distill({ config, repoRoot: repo.path });
    assert.equal(digest, '# Coding Style\n\n- ok');
  } finally {
    await repo.cleanup();
  }
});

test('composeStyleGuide: the style file leads verbatim, digest follows', () => {
  const config = claudeConfig('/repo/CLAUDE.md', '# House rules\n\n- named exports only\n');
  const guide = composeStyleGuide(config, '# Coding Style\n\n- tests live beside sources');

  const verbatimAt = guide.indexOf('- named exports only');
  const digestAt = guide.indexOf('- tests live beside sources');
  assert.ok(verbatimAt >= 0, 'every rule of the style file survives, unsummarized');
  assert.ok(digestAt > verbatimAt, 'the digest tails the authoritative half');
  assert.match(guide, /^# CLAUDE\.md \(project style file, verbatim — authoritative\)/);
});

test('composeStyleGuide: an AGENTS.md style file is labelled by its own filename', () => {
  const config: AgentConfig = {
    flavor: 'agents',
    path: '/repo/AGENTS.md',
    contents: '# Agents\n',
  };
  assert.match(composeStyleGuide(config, ''), /^# AGENTS\.md \(project style file/);
});

test('composeStyleGuide: no digest → the style file alone, no stray separators', () => {
  const config = claudeConfig('/repo/CLAUDE.md', '# House rules\n');
  const guide = composeStyleGuide(config, '   ');
  assert.equal(
    guide,
    '# CLAUDE.md (project style file, verbatim — authoritative)\n\n# House rules',
  );
});

test('composeStyleGuide: no style file → the digest alone', () => {
  assert.equal(composeStyleGuide(null, '# Coding Style\n\n- x'), '# Coding Style\n\n- x');
});

test('composeStyleGuide: nothing to say → empty, so the prompt omits the style block', () => {
  assert.equal(composeStyleGuide(null, ''), '');
  assert.equal(composeStyleGuide(claudeConfig('/repo/CLAUDE.md', '  \n'), ''), '');
});
