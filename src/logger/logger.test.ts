import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Logger, type LogRecord } from './logger.ts';

type WriteFn = typeof process.stdout.write;

function captureStream(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  const spy: WriteFn = (chunk, ...rest: unknown[]) => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? new TextDecoder().decode(chunk)
          : String(chunk);
    lines.push(text);
    const cb = rest.find((arg): arg is (err?: Error | null) => void => typeof arg === 'function');
    if (cb) cb(null);
    return true;
  };
  stream.write = spy;
  return {
    lines,
    restore: () => {
      stream.write = original;
    },
  };
}

function parseLines(lines: string[]): LogRecord[] {
  return lines
    .join('')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogRecord);
}

test('Logger is constructible', () => {
  const log = new Logger('info', 'run-test-id');
  assert.ok(log instanceof Logger);
});

test('Logger.status writes plain text to stdout (no JSON, no stderr)', () => {
  const out = captureStream(process.stdout);
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'run-1');
    log.status('all green');
  } finally {
    out.restore();
    err.restore();
  }
  assert.equal(out.lines.join(''), 'all green\n');
  assert.equal(err.lines.join(''), '');
});

test('Logger.info writes JSON to stderr with level/msg/ts/runId', () => {
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'run-42');
    log.info('hello', { foo: 'bar' });
  } finally {
    err.restore();
  }
  const [record] = parseLines(err.lines);
  assert.ok(record);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'hello');
  assert.equal(record.runId, 'run-42');
  assert.equal(record.foo, 'bar');
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('Logger level filter: debug below info is dropped', () => {
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'run-x');
    log.debug('shhh');
    log.info('audible');
    log.warn('warn');
    log.error('boom');
  } finally {
    err.restore();
  }
  const records = parseLines(err.lines);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.level),
    ['info', 'warn', 'error'],
  );
});

test('Logger level filter: error level only emits error', () => {
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('error', 'run-x');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
  } finally {
    err.restore();
  }
  const records = parseLines(err.lines);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, 'error');
});

test('Logger.redact replaces values for matching keys (case-insensitive)', () => {
  const out = Logger.redact({
    apiKey: 'sk-123',
    Authorization: 'Bearer abc',
    accessToken: 't',
    SECRET_VALUE: 'shh',
    keep: 'me',
  });
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.Authorization, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]');
  assert.equal(out.SECRET_VALUE, '[REDACTED]');
  assert.equal(out.keep, 'me');
});

test('Logger.redact recurses into nested objects and arrays', () => {
  const out = Logger.redact({
    user: { id: 1, apiKey: 'sk-xyz' },
    items: [{ token: 'a', name: 'n' }],
  });
  const user = out.user as Record<string, unknown>;
  assert.equal(user.apiKey, '[REDACTED]');
  assert.equal(user.id, 1);
  const items = out.items as Array<Record<string, unknown>>;
  assert.equal(items[0]?.token, '[REDACTED]');
  assert.equal(items[0]?.name, 'n');
});

test('Logger emits applied redaction in JSON output', () => {
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'run-r');
    log.info('auth', { apiKey: 'sk-leak', user: 'sebi' });
  } finally {
    err.restore();
  }
  const [record] = parseLines(err.lines);
  assert.ok(record);
  assert.equal(record.apiKey, '[REDACTED]');
  assert.equal(record.user, 'sebi');
});

test('Logger writes to logFile, creating parent dir lazily', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-logger-'));
  const logFile = join(dir, 'logs', 'run.log');
  const errCapture = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'run-file', logFile);
    log.info('one', { a: 1 });
    log.info('two', { b: 2 });
    await log.flush();
    const contents = await readFile(logFile, 'utf8');
    const lines = contents.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] ?? '') as LogRecord;
    const second = JSON.parse(lines[1] ?? '') as LogRecord;
    assert.equal(first.msg, 'one');
    assert.equal(second.msg, 'two');
    assert.equal(first.runId, 'run-file');
  } finally {
    errCapture.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Logger does not collide level/msg/runId when fields supply same keys', () => {
  const err = captureStream(process.stderr);
  try {
    const log = new Logger('info', 'canonical');
    log.info('real-msg', { level: 'fake', msg: 'fake', runId: 'fake' });
  } finally {
    err.restore();
  }
  const [record] = parseLines(err.lines);
  assert.ok(record);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'real-msg');
  assert.equal(record.runId, 'canonical');
});
