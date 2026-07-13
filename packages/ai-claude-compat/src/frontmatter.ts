// Minimal YAML-frontmatter parser for `.claude/` extension files (SKILL.md, agents/*.md) and the
// memory format (issue #118). Handles only what those files use — scalar strings, flow arrays
// (`[a, b]`), block sequences (`- a` lines), one level of nested map (indented `key: value` lines
// under a bare parent key), and block scalars (`key: |` / `key: >`, with `-` chomping — issue #120,
// where multi-line skill descriptions live) — so the lib stays dependency-free rather than pulling a
// full YAML engine. Anything outside that shape is ignored, not errored, so a malformed field never
// blocks discovery of the rest.

export type FrontmatterValue = string | string[] | Record<string, string>;
export type Frontmatter = { data: Record<string, FrontmatterValue>; body: string };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = FRONTMATTER.exec(content);
  if (!match) return { data: {}, body: content };
  return { data: parseBlock(match[1] ?? ''), body: match[2] ?? '' };
}

function parseBlock(raw: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  // Split on CRLF or LF so a Windows-authored / CRLF-checked-out SKILL.md doesn't leave a trailing
  // `\r` on every line — it would fail the key-line match outright and, for block scalars (whose
  // value skips the usual `.trim()`), embed `\r` inside the parsed text.
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const rest = (m[2] ?? '').trim();
    if (BLOCK_SCALAR.test(rest)) {
      // `key: |` / `key: >` head an indented block; the value spans the following more-indented
      // lines. Multi-line skill descriptions (issue #120) are the reason this exists.
      const { value, next } = parseBlockScalar(lines, i, rest);
      data[key] = value;
      i = next - 1;
    } else if (rest === '') {
      // A bare `key:` heads either a nested map (indented `subkey: value` lines) or a block
      // sequence (`- item` lines). An indented `key:` line wins — it's a map, not a sequence item.
      if (/^[ \t]+[A-Za-z0-9_-]+:/.test(lines[i + 1] ?? '')) {
        const map: Record<string, string> = {};
        while (i + 1 < lines.length && /^[ \t]+[A-Za-z0-9_-]+:/.test(lines[i + 1] ?? '')) {
          i += 1;
          const sub = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i] ?? '');
          if (sub) map[sub[1] ?? ''] = stripQuotes((sub[2] ?? '').trim());
        }
        data[key] = map;
      } else {
        const items: string[] = [];
        while (i + 1 < lines.length && /^[ \t]*-[ \t]+/.test(lines[i + 1] ?? '')) {
          i += 1;
          items.push(stripQuotes((lines[i] ?? '').replace(/^[ \t]*-[ \t]+/, '').trim()));
        }
        data[key] = items;
      }
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()));
    } else {
      data[key] = stripQuotes(rest);
    }
  }
  return data;
}

// A block-scalar header is a lone `|` or `>` (literal / folded) with an optional `-` (strip)
// chomping indicator. `key: >text` is a plain scalar, not a block — the header must stand alone.
// `+` (keep) is intentionally unsupported: `>+` fails this match and falls through to the plain
// scalar path rather than being silently treated as clip (its behavior can't be produced here, since
// trailing blank lines are always popped below).
const BLOCK_SCALAR = /^([|>])(-?)$/;

// Consume the indented lines following a `key: |` / `key: >` header into a single string. `folded`
// (`>`) joins lines with spaces and blank lines with newlines; literal (`|`) keeps every newline.
// The block ends at the first non-blank line that dedents to the header's column (the next key) or
// below the block's own indent. Default chomping keeps one trailing newline; `-` strips it.
function parseBlockScalar(
  lines: string[],
  keyIndex: number,
  header: string,
): { value: string; next: number } {
  const folded = header[0] === '>';
  const strip = header[1] === '-';
  const collected: string[] = [];
  let baseIndent = -1;
  let i = keyIndex + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (baseIndent === -1) baseIndent = indent;
    if (indent < baseIndent) break;
    collected.push(line.slice(baseIndent));
  }
  // Trailing blank lines are the separator before the next key, not part of the value.
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  const assembled = assembleBlockScalar(collected, folded);
  const value = strip || assembled === '' ? assembled : `${assembled}\n`;
  return { value, next: i };
}

function assembleBlockScalar(lines: string[], folded: boolean): string {
  if (!folded) return lines.join('\n');
  let out = '';
  for (const line of lines) {
    if (line === '') out += '\n';
    else if (out === '' || out.endsWith('\n')) out += line;
    else out += ` ${line}`;
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s[s.length - 1] === first) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// Coerce a parsed value to a single string (scalars stay; arrays join). Empty when absent.
export function asString(value: FrontmatterValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return '';
}

// Coerce a parsed value to a string list. A scalar splits on commas; absent → undefined.
export function asStringArray(value: FrontmatterValue | undefined): string[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((s) => s.trim());
  }
  return undefined;
}

// Coerce a parsed value to a nested map (issue #118). Scalars, arrays, and absent → undefined.
export function asRecord(value: FrontmatterValue | undefined): Record<string, string> | undefined {
  if (value !== undefined && typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}
