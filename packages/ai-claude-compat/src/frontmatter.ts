// Minimal YAML-frontmatter parser for `.claude/` extension files (SKILL.md, agents/*.md).
// Handles only what those files use — scalar strings, flow arrays (`[a, b]`), and block
// sequences (`- a` lines) — so the lib stays dependency-free rather than pulling a full YAML
// engine. Anything outside that shape is ignored, not errored, so a malformed field never
// blocks discovery of the rest.

export type FrontmatterValue = string | string[];
export type Frontmatter = { data: Record<string, FrontmatterValue>; body: string };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = FRONTMATTER.exec(content);
  if (!match) return { data: {}, body: content };
  return { data: parseBlock(match[1] ?? ''), body: match[2] ?? '' };
}

function parseBlock(raw: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const rest = (m[2] ?? '').trim();
    if (rest === '') {
      // A bare `key:` may head a block sequence on the following `- item` lines.
      const items: string[] = [];
      while (i + 1 < lines.length && /^[ \t]*-[ \t]+/.test(lines[i + 1] ?? '')) {
        i += 1;
        items.push(stripQuotes((lines[i] ?? '').replace(/^[ \t]*-[ \t]+/, '').trim()));
      }
      data[key] = items;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()));
    } else {
      data[key] = stripQuotes(rest);
    }
  }
  return data;
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
