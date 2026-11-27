// `${VAR}` / `${VAR:-default}` expansion in an MCP server entry, the form Claude Code documents for
// `.mcp.json` (https://code.claude.com/docs/en/mcp) — so a config that works there works here, and a
// token stays in the environment instead of the checked-in file. Expanded at connect time only: the
// resolved config, its snapshot and `config list` keep the placeholders, never the secrets.
//
// Covered fields: stdio `command`, `args`, `env` values; http/sse `url` and `headers` values. A bare
// `$VAR` is left alone (it is shell syntax an `args` entry may legitimately carry). An unset variable
// with no default throws, so the server is skipped loudly rather than sent a literal `${VAR}`.

import { registerSecretValues } from '../logger/secret-registry.ts';
import type { McpServer } from './schema.ts';

export class McpEnvVarMissing extends Error {
  constructor(readonly variable: string) {
    super(`environment variable ${variable} is not set and has no default (\${${variable}:-…})`);
    this.name = 'McpEnvVarMissing';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function expandServerEnv(server: McpServer, env: Env): McpServer {
  const expand = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
      // Own properties only: `${toString}` must read as unset, not as Object.prototype.toString.
      const value = Object.hasOwn(env, name) ? env[name] : undefined;
      // POSIX `:-`: the default stands in for unset OR empty. A bare `${VAR}` set to '' is just ''.
      if (fallback !== undefined && (value === undefined || value === '')) return fallback;
      if (value === undefined) throw new McpEnvVarMissing(name);
      // A value pulled from the environment into a header/env/arg is credential-shaped by default;
      // every output channel's scrubber now knows it (too-short values are ignored there).
      registerSecretValues([value]);
      return value;
    });
  const expandValues = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expand(v)]));

  if ('url' in server) {
    return {
      ...server,
      url: expand(server.url),
      ...(server.headers ? { headers: expandValues(server.headers) } : {}),
    };
  }
  return {
    ...server,
    command: expand(server.command),
    ...(server.args ? { args: server.args.map(expand) } : {}),
    ...(server.env ? { env: expandValues(server.env) } : {}),
  };
}
