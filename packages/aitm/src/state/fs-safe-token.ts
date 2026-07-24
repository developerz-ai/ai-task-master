// Filesystem-safe token from an arbitrary string (check name, file path, group id) — no
// separators/traversal. Shared by PrContextStore (check names, file paths) and TranscriptStore
// (planner-supplied group ids); both need the same charset restriction so files stay flat and
// collision-free under the state dir.
export function sanitizeFsToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}
