#!/usr/bin/env node
// Minimal MCP stdio server fixture for the SIGINT integration test
// (test/integration/sigint-cancellation.test.ts, plan slice 02-signal-cancellation-cleanup).
//
// Implements just enough of the MCP handshake — initialize, notifications/initialized, tools/list —
// for @ai-sdk/mcp's real client to connect over real stdio and mount zero tools, then idles until
// killed. A genuine `node` process is spawned by McpClientManager (Experimental_StdioMCPTransport),
// not a stub — proving the SIGINT-triggered `mcp.close()` reaps a real child, not an in-memory fake.
//
// Writes its own PID to STUB_MCP_PID_FILE on startup so the test can assert liveness before and
// after cancellation.

import { writeFileSync } from 'node:fs';

const pidFile = process.env.STUB_MCP_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-mcp', version: '0.0.1' },
        },
      });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      return;
    case 'notifications/initialized':
      return; // notification — no response expected
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.trim().length > 0) handleLine(line);
    newlineIndex = buffer.indexOf('\n');
  }
});
// The stdin 'data' listener keeps the event loop alive until the process is killed (SIGTERM from
// the parent's mcp.close() → AbortController → child_process signal option) or stdin closes.
