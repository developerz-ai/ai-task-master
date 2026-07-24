import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readClaudeProjectMcp, readClaudeUserMcp } from './claude-code-config.ts';

type Temp = { path: string; cleanup: () => Promise<void> };

async function tempDir(prefix: string): Promise<Temp> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('readClaudeUserMcp returns null when ~/.claude.json is missing', async () => {
  const home = await tempDir('claude-user-');
  try {
    assert.equal(await readClaudeUserMcp(home.path), null);
  } finally {
    await home.cleanup();
  }
});

test('readClaudeUserMcp extracts mcpServers, ignoring unrelated keys', async () => {
  const home = await tempDir('claude-user-');
  try {
    await writeFile(
      join(home.path, '.claude.json'),
      JSON.stringify({
        oauthAccount: { something: 'unrelated' },
        mcpServers: { notes: { command: 'mcp-notes' } },
      }),
    );
    const result = await readClaudeUserMcp(home.path);
    assert.deepEqual(result, { notes: { command: 'mcp-notes' } });
  } finally {
    await home.cleanup();
  }
});

test('readClaudeUserMcp returns null when the file has no mcpServers key', async () => {
  const home = await tempDir('claude-user-');
  try {
    await writeFile(join(home.path, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    assert.equal(await readClaudeUserMcp(home.path), null);
  } finally {
    await home.cleanup();
  }
});

test('readClaudeUserMcp throws with file path on invalid JSON', async () => {
  const home = await tempDir('claude-user-');
  try {
    await writeFile(join(home.path, '.claude.json'), '{ not valid json');
    await assert.rejects(() => readClaudeUserMcp(home.path), /\.claude\.json.*invalid JSON/);
  } finally {
    await home.cleanup();
  }
});

test('readClaudeUserMcp throws with file path on schema violation', async () => {
  const home = await tempDir('claude-user-');
  try {
    await writeFile(
      join(home.path, '.claude.json'),
      JSON.stringify({ mcpServers: { bad: { nope: true } } }),
    );
    await assert.rejects(() => readClaudeUserMcp(home.path), /\.claude\.json/);
  } finally {
    await home.cleanup();
  }
});

test('readClaudeProjectMcp returns null when ./.mcp.json is missing', async () => {
  const cwd = await tempDir('claude-project-');
  try {
    assert.equal(await readClaudeProjectMcp(cwd.path), null);
  } finally {
    await cwd.cleanup();
  }
});

test('readClaudeProjectMcp extracts mcpServers from ./.mcp.json', async () => {
  const cwd = await tempDir('claude-project-');
  try {
    await writeFile(
      join(cwd.path, '.mcp.json'),
      JSON.stringify({
        mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/docs' } },
      }),
    );
    const result = await readClaudeProjectMcp(cwd.path);
    assert.deepEqual(result, { docs: { type: 'http', url: 'https://mcp.example.com/docs' } });
  } finally {
    await cwd.cleanup();
  }
});

test('readClaudeProjectMcp throws with file path on invalid JSON', async () => {
  const cwd = await tempDir('claude-project-');
  try {
    await writeFile(join(cwd.path, '.mcp.json'), '{ not valid json');
    await assert.rejects(() => readClaudeProjectMcp(cwd.path), /\.mcp\.json.*invalid JSON/);
  } finally {
    await cwd.cleanup();
  }
});
