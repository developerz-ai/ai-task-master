// Cycle-safe JSON.stringify, shared by Logger and Compactor (issue #251). SDK message objects and
// log fields can transitively reference each other (tool result -> tool call -> step -> message), and
// a single circular ref would throw a raw TypeError out of the caller and crash the agent loop or a
// log write mid-step. Replace any cycle with the literal "[CYCLE]" so the caller still gets a usable
// string. Only TRUE cycles (a value that is its own ancestor) are replaced: the replacer tracks the
// ancestor chain via JSON.stringify's holder (`this`), because a grow-only seen-set would also mangle
// an object that merely appears twice (shared references are normal in SDK messages).
//
// `replacer` runs first per node so callers can still do their own value transforms (e.g. Logger's
// bigint-to-string) before the cycle check inspects the result.
export function safeStringify(
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, key, v) {
    const resolved = replacer ? replacer(key, v) : v;
    if (resolved !== null && typeof resolved === 'object') {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(resolved)) return '[CYCLE]';
      ancestors.push(resolved);
    }
    return resolved;
  });
}
