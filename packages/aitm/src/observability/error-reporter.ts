// Optional error reporting to GlitchTip via the Sentry SDK (issue #70). `@sentry/node` is a soft
// (optional) dependency, dynamically imported ONLY when a DSN is configured — so the default
// (no-DSN) path, and runtimes where it isn't installed (e.g. Deno), never load it and pay nothing.
// Every failure degrades to a no-op: observability must never break a run.

import type { EventHint, ErrorEvent as SentryEvent } from '@sentry/node';
import { scrubSecrets } from '../logger/secret-scrubber.ts';

export type ErrorReporter = {
  // Record an error for delivery. A no-op when reporting is disabled.
  captureException(error: unknown): void;
  // Flush pending events before the process exits. Resolves immediately when disabled.
  flush(): Promise<void>;
};

const NOOP_REPORTER: ErrorReporter = {
  captureException: () => {},
  flush: async () => {},
};

// Resolve the GlitchTip/Sentry DSN from the environment. `AITM_SENTRY_DSN` takes precedence over a
// generic `SENTRY_DSN`; blank/whitespace counts as unset. Exported for unit testing.
export function dsnFromEnv(env: Record<string, string | undefined>): string | undefined {
  const dsn = env.AITM_SENTRY_DSN ?? env.SENTRY_DSN;
  return dsn !== undefined && dsn.trim() !== '' ? dsn : undefined;
}

// Scrub secret-shaped substrings (tokens, bearer/basic headers, token-bearing URLs) out of an
// event before it leaves the process. Key-name redaction (Logger.redact) catches structured
// fields; this catches secrets embedded in free text — error messages, stack frames, request
// URLs — which GlitchTip events carry plenty of. Exported for unit testing.
export function scrubEvent(event: SentryEvent): SentryEvent {
  if (event.message !== undefined) {
    event.message = scrubSecrets(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = scrubSecrets(exception.value);
    }
  }
  if (event.request?.url !== undefined) {
    event.request.url = scrubSecrets(event.request.url);
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message !== undefined) {
      breadcrumb.message = scrubSecrets(breadcrumb.message);
    }
  }
  return event;
}

// Initialise error reporting. Returns a no-op reporter when no DSN is set or the SDK can't be
// loaded/initialised, so callers can always `captureException`/`flush` unconditionally. The DSN
// lives in the tool's own runtime env (aitm is standalone, not a cluster app), per issue #70.
export async function initErrorReporter(
  env: Record<string, string | undefined> = process.env,
): Promise<ErrorReporter> {
  const dsn = dsnFromEnv(env);
  if (dsn === undefined) return NOOP_REPORTER;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: env.AITM_ENV ?? 'production',
      ...(env.AITM_RELEASE !== undefined && env.AITM_RELEASE !== ''
        ? { release: env.AITM_RELEASE }
        : {}),
      // aitm is a short-lived CLI, not a service — report errors only, no performance tracing.
      tracesSampleRate: 0,
      beforeSend: (event: SentryEvent, _hint: EventHint) => scrubEvent(event),
    });
    return {
      // Swallow any SDK error here so reporting can never affect the run — including its exit code:
      // a failing capture/flush must not surface to the CLI's exit path.
      captureException: (error) => {
        try {
          Sentry.captureException(error);
        } catch {
          // ignore — observability must never break the run
        }
      },
      flush: async () => {
        try {
          await Sentry.flush(2000);
        } catch {
          // ignore — observability must never break the run
        }
      },
    };
  } catch {
    // SDK missing (optional dep not installed / unsupported runtime) or init failed — never let
    // observability break the CLI.
    return NOOP_REPORTER;
  }
}
