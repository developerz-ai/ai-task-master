// docs/state.md (logs dir), docs/auth.md §Security (redaction policy)
// Structured logs to .ai-task-master/logs/run-{ts}.log; user-facing status to stdout.
// Redact /key|token|secret|authorization/i before serializing.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  level: LogLevel;
  msg: string;
  ts: string;
  runId: string;
  [k: string]: unknown;
};

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACT_KEY = /key|token|secret|authorization/i;
const REDACTED = '[REDACTED]';

export class Logger {
  private writeTail: Promise<void> = Promise.resolve();
  private parentEnsured = false;
  private lastError: Error | null = null;

  constructor(
    private readonly level: LogLevel,
    private readonly runId: string,
    private readonly logFile?: string,
  ) {}

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }

  status(msg: string): void {
    process.stdout.write(`${msg}\n`);
  }

  static redact(fields: Record<string, unknown>): Record<string, unknown> {
    const out = redactValue(fields);
    return out as Record<string, unknown>;
  }

  // Flush pending file writes — tests and shutdown hooks await this.
  async flush(): Promise<void> {
    await this.writeTail;
    if (this.lastError) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;

    const safeFields = fields ? Logger.redact(fields) : {};
    const record: LogRecord = {
      ...safeFields,
      level,
      msg,
      ts: new Date().toISOString(),
      runId: this.runId,
    };

    const line = `${JSON.stringify(record)}\n`;
    process.stderr.write(line);

    if (this.logFile !== undefined) {
      this.appendToFile(this.logFile, line);
    }
  }

  private appendToFile(file: string, line: string): void {
    this.writeTail = this.writeTail.then(async () => {
      try {
        await this.ensureParent(file);
        await appendFile(file, line);
      } catch (err) {
        // Surface failures via flush() but never crash callers.
        this.lastError = err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  private async ensureParent(file: string): Promise<void> {
    if (this.parentEnsured) return;
    await mkdir(dirname(file), { recursive: true });
    this.parentEnsured = true;
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}
