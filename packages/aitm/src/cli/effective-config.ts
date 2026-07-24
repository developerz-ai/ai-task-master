// Renders `aitm config list --effective`: the merged ResolvedConfig with a per-key provenance label,
// so the actual precedence outcome (profile vs global vs env vs default) is visible without starting a
// run and reading the snapshot. One tab-separated `key<TAB>value<TAB>source` row per resolved value,
// in resolution order. The `{ resolved, sources }` pair comes from ConfigLoader.resolveWithSources, so
// values and labels can't drift. Secrets are display-masked here (this output lands in terminals).

import { getDotted } from '../config/dotted-path.ts';
import type { ConfigSourceMap, ResolvedConfig } from '../config/schema.ts';
import type { McpServer } from '../mcp/schema.ts';
import { maskSecret } from './mask-secret.ts';

const HEADER =
  'Effective config — precedence low→high: default < profile < global < project < CLI\n' +
  'key\tvalue\tsource\n';

export function formatEffectiveConfig(resolved: ResolvedConfig, sources: ConfigSourceMap): string {
  const rows: string[] = [];
  for (const [key, source] of Object.entries(sources)) {
    rows.push(
      `${key}\t${formatValue(key, getDotted(resolved as Record<string, unknown>, key.split('.')))}\t${source}`,
    );
  }
  // bashRules is a first-match-wins merge of several layers, not a single-source pick, so it carries
  // no ConfigSource — report the effective count and label it 'merged'.
  rows.push(`bashRules\t${resolved.bashRules.length} rules (first-match-wins)\tmerged`);
  // MCP servers carry their own per-entry provenance (McpServerSource), listed lowest-first by name.
  for (const name of Object.keys(resolved.mcpServers).sort()) {
    const server = resolved.mcpServers[name];
    const src = resolved.mcpServerSources[name] ?? 'unknown';
    rows.push(`mcpServers.${name}\t${server ? transportOf(server) : 'unknown'}\t${src}`);
  }
  return `${HEADER}${rows.join('\n')}\n`;
}

function transportOf(server: McpServer): string {
  return 'type' in server && server.type ? server.type : 'stdio';
}

function formatValue(key: string, value: unknown): string {
  if (key === 'openrouterApiKey' && typeof value === 'string') return maskSecret(value);
  if (key === 'baseURL' && value === undefined) return '(provider default)';
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
