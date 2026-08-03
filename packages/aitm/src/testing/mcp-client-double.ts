// A stand-in for the AI SDK's MCP client (issue #330).
//
// This is the cast #330 leaves standing, and the reason is worth stating once instead of at four
// call sites. `MCPClient` is the SDK's own interface — a `serverInfo` handshake result, `listTools`,
// `callTool`, elicitation and resource methods, and a `tools<TOOL_SCHEMAS>()` whose return is
// generic over the schema map, so no hand-written object can satisfy it even in principle. The
// manager under test reaches exactly two of those methods (`tools`, `close`), and the tests that use
// this one assert on what the manager does with the listing — never on the protocol.
//
// So the partial is deliberate, the boundary is external, and the narrowing happens here.

import type { MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';

export type McpClientDoubleInit = {
  // What the fake server lists. Default: a server that connects and offers nothing.
  tools?: ToolSet;
  // Called on close(), so a test can assert the manager reaps its clients.
  onClose?: () => void;
};

export function mcpClientDouble(init: McpClientDoubleInit = {}): MCPClient {
  const tools = init.tools ?? {};
  // `tools` is cast at the VALUE, not the object: the method's declared return is McpToolSet<T> for
  // a caller-chosen T, which a concrete ToolSet cannot be. Promise<never> satisfies every T.
  return {
    tools: async () => tools as never,
    close: async () => init.onClose?.(),
  } as never;
}
