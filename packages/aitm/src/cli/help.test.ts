import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PRESET_NAMES } from '../config/provider-presets.ts';
import { CLI_COMMANDS, HELP_TEXT } from './help.ts';

// Every flag argv token the parser branches on: `flag === '--x'`, `raw === '-f'`, `command === '-h'`,
// … A leading dash plus a letter distinguishes a flag from a subcommand (`'set'`) or the bare
// sentinels (`'--'`, `'-'`), which carry no letter after the dashes.
function parserFlags(source: string): Set<string> {
  const flags = new Set<string>();
  const pattern = /[\w$]+\s*===\s*'(-{1,2}[a-z][a-z0-9-]*)'/g;
  for (const match of source.matchAll(pattern)) {
    const token = match[1];
    if (token !== undefined) flags.add(token);
  }
  return flags;
}

// Every flag token the help text advertises. A token is preceded by a boundary (start, whitespace,
// `[`, or `|`) then a dash — so `command-line` and `merge-pr.md` (dash after a letter) don't count,
// and neither do preset values like `zai` (no dash).
function helpFlags(text: string): Set<string> {
  const flags = new Set<string>();
  const pattern = /(?:^|[\s[|])(-{1,2}[a-z][a-z0-9-]*)/gm;
  for (const match of text.matchAll(pattern)) {
    const token = match[1];
    if (token !== undefined) flags.add(token);
  }
  return flags;
}

async function readArgsSource(): Promise<string> {
  return readFile(new URL('./args.ts', import.meta.url), 'utf8');
}

// The drift-killer: the set of flags the parser recognizes and the set the help text advertises must
// be identical. This is what makes `--pr-per-task`/`--max-fix-attempts`/`--max-iterations` (parsed
// but undocumented before this table existed) — and any future flag — a test failure, not a paper cut.
test('help: every parsed flag is advertised and every advertised flag is parsed', async () => {
  const parsed = parserFlags(await readArgsSource());
  const advertised = helpFlags(HELP_TEXT);

  // Guard against a broken extractor passing vacuously via two empty sets.
  assert.ok(parsed.size >= 25, `expected the parser to recognize many flags, got ${parsed.size}`);

  const parsedNotAdvertised = [...parsed].filter((f) => !advertised.has(f)).sort();
  const advertisedNotParsed = [...advertised].filter((f) => !parsed.has(f)).sort();
  assert.deepEqual(parsedNotAdvertised, [], 'flags the parser accepts but help omits');
  assert.deepEqual(advertisedNotParsed, [], 'flags help advertises but the parser rejects');
});

// Explicit regression pin for the three flags the hand-written help had drifted away from.
test('help: advertises the flags that had drifted out of the hand-written text', () => {
  for (const flag of ['--pr-per-task', '--max-fix-attempts', '--max-iterations']) {
    assert.ok(HELP_TEXT.includes(flag), `${flag} missing from help`);
  }
});

// The `--preset` value list is generated from PRESET_NAMES, so a new preset can't be accepted by the
// parser while the help still shows the old list (the `openrouter|zai` vs `…|moonshot` drift).
test('help: --preset lists exactly the built-in presets', () => {
  assert.ok(HELP_TEXT.includes(`[--preset ${PRESET_NAMES.join('|')}]`));
  for (const preset of PRESET_NAMES) {
    assert.ok(HELP_TEXT.includes(preset), `preset ${preset} missing from help`);
  }
});

// Every token declared in the table renders into the help output — guards the renderer against
// silently dropping a flag.
test('help: every declared flag token appears in the rendered help', () => {
  const advertised = helpFlags(HELP_TEXT);
  for (const cmd of CLI_COMMANDS) {
    for (const flag of cmd.flags ?? []) {
      for (const token of flag.tokens) {
        assert.ok(advertised.has(token), `${token} declared but not rendered`);
      }
    }
  }
});

test('help: has the expected top-level structure', () => {
  assert.ok(HELP_TEXT.startsWith('aitm — autonomous task orchestrator'));
  assert.match(HELP_TEXT, /\nUsage:\n/);
  assert.match(HELP_TEXT, /\nExit codes:\n/);
  for (const invocation of [
    'aitm start "<goal>"',
    'aitm resume',
    'aitm merge-pr',
    'aitm config set <key> <value>',
    'aitm profile add <name>',
    'aitm mcp-login <server-url>',
    'aitm clean',
    'aitm version | --version | -v',
  ]) {
    assert.ok(HELP_TEXT.includes(invocation), `usage missing: ${invocation}`);
  }
});
