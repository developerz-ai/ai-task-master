// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${VAR}` placeholders are the input under test, not template literals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRegisteredSecrets } from '../logger/secret-registry.ts';
import { scrubSecrets } from '../logger/secret-scrubber.ts';
import { expandServerEnv, McpEnvVarMissing } from './env-expand.ts';

const env = { API_KEY: 'k-1234567890', HOST: 'mcp.example.com' };

test('expandServerEnv: ${VAR} in http url and headers is replaced from env', () => {
  const out = expandServerEnv(
    {
      type: 'http',
      url: 'https://${HOST}/v1',
      headers: { Authorization: 'Bearer ${API_KEY}' },
    },
    env,
  );
  assert.deepEqual(out, {
    type: 'http',
    url: 'https://mcp.example.com/v1',
    headers: { Authorization: 'Bearer k-1234567890' },
  });
});

test('expandServerEnv: stdio command, args and env values expand; ${X:-def} falls back', () => {
  const out = expandServerEnv(
    {
      command: '${BIN:-npx}',
      args: ['--host', '${HOST}'],
      env: { TOKEN: '${API_KEY}', MODE: '${MODE:-prod}' },
      cwd: '/repo',
    },
    env,
  );
  assert.deepEqual(out, {
    command: 'npx',
    args: ['--host', 'mcp.example.com'],
    env: { TOKEN: 'k-1234567890', MODE: 'prod' },
    cwd: '/repo',
  });
});

test('expandServerEnv: a set variable wins over its default; an empty one takes the default', () => {
  const out = expandServerEnv({ command: '${A:-x}', args: ['${B:-y}'] }, { A: 'set', B: '' });
  assert.deepEqual(out, { command: 'set', args: ['y'] });
});

test('expandServerEnv: an unset variable with no default fails loud, naming it', () => {
  assert.throws(
    () => expandServerEnv({ type: 'sse', url: 'https://x/${NOPE}' }, env),
    (err: unknown) => err instanceof McpEnvVarMissing && /NOPE/.test(err.message),
  );
});

test('expandServerEnv: text without ${…} is untouched, including a bare $VAR', () => {
  const server = { command: 'sh', args: ['-c', 'echo $HOME'] };
  assert.deepEqual(expandServerEnv(server, env), server);
});

test('expandServerEnv: an inherited property name is unset, not Object.prototype', () => {
  assert.deepEqual(expandServerEnv({ command: '${toString:-fallback}' }, {}), {
    command: 'fallback',
  });
});

test('expandServerEnv: a bare placeholder set to the empty string expands to empty, not an error', () => {
  assert.deepEqual(expandServerEnv({ command: 'x', args: ['--flag=${EMPTY}'] }, { EMPTY: '' }), {
    command: 'x',
    args: ['--flag='],
  });
});

test('expandServerEnv: a substituted value is registered with the output scrubber', () => {
  clearRegisteredSecrets();
  try {
    const secret = 'opaque-value-9f8e7d6c';
    assert.equal(scrubSecrets(`token ${secret}`), `token ${secret}`, 'not known before expansion');
    expandServerEnv(
      { type: 'http', url: 'https://x/', headers: { 'X-Key': '${S}' } },
      { S: secret },
    );
    assert.equal(scrubSecrets(`token ${secret}`), 'token [REDACTED]');
  } finally {
    clearRegisteredSecrets();
  }
});
