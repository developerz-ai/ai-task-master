// Structural probe for "this schema can parse asynchronously".
//
// `Tool.inputSchema` is the AI SDK's `FlexibleSchema`: a union of Zod, the SDK's own JSON-schema
// wrapper, Standard Schema and lazy schemas. Since ai@7.0.170 no member of that union declares
// `parseAsync`, so the `'parseAsync' in schema` narrowing the call sites used degraded the
// property to `unknown` (TS18046) instead of a callable. What matters at runtime is the shape, so
// probe the shape: one guard, shared by every site that parses a tool's input.

export function hasParseAsync<T = unknown>(
  schema: unknown,
): schema is { parseAsync: (data: unknown) => Promise<T> } {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as { parseAsync?: unknown }).parseAsync === 'function'
  );
}
