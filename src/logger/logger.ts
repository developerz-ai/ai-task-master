// docs/state.md (logs dir), docs/auth.md §Security (redaction policy)
// Structured logs to .ai-task-master/logs/run-{ts}.log; user-facing status to stdout.
// Redact /key|token|secret|authorization/i before serializing.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  level: LogLevel;
  msg: string;
  ts: string;
  runId: string;
  [k: string]: unknown;
};

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly runId: string,
    private readonly logFile?: string,
  ) {}

  debug(_msg: string, _fields?: Record<string, unknown>): void {
    throw new Error('not implemented');
  }

  info(_msg: string, _fields?: Record<string, unknown>): void {
    throw new Error('not implemented');
  }

  warn(_msg: string, _fields?: Record<string, unknown>): void {
    throw new Error('not implemented');
  }

  error(_msg: string, _fields?: Record<string, unknown>): void {
    throw new Error('not implemented');
  }

  status(_msg: string): void {
    throw new Error('not implemented');
  }

  static redact(_fields: Record<string, unknown>): Record<string, unknown> {
    throw new Error('not implemented');
  }
}
