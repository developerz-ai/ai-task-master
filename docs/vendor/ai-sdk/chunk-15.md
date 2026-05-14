# Model Context Protocol (MCP)

The AI SDK supports connecting to [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers to access their tools, resources, and prompts.
This enables your AI applications to discover and use capabilities across various services through a standardized interface.

<Note>
  If you're using OpenAI's Responses API, you can also use the built-in
  `openai.tools.mcp` tool, which provides direct MCP server integration without
  needing to convert tools. See the [OpenAI provider
  documentation](/providers/ai-sdk-providers/openai#mcp-tool) for details.
</Note>

## Initializing an MCP Client

We recommend using HTTP transport (like `StreamableHTTPClientTransport`) for production deployments. The stdio transport should only be used for connecting to local servers as it cannot be deployed to production environments.

Create an MCP client using one of the following transport options:

- **HTTP transport (Recommended)**: Either configure HTTP directly via the client using `transport: { type: 'http', ... }`, or use MCP's official TypeScript SDK `StreamableHTTPClientTransport`
- SSE (Server-Sent Events): An alternative HTTP-based transport
- `stdio`: For local development only. Uses standard input/output streams for local MCP servers

### HTTP Transport (Recommended)

For production deployments, we recommend using the HTTP transport. You can configure it directly on the client:

```typescript
import { createMCPClient } from '@ai-sdk/mcp';

const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://your-server.com/mcp',

    // optional: configure HTTP headers
    headers: { Authorization: 'Bearer my-api-key' },

    // optional: provide an OAuth client provider for automatic authorization
    authProvider: myOAuthClientProvider,

    // optional: allow redirect responses (default is 'error' to prevent SSRF)
    redirect: 'follow',
  },
});
```

Alternatively, you can use `StreamableHTTPClientTransport` from MCP's official TypeScript SDK:

```typescript
import { createMCPClient } from '@ai-sdk/mcp';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('https://your-server.com/mcp');
const mcpClient = await createMCPClient({
  transport: new StreamableHTTPClientTransport(url, {
    sessionId: 'session_123',
  }),
});
```

### SSE Transport

SSE provides an alternative HTTP-based transport option. Configure it with a `type` and `url` property. You can also provide an `authProvider` for OAuth:

```typescript
import { createMCPClient } from '@ai-sdk/mcp';

const mcpClient = await createMCPClient({
  transport: {
    type: 'sse',
    url: 'https://my-server.com/sse',

    // optional: configure HTTP headers
    headers: { Authorization: 'Bearer my-api-key' },

    // optional: provide an OAuth client provider for automatic authorization
    authProvider: myOAuthClientProvider,

    // optional: allow redirect responses (default is 'error' to prevent SSRF)
    redirect: 'follow',
  },
});
```

### Stdio Transport (Local Servers)

<Note type="warning">
  The stdio transport should only be used for local servers.
</Note>

The Stdio transport can be imported from either the MCP SDK or the AI SDK:

```typescript
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// Or use the AI SDK's stdio transport:
// import { Experimental_StdioMCPTransport as StdioClientTransport } from '@ai-sdk/mcp/mcp-stdio';

const mcpClient = await createMCPClient({
  transport: new StdioClientTransport({
    command: 'node',
    args: ['src/stdio/dist/server.js'],
  }),
});
```

### Custom Transport

You can also bring your own transport by implementing the `MCPTransport` interface for specific requirements not covered by the standard transports.

<Note>
  The client returned by the `createMCPClient` function is a
  lightweight client intended for use in tool conversion. It currently does not
  support all features of the full MCP client, such as: session
  management, resumable streams, and receiving notifications.

Authorization via OAuth is supported when using the AI SDK MCP HTTP or SSE
transports by providing an `authProvider`.

</Note>

### Closing the MCP Client

After initialization, you should close the MCP client based on your usage pattern:

- For short-lived usage (e.g., single requests), close the client when the response is finished
- For long-running clients (e.g., command line apps), keep the client open but ensure it's closed when the application terminates

When streaming responses, you can close the client when the LLM response has finished. For example, when using `streamText`, you should use the `onFinish` callback:

```typescript
const mcpClient = await createMCPClient({
  // ...
});

const tools = await mcpClient.tools();

const result = await streamText({
  model: __MODEL__,
  tools,
  prompt: 'What is the weather in Brooklyn, New York?',
  onFinish: async () => {
    await mcpClient.close();
  },
});
```

When generating responses without streaming, you can use try/finally or cleanup functions in your framework:

```typescript
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';

let mcpClient: MCPClient | undefined;

try {
  mcpClient = await createMCPClient({
    // ...
  });
} finally {
  await mcpClient?.close();
}
```

## Using MCP Tools

The client's `tools` method acts as an adapter between MCP tools and AI SDK tools. It supports two approaches for working with tool schemas:

### Schema Discovery

With schema discovery, all tools offered by the server are automatically listed, and input parameter types are inferred based on the schemas provided by the server:

```typescript
const tools = await mcpClient.tools();
```

This approach is simpler to implement and automatically stays in sync with server changes. However, you won't have TypeScript type safety during development, and all tools from the server will be loaded

### Schema Definition

For better type safety and control, you can define the tools and their input schemas explicitly in your client code:

```typescript
import { z } from 'zod';

const tools = await mcpClient.tools({
  schemas: {
    'get-data': {
      inputSchema: z.object({
        query: z.string().describe('The data query'),
        format: z.enum(['json', 'text']).optional(),
      }),
    },
    // For tools with zero inputs, you should use an empty object:
    'tool-with-no-args': {
      inputSchema: z.object({}),
    },
  },
});
```

This approach provides full TypeScript type safety and IDE autocompletion, letting you catch parameter mismatches during development. When you define `schemas`, the client only pulls the explicitly defined tools, keeping your application focused on the tools it needs

### Typed Tool Outputs

When MCP servers return `structuredContent` (per the [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)), you can define an `outputSchema` to get typed tool results:

```typescript
import { z } from 'zod';

const tools = await mcpClient.tools({
  schemas: {
    'get-weather': {
      inputSchema: z.object({
        location: z.string(),
      }),
      // Define outputSchema for typed results
      outputSchema: z.object({
        temperature: z.number(),
        conditions: z.string(),
        humidity: z.number(),
      }),
    },
  },
});

const result = await tools['get-weather'].execute(
  { location: 'New York' },
  { messages: [], toolCallId: 'weather-1' },
);

console.log(`Temperature: ${result.temperature}°C`);
```

When `outputSchema` is provided:

- The client extracts `structuredContent` from the tool result
- The output is validated against your schema at runtime
- You get full TypeScript type safety for the result

If the server doesn't return `structuredContent`, the client falls back to parsing JSON from the text content. If neither is available or validation fails, an error is thrown.

<Note>
  Without `outputSchema`, the tool returns the raw `CallToolResult` object
  containing `content` and optional `isError` fields.
</Note>

## Using MCP Resources

According to the [MCP specification](https://modelcontextprotocol.io/docs/learn/server-concepts#resources), resources are **application-driven** data sources that provide context to the model. Unlike tools (which are model-controlled), your application decides when to fetch and pass resources as context.

The MCP client provides three methods for working with resources:

### Listing Resources

List all available resources from the MCP server:

```typescript
const resources = await mcpClient.listResources();
```

### Reading Resource Contents

Read the contents of a specific resource by its URI:

```typescript
const resourceData = await mcpClient.readResource({
  uri: 'file:///example/document.txt',
});
```

### Listing Resource Templates

Resource templates are dynamic URI patterns that allow flexible queries. List all available templates:

```typescript
const templates = await mcpClient.listResourceTemplates();
```

## Using MCP Prompts

<Note type="warning">
  MCP Prompts is an experimental feature and may change in the future.
</Note>

According to the MCP specification, prompts are user-controlled templates that servers expose for clients to list and retrieve with optional arguments.

### Listing Prompts

```typescript
const prompts = await mcpClient.experimental_listPrompts();
```

### Getting a Prompt

Retrieve prompt messages, optionally passing arguments defined by the server:

```typescript
const prompt = await mcpClient.experimental_getPrompt({
  name: 'code_review',
  arguments: { code: 'function add(a, b) { return a + b; }' },
});
```

## Handling Elicitation Requests

Elicitation is a mechanism where MCP servers can request additional information from the client during tool execution. For example, a server might need user input to complete a registration form or confirmation for a sensitive operation.

<Note type="warning">
  It is up to the client application to handle elicitation requests properly.
  The MCP client simply surfaces these requests from the server to your
  application code.
</Note>

### Enabling Elicitation Support

To enable elicitation, you need to advertise the capability when creating the MCP client:

```typescript
const mcpClient = await createMCPClient({
  transport: {
    type: 'sse',
    url: 'https://your-server.com/sse',
  },
  capabilities: {
    elicitation: {},
  },
});
```

### Registering an Elicitation Handler

Use the `onElicitationRequest` method to register a handler that will be called when the server requests input:

```typescript
import { ElicitationRequestSchema } from '@ai-sdk/mcp';

mcpClient.onElicitationRequest(ElicitationRequestSchema, async request => {
  // request.params.message: A message describing what input is needed
  // request.params.requestedSchema: JSON schema defining the expected input structure

  // Get input from the user (implement according to your application's needs)
  const userInput = await getInputFromUser(
    request.params.message,
    request.params.requestedSchema,
  );

  // Return the result with one of three actions:
  return {
    action: 'accept', // or 'decline' or 'cancel'
    content: userInput, // only required when action is 'accept'
  };
});
```

### Elicitation Response Actions

Your handler must return an object with an `action` field that can be one of:

- `'accept'`: User provided the requested information. Must include `content` with the data.
- `'decline'`: User chose not to provide the information.
- `'cancel'`: User cancelled the operation entirely.

## Examples

You can see MCP in action in the following examples:

<ExampleLinks
  examples={[
    {
      title: 'Learn to use MCP tools in Node.js',
      link: '/cookbook/node/mcp-tools',
    },
    {
      title: 'Learn to handle MCP elicitation requests in Node.js',
      link: '/cookbook/node/mcp-elicitation',
    },
  ]}
/>

---
title: Prompt Engineering
description: Learn how to develop prompts with AI SDK Core.
---

# Prompt Engineering

## Tips

### Prompts for Tools

When you create prompts that include tools, getting good results can be tricky as the number and complexity of your tools increases.

Here are a few tips to help you get the best results:

1. Use a model that is strong at tool calling, such as `gpt-5` or `gpt-4.1`. Weaker models will often struggle to call tools effectively and flawlessly.
1. Keep the number of tools low, e.g. to 5 or less.
1. Keep the complexity of the tool parameters low. Complex Zod schemas with many nested and optional elements, unions, etc. can be challenging for the model to work with.
1. Use semantically meaningful names for your tools, parameters, parameter properties, etc. The more information you pass to the model, the better it can understand what you want.
1. Add `.describe("...")` to your Zod schema properties to give the model hints about what a particular property is for.
1. When the output of a tool might be unclear to the model and there are dependencies between tools, use the `description` field of a tool to provide information about the output of the tool execution.
1. You can include example input/outputs of tool calls in your prompt to help the model understand how to use the tools. Keep in mind that the tools work with JSON objects, so the examples should use JSON.

In general, the goal should be to give the model all information it needs in a clear way.

### Tool & Structured Data Schemas

The mapping from Zod schemas to LLM inputs (typically JSON schema) is not always straightforward, since the mapping is not one-to-one.

#### Zod Dates

Zod expects JavaScript Date objects, but models return dates as strings.
You can specify and validate the date format using `z.string().datetime()` or `z.string().date()`,
and then use a Zod transformer to convert the string to a Date object.

```ts highlight="8-11"
const result = await generateText({
  model: __MODEL__,
  output: Output.object({
    schema: z.object({
      events: z.array(
        z.object({
          event: z.string(),
          date: z
            .string()
            .date()
            .transform(value => new Date(value)),
        }),
      ),
    }),
  }),
  prompt: 'List 5 important events from the year 2000.',
});
```

#### Optional Parameters

When working with tools that have optional parameters, you may encounter compatibility issues with certain providers that use strict schema validation.

<Note>
  This is particularly relevant for OpenAI models with structured outputs
  (strict mode).
</Note>

For maximum compatibility, optional parameters should use `.nullable()` instead of `.optional()`:

```ts highlight="6,7,16,17"
// This may fail with strict schema validation
const failingTool = tool({
  description: 'Execute a command',
  inputSchema: z.object({
    command: z.string(),
    workdir: z.string().optional(), // This can cause errors
    timeout: z.string().optional(),
  }),
});

// This works with strict schema validation
const workingTool = tool({
  description: 'Execute a command',
  inputSchema: z.object({
    command: z.string(),
    workdir: z.string().nullable(), // Use nullable instead
    timeout: z.string().nullable(),
  }),
});
```

#### Temperature Settings

For tool calls and object generation, it's recommended to use `temperature: 0` to ensure deterministic and consistent results:

```ts highlight="3"
const result = await generateText({
  model: __MODEL__,
  temperature: 0, // Recommended for tool calls
  tools: {
    myTool: tool({
      description: 'Execute a command',
      inputSchema: z.object({
        command: z.string(),
      }),
    }),
  },
  prompt: 'Execute the ls command',
});
```

Lower temperature values reduce randomness in model outputs, which is particularly important when the model needs to:

- Generate structured data with specific formats
- Make precise tool calls with correct parameters
- Follow strict schemas consistently

## Debugging

### Inspecting Warnings

Not all providers support all AI SDK features.
Providers either throw exceptions or return warnings when they do not support a feature.
To check if your prompt, tools, and settings are handled correctly by the provider, you can check the call warnings:

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Hello, world!',
});

console.log(result.warnings);
```

### HTTP Request Bodies

You can inspect the raw HTTP request bodies for models that expose them, e.g. [OpenAI](/providers/ai-sdk-providers/openai).
This allows you to inspect the exact payload that is sent to the model provider in the provider-specific way.

Request bodies are available via the `request.body` property of the response:

```ts highlight="6"
const result = await generateText({
  model: __MODEL__,
  prompt: 'Hello, world!',
});

console.log(result.request.body);
```

---
title: Settings
description: Learn how to configure the AI SDK.
---

# Settings

Large language models (LLMs) typically provide settings to augment their output.

All AI SDK functions support the following common settings in addition to the model, the [prompt](./prompts), and additional provider-specific settings:

```ts highlight="3-6"
const result = await generateText({
  model: __MODEL__,
  maxOutputTokens: 512,
  temperature: 0.3,
  maxRetries: 5,
  timeout: 10000,
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

<Note>
  Some providers do not support all common settings. If you use a setting with a
  provider that does not support it, a warning will be generated. You can check
  the `warnings` property in the result object to see if any warnings were
  generated.
</Note>

## Language Model Call Options

Language model call options (`LanguageModelCallOptions`) are settings that influence how the language model generates its response — token limits, sampling behavior, penalties, stop sequences, seed, and reasoning. They are forwarded to the underlying model.

### `maxOutputTokens`

Maximum number of tokens to generate.

### `temperature`

Temperature setting.

The value is passed through to the provider. The range depends on the provider and model.
For most providers, `0` means almost deterministic results, and higher values mean more randomness.

It is recommended to set either `temperature` or `topP`, but not both.

<Note>In AI SDK 5.0, temperature is no longer set to `0` by default.</Note>

### `topP`

Nucleus sampling.

The value is passed through to the provider. The range depends on the provider and model.
For most providers, nucleus sampling is a number between 0 and 1.
E.g. 0.1 would mean that only tokens with the top 10% probability mass are considered.

It is recommended to set either `temperature` or `topP`, but not both.

### `topK`

Only sample from the top K options for each subsequent token.

Used to remove "long tail" low probability responses.
Recommended for advanced use cases only. You usually only need to use `temperature`.

### `presencePenalty`

The presence penalty affects the likelihood of the model to repeat information that is already in the prompt.

The value is passed through to the provider. The range depends on the provider and model.
For most providers, `0` means no penalty.

### `frequencyPenalty`

The frequency penalty affects the likelihood of the model to repeatedly use the same words or phrases.

The value is passed through to the provider. The range depends on the provider and model.
For most providers, `0` means no penalty.

### `stopSequences`

The stop sequences to use for stopping the text generation.

If set, the model will stop generating text when one of the stop sequences is generated.
Providers may have limits on the number of stop sequences.

### `seed`

It is the seed (integer) to use for random sampling.
If set and supported by the model, calls will generate deterministic results.

### `reasoning`

Controls how much reasoning the model performs before generating a response.

| Value                | Behavior                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `'provider-default'` | Use the provider's default reasoning behavior (default when omitted) |
| `'none'`             | Disable reasoning                                                    |
| `'minimal'`          | Bare-minimum reasoning                                               |
| `'low'`              | Fast, concise reasoning                                              |
| `'medium'`           | Balanced reasoning                                                   |
| `'high'`             | Thorough reasoning                                                   |
| `'xhigh'`            | Maximum reasoning                                                    |

If you also set reasoning-related options in `providerOptions` (e.g. `openai.reasoningEffort` or `anthropic.thinking`), the provider-specific options take precedence and the top-level `reasoning` parameter is ignored.

See the [reasoning guide](/docs/ai-sdk-core/reasoning) for details on per-provider mapping and migration from `providerOptions`.

## Request Options

Request options (`RequestOptions`) are settings that affect transport, retries, cancellation, and timeouts — not model generation behavior. They control how the SDK communicates with the provider's API.

### `maxRetries`

Maximum number of retries. Set to 0 to disable retries. Default: `2`.

### `abortSignal`

An optional abort signal that can be used to cancel the call.

The abort signal can e.g. be forwarded from a user interface to cancel the call,
or to define a timeout using `AbortSignal.timeout`.

#### Example: AbortSignal.timeout

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  abortSignal: AbortSignal.timeout(5000), // 5 seconds
});
```

### `timeout`

An optional timeout in milliseconds. The call will be aborted if it takes longer than the specified duration.

This is a convenience parameter that creates an abort signal internally. It can be used alongside `abortSignal` - if both are provided, the call will abort when either condition is met.

You can specify the timeout either as a number (milliseconds) or as an object with the following properties:

- `totalMs`: The total timeout for the entire call including all steps.
- `stepMs`: The timeout for each individual step (LLM call). This is useful for multi-step generations where you want to limit the time spent on each step independently.
- `chunkMs`: The timeout between stream chunks (streaming only). The call will abort if no new chunk is received within this duration. This is useful for detecting stalled streams.
- `toolMs`: The default timeout for all tool executions. If a tool takes longer, it aborts and returns a tool-error so the model can respond or retry.
- `tools`: Per-tool timeout overrides using `{toolName}Ms` keys (e.g. `weatherMs`, `slowApiMs`). Takes precedence over `toolMs`. Tool names are type-checked for autocomplete.

#### Example: 5 second timeout (number format)

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  timeout: 5000, // 5 seconds
});
```

#### Example: 5 second total timeout (object format)

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  timeout: { totalMs: 5000 }, // 5 seconds
});
```

#### Example: 10 second step timeout

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  timeout: { stepMs: 10000 }, // 10 seconds per step
});
```

#### Example: Combined total and step timeout

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  timeout: {
    totalMs: 60000, // 60 seconds total
    stepMs: 10000, // 10 seconds per step
  },
});
```

#### Example: Per-chunk timeout for streaming (streamText only)

```ts
const result = streamText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  timeout: { chunkMs: 5000 }, // abort if no chunk received for 5 seconds
});
```

#### Example: Tool execution timeout

```ts
const result = await generateText({
  model: __MODEL__,
  tools: { weather: weatherTool, slowApi: slowApiTool },
  timeout: {
    toolMs: 5000, // 5 seconds default for all tools
  },
  prompt: 'What is the weather in San Francisco?',
});
```

#### Example: Per-tool timeout overrides

```ts
const result = await generateText({
  model: __MODEL__,
  tools: { weather: weatherTool, slowApi: slowApiTool },
  timeout: {
    toolMs: 5000, // default for all tools
    tools: {
      weatherMs: 3000, // 3 seconds for weather tool
      slowApiMs: 10000, // 10 seconds for slow API tool
    },
  },
  prompt: 'What is the weather in San Francisco?',
});
```

### `headers`

Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

You can use the request headers to provide additional information to the provider,
depending on what the provider supports. For example, some observability providers support
headers such as `Prompt-Id`.

```ts
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  headers: {
    'Prompt-Id': 'my-prompt-id',
  },
});
```

<Note>
  The `headers` setting is for request-specific headers. You can also set
  `headers` in the provider configuration. These headers will be sent with every
  request made by the provider.
</Note>

---
title: Reasoning
description: Learn how to control reasoning across providers with the top-level reasoning parameter.
---

# Reasoning

Many language models support an internal "reasoning" phase (sometimes also called "thinking") before producing a response. The AI SDK provides a top-level `reasoning` parameter on [`generateText`](/docs/reference/ai-sdk-core/generate-text) and [`streamText`](/docs/reference/ai-sdk-core/stream-text) that controls this behavior across providers with a single, portable setting.

## Basic Usage

```ts
import { generateText } from 'ai';

const { text, reasoning, reasoningText } = await generateText({
  model: 'anthropic/claude-sonnet-4.6,
  reasoning: 'medium',
  prompt: 'How many people will live in the world in 2040?',
});
```

The `reasoning` parameter accepts the following values:

| Value                | Behavior                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `'provider-default'` | Use the provider's default reasoning behavior (default when omitted) |
| `'none'`             | Disable reasoning                                                    |
| `'minimal'`          | Bare-minimum reasoning                                               |
| `'low'`              | Fast, concise reasoning                                              |
| `'medium'`           | Balanced reasoning                                                   |
| `'high'`             | Thorough reasoning                                                   |
| `'xhigh'`            | Maximum reasoning                                                    |

## Streaming

The `reasoning` parameter works the same way with `streamText`:

```ts
import { streamText } from 'ai';

const result = streamText({
  model: 'google/gemini-3-flash-preview',
  reasoning: 'high',
  prompt: 'Explain the Riemann hypothesis in simple terms.',
});

for await (const part of result.fullStream) {
  if (part.type === 'reasoning') {
    process.stdout.write(part.textDelta);
  } else if (part.type === 'text-delta') {
    process.stdout.write(part.textDelta);
  }
}
```

## Precedence Rules

The top-level `reasoning` parameter and provider-specific `providerOptions` are **never merged**. If you set reasoning-related options in `providerOptions`, they take full precedence and the top-level `reasoning` parameter is ignored.

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai.responses('gpt-5.4'),
  reasoning: 'low', // ignored because providerOptions.openai.reasoningEffort is set
  providerOptions: {
    openai: {
      reasoningEffort: 'high', // this wins
    },
  },
  prompt: 'Explain quantum entanglement.',
});
```

This design lets you use the portable `reasoning` parameter by default and fall back to `providerOptions` only when you need provider-specific features like exact token budgets.

## Provider Support

The `reasoning` parameter is supported by the following providers: OpenAI, Anthropic, Google, xAI, Groq, DeepSeek, Fireworks, and Amazon Bedrock. Each provider translates the value to its native reasoning API. Some providers support all six levels natively, while others coerce to fewer levels (a warning is emitted when coercion occurs). Some providers use a numeric token budget instead of an enum for reasoning control; in those cases the top-level `reasoning` value is mapped to a budget calculated as a percentage of the model's maximum output tokens.

Providers that do not support reasoning (e.g. Mistral, Perplexity, Cohere) emit an `unsupported` warning and ignore the parameter.

## Migrating from `providerOptions`

If you currently control reasoning via `providerOptions`, you can migrate to the top-level `reasoning` parameter for portability across providers.

### Before (Anthropic)

```ts
const { text } = await generateText({
  model: anthropic('claude-opus-4.6'),
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive', effort: 'high' },
    },
  },
  prompt: 'How many people will live in the world in 2040?',
});
```

### After (Anthropic)

```ts
const { text } = await generateText({
  model: anthropic('claude-opus-4.6'),
  reasoning: 'high',
  prompt: 'How many people will live in the world in 2040?',
});
```

### Before (Anthropic with older model)

```ts
const { text } = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    },
  },
  prompt: 'How many people will live in the world in 2040?',
});
```

### After (Anthropic with older model)

```ts
const { text } = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  reasoning: 'medium',
  prompt: 'How many people will live in the world in 2040?',
});
```

If you need to enforce an exact token budget (e.g. exactly 12000 tokens), keep using `providerOptions` instead of the top-level `reasoning` parameter.

### Before (Google with `includeThoughts`)

```ts
const { text } = await generateText({
  model: google('gemini-3-flash-preview'),
  providerOptions: {
    google: {
      thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
    },
  },
  prompt: 'Explain the Riemann hypothesis in simple terms.',
});
```

### After (Google with `includeThoughts`)

```ts
const { text } = await generateText({
  model: google('gemini-3-flash-preview'),
  reasoning: 'medium',
  providerOptions: {
    google: { thinkingConfig: { includeThoughts: true } },
  },
  prompt: 'Explain the Riemann hypothesis in simple terms.',
});
```

### Before (OpenAI with `reasoningSummary`)

```ts
const { text } = await generateText({
  model: openai.responses('o3'),
  providerOptions: {
    openai: { reasoningEffort: 'high', reasoningSummary: 'auto' },
  },
  prompt: 'Explain quantum entanglement.',
});
```

### After (OpenAI with `reasoningSummary`)

```ts
const { text } = await generateText({
  model: openai.responses('o3'),
  reasoning: 'high',
  providerOptions: {
    openai: { reasoningSummary: 'auto' },
  },
  prompt: 'Explain quantum entanglement.',
});
```

Note that `providerOptions` can still be used alongside `reasoning` for provider-specific features unrelated to reasoning effort. However, if `providerOptions` includes reasoning effort/budget settings (e.g. `reasoningEffort`, `thinking`, `thinkingConfig.thinkingBudget`), those take full precedence and the top-level `reasoning` parameter is ignored.

---
title: Embeddings
description: Learn how to embed values with the AI SDK.
---

# Embeddings

Embeddings are a way to represent words, phrases, or images as vectors in a high-dimensional space.
In this space, similar words are close to each other, and the distance between words can be used to measure their similarity.

## Embedding a Single Value

The AI SDK provides the [`embed`](/docs/reference/ai-sdk-core/embed) function to embed single values, which is useful for tasks such as finding similar words
or phrases or clustering text.
You can use it with embeddings models, e.g. `openai.embeddingModel('text-embedding-3-large')` or `mistral.embeddingModel('mistral-embed')`.

```tsx
import { embed } from 'ai';

// 'embedding' is a single embedding object (number[])
const { embedding } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
});
```

## Embedding Many Values

When loading data, e.g. when preparing a data store for retrieval-augmented generation (RAG),
it is often useful to embed many values at once (batch embedding).

The AI SDK provides the [`embedMany`](/docs/reference/ai-sdk-core/embed-many) function for this purpose.
Similar to `embed`, you can use it with embeddings models,
e.g. `openai.embeddingModel('text-embedding-3-large')` or `mistral.embeddingModel('mistral-embed')`.

```tsx
import { embedMany } from 'ai';

// 'embeddings' is an array of embedding objects (number[][]).
// It is sorted in the same order as the input values.
const { embeddings } = await embedMany({
  model: 'openai/text-embedding-3-small',
  values: [
    'sunny day at the beach',
    'rainy afternoon in the city',
    'snowy night in the mountains',
  ],
});
```

## Embedding Similarity

After embedding values, you can calculate the similarity between them using the [`cosineSimilarity`](/docs/reference/ai-sdk-core/cosine-similarity) function.
This is useful to e.g. find similar words or phrases in a dataset.
You can also rank and filter related items based on their similarity.

```ts highlight={"1,9"}
import { cosineSimilarity, embedMany } from 'ai';

const { embeddings } = await embedMany({
  model: 'openai/text-embedding-3-small',
  values: ['sunny day at the beach', 'rainy afternoon in the city'],
});

console.log(
  `cosine similarity: ${cosineSimilarity(embeddings[0], embeddings[1])}`,
);
```

## Token Usage

Many providers charge based on the number of tokens used to generate embeddings.
Both `embed` and `embedMany` provide token usage information in the `usage` property of the result object:

```ts highlight={"3,8"}
import { embed } from 'ai';

const { embedding, usage } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
});

console.log(usage); // { tokens: 10 }
```

## Settings

### Provider Options

Embedding model settings can be configured using `providerOptions` for provider-specific parameters:

```ts highlight={"4-8"}
import { embed } from 'ai';

const { embedding } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
  providerOptions: {
    openai: {
      dimensions: 512, // Reduce embedding dimensions
    },
  },
});
```

### Parallel Requests

The `embedMany` function now supports parallel processing with configurable `maxParallelCalls` to optimize performance:

```ts highlight={"3"}
import { embedMany } from 'ai';

const { embeddings, usage } = await embedMany({
  maxParallelCalls: 2, // Limit parallel requests
  model: 'openai/text-embedding-3-small',
  values: [
    'sunny day at the beach',
    'rainy afternoon in the city',
    'snowy night in the mountains',
  ],
});
```

### Retries

Both `embed` and `embedMany` accept an optional `maxRetries` parameter of type `number`
that you can use to set the maximum number of retries for the embedding process.
It defaults to `2` retries (3 attempts in total). You can set it to `0` to disable retries.

```ts highlight={"6"}
import { embed } from 'ai';

const { embedding } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
  maxRetries: 0, // Disable retries
});
```

### Abort Signals and Timeouts

Both `embed` and `embedMany` accept an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the embedding process or set a timeout.

```ts highlight={"6"}
import { embed } from 'ai';

const { embedding } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

Both `embed` and `embedMany` accept an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the embedding request.

```ts highlight={"6"}
import { embed } from 'ai';

const { embedding } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

## Response Information

Both `embed` and `embedMany` return response information that includes the raw provider response:

```ts highlight={"3,8"}
import { embed } from 'ai';

const { embedding, response } = await embed({
  model: 'openai/text-embedding-3-small',
  value: 'sunny day at the beach',
});

console.log(response); // Raw provider response
```

## Embedding Middleware

You can enhance embedding models, e.g. to set default values, using
`wrapEmbeddingModel` and `EmbeddingModelMiddleware`.

Here is an example that uses the built-in `defaultEmbeddingSettingsMiddleware`:

```ts
import {
  defaultEmbeddingSettingsMiddleware,
  embed,
  wrapEmbeddingModel,
  gateway,
} from 'ai';

const embeddingModelWithDefaults = wrapEmbeddingModel({
  model: gateway.embeddingModel('google/gemini-embedding-001'),
  middleware: defaultEmbeddingSettingsMiddleware({
    settings: {
      providerOptions: {
        google: {
          outputDimensionality: 256,
          taskType: 'CLASSIFICATION',
        },
      },
    },
  }),
});
```

## Embedding Providers & Models

Several providers offer embedding models:

| Provider                                                                                  | Model                           | Embedding Dimensions | Multimodal          |
| ----------------------------------------------------------------------------------------- | ------------------------------- | -------------------- | ------------------- |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-3-large`        | 3072                 | <Cross size={18} /> |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-3-small`        | 1536                 | <Cross size={18} /> |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-ada-002`        | 1536                 | <Cross size={18} /> |
| [Google](/providers/ai-sdk-providers/google#embedding-models)                             | `gemini-embedding-001`          | 3072                 | <Cross size={18} /> |
| [Google](/providers/ai-sdk-providers/google#embedding-models)                             | `gemini-embedding-2-preview`    | 3072                 | <Check size={18} /> |
| [Mistral](/providers/ai-sdk-providers/mistral#embedding-models)                           | `mistral-embed`                 | 1024                 | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-v3.0`            | 1024                 | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-v3.0`       | 1024                 | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-light-v3.0`      | 384                  | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-light-v3.0` | 384                  | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-v2.0`            | 4096                 | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-light-v2.0`      | 1024                 | <Cross size={18} /> |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-v2.0`       | 768                  | <Cross size={18} /> |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#embedding-models)             | `amazon.titan-embed-text-v1`    | 1536                 | <Cross size={18} /> |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#embedding-models)             | `amazon.titan-embed-text-v2:0`  | 1024                 | <Cross size={18} /> |

---
title: Reranking
description: Learn how to rerank documents with the AI SDK.
---

# Reranking

Reranking is a technique used to improve search relevance by reordering a set of documents based on their relevance to a query.
Unlike embedding-based similarity search, reranking models are specifically trained to understand the relationship between queries and documents,
often producing more accurate relevance scores.

## Reranking Documents

The AI SDK provides the [`rerank`](/docs/reference/ai-sdk-core/rerank) function to rerank documents based on their relevance to a query.
You can use it with reranking models, e.g. `cohere.reranking('rerank-v3.5')` or `bedrock.reranking('cohere.rerank-v3-5:0')`.

```tsx
import { rerank } from 'ai';
import { cohere } from '@ai-sdk/cohere';

const documents = [
  'sunny day at the beach',
  'rainy afternoon in the city',
  'snowy night in the mountains',
];

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents,
  query: 'talk about rain',
  topN: 2, // Return top 2 most relevant documents
});

console.log(ranking);
// [
//   { originalIndex: 1, score: 0.9, document: 'rainy afternoon in the city' },
//   { originalIndex: 0, score: 0.3, document: 'sunny day at the beach' }
// ]
```

## Working with Object Documents

Reranking also supports structured documents (JSON objects), making it ideal for searching through databases, emails, or other structured content:

```tsx
import { rerank } from 'ai';
import { cohere } from '@ai-sdk/cohere';

const documents = [
  {
    from: 'Paul Doe',
    subject: 'Follow-up',
    text: 'We are happy to give you a discount of 20% on your next order.',
  },
  {
    from: 'John McGill',
    subject: 'Missing Info',
    text: 'Sorry, but here is the pricing information from Oracle: $5000/month',
  },
];

const { ranking, rerankedDocuments } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents,
  query: 'Which pricing did we get from Oracle?',
  topN: 1,
});

console.log(rerankedDocuments[0]);
// { from: 'John McGill', subject: 'Missing Info', text: '...' }
```

## Understanding the Results

The `rerank` function returns a comprehensive result object:

```ts
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking, rerankedDocuments, originalDocuments } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
});

// ranking: sorted array of { originalIndex, score, document }
// rerankedDocuments: documents sorted by relevance (convenience property)
// originalDocuments: original documents array
```

Each item in the `ranking` array contains:

- `originalIndex`: Position in the original documents array
- `score`: Relevance score (typically 0-1, where higher is more relevant)
- `document`: The original document

## Settings

### Top-N Results

Use `topN` to limit the number of results returned. This is useful for retrieving only the most relevant documents:

```ts highlight={"7"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['doc1', 'doc2', 'doc3', 'doc4', 'doc5'],
  query: 'relevant information',
  topN: 3, // Return only top 3 most relevant documents
});
```

### Provider Options

Reranking model settings can be configured using `providerOptions` for provider-specific parameters:

```ts highlight={"8-12"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  providerOptions: {
    cohere: {
      maxTokensPerDoc: 1000, // Limit tokens per document
    },
  },
});
```

### Retries

The `rerank` function accepts an optional `maxRetries` parameter of type `number`
that you can use to set the maximum number of retries for the reranking process.
It defaults to `2` retries (3 attempts in total). You can set it to `0` to disable retries.

```ts highlight={"7"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  maxRetries: 0, // Disable retries
});
```

### Abort Signals and Timeouts

The `rerank` function accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the reranking process or set a timeout.

```ts highlight={"7"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  abortSignal: AbortSignal.timeout(5000), // Abort after 5 seconds
});
```

### Custom Headers

The `rerank` function accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the reranking request.

```ts highlight={"7"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

## Response Information

The `rerank` function returns response information that includes the raw provider response:

```ts highlight={"4,10"}
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking, response } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
});

console.log(response); // { id, timestamp, modelId, headers, body }
```

## Reranking Providers & Models

Several providers offer reranking models:

| Provider                                                                      | Model                                 |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| [Cohere](/providers/ai-sdk-providers/cohere#reranking-models)                 | `rerank-v3.5`                         |
| [Cohere](/providers/ai-sdk-providers/cohere#reranking-models)                 | `rerank-english-v3.0`                 |
| [Cohere](/providers/ai-sdk-providers/cohere#reranking-models)                 | `rerank-multilingual-v3.0`            |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#reranking-models) | `amazon.rerank-v1:0`                  |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#reranking-models) | `cohere.rerank-v3-5:0`                |
| [Together.ai](/providers/ai-sdk-providers/togetherai#reranking-models)        | `Salesforce/Llama-Rank-v1`            |
| [Together.ai](/providers/ai-sdk-providers/togetherai#reranking-models)        | `mixedbread-ai/Mxbai-Rerank-Large-V2` |

---
title: Image Generation
description: Learn how to generate images with the AI SDK.
---

# Image Generation

The AI SDK provides the [`generateImage`](/docs/reference/ai-sdk-core/generate-image)
function to generate images based on a given prompt using an image model.

```tsx
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
});
```

You can access the image data using the `base64` or `uint8Array` properties:

```tsx
const base64 = image.base64; // base64 image data
const uint8Array = image.uint8Array; // Uint8Array image data
```

## Settings

### Size and Aspect Ratio

Depending on the model, you can either specify the size or the aspect ratio.

##### Size

The size is specified as a string in the format `{width}x{height}`.
Models only support a few sizes, and the supported sizes are different for each model and provider.

```tsx highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  size: '1024x1024',
});
```

##### Aspect Ratio

The aspect ratio is specified as a string in the format `{width}:{height}`.
Models only support a few aspect ratios, and the supported aspect ratios are different for each model and provider.

```tsx highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  aspectRatio: '16:9',
});
```

### Generating Multiple Images

`generateImage` also supports generating multiple images at once:

```tsx highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { images } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  n: 4, // number of images to generate
});
```

<Note>
  `generateImage` will automatically call the model as often as needed (in
  parallel) to generate the requested number of images.
</Note>

Each image model has an internal limit on how many images it can generate in a single API call. The AI SDK manages this automatically by batching requests appropriately when you request multiple images using the `n` parameter. By default, the SDK uses provider-documented limits (for example, DALL-E 3 can only generate 1 image per call, while DALL-E 2 supports up to 10).

If needed, you can override this behavior using the `maxImagesPerCall` setting when generating your image. This is particularly useful when working with new or custom models where the default batch size might not be optimal:

```tsx
const { images } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  maxImagesPerCall: 5, // Override the default batch size
  n: 10, // Will make 2 calls of 5 images each
});
```

### Providing a Seed

You can provide a seed to the `generateImage` function to control the output of the image generation process.
If supported by the model, the same seed will always produce the same image.

```tsx highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  seed: 1234567890,
});
```

### Provider-specific Settings

Image models often have provider- or even model-specific settings.
You can pass such settings to the `generateImage` function
using the `providerOptions` parameter. The options for the provider
(`openai` in the example below) become request body properties.

```tsx highlight={"9"}
import { generateImage } from 'ai';
import { openai } from '@ai-sdk/openai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt: 'Santa Claus driving a Cadillac',
  size: '1024x1024',
  providerOptions: {
    openai: { style: 'vivid', quality: 'hd' },
  },
});
```

### Abort Signals and Timeouts

`generateImage` accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the image generation process or set a timeout.

```ts highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

`generateImage` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the image generation request.

```ts highlight={"7"}
import { generateImage } from 'ai';
__PROVIDER_IMPORT__;

const { image } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

### Warnings

If the model returns warnings, e.g. for unsupported parameters, they will be available in the `warnings` property of the response.

```tsx
const { image, warnings } = await generateImage({
  model: __IMAGE_MODEL__,
  prompt: 'Santa Claus driving a Cadillac',
});
```

### Additional provider-specific meta data

Some providers expose additional meta data for the result overall or per image.

```tsx
const prompt = 'Santa Claus driving a Cadillac';

const { image, providerMetadata } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt,
});

const revisedPrompt = providerMetadata.openai.images[0]?.revisedPrompt;

console.log({
  prompt,
  revisedPrompt,
});
```

The outer key of the returned `providerMetadata` is the provider name. The inner values are the metadata. An `images` key is always present in the metadata and is an array with the same length as the top level `images` key.

### Error Handling

When `generateImage` cannot generate a valid image, it throws a [`AI_NoImageGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-image-generated-error).

This error occurs when the AI provider fails to generate an image. It can arise due to the following reasons:

- The model failed to generate a response
- The model generated a response that could not be parsed

The error preserves the following information to help you log the issue:

- `responses`: Metadata about the image model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling

```ts
import { generateImage, NoImageGeneratedError } from 'ai';

try {
  await generateImage({ model, prompt });
} catch (error) {
  if (NoImageGeneratedError.isInstance(error)) {
    console.log('NoImageGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Responses:', error.responses);
  }
}
```

## Image Middleware

You can enhance image models, e.g. to set default values or implement logging, using
`wrapImageModel` and `ImageModelV4Middleware`.

Here is an example that sets a default size when none is provided:

```ts
import { generateImage, wrapImageModel } from 'ai';
__PROVIDER_IMPORT__;

const model = wrapImageModel({
  model: __IMAGE_MODEL__,
  middleware: {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({
      ...params,
      size: params.size ?? '1024x1024',
    }),
  },
});

const { image } = await generateImage({
  model,
  prompt: 'Santa Claus driving a Cadillac',
});
```

## Generating Images with Language Models

Some language models such as Google `gemini-2.5-flash-image` support multi-modal outputs including images.
With such models, you can access the generated images using the `files` property of the response.

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  prompt: 'Generate an image of a comic cat',
});

for (const file of result.files) {
  if (file.mediaType.startsWith('image/')) {
    // The file object provides multiple data formats:
    // Access images as base64 string, Uint8Array binary data, or check type
    // - file.base64: string (data URL format)
    // - file.uint8Array: Uint8Array (binary data)
    // - file.mediaType: string (e.g. "image/png")
  }
}
```

## Image Models

| Provider                                                                        | Model                                                        | Support sizes (`width x height`) or aspect ratios (`width : height`)                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [xAI Grok](/providers/ai-sdk-providers/xai#image-models)                        | `grok-imagine-image`                                         | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto`                                                         |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                       | `gpt-image-1`                                                | 1024x1024, 1536x1024, 1024x1536                                                                                                                                     |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                       | `dall-e-3`                                                   | 1024x1024, 1792x1024, 1024x1792                                                                                                                                     |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                       | `dall-e-2`                                                   | 256x256, 512x512, 1024x1024                                                                                                                                         |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#image-models)       | `amazon.nova-canvas-v1:0`                                    | 320-4096 (multiples of 16), 1:4 to 4:1, max 4.2M pixels                                                                                                             |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/flux/dev`                                            | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/flux-lora`                                           | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/fast-sdxl`                                           | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/flux-pro/v1.1-ultra`                                 | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/ideogram/v2`                                         | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/recraft-v3`                                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/stable-diffusion-3.5-large`                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                             | `fal-ai/hyper-sdxl`                                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `stabilityai/sd3.5`                                          | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `black-forest-labs/FLUX-1.1-pro`                             | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `black-forest-labs/FLUX-1-schnell`                           | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `black-forest-labs/FLUX-1-dev`                               | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `black-forest-labs/FLUX-pro`                                 | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `stabilityai/sd3.5-medium`                                   | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)                 | `stabilityai/sdxl-turbo`                                     | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [Replicate](/providers/ai-sdk-providers/replicate)                              | `black-forest-labs/flux-schnell`                             | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Replicate](/providers/ai-sdk-providers/replicate)                              | `recraft-ai/recraft-v3`                                      | 1024x1024, 1365x1024, 1024x1365, 1536x1024, 1024x1536, 1820x1024, 1024x1820, 1024x2048, 2048x1024, 1434x1024, 1024x1434, 1024x1280, 1280x1024, 1024x1707, 1707x1024 |
| [Google](/providers/ai-sdk-providers/google#image-models)         | `imagen-4.0-generate-001`                                    | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google](/providers/ai-sdk-providers/google#image-models)         | `imagen-4.0-fast-generate-001`                               | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google](/providers/ai-sdk-providers/google#image-models)         | `imagen-4.0-ultra-generate-001`                              | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)         | `imagen-4.0-generate-001`                                    | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)         | `imagen-4.0-fast-generate-001`                               | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)         | `imagen-4.0-ultra-generate-001`                              | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)         | `imagen-3.0-fast-generate-001`                               | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/flux-1-dev-fp8`                   | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/flux-1-schnell-fp8`               | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/playground-v2-5-1024px-aesthetic` | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/japanese-stable-diffusion-xl`     | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/playground-v2-1024px-aesthetic`   | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/SSD-1B`                           | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)                 | `accounts/fireworks/models/stable-diffusion-xl-1024-v1-0`    | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Luma](/providers/ai-sdk-providers/luma#image-models)                           | `photon-1`                                                   | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Luma](/providers/ai-sdk-providers/luma#image-models)                           | `photon-flash-1`                                             | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `stabilityai/stable-diffusion-xl-base-1.0`                   | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-dev`                               | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-dev-lora`                          | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-schnell`                           | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-canny`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-depth`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-redux`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1.1-pro`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-pro`                               | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)              | `black-forest-labs/FLUX.1-schnell-Free`                      | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Black Forest Labs](/providers/ai-sdk-providers/black-forest-labs#image-models) | `flux-kontext-pro`                                           | From 3:7 (portrait) to 7:3 (landscape)                                                                                                                              |
| [Black Forest Labs](/providers/ai-sdk-providers/black-forest-labs#image-models) | `flux-kontext-max`                                           | From 3:7 (portrait) to 7:3 (landscape)                                                                                                                              |
| [Black Forest Labs](/providers/ai-sdk-providers/black-forest-labs#image-models) | `flux-pro-1.1-ultra`                                         | From 3:7 (portrait) to 7:3 (landscape)                                                                                                                              |
| [Black Forest Labs](/providers/ai-sdk-providers/black-forest-labs#image-models) | `flux-pro-1.1`                                               | From 3:7 (portrait) to 7:3 (landscape)                                                                                                                              |
| [Black Forest Labs](/providers/ai-sdk-providers/black-forest-labs#image-models) | `flux-pro-1.0-fill`                                          | From 3:7 (portrait) to 7:3 (landscape)                                                                                                                              |

Above are a small subset of the image models supported by the AI SDK providers. For more, see the respective provider documentation.

---
title: Transcription
description: Learn how to transcribe audio with the AI SDK.
---

# Transcription

<Note type="warning">Transcription is an experimental feature.</Note>

The AI SDK provides the [`transcribe`](/docs/reference/ai-sdk-core/transcribe)
function to transcribe audio using a transcription model.

```ts
import { experimental_transcribe as transcribe } from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFile } from 'fs/promises';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
});
```

The `audio` property can be a `Uint8Array`, `ArrayBuffer`, `Buffer`, `string` (base64 encoded audio data), or a `URL`.

To access the generated transcript:

```ts
const text = transcript.text; // transcript text e.g. "Hello, world!"
const segments = transcript.segments; // array of segments with start and end times, if available
const language = transcript.language; // language of the transcript e.g. "en", if available
const durationInSeconds = transcript.durationInSeconds; // duration of the transcript in seconds, if available
```

## Settings

### Provider-Specific settings

Transcription models often have provider or model-specific settings which you can set using the `providerOptions` parameter.

```ts highlight="8-12"
import { experimental_transcribe as transcribe } from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFile } from 'fs/promises';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    openai: {
      timestampGranularities: ['word'],
    },
  },
});
```

### Download Size Limits

When `audio` is a URL, the SDK downloads the file with a default **2 GiB** size limit.
You can customize this using `createDownload`:

```ts highlight="1,8"
import { experimental_transcribe as transcribe, createDownload } from 'ai';
import { openai } from '@ai-sdk/openai';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new URL('https://example.com/audio.mp3'),
  download: createDownload({ maxBytes: 50 * 1024 * 1024 }), // 50 MB limit
});
```

You can also provide a fully custom download function:

```ts highlight="6-12"
import { experimental_transcribe as transcribe } from 'ai';
import { openai } from '@ai-sdk/openai';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new URL('https://example.com/audio.mp3'),
  download: async ({ url }) => {
    const res = await myAuthenticatedFetch(url);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mediaType: res.headers.get('content-type') ?? undefined,
    };
  },
});
```

If a download exceeds the size limit, a `DownloadError` is thrown:

```ts
import { experimental_transcribe as transcribe, DownloadError } from 'ai';
import { openai } from '@ai-sdk/openai';

try {
  await transcribe({
    model: openai.transcription('whisper-1'),
    audio: new URL('https://example.com/audio.mp3'),
  });
} catch (error) {
  if (DownloadError.isInstance(error)) {
    console.log('Download failed:', error.message);
  }
}
```

### Abort Signals and Timeouts

`transcribe` accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the transcription process or set a timeout.

This is particularly useful when combined with URL downloads to prevent long-running requests:

```ts highlight="8"
import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new URL('https://example.com/audio.mp3'),
  abortSignal: AbortSignal.timeout(5000), // Abort after 5 seconds
});
```

### Custom Headers

`transcribe` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the transcription request.

```ts highlight="8"
import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';
import { readFile } from 'fs/promises';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

### Warnings

Warnings (e.g. unsupported parameters) are available on the `warnings` property.

```ts
import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';
import { readFile } from 'fs/promises';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
});

const warnings = transcript.warnings;
```

### Error Handling

When `transcribe` cannot generate a valid transcript, it throws a [`AI_NoTranscriptGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-transcript-generated-error).

This error can arise for any of the following reasons:

- The model failed to generate a response
- The model generated a response that could not be parsed

The error preserves the following information to help you log the issue:

- `responses`: Metadata about the transcription model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling.

```ts
import {
  experimental_transcribe as transcribe,
  NoTranscriptGeneratedError,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFile } from 'fs/promises';

try {
  await transcribe({
    model: openai.transcription('whisper-1'),
    audio: await readFile('audio.mp3'),
  });
} catch (error) {
  if (NoTranscriptGeneratedError.isInstance(error)) {
    console.log('NoTranscriptGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Responses:', error.responses);
  }
}
```

## Transcription Models

| Provider                                                                  | Model                    |
| ------------------------------------------------------------------------- | ------------------------ |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `whisper-1`              |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `gpt-4o-transcribe`      |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `gpt-4o-mini-transcribe` |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#transcription-models) | `scribe_v1`              |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#transcription-models) | `scribe_v1_experimental` |
| [Groq](/providers/ai-sdk-providers/groq#transcription-models)             | `whisper-large-v3-turbo` |
| [Groq](/providers/ai-sdk-providers/groq#transcription-models)             | `whisper-large-v3`       |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `whisper-1`              |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `gpt-4o-transcribe`      |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `gpt-4o-mini-transcribe` |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `machine`                |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `low_cost`               |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `fusion`                 |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `base` (+ variants)      |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `enhanced` (+ variants)  |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova` (+ variants)      |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova-2` (+ variants)    |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova-3` (+ variants)    |
| [Gladia](/providers/ai-sdk-providers/gladia#transcription-models)         | `default`                |
| [AssemblyAI](/providers/ai-sdk-providers/assemblyai#transcription-models) | `best`                   |
| [AssemblyAI](/providers/ai-sdk-providers/assemblyai#transcription-models) | `nano`                   |
| [Fal](/providers/ai-sdk-providers/fal#transcription-models)               | `whisper`                |
| [Fal](/providers/ai-sdk-providers/fal#transcription-models)               | `wizper`                 |

Above are a small subset of the transcription models supported by the AI SDK providers. For more, see the respective provider documentation.

---
title: Speech
description: Learn how to generate speech from text with the AI SDK.
---

# Speech

<Note type="warning">Speech is an experimental feature.</Note>

The AI SDK provides the [`generateSpeech`](/docs/reference/ai-sdk-core/generate-speech)
function to generate speech from text using a speech model.

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai } from '@ai-sdk/openai';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  voice: 'alloy',
});
```

### Language Setting

You can specify the language for speech generation (provider support varies):

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { lmnt } from '@ai-sdk/lmnt';

const audio = await generateSpeech({
  model: lmnt.speech('aurora'),
  text: 'Hola, mundo!',
  language: 'es', // Spanish
});
```

To access the generated audio:

```ts
const audioData = result.audio.uint8Array; // audio data as Uint8Array
// or
const audioBase64 = result.audio.base64; // audio data as base64 string
```

## Settings

### Provider-Specific settings

You can set model-specific settings with the `providerOptions` parameter.

```ts highlight="7-11"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai } from '@ai-sdk/openai';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  providerOptions: {
    openai: {
      // ...
    },
  },
});
```

### Abort Signals and Timeouts

`generateSpeech` accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the speech generation process or set a timeout.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

`generateSpeech` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the speech generation request.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

### Warnings

Warnings (e.g. unsupported parameters) are available on the `warnings` property.

```ts
import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
});

const warnings = audio.warnings;
```

### Error Handling

When `generateSpeech` cannot generate a valid audio, it throws a [`AI_NoSpeechGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-speech-generated-error).

This error can arise for any of the following reasons:

- The model failed to generate a response
- The model generated a response that could not be parsed

The error preserves the following information to help you log the issue:

- `responses`: Metadata about the speech model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling.

```ts
import {
  experimental_generateSpeech as generateSpeech,
  NoSpeechGeneratedError,
} from 'ai';
import { openai } from '@ai-sdk/openai';

try {
  await generateSpeech({
    model: openai.speech('tts-1'),
    text: 'Hello, world!',
  });
} catch (error) {
  if (NoSpeechGeneratedError.isInstance(error)) {
    console.log('AI_NoSpeechGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Responses:', error.responses);
  }
}
```

## Speech Models

| Provider                                                           | Model                    |
| ------------------------------------------------------------------ | ------------------------ |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models)         | `tts-1`                  |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models)         | `tts-1-hd`               |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models)         | `gpt-4o-mini-tts`        |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_v3`              |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_multilingual_v2` |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_flash_v2_5`      |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_flash_v2`        |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_turbo_v2_5`      |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#speech-models) | `eleven_turbo_v2`        |
| [LMNT](/providers/ai-sdk-providers/lmnt#speech-models)             | `aurora`                 |
| [LMNT](/providers/ai-sdk-providers/lmnt#speech-models)             | `blizzard`               |
| [Hume](/providers/ai-sdk-providers/hume#speech-models)             | `default`                |

Above are a small subset of the speech models supported by the AI SDK providers. For more, see the respective provider documentation.

---
title: Video Generation
description: Learn how to generate videos with the AI SDK.
---

# Video Generation

<Note>
  Video generation is an experimental feature. The API may change in future
  versions.
</Note>

The AI SDK provides the [`experimental_generateVideo`](/docs/reference/ai-sdk-core/generate-video)
function to generate videos based on a given prompt using a video model.

```tsx
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
});
```

You can access the video data using the `base64` or `uint8Array` properties:

```tsx
const base64 = video.base64; // base64 video data
const uint8Array = video.uint8Array; // Uint8Array video data
```

## Settings

### Aspect Ratio

The aspect ratio is specified as a string in the format `{width}:{height}`.
Models only support a few aspect ratios, and the supported aspect ratios are different for each model and provider.

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
  aspectRatio: '16:9',
});
```

### Resolution

The resolution is specified as a string in the format `{width}x{height}`.
Models only support specific resolutions, and the supported resolutions are different for each model and provider.

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A serene mountain landscape at sunset',
  resolution: '1280x720',
});
```

### Duration

Some video models support specifying the duration of the generated video in seconds.

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A timelapse of clouds moving across the sky',
  duration: 5,
});
```

### Frames Per Second (FPS)

Some video models allow you to specify the frames per second for the generated video.

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A hummingbird in slow motion',
  fps: 24,
});
```

### Generating Multiple Videos

`experimental_generateVideo` supports generating multiple videos at once:

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { videos } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A rocket launching into space',
  n: 3, // number of videos to generate
});
```

<Note>
  `experimental_generateVideo` will automatically call the model as often as
  needed (in parallel) to generate the requested number of videos.
</Note>

Each video model has an internal limit on how many videos it can generate in a single API call. The AI SDK manages this automatically by batching requests appropriately when you request multiple videos using the `n` parameter. Most video models only support generating 1 video per call due to computational cost.

If needed, you can override this behavior using the `maxVideosPerCall` setting:

```tsx
const { videos } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A rocket launching into space',
  maxVideosPerCall: 2, // Override the default batch size
  n: 4, // Will make 2 calls of 2 videos each
});
```

### Image-to-Video Generation

Some video models support generating videos from an input image. You can provide an image using the prompt object:

```tsx highlight={"7-10"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: {
    image: 'https://example.com/my-image.png',
    text: 'Animate this image with gentle motion',
  },
});
```

You can also provide the image as a base64-encoded string or `Uint8Array`:

```tsx
const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: {
    image: imageBase64String, // or imageUint8Array
    text: 'Animate this image',
  },
});
```

### Providing a Seed

You can provide a seed to the `experimental_generateVideo` function to control the output of the video generation process.
If supported by the model, the same seed will always produce the same video.

```tsx highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
  seed: 1234567890,
});
```

### Provider-specific Settings

Video models often have provider- or even model-specific settings.
You can pass such settings to the `experimental_generateVideo` function
using the `providerOptions` parameter. The options for the provider
become request body properties.

```tsx highlight={"8-10"}
import { experimental_generateVideo as generateVideo } from 'ai';
import { fal } from '@ai-sdk/fal';

const { video } = await generateVideo({
  model: fal.video('luma-dream-machine/ray-2'),
  prompt: 'A cat walking on a treadmill',
  aspectRatio: '16:9',
  providerOptions: {
    fal: { loop: true, motionStrength: 0.8 },
  },
});
```

### Abort Signals and Timeouts

`experimental_generateVideo` accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the video generation process or set a timeout.

```ts highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
  abortSignal: AbortSignal.timeout(60000), // Abort after 60 seconds
});
```

<Note>
  Video generation typically takes longer than image generation. Consider using
  longer timeouts (60 seconds or more) depending on the model and video length.
</Note>

### Polling Timeout

Video generation is an asynchronous process that can take several minutes to complete. Most providers use a polling mechanism where the SDK periodically checks if the video is ready. The default polling timeout is typically 5 minutes, which may not be sufficient for longer videos or certain models.

You can configure the polling timeout using provider-specific options. Each provider exports a type for its options that you can use with `satisfies` for type safety:

```tsx highlight={"10-12"}
import { experimental_generateVideo as generateVideo } from 'ai';
import { fal, type FalVideoModelOptions } from '@ai-sdk/fal';

const { video } = await generateVideo({
  model: fal.video('luma-dream-machine/ray-2'),
  prompt: 'A cinematic timelapse of a city from dawn to dusk',
  duration: 10,
  providerOptions: {
    fal: {
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies FalVideoModelOptions,
  },
});
```

<Note>
  For production use, we recommend setting `pollTimeoutMs` to at least 10
  minutes (600000ms) to account for varying generation times across different
  models and video lengths.
</Note>

### Custom Headers

`experimental_generateVideo` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the video generation request.

```ts highlight={"7"}
import { experimental_generateVideo as generateVideo } from 'ai';
__PROVIDER_IMPORT__;

const { video } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

### Warnings

If the model returns warnings, e.g. for unsupported parameters, they will be available in the `warnings` property of the response.

```tsx
const { video, warnings } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A cat walking on a treadmill',
});
```

### Additional Provider-specific Metadata

Some providers expose additional metadata for the result overall or per video.

```tsx
const prompt = 'A cat walking on a treadmill';

const { video, providerMetadata } = await generateVideo({
  model: fal.video('luma-dream-machine/ray-2'),
  prompt,
});

// Access provider-specific metadata
const videoMetadata = providerMetadata.fal?.videos[0];
console.log({
  duration: videoMetadata?.duration,
  fps: videoMetadata?.fps,
  width: videoMetadata?.width,
  height: videoMetadata?.height,
});
```

The outer key of the returned `providerMetadata` is the provider name. The inner values are the metadata. A `videos` key is typically present in the metadata and is an array with the same length as the top level `videos` key.

When generating multiple videos with `n > 1`, you can also access per-call metadata through the `responses` array:

```tsx
const { videos, responses } = await generateVideo({
  model: __VIDEO_MODEL__,
  prompt: 'A rocket launching into space',
  n: 5, // May require multiple API calls
});

// Access metadata from each individual API call
for (const response of responses) {
  console.log({
    timestamp: response.timestamp,
    modelId: response.modelId,
    // Per-call provider metadata (lossless)
    providerMetadata: response.providerMetadata,
  });
}
```

### Error Handling

When `experimental_generateVideo` cannot generate a valid video, it throws a [`AI_NoVideoGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-video-generated-error).

This error occurs when the AI provider fails to generate a video. It can arise due to the following reasons:

- The model failed to generate a response
- The model generated a response that could not be parsed

The error preserves the following information to help you log the issue:

- `responses`: Metadata about the video model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling

```ts
import {
  experimental_generateVideo as generateVideo,
  NoVideoGeneratedError,
} from 'ai';

try {
  await generateVideo({ model, prompt });
} catch (error) {
  if (NoVideoGeneratedError.isInstance(error)) {
    console.log('NoVideoGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Responses:', error.responses);
  }
}
```

## Video Models

| Provider                                                                | Model                       | Features                               |
| ----------------------------------------------------------------------- | --------------------------- | -------------------------------------- |
| [FAL](/providers/ai-sdk-providers/fal#video-models)                     | `luma-dream-machine/ray-2`  | Text-to-video, image-to-video          |
| [FAL](/providers/ai-sdk-providers/fal#video-models)                     | `minimax-video`             | Text-to-video                          |
| [Google](/providers/ai-sdk-providers/google#video-models) | `veo-2.0-generate-001`      | Text-to-video, up to 4 videos per call |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#video-models) | `veo-3.1-generate-001`      | Text-to-video, audio generation        |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#video-models) | `veo-3.1-fast-generate-001` | Text-to-video, audio generation        |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#video-models) | `veo-3.0-generate-001`      | Text-to-video, audio generation        |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#video-models) | `veo-3.0-fast-generate-001` | Text-to-video, audio generation        |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#video-models) | `veo-2.0-generate-001`      | Text-to-video, up to 4 videos per call |
| [Kling AI](/providers/ai-sdk-providers/klingai#video-models)            | `kling-v2.6-t2v`            | Text-to-video                          |
| [Kling AI](/providers/ai-sdk-providers/klingai#video-models)            | `kling-v2.6-i2v`            | Image-to-video                         |
| [Kling AI](/providers/ai-sdk-providers/klingai#video-models)            | `kling-v2.6-motion-control` | Motion control                         |
| [Replicate](/providers/ai-sdk-providers/replicate#video-models)         | `minimax/video-01`          | Text-to-video                          |
| [xAI](/providers/ai-sdk-providers/xai#video-models)                     | `grok-imagine-video`        | Text-to-video, image-to-video, editing, extension, R2V |

Above are a small subset of the video models supported by the AI SDK providers. For more, see the respective provider documentation.

---
title: File Uploads
description: Learn how to upload files and use provider references with the AI SDK.
---

# File Uploads

The AI SDK provides the [`uploadFile`](/docs/reference/ai-sdk-core/upload-file)
function to upload files to a provider and get back a `ProviderReference` that can be
used in subsequent API calls.

In the AI SDK, the uploaded file is identified by a `ProviderReference` — a
`Record<string, string>` mapping provider names to provider-specific identifiers.
This concept is used for other provider specific asset references too, such as
uploaded skills.

```ts
import { uploadFile, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import fs from 'node:fs';

const { providerReference } = await uploadFile({
  api: openai.files(),
  data: fs.readFileSync('./photo.png'),
  filename: 'photo.png',
});

const { text } = await generateText({
  model: openai.responses('gpt-4o-mini'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe what you see in this image.' },
        { type: 'image', image: providerReference },
      ],
    },
  ],
});
```

As a shorthand, you can pass a provider instance directly to `api` instead of calling `.files()` explicitly — the SDK will call `.files()` for you:

```ts highlight="3"
const { providerReference } = await uploadFile({
  api: openai, // shorthand for openai.files()
  data: fs.readFileSync('./photo.png'),
  filename: 'photo.png',
});
```

## Supported File Types

You can upload images, PDFs, text files, and other documents depending on the provider.
The media type is auto-detected from the file bytes when not specified explicitly:

```ts highlight="4"
const { providerReference } = await uploadFile({
  api: anthropic.files(),
  data: fs.readFileSync('./document.pdf'),
  mediaType: 'application/pdf', // optional, auto-detected if omitted
  filename: 'document.pdf',
});
```

Use the `providerReference` in a file content part with its media type:

```ts
{
  role: 'user',
  content: [
    { type: 'text', text: 'Summarize this document.' },
    { type: 'file', data: providerReference, mediaType: 'application/pdf' },
  ],
}
```

## Provider-Specific Options

Some providers accept additional options through `providerOptions`.
For example, OpenAI requires a `purpose` field:

```ts highlight="5-9"
import { openai, type OpenAIFilesOptions } from '@ai-sdk/openai';

const { providerReference } = await uploadFile({
  api: openai.files(),
  data: fs.readFileSync('./photo.png'),
  providerOptions: {
    openai: {
      purpose: 'assistants',
    } satisfies OpenAIFilesOptions,
  },
});
```

## Provider References

A `ProviderReference` is a `Record<string, string>` that maps provider names to
provider-specific file identifiers:

```ts
// Example ProviderReference
{
  openai: 'file-abc123',
}
```

When you pass a `ProviderReference` as the `data` or `image` field of a message content
part, the provider looks up its own file ID from the reference. If the reference doesn't
contain an entry for the current provider, an error is thrown.

## Multi-Provider Usage

If you switch providers mid-conversation (for example, continuing a chat started with
OpenAI using Anthropic), you need to upload the file to both providers and merge the
references:

```ts
const openaiResult = await uploadFile({
  api: openai.files(),
  data: imageBytes,
  filename: 'photo.png',
});

const anthropicResult = await uploadFile({
  api: anthropic.files(),
  data: imageBytes,
  filename: 'photo.png',
});

const mergedReference = {
  ...openaiResult.providerReference,
  ...anthropicResult.providerReference,
};

// mergedReference: { openai: 'file-abc123', anthropic: 'file-xyz789' }
```

The merged reference can then be used in messages regardless of which provider processes
the request — each provider will find its own file ID.

## Supported Providers

The following providers support `files()` and file uploads:

| Provider  | Factory Method        |
| --------- | --------------------- |
| Anthropic | `anthropic.files()`   |
| Google    | `google.files()`      |
| OpenAI    | `openai.files()`      |
| xAI       | `xai.files()`         |

Providers without file upload support will throw an `UnsupportedFunctionalityError`
if they encounter a provider reference in a message.

---
title: Language Model Middleware
description: Learn how to use middleware to enhance the behavior of language models
---

# Language Model Middleware

Language model middleware is a way to enhance the behavior of language models
by intercepting and modifying the calls to the language model.

It can be used to add features like guardrails, RAG, caching, and logging
in a language model agnostic way. Such middleware can be developed and
distributed independently from the language models that they are applied to.

## Using Language Model Middleware

You can use language model middleware with the `wrapLanguageModel` function.
It takes a language model and a language model middleware and returns a new
language model that incorporates the middleware.

```ts
import { wrapLanguageModel, streamText } from 'ai';

const wrappedLanguageModel = wrapLanguageModel({
  model: yourModel,
  middleware: yourLanguageModelMiddleware,
});
```

The wrapped language model can be used just like any other language model, e.g. in `streamText`:

```ts highlight="2"
const result = streamText({
  model: wrappedLanguageModel,
  prompt: 'What cities are in the United States?',
});
```

## Multiple middlewares

You can provide multiple middlewares to the `wrapLanguageModel` function.
The middlewares will be applied in the order they are provided.

```ts
const wrappedLanguageModel = wrapLanguageModel({
  model: yourModel,
  middleware: [firstMiddleware, secondMiddleware],
});

// applied as: firstMiddleware(secondMiddleware(yourModel))
```

## Built-in Middleware

The AI SDK comes with several built-in middlewares that you can use to configure language models:

- `extractReasoningMiddleware`: Extracts reasoning information from the generated text and exposes it as a `reasoning` property on the result.
- `extractJsonMiddleware`: Extracts JSON from text content by stripping markdown code fences. Useful when using `Output.object()` with models that wrap JSON responses in code blocks.
- `simulateStreamingMiddleware`: Simulates streaming behavior with responses from non-streaming language models.
- `defaultSettingsMiddleware`: Applies default settings to a language model.
- `addToolInputExamplesMiddleware`: Adds tool input examples to tool descriptions for providers that don't natively support the `inputExamples` property.

### Extract Reasoning

Some providers and models expose reasoning information in the generated text using special tags,
e.g. &lt;think&gt; and &lt;/think&gt;.

The `extractReasoningMiddleware` function can be used to extract this reasoning information and expose it as a `reasoning` property on the result.

```ts
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});
```

You can then use that enhanced model in functions like `generateText` and `streamText`.

The `extractReasoningMiddleware` function also includes a `startWithReasoning` option.
When set to `true`, the reasoning tag will be prepended to the generated text.
This is useful for models that do not include the reasoning tag at the beginning of the response.
For more details, see the [DeepSeek R1 guide](/cookbook/guides/r1#deepseek-r1-middleware).

### Extract JSON

Some models wrap JSON responses in markdown code fences (e.g., ` ```json ... ``` `) even when you request structured output.

The `extractJsonMiddleware` function strips these code fences from the response, making it compatible with `Output.object()`.

```ts
import {
  wrapLanguageModel,
  extractJsonMiddleware,
  Output,
  generateText,
} from 'ai';
import { z } from 'zod';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: extractJsonMiddleware(),
});

const result = await generateText({
  model,
  output: Output.object({
    schema: z.object({
      name: z.string(),
      ingredients: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a recipe.',
});
```

You can also provide a custom transform function for models that use different formatting:

```ts
const model = wrapLanguageModel({
  model: yourModel,
  middleware: extractJsonMiddleware({
    transform: text => text.replace(/^PREFIX/, '').replace(/SUFFIX$/, ''),
  }),
});
```

### Simulate Streaming

The `simulateStreamingMiddleware` function can be used to simulate streaming behavior with responses from non-streaming language models.
This is useful when you want to maintain a consistent streaming interface even when using models that only provide complete responses.

```ts
import { wrapLanguageModel, simulateStreamingMiddleware } from 'ai';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: simulateStreamingMiddleware(),
});
```

### Default Settings

The `defaultSettingsMiddleware` function can be used to apply default settings to a language model.

```ts
import { wrapLanguageModel, defaultSettingsMiddleware } from 'ai';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: defaultSettingsMiddleware({
    settings: {
      temperature: 0.5,
      maxOutputTokens: 800,
      providerOptions: { openai: { store: false } },
    },
  }),
});
```

### Add Tool Input Examples

The `addToolInputExamplesMiddleware` function adds tool input examples to tool descriptions.
This is useful for providers that don't natively support the `inputExamples` property on tools.
The middleware serializes the examples into the tool's description text so models can still benefit from seeing example inputs.

```ts
import { wrapLanguageModel, addToolInputExamplesMiddleware } from 'ai';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: addToolInputExamplesMiddleware({
    prefix: 'Input Examples:',
  }),
});
```

When you define a tool with `inputExamples`, the middleware will append them to the tool's description:

```ts
import { generateText, tool } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model, // wrapped model from above
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string(),
      }),
      inputExamples: [
        { input: { location: 'San Francisco' } },
        { input: { location: 'London' } },
      ],
    }),
  },
  prompt: 'What is the weather in Tokyo?',
});
```

The tool description will be transformed to:

```
Get the weather in a location

Input Examples:
{"location":"San Francisco"}
{"location":"London"}
```

#### Options

- `prefix` (optional): A prefix text to prepend before the examples. Default: `'Input Examples:'`.
- `format` (optional): A custom formatter function for each example. Receives the example object and its index. Default: `JSON.stringify(example.input)`.
- `remove` (optional): Whether to remove the `inputExamples` property from the tool after adding them to the description. Default: `true`.

```ts
const model = wrapLanguageModel({
  model: yourModel,
  middleware: addToolInputExamplesMiddleware({
    prefix: 'Input Examples:',
    format: (example, index) =>
      `${index + 1}. ${JSON.stringify(example.input)}`,
    remove: true,
  }),
});
```

## Community Middleware

The AI SDK provides a Language Model Middleware specification. Community members can develop middleware that adheres to this specification, making it compatible with the AI SDK ecosystem.

Here are some community middlewares that you can explore:

### Custom tool call parser

The [Custom tool call parser](https://github.com/minpeter/ai-sdk-tool-call-middleware) middleware extends tool call capabilities to models that don't natively support the OpenAI-style `tools` parameter. This includes many self-hosted and third-party models that lack native function calling features.

<Note>
  Using this middleware on models that support native function calls may result
  in unintended performance degradation, so check whether your model supports
  native function calls before deciding to use it.
</Note>

This middleware enables function calling capabilities by converting function schemas into prompt instructions and parsing the model's responses into structured function calls. It works by transforming the JSON function definitions into natural language instructions the model can understand, then analyzing the generated text to extract function call attempts. This approach allows developers to use the same function calling API across different model providers, even with models that don't natively support the OpenAI-style function calling format, providing a consistent function calling experience regardless of the underlying model implementation.

The `@ai-sdk-tool/parser` package offers three middleware variants:

- `createToolMiddleware`: A flexible function for creating custom tool call middleware tailored to specific models
- `hermesToolMiddleware`: Ready-to-use middleware for Hermes & Qwen format function calls
- `gemmaToolMiddleware`: Pre-configured middleware for Gemma 3 model series function call format

Here's how you can enable function calls with Gemma models that don't support them natively:

```ts
import { wrapLanguageModel } from 'ai';
import { gemmaToolMiddleware } from '@ai-sdk-tool/parser';

const model = wrapLanguageModel({
  model: openrouter('google/gemma-3-27b-it'),
  middleware: gemmaToolMiddleware,
});
```

Find more examples at this [link](https://github.com/minpeter/ai-sdk-tool-call-middleware/tree/main/examples/core/src).

## Implementing Language Model Middleware

<Note>
  Implementing language model middleware is advanced functionality and requires
  a solid understanding of the [language model
  specification](https://github.com/vercel/ai/blob/v5/packages/provider/src/language-model/v2/language-model-v2.ts).
</Note>

You can implement any of the following three function to modify the behavior of the language model:

1. `transformParams`: Transforms the parameters before they are passed to the language model, for both `doGenerate` and `doStream`.
2. `wrapGenerate`: Wraps the `doGenerate` method of the [language model](https://github.com/vercel/ai/blob/v5/packages/provider/src/language-model/v2/language-model-v2.ts).
   You can modify the parameters, call the language model, and modify the result.
3. `wrapStream`: Wraps the `doStream` method of the [language model](https://github.com/vercel/ai/blob/v5/packages/provider/src/language-model/v2/language-model-v2.ts).
   You can modify the parameters, call the language model, and modify the result.

Here are some examples of how to implement language model middleware:

## Examples

<Note>
  These examples are not meant to be used in production. They are just to show
  how you can use middleware to enhance the behavior of language models.
</Note>

### Logging

This example shows how to log the parameters and generated text of a language model call.

```ts
import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';

export const yourLogMiddleware: LanguageModelV4Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    console.log('doGenerate called');
    console.log(`params: ${JSON.stringify(params, null, 2)}`);

    const result = await doGenerate();

    console.log('doGenerate finished');
    console.log(`generated text: ${result.text}`);

    return result;
  },

  wrapStream: async ({ doStream, params }) => {
    console.log('doStream called');
    console.log(`params: ${JSON.stringify(params, null, 2)}`);

    const { stream, ...rest } = await doStream();

    let generatedText = '';
    const textBlocks = new Map<string, string>();

    const transformStream = new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >({
      transform(chunk, controller) {
        switch (chunk.type) {
          case 'text-start': {
            textBlocks.set(chunk.id, '');
            break;
          }
          case 'text-delta': {
            const existing = textBlocks.get(chunk.id) || '';
            textBlocks.set(chunk.id, existing + chunk.delta);
            generatedText += chunk.delta;
            break;
          }
          case 'text-end': {
            console.log(
              `Text block ${chunk.id} completed:`,
              textBlocks.get(chunk.id),
            );
            break;
          }
        }

        controller.enqueue(chunk);
      },

      flush() {
        console.log('doStream finished');
        console.log(`generated text: ${generatedText}`);
      },
    });

    return {
      stream: stream.pipeThrough(transformStream),
      ...rest,
    };
  },
};
```

### Caching

This example shows how to build a simple cache for the generated text of a language model call.

```ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider';

const cache = new Map<string, any>();

export const yourCacheMiddleware: LanguageModelV4Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const cacheKey = JSON.stringify(params);

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const result = await doGenerate();

    cache.set(cacheKey, result);

    return result;
  },

  // here you would implement the caching logic for streaming
};
```

### Retrieval Augmented Generation (RAG)

This example shows how to use RAG as middleware.

<Note>
  Helper functions like `getLastUserMessageText` and `findSources` are not part
  of the AI SDK. They are just used in this example to illustrate the concept of
  RAG.
</Note>

```ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider';

export const yourRagMiddleware: LanguageModelV4Middleware = {
  transformParams: async ({ params }) => {
    const lastUserMessageText = getLastUserMessageText({
      prompt: params.prompt,
    });

    if (lastUserMessageText == null) {
      return params; // do not use RAG (send unmodified parameters)
    }

    const instruction =
      'Use the following information to answer the question:\n' +
      findSources({ text: lastUserMessageText })
        .map(chunk => JSON.stringify(chunk))
        .join('\n');

    return addToLastUserMessage({ params, text: instruction });
  },
};
```

### Guardrails

Guard rails are a way to ensure that the generated text of a language model call
is safe and appropriate. This example shows how to use guardrails as middleware.

```ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider';

export const yourGuardrailMiddleware: LanguageModelV4Middleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const { text, ...rest } = await doGenerate();

    // filtering approach, e.g. for PII or other sensitive information:
    const cleanedText = text?.replace(/badword/g, '<REDACTED>');

    return { text: cleanedText, ...rest };
  },

  // here you would implement the guardrail logic for streaming
  // Note: streaming guardrails are difficult to implement, because
  // you do not know the full content of the stream until it's finished.
};
```

## Configuring Per Request Custom Metadata

To send and access custom metadata in Middleware, you can use `providerOptions`. This is useful when building logging middleware where you want to pass additional context like user IDs, timestamps, or other contextual data that can help with tracking and debugging.

```ts
import { generateText, wrapLanguageModel } from 'ai';
__PROVIDER_IMPORT__;
import type { LanguageModelV4Middleware } from '@ai-sdk/provider';

export const yourLogMiddleware: LanguageModelV4Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    console.log('METADATA', params?.providerMetadata?.yourLogMiddleware);
    const result = await doGenerate();
    return result;
  },
};

const { text } = await generateText({
  model: wrapLanguageModel({
    model: __MODEL__,
    middleware: yourLogMiddleware,
  }),
  prompt: 'Invent a new holiday and describe its traditions.',
  providerOptions: {
    yourLogMiddleware: {
      hello: 'world',
    },
  },
});

console.log(text);
```

---
title: Skill Uploads
description: Learn how to upload skills and use provider references with the AI SDK.
---

# Skill Uploads

The AI SDK provides the [`uploadSkill`](/docs/reference/ai-sdk-core/upload-skill)
function to upload custom skills to a provider and get back a `ProviderReference` that
can be passed to subsequent inference calls.

A **skill** is a bundle of files (e.g. a `SKILL.md` describing the skill's behavior)
that providers can load, e.g. in sandboxed container environments.

In the AI SDK, the uploaded skill is identified by a `ProviderReference` — a
`Record<string, string>` mapping provider names to provider-specific identifiers.
This concept is used for other provider specific asset references too, such as
uploaded media files.

```ts
import { uploadSkill, generateText } from 'ai';
import { anthropic, type AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { readFileSync } from 'fs';

const { providerReference } = await uploadSkill({
  api: anthropic.skills(),
  files: [
    {
      path: 'my-skill/SKILL.md',
      content: readFileSync('./SKILL.md'),
    },
  ],
  displayTitle: 'My Skill',
});

const { text } = await generateText({
  model: anthropic('claude-sonnet-4-6'),
  tools: {
    code_execution: anthropic.tools.codeExecution_20260120(),
  },
  prompt: 'Use the skill to complete the task.',
  providerOptions: {
    anthropic: {
      container: {
        skills: [{ type: 'custom', providerReference }],
      },
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

As a shorthand, you can pass a provider instance directly to `api` instead of calling `.skills()` explicitly — the SDK will call `.skills()` for you:

```ts highlight="2"
const { providerReference } = await uploadSkill({
  api: anthropic, // shorthand for anthropic.skills()
  files: [{ path: 'my-skill/SKILL.md', content: readFileSync('./SKILL.md') }],
  displayTitle: 'My Skill',
});
```

## Skill Files

A skill is composed of one or more files, each with a relative `path` and `content`.
File content can be provided as a `Uint8Array` (e.g. from `fs.readFileSync`) or as a
base64-encoded string:

```ts
const { providerReference } = await uploadSkill({
  api: openai.skills(),
  files: [
    {
      path: 'my-skill/SKILL.md',
      content: readFileSync('./SKILL.md'), // Uint8Array
    },
    {
      path: 'my-skill/helper.py',
      content: readFileSync('./helper.py'),
    },
  ],
});
```

## Upload Result

`uploadSkill` returns an `UploadSkillResult` with the following fields:

| Field               | Type                | Description                                                     |
| ------------------- | ------------------- | --------------------------------------------------------------- |
| `providerReference` | `ProviderReference` | Maps provider names to provider-specific skill IDs              |
| `displayTitle`      | `string?`           | Human-readable title (if supported and provided)                |
| `name`              | `string?`           | Name inferred by the provider from the skill files              |
| `description`       | `string?`           | Description inferred by the provider from the skill files       |
| `latestVersion`     | `string?`           | Latest version identifier assigned by the provider              |
| `providerMetadata`  | `object?`           | Additional provider-specific metadata (e.g. timestamps)         |
| `warnings`          | `Warning[]`         | Warnings for unsupported options (e.g. `displayTitle` on OpenAI)|

## Provider References

A `ProviderReference` is a `Record<string, string>` mapping provider names to
provider-specific skill identifiers:

```ts
// Example ProviderReference
{
  anthropic: 'skill_abc123',
}
```

Pass the `providerReference` when referencing the skill during inference. Each provider
looks up its own skill ID from the reference. If no entry exists for the current
provider, an error is thrown.

## Multi-Provider Usage

If you want to use the same skill across multiple providers, upload it to each one and
merge the references:

```ts
const [openaiUpload, anthropicUpload] = await Promise.all([
  uploadSkill({
    api: openai.skills(),
    files: [{ path: 'my-skill/SKILL.md', content: skillSource }],
  }),
  uploadSkill({
    api: anthropic.skills(),
    files: [{ path: 'my-skill/SKILL.md', content: skillSource }],
    displayTitle: 'My Skill',
  }),
]);

const mergedReference = {
  ...openaiUpload.providerReference,
  ...anthropicUpload.providerReference,
};

// mergedReference: { openai: 'sk_...', anthropic: 'sk_...' }
```

The merged reference can then be used in inference calls regardless of which provider
processes the request — each provider will find its own skill ID.

## Using Skills in Inference Calls

How you attach a skill to an inference call depends on the provider.

### Anthropic

Pass the `providerReference` inside the `container.skills` array in `providerOptions`:

```ts
await generateText({
  model: anthropic('claude-sonnet-4-6'),
  tools: {
    code_execution: anthropic.tools.codeExecution_20260120(),
  },
  prompt: '...',
  providerOptions: {
    anthropic: {
      container: {
        skills: [{ type: 'custom', providerReference }],
      },
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

### OpenAI

Pass the `providerReference` inside the `shell` tool's `environment.skills` array:

```ts
await generateText({
  model: openai.responses('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      environment: {
        type: 'containerAuto',
        skills: [{ type: 'skillReference', providerReference }],
      },
    }),
  },
  prompt: '...',
});
```

## Supported Providers

The following providers support `skills()` and skill uploads:

| Provider  | Factory Method      |
| --------- | ------------------- |
| Anthropic | `anthropic.skills()` |
| OpenAI    | `openai.skills()`   |

---
title: Provider & Model Management
description: Learn how to work with multiple providers and models
---

# Provider & Model Management

When you work with multiple providers and models, it is often desirable to manage them in a central place
and access the models through simple string ids.

The AI SDK offers [custom providers](/docs/reference/ai-sdk-core/custom-provider) and
a [provider registry](/docs/reference/ai-sdk-core/provider-registry) for this purpose:

- With **custom providers**, you can pre-configure model settings, provide model name aliases,
  and limit the available models.
- The **provider registry** lets you mix multiple providers and access them through simple string ids.

You can mix and match custom providers, the provider registry, and [middleware](/docs/ai-sdk-core/middleware) in your application.

## Custom Providers

You can create a [custom provider](/docs/reference/ai-sdk-core/custom-provider) using `customProvider`.

### Example: custom model settings

You might want to override the default model settings for a provider or provide model name aliases
with pre-configured settings.

```ts
import {
  gateway,
  customProvider,
  defaultSettingsMiddleware,
  wrapLanguageModel,
} from 'ai';

// custom provider with different provider options:
export const openai = customProvider({
  languageModels: {
    // replacement model with custom provider options:
    'gpt-5.1': wrapLanguageModel({
      model: gateway('openai/gpt-5.1'),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              reasoningEffort: 'high',
            },
          },
        },
      }),
    }),
    // alias model with custom provider options:
    'gpt-5.1-high-reasoning': wrapLanguageModel({
      model: gateway('openai/gpt-5.1'),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              reasoningEffort: 'high',
            },
          },
        },
      }),
    }),
  },
  fallbackProvider: gateway,
});
```

### Example: model name alias

You can also provide model name aliases, so you can update the model version in one place in the future:

```ts
import { customProvider, gateway } from 'ai';

// custom provider with alias names:
export const anthropic = customProvider({
  languageModels: {
    opus: gateway('anthropic/claude-opus-4.1'),
    sonnet: gateway('anthropic/claude-sonnet-4.5'),
    haiku: gateway('anthropic/claude-haiku-4.5'),
  },
  fallbackProvider: gateway,
});
```

### Example: limit available models

You can limit the available models in the system, even if you have multiple providers.

```ts
import {
  customProvider,
  defaultSettingsMiddleware,
  wrapLanguageModel,
  gateway,
} from 'ai';

export const myProvider = customProvider({
  languageModels: {
    'text-medium': gateway('anthropic/claude-3-5-sonnet-20240620'),
    'text-small': gateway('openai/gpt-5-mini'),
    'reasoning-medium': wrapLanguageModel({
      model: gateway('openai/gpt-5.1'),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              reasoningEffort: 'high',
            },
          },
        },
      }),
    }),
    'reasoning-fast': wrapLanguageModel({
      model: gateway('openai/gpt-5.1'),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              reasoningEffort: 'low',
            },
          },
        },
      }),
    }),
  },
  embeddingModels: {
    embedding: gateway.embeddingModel('openai/text-embedding-3-small'),
  },
  // no fallback provider
});
```

### Example: files and skills interfaces

You can attach a provider's `files` or `skills` interface to your custom provider. This allows you to use `uploadFile` and `uploadSkill` through the same provider abstraction.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { customProvider, uploadFile, uploadSkill } from 'ai';

// custom provider with files interface:
const myOpenAI = customProvider({
  languageModels: {
    'gpt-4o-mini': openai.responses('gpt-4o-mini'),
  },
  files: openai.files(),
});

// custom provider with skills interface:
const myAnthropic = customProvider({
  languageModels: {
    sonnet: anthropic('claude-sonnet-4-5'),
  },
  skills: anthropic.skills(),
});

// usage:
await uploadFile({ api: myOpenAI.files!(), data: fileData, filename: 'image.png' });
await uploadSkill({ api: myAnthropic.skills!(), files: skillFiles, displayTitle: 'My Skill' });
```

If no `files` or `skills` option is set but a `fallbackProvider` is configured, the custom provider will inherit those interfaces from the fallback.

## Provider Registry

You can create a [provider registry](/docs/reference/ai-sdk-core/provider-registry) with multiple providers and models using `createProviderRegistry`.

### Setup

```ts filename={"registry.ts"}
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { createProviderRegistry, gateway } from 'ai';

export const registry = createProviderRegistry({
  // register provider with prefix and default setup using gateway:
  gateway,

  // register provider with prefix and direct provider import:
  anthropic,
  openai,
});
```

### Setup with Custom Separator

By default, the registry uses `:` as the separator between provider and model IDs. You can customize this separator:

```ts filename={"registry.ts"}
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { createProviderRegistry, gateway } from 'ai';

export const customSeparatorRegistry = createProviderRegistry(
  {
    gateway,
    anthropic,
    openai,
  },
  { separator: ' > ' },
);
```

### Example: Use language models

You can access language models by using the `languageModel` method on the registry.
The provider id will become the prefix of the model id: `providerId:modelId`.

```ts highlight={"5"}
import { generateText } from 'ai';
import { registry } from './registry';

const { text } = await generateText({
  model: registry.languageModel('openai:gpt-5.1'), // default separator
  // or with custom separator:
  // model: customSeparatorRegistry.languageModel('openai > gpt-5.1'),
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

### Example: Use text embedding models

You can access text embedding models by using the `.embeddingModel` method on the registry.
The provider id will become the prefix of the model id: `providerId:modelId`.

```ts highlight={"5"}
import { embed } from 'ai';
import { registry } from './registry';

const { embedding } = await embed({
  model: registry.embeddingModel('openai:text-embedding-3-small'),
  value: 'sunny day at the beach',
});
```

### Example: Use image models

You can access image models by using the `imageModel` method on the registry.
The provider id will become the prefix of the model id: `providerId:modelId`.

```ts highlight={"5"}
import { generateImage } from 'ai';
import { registry } from './registry';

const { image } = await generateImage({
  model: registry.imageModel('openai:dall-e-3'),
  prompt: 'A beautiful sunset over a calm ocean',
});
```

### Example: Use video models

You can access video models by using the `videoModel` method on the registry.
The provider id will become the prefix of the model id: `providerId:modelId`.

```ts highlight={"5"}
import { experimental_generateVideo } from 'ai';
import { fal } from '@ai-sdk/fal';
import { createProviderRegistry } from 'ai';

const registry = createProviderRegistry({ fal });

const { videos } = await experimental_generateVideo({
  model: registry.videoModel('fal:luma-dream-machine/ray-2'),
  prompt: 'A cat walking on a beach at sunset',
});
```

### Example: Use files interface

You can access a provider's files interface by calling `registry.files(providerId)`.
This is useful when you want to upload files through a provider in the registry before referencing them in model requests.

```ts highlight={"7,8"}
import { openai } from '@ai-sdk/openai';
import { createProviderRegistry, customProvider, generateText, uploadFile } from 'ai';

const registry = createProviderRegistry({
  openai: customProvider({
    languageModels: { 'gpt-4o-mini': openai.responses('gpt-4o-mini') },
    files: openai.files(),
  }),
});

const { providerReference } = await uploadFile({
  api: registry.files('openai'),
  data: fileData,
  filename: 'image.png',
});

const { text } = await generateText({
  model: registry.languageModel('openai:gpt-4o-mini'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe what you see in this image.' },
        { type: 'image', image: providerReference },
      ],
    },
  ],
});
```

### Example: Use skills interface

You can access a provider's skills interface by calling `registry.skills(providerId)`.

```ts highlight={"8"}
import { anthropic } from '@ai-sdk/anthropic';
import { createProviderRegistry, customProvider, uploadSkill } from 'ai';

const registry = createProviderRegistry({
  anthropic: customProvider({
    languageModels: { sonnet: anthropic('claude-sonnet-4-5') },
    skills: anthropic.skills(),
  }),
});

await uploadSkill({
  api: registry.skills('anthropic'),
  files: skillFiles,
  displayTitle: 'My Skill',
});
```

## Combining Custom Providers, Provider Registry, and Middleware

The central idea of provider management is to set up a file that contains all the providers and models you want to use.
You may want to pre-configure model settings, provide model name aliases, limit the available models, and more.

Here is an example that implements the following concepts:

- pass through gateway with a namespace prefix (here: `gateway > *`)
- pass through a full provider with a namespace prefix (here: `xai > *`)
- setup an OpenAI-compatible provider with custom api key and base URL (here: `custom > *`)
- setup model name aliases (here: `anthropic > fast`, `anthropic > writing`, `anthropic > reasoning`)
- pre-configure model settings (here: `anthropic > reasoning`)
- validate the provider-specific options (here: `AnthropicLanguageModelOptions`)
- use a fallback provider (here: `anthropic > *`)
- limit a provider to certain models without a fallback (here: `groq > gemma2-9b-it`, `groq > qwen-qwq-32b`)
- define a custom separator for the provider registry (here: `>`)

```ts
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { xai } from '@ai-sdk/xai';
import { groq } from '@ai-sdk/groq';
import {
  createProviderRegistry,
  customProvider,
  defaultSettingsMiddleware,
  gateway,
  wrapLanguageModel,
} from 'ai';

export const registry = createProviderRegistry(
  {
    // pass through gateway with a namespace prefix
    gateway,

    // pass through full providers with namespace prefixes
    xai,

    // access an OpenAI-compatible provider with custom setup
    custom: createOpenAICompatible({
      name: 'provider-name',
      apiKey: process.env.CUSTOM_API_KEY,
      baseURL: 'https://api.custom.com/v1',
    }),

    // setup model name aliases
    anthropic: customProvider({
      languageModels: {
        fast: anthropic('claude-haiku-4-5'),

        // simple model
        writing: anthropic('claude-sonnet-4-5'),

        // extended reasoning model configuration:
        reasoning: wrapLanguageModel({
          model: anthropic('claude-sonnet-4-5'),
          middleware: defaultSettingsMiddleware({
            settings: {
              maxOutputTokens: 100000, // example default setting
              providerOptions: {
                anthropic: {
                  thinking: {
                    type: 'enabled',
                    budgetTokens: 32000,
                  },
                } satisfies AnthropicLanguageModelOptions,
              },
            },
          }),
        }),
      },
      fallbackProvider: anthropic,
    }),

    // limit a provider to certain models without a fallback
    groq: customProvider({
      languageModels: {
        'gemma2-9b-it': groq('gemma2-9b-it'),
        'qwen-qwq-32b': groq('qwen-qwq-32b'),
      },
    }),
  },
  { separator: ' > ' },
);

// usage:
const model = registry.languageModel('anthropic > reasoning');
```

## Global Provider Configuration

The AI SDK 5 includes a global provider feature that allows you to specify a model using just a plain model ID string:

```ts
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = await streamText({
  model: __MODEL__, // Uses the global provider (defaults to gateway)
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

By default, the global provider is set to the Vercel AI Gateway.

### Customizing the Global Provider

You can set your own preferred global provider:

```ts filename="setup.ts"
import { openai } from '@ai-sdk/openai';

// Initialize once during startup:
globalThis.AI_SDK_DEFAULT_PROVIDER = openai;
```

```ts filename="app.ts"
import { streamText } from 'ai';

const result = await streamText({
  model: 'gpt-5.1', // Uses OpenAI provider without prefix
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

This simplifies provider usage and makes it easier to switch between providers without changing your model references throughout your codebase.

---
title: Error Handling
description: Learn how to handle errors in the AI SDK Core
---

# Error Handling

## Handling regular errors

Regular errors are thrown and can be handled using the `try/catch` block.

```ts highlight="3,8-10"
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

try {
  const { text } = await generateText({
    model: __MODEL__,
    prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  });
} catch (error) {
  // handle error
}
```

See [Error Types](/docs/reference/ai-sdk-errors) for more information on the different types of errors that may be thrown.

## Handling streaming errors (simple streams)

When errors occur during streams that do not support error chunks,
the error is thrown as a regular error.
You can handle these errors using the `try/catch` block.

```ts highlight="3,12-14"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

try {
  const { textStream } = streamText({
    model: __MODEL__,
    prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  });

  for await (const textPart of textStream) {
    process.stdout.write(textPart);
  }
} catch (error) {
  // handle error
}
```

## Handling streaming errors (streaming with `error` support)

Full streams support error parts.
You can handle those parts similar to other parts.
It is recommended to also add a try-catch block for errors that
happen outside of the streaming.

```ts highlight="13-21"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

try {
  const { fullStream } = streamText({
    model: __MODEL__,
    prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  });

  for await (const part of fullStream) {
    switch (part.type) {
      // ... handle other part types

      case 'error': {
        const error = part.error;
        // handle error
        break;
      }

      case 'abort': {
        // handle stream abort
        break;
      }

      case 'tool-error': {
        const error = part.error;
        // handle error
        break;
      }
    }
  }
} catch (error) {
  // handle error
}
```

## Handling stream aborts

When streams are aborted (e.g., via chat stop button), you may want to perform cleanup operations like updating stored messages in your UI. Use the `onAbort` callback to handle these cases.

The `onAbort` callback is called when a stream is aborted via `AbortSignal`, but `onFinish` is not called. This ensures you can still update your UI state appropriately.

```ts highlight="5-9"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const { textStream } = streamText({
  model: __MODEL__,
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  onAbort: ({ steps }) => {
    // Update stored messages or perform cleanup
    console.log('Stream aborted after', steps.length, 'steps');
  },
  onFinish: ({ steps, totalUsage }) => {
    // This is called on normal completion
    console.log('Stream completed normally');
  },
});

for await (const textPart of textStream) {
  process.stdout.write(textPart);
}
```

The `onAbort` callback receives:

- `steps`: An array of all completed steps before the abort

You can also handle abort events directly in the stream:

```ts highlight="10-13"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const { fullStream } = streamText({
  model: __MODEL__,
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});

for await (const chunk of fullStream) {
  switch (chunk.type) {
    case 'abort': {
      // Handle abort directly in stream
      console.log('Stream was aborted');
      break;
    }
    // ... handle other part types
  }
}
```

---
title: Testing
description: Learn how to use AI SDK Core mock providers for testing.
---

# Testing

Testing language models can be challenging, because they are non-deterministic
and calling them is slow and expensive.

To enable you to unit test your code that uses the AI SDK, the AI SDK Core
includes mock providers and test helpers. You can import the following helpers from `ai/test`:

- `MockEmbeddingModelV4`: A mock embedding model using the [embedding model v4 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/embedding-model/v4/embedding-model-v4.ts).
- `MockLanguageModelV4`: A mock language model using the [language model v4 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v4/language-model-v4.ts).
- `mockId`: Provides an incrementing integer ID.
- `mockValues`: Iterates over an array of values with each call. Returns the last value when the array is exhausted.

You can also import [`simulateReadableStream`](/docs/reference/ai-sdk-core/simulate-readable-stream) from `ai` to simulate a readable stream with delays.

With mock providers and test helpers, you can control the output of the AI SDK
and test your code in a repeatable and deterministic way without actually calling
a language model provider.

## Examples

You can use the test helpers with the AI Core functions in your unit tests:

### generateText

```ts
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const result = await generateText({
  model: new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: `Hello, world!` }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 20,
          text: 20,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  }),
  prompt: 'Hello, test!',
});
```

### streamText

```ts
import { streamText, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const result = streamText({
  model: new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Hello' },
          { type: 'text-delta', id: 'text-1', delta: ', ' },
          { type: 'text-delta', id: 'text-1', delta: 'world!' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: {
                total: 3,
                noCache: 3,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 10,
                text: 10,
                reasoning: undefined,
              },
            },
          },
        ],
      }),
    }),
  }),
  prompt: 'Hello, test!',
});
```

### generateText with Output

```ts
import { generateText, Output } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

const result = await generateText({
  model: new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: `{"content":"Hello, world!"}` }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 20,
          text: 20,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  }),
  output: Output.object({ schema: z.object({ content: z.string() }) }),
  prompt: 'Hello, test!',
});
```

### streamText with Output

```ts
import { streamText, Output, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

const result = streamText({
  model: new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: '{ ' },
          { type: 'text-delta', id: 'text-1', delta: '"content": ' },
          { type: 'text-delta', id: 'text-1', delta: `"Hello, ` },
          { type: 'text-delta', id: 'text-1', delta: `world` },
          { type: 'text-delta', id: 'text-1', delta: `!"` },
          { type: 'text-delta', id: 'text-1', delta: ' }' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: {
                total: 3,
                noCache: 3,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 10,
                text: 10,
                reasoning: undefined,
              },
            },
          },
        ],
      }),
    }),
  }),
  output: Output.object({ schema: z.object({ content: z.string() }) }),
  prompt: 'Hello, test!',
});
```

### Simulate UI Message Stream Responses

You can also simulate [UI Message Stream](/docs/ai-sdk-ui/stream-protocol#ui-message-stream) responses for testing,
debugging, or demonstration purposes.

Here is a Next example:

```ts filename="route.ts"
import { simulateReadableStream } from 'ai';

export async function POST(req: Request) {
  return new Response(
    simulateReadableStream({
      initialDelayInMs: 1000, // Delay before the first chunk
      chunkDelayInMs: 300, // Delay between chunks
      chunks: [
        `data: {"type":"start","messageId":"msg-123"}\n\n`,
        `data: {"type":"text-start","id":"text-1"}\n\n`,
        `data: {"type":"text-delta","id":"text-1","delta":"This"}\n\n`,
        `data: {"type":"text-delta","id":"text-1","delta":" is an"}\n\n`,
        `data: {"type":"text-delta","id":"text-1","delta":" example."}\n\n`,
        `data: {"type":"text-end","id":"text-1"}\n\n`,
        `data: {"type":"finish"}\n\n`,
        `data: [DONE]\n\n`,
      ],
    }).pipeThrough(new TextEncoderStream()),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    },
  );
}
```

---
title: Telemetry
description: Using OpenTelemetry with AI SDK Core
---

# Telemetry

<Note type="warning">
  AI SDK Telemetry is experimental and may change in the future.
</Note>

The AI SDK uses [OpenTelemetry](https://opentelemetry.io/) to collect telemetry data.
OpenTelemetry is an open-source observability framework designed to provide
standardized instrumentation for collecting telemetry data.

Check out the [AI SDK Observability Integrations](/providers/observability)
to see providers that offer monitoring and tracing for AI SDK applications.

## Enabling telemetry

### Step 1: Register the OpenTelemetry integration

OpenTelemetry span collection requires the `@ai-sdk/otel` package. Install it and register the integration once at application startup:

```bash
pnpm install @ai-sdk/otel
```

```ts
import { registerTelemetryIntegration } from 'ai';
import { OpenTelemetryIntegration } from '@ai-sdk/otel';

registerTelemetryIntegration(new OpenTelemetryIntegration());
```

For Next.js applications, place this in your `instrumentation.ts` file alongside your OpenTelemetry provider setup. See the [Next.js OpenTelemetry guide](https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry) for more details on setting up the provider.

For Node.js applications (without Next.js), register the integration at the top level of your entry file.

### Step 2: Enabling Telemetry

Once a telemetry integration is registered, all AI SDK calls emit telemetry events by default.
You can still pass `telemetry` to attach metadata (like `functionId`) or to opt out of a specific call:

```ts highlight="4-6"
const result = await generateText({
  model: __MODEL__,
  prompt: 'Write a short story about a cat.',
  telemetry: {
    functionId: `story-agent`,
  },
});
```

By default, both inputs and outputs are recorded. You can disable them by setting the `recordInputs` and `recordOutputs` options to `false`.

Disabling the recording of inputs and outputs can be useful for privacy, data transfer, and performance reasons.
You might for example want to disable recording inputs if they contain sensitive information.

### Opting out

Telemetry is opt-out. To disable telemetry for a specific call, set `isEnabled: false`:

```ts
const result = await generateText({
  model: __MODEL__,
  prompt: 'Write a short story about a cat.',
  telemetry: { isEnabled: false },
});
```

To disable telemetry globally, do not register any telemetry integrations via the `registerTelemetryIntegration()` function.

## Telemetry Metadata

You can provide a `functionId` to identify the function that the telemetry data is for,
and `runtimeContext` to include additional information in the telemetry data.

```ts highlight="4-10"
const result = await generateText({
  model: __MODEL__,
  prompt: 'Write a short story about a cat.',
  runtimeContext: {
    something: 'custom',
    someOtherThing: 'other-value',
  },
  telemetry: {
    functionId: 'my-awesome-function',
  },
});
```

## Custom Tracer

If you want your traces to use a `TracerProvider` other than the one provided by the `@opentelemetry/api` singleton, pass a custom `Tracer` to the `OpenTelemetryIntegration` constructor:

```ts highlight="6-8"
import { registerTelemetryIntegration } from 'ai';
import { OpenTelemetryIntegration } from '@ai-sdk/otel';

const tracerProvider = new NodeTracerProvider();
registerTelemetryIntegration(
  new OpenTelemetryIntegration({
    tracer: tracerProvider.getTracer('ai'),
  }),
);
```

The `GenAIOpenTelemetryIntegration` also accepts a custom `Tracer` in the same way.

## Telemetry Integrations

Telemetry integrations let you hook into the generation lifecycle to build custom observability — logging, analytics, DevTools, or any other monitoring system. Instead of wiring up individual callbacks on every call, you implement a `TelemetryIntegration` once and register it globally or pass it via `telemetry.integrations`.

The `GenAIOpenTelemetryIntegration` and `OpenTelemetryIntegration` from `@ai-sdk/otel` are the built-in integrations for collecting OpenTelemetry spans (see [Enabling telemetry](#enabling-telemetry) above).

### Registering integrations globally

Use `registerTelemetryIntegration` to register an integration once for all AI SDK calls:

```ts
import { registerTelemetryIntegration } from 'ai';
import { OpenTelemetryIntegration } from '@ai-sdk/otel';

registerTelemetryIntegration(new OpenTelemetryIntegration());
```

You can also register multiple integrations in a single call by passing them as additional arguments. They all receive the same lifecycle events:

```ts
import { registerTelemetryIntegration } from 'ai';
import { OpenTelemetryIntegration } from '@ai-sdk/otel';
import { DevToolsTelemetry } from '@ai-sdk/devtools';

registerTelemetryIntegration(
  new OpenTelemetryIntegration(),
  DevToolsTelemetry(),
);
```

### Per-call integrations

You can also pass one or more integrations to individual `generateText` or `streamText` calls. When per-call integrations are provided, they replace the globally registered integrations for that call:

```ts highlight="6-8"
import { streamText } from 'ai';
import { DevToolsTelemetry } from '@ai-sdk/devtools';

const result = streamText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  telemetry: {
    integrations: [DevToolsTelemetry()],
  },
});
```

You can combine multiple integrations — they all receive the same lifecycle events:

```ts
telemetry: {
  integrations: [DevToolsTelemetry(), customLogger()],
},
```

Errors inside integrations are caught and do not break the generation flow.

### Building a custom integration

Implement the `TelemetryIntegration` interface from the `ai` package. All methods are optional — implement only the lifecycle events you care about:

```ts
import type { TelemetryIntegration } from 'ai';

class MyIntegration implements TelemetryIntegration {
  async onStart(event) {
    console.log('Generation started:', event.model.modelId);
  }

  async onStepFinish(event) {
    console.log(
      `Step ${event.stepNumber} done:`,
      event.usage.totalTokens,
      'tokens',
    );
  }

  async onToolExecutionEnd(event) {
    if (event.success) {
      console.log(
        `Tool "${event.toolCall.toolName}" took ${event.durationMs}ms`,
      );
    } else {
      console.error(`Tool "${event.toolCall.toolName}" failed:`, event.error);
    }
  }

  async onFinish(event) {
    console.log('Done. Total tokens:', event.totalUsage.totalTokens);
  }
}

export function myIntegration(): TelemetryIntegration {
  return new MyIntegration();
}
```

### Available lifecycle methods

<PropertiesTable
  content={[
    {
      name: 'onStart',
      type: '(event: OnStartEvent) => void | PromiseLike<void>',
      description:
        'Called when the generation operation begins, before any LLM calls.',
    },
    {
      name: 'onStepStart',
      type: '(event: OnStepStartEvent) => void | PromiseLike<void>',
      description:
        'Called when a step (LLM call) begins, before the provider is called.',
    },
    {
      name: 'onToolExecutionStart',
      type: '(event: ToolExecutionStartEvent) => void | PromiseLike<void>',
      description: "Called when a tool's execute function is about to run.",
    },
    {
      name: 'onToolExecutionEnd',
      type: '(event: ToolExecutionEndEvent) => void | PromiseLike<void>',
      description: "Called when a tool's execute function completes or errors.",
    },
    {
      name: 'onStepFinish',
      type: '(event: OnStepFinishEvent) => void | PromiseLike<void>',
      description: 'Called when a step (LLM call) completes.',
    },
    {
      name: 'onFinish',
      type: '(event: OnFinishEvent) => void | PromiseLike<void>',
      description:
        'Called when the entire generation completes (all steps finished).',
    },
  ]}
/>

The event types for each method are the same as the corresponding [event callbacks](/docs/ai-sdk-core/event-listeners). See the event callbacks documentation for the full property reference of each event.

## Collected Data

The `@ai-sdk/otel` package provides two integrations that emit different span formats.
The `GenAIOpenTelemetryIntegration` follows the [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and is the recommended integration.
The `OpenTelemetryIntegration` emits legacy AI SDK-specific spans.

### GenAI Semantic Conventions

The `GenAIOpenTelemetryIntegration` emits spans that follow the [OpenTelemetry Semantic Conventions for GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
All attributes use the `gen_ai.*` prefix. Provider names are mapped to well-known values (e.g. `openai`, `anthropic`, `gcp.vertex_ai`).

#### generateText / streamText

For `generateText` and `streamText`, the integration records 3 types of spans:

- **`invoke_agent {modelId}`** (root span, `INTERNAL`): covers the full operation including all steps and tool calls.

  Initial attributes:
  - `gen_ai.operation.name`: `"invoke_agent"`
  - `gen_ai.provider.name`: the provider (e.g. `"openai"`, `"anthropic"`)
  - `gen_ai.request.model`: the requested model ID
  - `gen_ai.agent.name`: the `functionId` from telemetry settings
  - `gen_ai.system_instructions`: system instructions formatted as a JSON array of parts (when `recordInputs` is enabled)
  - `gen_ai.input.messages`: the input messages in [GenAI SemConv message format](#genai-message-format) (when `recordInputs` is enabled)
  - `gen_ai.request.temperature`: the temperature setting
  - `gen_ai.request.max_tokens`: the maximum output tokens
  - `gen_ai.request.top_p`: the topP setting
  - `gen_ai.request.top_k`: the topK setting
  - `gen_ai.request.frequency_penalty`: the frequency penalty
  - `gen_ai.request.presence_penalty`: the presence penalty
  - `gen_ai.request.stop_sequences`: the stop sequences
  - `gen_ai.request.seed`: the seed value

  Attributes set on finish:
  - `gen_ai.response.finish_reasons`: array of finish reasons (e.g. `["stop"]`, `["tool_call"]`)
  - `gen_ai.usage.input_tokens`: the number of input tokens used
  - `gen_ai.usage.output_tokens`: the number of output tokens used
  - `gen_ai.usage.cache_read.input_tokens`: cached input tokens read
  - `gen_ai.usage.cache_creation.input_tokens`: cached input tokens created
  - `gen_ai.output.messages`: the output in [GenAI SemConv message format](#genai-message-format) (when `recordOutputs` is enabled)

- **`chat {modelId}`** (step span, `CLIENT`): one span per LLM provider call, nested under the root span.

  Initial attributes:
  - `gen_ai.operation.name`: `"chat"`
  - `gen_ai.provider.name`: the provider
  - `gen_ai.request.model`: the requested model ID
  - `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.request.top_p`, `gen_ai.request.top_k`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.request.stop_sequences`: request parameters
  - `gen_ai.input.messages`: the prompt messages in [GenAI SemConv message format](#genai-message-format) (when `recordInputs` is enabled)
  - `gen_ai.tool.definitions`: the tool definitions as stringified JSON (when `recordInputs` is enabled)

  Attributes set on finish:
  - `gen_ai.response.finish_reasons`: array of finish reasons
  - `gen_ai.response.id`: the response ID from the provider
  - `gen_ai.response.model`: the model that generated the response (may differ from the requested model)
  - `gen_ai.usage.input_tokens`: input tokens used in this step
  - `gen_ai.usage.output_tokens`: output tokens used in this step
  - `gen_ai.usage.cache_read.input_tokens`: cached input tokens read
  - `gen_ai.usage.cache_creation.input_tokens`: cached input tokens created
  - `gen_ai.output.messages`: the output in [GenAI SemConv message format](#genai-message-format) (when `recordOutputs` is enabled)

- **`execute_tool {toolName}`** (tool span, `INTERNAL`): one span per tool execution, nested under the step span. See [GenAI tool call spans](#genai-tool-call-spans) for details.

#### Deprecated object APIs (generateObject / streamObject)

<Note type="warning">
  `generateObject` and `streamObject` are deprecated. Use `generateText` and
  `streamText` with the `output` property instead.
</Note>

The deprecated object APIs emit the same span hierarchy as `generateText`/`streamText` with these additional attributes on the root span:

- `gen_ai.output.type`: `"json"`

The step spans also include `gen_ai.output.type: "json"`, and `gen_ai.output.messages` contains the generated object as a text part.

#### embed / embedMany

For `embed` and `embedMany`, the integration records spans with `CLIENT` kind:

- **`embeddings {modelId}`** (root span): covers the full embedding operation.

  Initial attributes:
  - `gen_ai.operation.name`: `"embeddings"`
  - `gen_ai.provider.name`: the provider
  - `gen_ai.request.model`: the requested model ID

  Attributes set on finish:
  - `gen_ai.usage.input_tokens`: the number of tokens used

- **`embeddings {modelId}`** (inner span, `embedMany` only): one span per provider batch call, nested under the root span.

  Initial attributes:
  - `gen_ai.operation.name`: `"embeddings"`
  - `gen_ai.provider.name`: the provider
  - `gen_ai.request.model`: the model ID

  Attributes set on finish:
  - `gen_ai.usage.input_tokens`: the number of tokens used

#### rerank

For `rerank`, the integration records spans with `CLIENT` kind:

- **`rerank {modelId}`** (root span): covers the full rerank operation.

  Initial attributes:
  - `gen_ai.operation.name`: `"rerank"`
  - `gen_ai.provider.name`: the provider
  - `gen_ai.request.model`: the requested model ID

- **`rerank {modelId}`** (inner span): one span per provider rerank call, nested under the root span.

  Initial attributes:
  - `gen_ai.operation.name`: `"rerank"`
  - `gen_ai.provider.name`: the provider
  - `gen_ai.request.model`: the model ID

#### GenAI span details

##### GenAI message format

The `gen_ai.input.messages` and `gen_ai.output.messages` attributes follow the [OpenTelemetry GenAI Semantic Conventions message format](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/).
Messages are JSON arrays of objects with a `role` and a `parts` array. Each part has a `type` and type-specific fields:

- `text`: `{ type: "text", content: "..." }`
- `reasoning`: `{ type: "reasoning", content: "..." }`
- `tool_call`: `{ type: "tool_call", id: "...", name: "...", arguments: ... }`
- `tool_call_response`: `{ type: "tool_call_response", id: "...", response: ... }`
- `blob`: `{ type: "blob", modality: "image"|"video"|"audio", mime_type: "...", content: "..." }` (base64-encoded)
- `uri`: `{ type: "uri", modality: "image"|"video"|"audio", mime_type: "...", uri: "..." }` (for URL-based files)

Output messages also include a `finish_reason` field (e.g. `"stop"`, `"tool_call"`, `"length"`, `"content_filter"`).

System instructions are recorded separately in `gen_ai.system_instructions` as a JSON array of `{ type: "text", content: "..." }` parts.

##### GenAI tool call spans

Tool call spans (`execute_tool {toolName}`) are nested under the step span and contain:

- `gen_ai.operation.name`: `"execute_tool"`
- `gen_ai.tool.name`: the name of the tool
- `gen_ai.tool.call.id`: the tool call ID
- `gen_ai.tool.type`: `"function"`
- `gen_ai.tool.call.arguments`: the input arguments (stringified JSON, when `recordInputs` is enabled)
- `gen_ai.tool.call.result`: the output result (stringified JSON, when `recordOutputs` is enabled). Only set when the tool call succeeds.

### Legacy AI SDK Spans (`OpenTelemetryIntegration`)

The `OpenTelemetryIntegration` emits spans using AI SDK-specific `ai.*` prefixed attributes.
This is the legacy format. Consider migrating to the `GenAIOpenTelemetryIntegration` for better compatibility with observability platforms.

#### generateText function

`generateText` records 3 types of spans:

- `ai.generateText` (span): the full length of the generateText call. It contains 1 or more `ai.generateText.doGenerate` spans.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateText` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateText"`
  - `ai.prompt`: the prompt that was used when calling `generateText`
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished
  - `ai.settings.maxOutputTokens`: the maximum number of output tokens that were set

- `ai.generateText.doGenerate` (span): a provider doGenerate call. It can contain `ai.toolCall` spans.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateText.doGenerate` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateText.doGenerate"`
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.prompt.tools`: array of stringified tool definitions. The tools can be of type `function` or `provider-defined-client`.
    Function tools have a `name`, `description` (optional), and `inputSchema` (JSON schema).
    Provider-defined-client tools have a `name`, `id`, and `input` (Record).
  - `ai.prompt.toolChoice`: the stringified tool choice setting (JSON). It has a `type` property
    (`auto`, `none`, `required`, `tool`), and if the type is `tool`, a `toolName` property with the specific tool.
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished

- `ai.toolCall` (span): a tool call that is made as part of the generateText call. See [Legacy tool call spans](#legacy-tool-call-spans) for more details.

#### streamText function

`streamText` records 3 types of spans and 2 types of events:

- `ai.streamText` (span): the full length of the streamText call. It contains a `ai.streamText.doStream` span.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamText` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamText"`
  - `ai.prompt`: the prompt that was used when calling `streamText`
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished
  - `ai.settings.maxOutputTokens`: the maximum number of output tokens that were set

- `ai.streamText.doStream` (span): a provider doStream call.
  This span contains an `ai.stream.firstChunk` event and `ai.toolCall` spans.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamText.doStream` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamText.doStream"`
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.prompt.tools`: array of stringified tool definitions. The tools can be of type `function` or `provider-defined-client`.
    Function tools have a `name`, `description` (optional), and `inputSchema` (JSON schema).
    Provider-defined-client tools have a `name`, `id`, and `input` (Record).
  - `ai.prompt.toolChoice`: the stringified tool choice setting (JSON). It has a `type` property
    (`auto`, `none`, `required`, `tool`), and if the type is `tool`, a `toolName` property with the specific tool.
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk in milliseconds
  - `ai.response.msToFinish`: the time it took to receive the finish part of the LLM stream in milliseconds
  - `ai.response.avgCompletionTokensPerSecond`: the average number of completion tokens per second
  - `ai.response.finishReason`: the reason why the generation finished

- `ai.toolCall` (span): a tool call that is made as part of the streamText call. See [Legacy tool call spans](#legacy-tool-call-spans) for more details.

- `ai.stream.firstChunk` (event): an event that is emitted when the first chunk of the stream is received.

  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk

- `ai.stream.finish` (event): an event that is emitted when the finish part of the LLM stream is received.

#### Deprecated object APIs

<Note type="warning">
  `generateObject` and `streamObject` are deprecated. Use `generateText` and
  `streamText` with the `output` property instead.
</Note>

If you still run deprecated object APIs, you will see legacy span names:

- `generateObject`: `ai.generateObject`, `ai.generateObject.doGenerate`
- `streamObject`: `ai.streamObject`, `ai.streamObject.doStream`, `ai.stream.firstChunk`

Legacy object spans include the same core metadata as other LLM spans, plus
object-specific attributes such as `ai.schema.*`, `ai.response.object`, and
`ai.settings.output`.

#### embed function

`embed` records 2 types of spans:

- `ai.embed` (span): the full length of the embed call. It contains 1 `ai.embed.doEmbed` spans.
  It contains the [basic embedding span information](#basic-embedding-span-information) and the following attributes:

  - `operation.name`: `ai.embed` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.embed"`
  - `ai.value`: the value that was passed into the `embed` function
  - `ai.embedding`: a JSON-stringified embedding

- `ai.embed.doEmbed` (span): a provider doEmbed call.
  It contains the [basic embedding span information](#basic-embedding-span-information) and the following attributes:

  - `operation.name`: `ai.embed.doEmbed` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.embed.doEmbed"`
  - `ai.values`: the values that were passed into the provider (array)
  - `ai.embeddings`: an array of JSON-stringified embeddings

#### embedMany function

`embedMany` records 2 types of spans:

- `ai.embedMany` (span): the full length of the embedMany call. It contains 1 or more `ai.embedMany.doEmbed` spans.
  It contains the [basic embedding span information](#basic-embedding-span-information) and the following attributes:

  - `operation.name`: `ai.embedMany` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.embedMany"`
  - `ai.values`: the values that were passed into the `embedMany` function
  - `ai.embeddings`: an array of JSON-stringified embedding

- `ai.embedMany.doEmbed` (span): a provider doEmbed call.
  It contains the [basic embedding span information](#basic-embedding-span-information) and the following attributes:

  - `operation.name`: `ai.embedMany.doEmbed` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.embedMany.doEmbed"`
  - `ai.values`: the values that were sent to the provider
  - `ai.embeddings`: an array of JSON-stringified embeddings for each value

#### Legacy span details

##### Basic LLM span information

Many spans that use LLMs (`ai.generateText`, `ai.generateText.doGenerate`, `ai.streamText`, `ai.streamText.doStream`) contain the following attributes:

- `resource.name`: the functionId that was set through `telemetry.functionId`
- `ai.model.id`: the id of the model
- `ai.model.provider`: the provider of the model
- `ai.request.headers.*`: the request headers that were passed in through `headers`
- `ai.response.providerMetadata`: provider specific metadata returned with the generation response
- `ai.settings.maxRetries`: the maximum number of retries that were set
- `ai.telemetry.functionId`: the functionId that was set through `telemetry.functionId`
- `ai.settings.runtimeContext.*`: the runtime context that was passed in through the `runtimeContext` option
- `ai.usage.completionTokens`: the number of completion tokens that were used
- `ai.usage.promptTokens`: the number of prompt tokens that were used

##### Call LLM span information

Spans that correspond to individual LLM calls (`ai.generateText.doGenerate`, `ai.streamText.doStream`) contain
[basic LLM span information](#basic-llm-span-information) and the following attributes:

- `ai.response.model`: the model that was used to generate the response. This can be different from the model that was requested if the provider supports aliases.
- `ai.response.id`: the id of the response. Uses the ID from the provider when available.
- `ai.response.timestamp`: the timestamp of the response. Uses the timestamp from the provider when available.
- [Semantic Conventions for GenAI operations](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
  - `gen_ai.system`: the provider that was used
  - `gen_ai.request.model`: the model that was requested
  - `gen_ai.request.temperature`: the temperature that was set
  - `gen_ai.request.max_tokens`: the maximum number of tokens that were set
  - `gen_ai.request.frequency_penalty`: the frequency penalty that was set
  - `gen_ai.request.presence_penalty`: the presence penalty that was set
  - `gen_ai.request.top_k`: the topK parameter value that was set
  - `gen_ai.request.top_p`: the topP parameter value that was set
  - `gen_ai.request.stop_sequences`: the stop sequences
  - `gen_ai.response.finish_reasons`: the finish reasons that were returned by the provider
  - `gen_ai.response.model`: the model that was used to generate the response. This can be different from the model that was requested if the provider supports aliases.
  - `gen_ai.response.id`: the id of the response. Uses the ID from the provider when available.
  - `gen_ai.usage.input_tokens`: the number of prompt tokens that were used
  - `gen_ai.usage.output_tokens`: the number of completion tokens that were used

##### Basic embedding span information

Many spans that use embedding models (`ai.embed`, `ai.embed.doEmbed`, `ai.embedMany`, `ai.embedMany.doEmbed`) contain the following attributes:

- `ai.model.id`: the id of the model
- `ai.model.provider`: the provider of the model
- `ai.request.headers.*`: the request headers that were passed in through `headers`
- `ai.settings.maxRetries`: the maximum number of retries that were set
- `ai.telemetry.functionId`: the functionId that was set through `telemetry.functionId`
- `ai.settings.runtimeContext.*`: the runtime context that was passed in through the `runtimeContext` option
- `ai.usage.tokens`: the number of tokens that were used
- `resource.name`: the functionId that was set through `telemetry.functionId`

##### Legacy tool call spans

Tool call spans (`ai.toolCall`) contain the following attributes:

- `operation.name`: `"ai.toolCall"`
- `ai.operationId`: `"ai.toolCall"`
- `ai.toolCall.name`: the name of the tool
- `ai.toolCall.id`: the id of the tool call
- `ai.toolCall.args`: the input parameters of the tool call
- `ai.toolCall.result`: the output result of the tool call. Only available if the tool call is successful and the result is serializable.

---
title: DevTools
description: Debug and inspect AI SDK applications with DevTools
---

# DevTools

<Note type="warning">
  AI SDK DevTools is experimental and intended for local development only. Do
  not use in production environments.
</Note>

AI SDK DevTools gives you full visibility over your AI SDK calls with [`generateText`](/docs/reference/ai-sdk-core/generate-text), [`streamText`](/docs/reference/ai-sdk-core/stream-text), and [`ToolLoopAgent`](/docs/reference/ai-sdk-core/tool-loop-agent). It helps you debug and inspect LLM requests, responses, tool calls, and multi-step interactions through a web-based UI.

DevTools is composed of two parts:

1. **Telemetry Integration**: Captures runs and steps from your AI SDK calls via the [telemetry](/docs/ai-sdk-core/telemetry) system
2. **Viewer**: A web UI to inspect the captured data

## Installation

Install the DevTools package:

```bash
pnpm add @ai-sdk/devtools
```

## Requirements

- AI SDK v6 beta (`ai@^6.0.0-beta.0`)
- Node.js compatible runtime

## Using DevTools

### Register the integration

Register `DevToolsTelemetry` globally so it captures all AI SDK calls:

```ts
import { registerTelemetryIntegration } from 'ai';
import { DevToolsTelemetry } from '@ai-sdk/devtools';

registerTelemetryIntegration(DevToolsTelemetry());
```

Telemetry is enabled automatically once an integration is registered — no per-call configuration is needed:

```ts
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What cities are in the United States?',
});
```

You can also pass the integration to individual calls instead of registering it globally:

```ts highlight="7-9"
import { streamText } from 'ai';
import { DevToolsTelemetry } from '@ai-sdk/devtools';

const result = streamText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  telemetry: {
    integrations: [DevToolsTelemetry()],
  },
});
```

### Launch the viewer

Start the DevTools viewer:

```bash
npx @ai-sdk/devtools
```

Open [http://localhost:4983](http://localhost:4983) to view your AI SDK interactions.

### Monorepo usage

If you are using a monorepo setup (e.g. Turborepo, Nx), start DevTools from the same workspace where your AI SDK code runs.

For example, if your API is in `apps/api`, run:

```bash
cd apps/api
npx @ai-sdk/devtools
```

## Captured data

DevTools captures the following information from your AI SDK calls:

- **Input parameters and prompts**: View the complete input sent to your LLM
- **Output content and tool calls**: Inspect generated text and tool invocations
- **Token usage and timing**: Monitor resource consumption and performance
- **Raw provider data**: Access complete request and response payloads

### Runs and steps

DevTools organizes captured data into runs and steps:

- **Run**: A complete multi-step AI interaction, grouped by the initial prompt
- **Step**: A single LLM call within a run (e.g., one `generateText` or `streamText` call)

Multi-step interactions, such as those created by tool calling or agent loops, are grouped together as a single run with multiple steps. Nested sub-agent calls are linked to their parent run, making it easy to trace the full execution tree.

## How it works

The `DevToolsTelemetry` integration hooks into the AI SDK [telemetry](/docs/ai-sdk-core/telemetry) lifecycle to capture all `generateText`, `streamText`, `generateObject`, and `streamObject` calls. Captured data is stored locally in a JSON file (`.devtools/generations.json`) and served through a web UI built with Hono and React.

<Note type="warning">
  The integration automatically adds `.devtools` to your `.gitignore` file.
  Verify that `.devtools` is in your `.gitignore` to ensure you don't commit
  sensitive AI interaction data to your repository.
</Note>

## Security considerations

DevTools stores all AI interactions locally in plain text files, including:

- User prompts and messages
- LLM responses
- Tool call arguments and results
- API request and response data

**Only use DevTools in local development environments.** Do not enable DevTools in production or when handling sensitive data.

---
title: Event Callbacks
description: Subscribe to lifecycle events in generateText, streamText, embed, embedMany, and rerank calls
---

# Event Callbacks

The AI SDK provides per-call event callbacks that you can pass to `generateText`, `streamText`, `embed`, `embedMany`, and `rerank` to observe lifecycle events. This is useful for building observability tools, logging systems, analytics, and debugging utilities.

## Basic Usage

Pass callbacks directly to `generateText`, `streamText`, `embed`, `embedMany`, or `rerank`:

```ts
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather in San Francisco?',
  experimental_onStart: event => {
    console.log('Generation started:', event.model.modelId);
  },
  onFinish: event => {
    console.log('Generation finished:', event.totalUsage);
  },
});
```

## Available Callbacks

### `generateText` / `streamText`

<PropertiesTable
  content={[
    {
      name: 'experimental_onStart',
      type: '(event: OnStartEvent) => void | Promise<void>',
      description: 'Called when generation begins, before any LLM calls.',
    },
    {
      name: 'experimental_onStepStart',
      type: '(event: OnStepStartEvent) => void | Promise<void>',
      description:
        'Called when a step (LLM call) begins, before the provider is called.',
    },
    {
      name: 'experimental_onToolExecutionStart',
      type: '(event: ToolExecutionStartEvent) => void | Promise<void>',
      description: "Called when a tool's execute function is about to run.",
    },
    {
      name: 'experimental_onToolExecutionEnd',
      type: '(event: ToolExecutionEndEvent) => void | Promise<void>',
      description: "Called when a tool's execute function completes or errors.",
    },
    {
      name: 'onStepFinish',
      type: '(event: OnStepFinishEvent) => void | Promise<void>',
      description: 'Called when a step (LLM call) completes.',
    },
    {
      name: 'onFinish',
      type: '(event: OnFinishEvent) => void | Promise<void>',
      description:
        'Called when the entire generation completes (all steps finished).',
    },
  ]}
/>

### `embed` / `embedMany`

<PropertiesTable
  content={[
    {
      name: 'experimental_onStart',
      type: '(event: EmbedOnStartEvent) => void | Promise<void>',
      description:
        'Called when the embedding operation begins, before the embedding model is called.',
    },
    {
      name: 'experimental_onFinish',
      type: '(event: EmbedOnFinishEvent) => void | Promise<void>',
      description:
        'Called when the embedding operation completes, after the embedding model returns.',
    },
  ]}
/>

### `rerank`

<PropertiesTable
  content={[
    {
      name: 'experimental_onStart',
      type: '(event: RerankOnStartEvent) => void | Promise<void>',
      description:
        'Called when the reranking operation begins, before the reranking model is called.',
    },
    {
      name: 'experimental_onFinish',
      type: '(event: RerankOnFinishEvent) => void | Promise<void>',
      description:
        'Called when the reranking operation completes, after the reranking model returns.',
    },
  ]}
/>

## Event Reference

### `generateText` / `streamText`

#### `experimental_onStart`

Called when the generation operation begins, before any LLM calls are made.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  experimental_onStart: event => {
    console.log('Model:', event.model.modelId);
    console.log('Temperature:', event.temperature);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The model being used for generation.',
    },
    {
      name: 'system',
      type: 'string | SystemModelMessage | Array<SystemModelMessage> | undefined',
      description: 'The system message(s) provided to the model.',
    },
    {
      name: 'prompt',
      type: 'string | Array<ModelMessage> | undefined',
      description:
        'The prompt string or array of messages if using the prompt option.',
    },
    {
      name: 'messages',
      type: 'Array<ModelMessage> | undefined',
      description: 'The messages array if using the messages option.',
    },
    {
      name: 'tools',
      type: 'ToolSet | undefined',
      description: 'The tools available for this generation.',
    },
    {
      name: 'toolChoice',
      type: 'ToolChoice | undefined',
      description: 'The tool choice strategy for this generation.',
    },
    {
      name: 'activeTools',
      type: 'Array<keyof TOOLS> | undefined',
      description: 'Limits which tools are available for the model to call.',
    },
    {
      name: 'maxOutputTokens',
      type: 'number | undefined',
      description: 'Maximum number of tokens to generate.',
    },
    {
      name: 'temperature',
      type: 'number | undefined',
      description: 'Sampling temperature for generation.',
    },
    {
      name: 'topP',
      type: 'number | undefined',
      description: 'Top-p (nucleus) sampling parameter.',
    },
    {
      name: 'topK',
      type: 'number | undefined',
      description: 'Top-k sampling parameter.',
    },
    {
      name: 'presencePenalty',
      type: 'number | undefined',
      description: 'Presence penalty for generation.',
    },
    {
      name: 'frequencyPenalty',
      type: 'number | undefined',
      description: 'Frequency penalty for generation.',
    },
    {
      name: 'stopSequences',
      type: 'string[] | undefined',
      description: 'Sequences that will stop generation.',
    },
    {
      name: 'seed',
      type: 'number | undefined',
      description: 'Random seed for reproducible generation.',
    },
    {
      name: 'maxRetries',
      type: 'number',
      description: 'Maximum number of retries for failed requests.',
    },
    {
      name: 'timeout',
      type: 'TimeoutConfiguration | undefined',
      description: 'Timeout configuration for the generation.',
    },
    {
      name: 'headers',
      type: 'Record<string, string | undefined> | undefined',
      description: 'Additional HTTP headers sent with the request.',
    },
    {
      name: 'providerOptions',
      type: 'ProviderOptions | undefined',
      description: 'Additional provider-specific options.',
    },
    {
      name: 'stopWhen',
      type: 'StopCondition | Array<StopCondition> | undefined',
      description: 'Condition(s) for stopping the generation.',
    },
    {
      name: 'output',
      type: 'Output | undefined',
      description: 'The output specification for structured outputs.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Abort signal for cancelling the operation.',
    },
    {
      name: 'include',
      type: '{ requestBody?: boolean; responseBody?: boolean } | undefined',
      description:
        'Settings for controlling what data is included in step results.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'runtimeContext',
      type: 'CONTEXT',
      description:
        'User-defined shared runtime context object that flows through the generation lifecycle.',
    },
    {
      name: 'toolsContext',
      type: 'InferToolSetContext<TOOLS>',
      description:
        'Per-tool context map passed via `toolsContext`, keyed by tool name.',
    },
  ]}
/>

#### `experimental_onStepStart`

Called before each step (LLM call) begins. Useful for tracking multi-step generations.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  experimental_onStepStart: event => {
    console.log('Step:', event.stepNumber);
    console.log('Messages:', event.messages.length);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'stepNumber',
      type: 'number',
      description: 'Zero-based index of the current step.',
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The model being used for this step.',
    },
    {
      name: 'system',
      type: 'string | SystemModelMessage | Array<SystemModelMessage> | undefined',
      description: 'The system message for this step.',
    },
    {
      name: 'messages',
      type: 'Array<ModelMessage>',
      description: 'The messages that will be sent to the model for this step.',
    },
    {
      name: 'tools',
      type: 'ToolSet | undefined',
      description: 'The tools available for this generation.',
    },
    {
      name: 'toolChoice',
      type: 'LanguageModelV4ToolChoice | undefined',
      description: 'The tool choice configuration for this step.',
    },
    {
      name: 'activeTools',
      type: 'Array<keyof TOOLS> | undefined',
      description: 'Limits which tools are available for this step.',
    },
    {
      name: 'steps',
      type: 'ReadonlyArray<StepResult>',
      description:
        'Array of results from previous steps (empty for first step).',
    },
    {
      name: 'providerOptions',
      type: 'ProviderOptions | undefined',
      description: 'Additional provider-specific options for this step.',
    },
    {
      name: 'timeout',
      type: 'TimeoutConfiguration | undefined',
      description: 'Timeout configuration for the generation.',
    },
    {
      name: 'headers',
      type: 'Record<string, string | undefined> | undefined',
      description: 'Additional HTTP headers sent with the request.',
    },
    {
      name: 'stopWhen',
      type: 'StopCondition | Array<StopCondition> | undefined',
      description: 'Condition(s) for stopping the generation.',
    },
    {
      name: 'output',
      type: 'Output | undefined',
      description: 'The output specification for structured outputs.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Abort signal for cancelling the operation.',
    },
    {
      name: 'include',
      type: '{ requestBody?: boolean; responseBody?: boolean } | undefined',
      description:
        'Settings for controlling what data is included in step results.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'runtimeContext',
      type: 'CONTEXT',
      description:
        'User-defined shared runtime context object. May be updated from prepareStep between steps.',
    },
    {
      name: 'toolsContext',
      type: 'InferToolSetContext<TOOLS>',
      description:
        'Per-tool context map. May be updated from prepareStep between steps.',
    },
  ]}
/>

#### `experimental_onToolExecutionStart`

Called before a tool's `execute` function runs.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather?',
  tools: { getWeather },
  experimental_onToolExecutionStart: event => {
    console.log('Tool:', event.toolCall.toolName);
    console.log('Input:', event.toolCall.input);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'stepNumber',
      type: 'number | undefined',
      description:
        'Zero-based index of the current step where this tool call occurs.',
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string } | undefined',
      description: 'The model being used for this step.',
    },
    {
      name: 'toolCall',
      type: 'TypedToolCall',
      description: 'The full tool call object.',
      properties: [
        {
          type: 'TypedToolCall',
          parameters: [
            {
              name: 'type',
              type: "'tool-call'",
              description: 'The type of the call.',
            },
            {
              name: 'toolCallId',
              type: 'string',
              description: 'Unique identifier for this tool call.',
            },
            {
              name: 'toolName',
              type: 'string',
              description: 'Name of the tool being called.',
            },
            {
              name: 'input',
              type: 'unknown',
              description: 'Input arguments passed to the tool.',
            },
          ],
        },
      ],
    },
    {
      name: 'messages',
      type: 'Array<ModelMessage>',
      description:
        'The conversation messages available at tool execution time.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Signal for cancelling the operation.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'context',
      type: 'CONTEXT',
      description:
        'Tool-specific context object for the tool call that is about to execute.',
    },
  ]}
/>

#### `experimental_onToolExecutionEnd`

Called after a tool's `execute` function completes or errors. Uses a discriminated union on the `success` field.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather?',
  tools: { getWeather },
  experimental_onToolExecutionEnd: event => {
    console.log('Tool:', event.toolCall.toolName);
    console.log('Duration:', event.durationMs, 'ms');

    if (event.success) {
      console.log('Output:', event.output);
    } else {
      console.error('Error:', event.error);
    }
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'stepNumber',
      type: 'number | undefined',
      description:
        'Zero-based index of the current step where this tool call occurred.',
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string } | undefined',
      description: 'The model being used for this step.',
    },
    {
      name: 'toolCall',
      type: 'TypedToolCall',
      description: 'The full tool call object.',
      properties: [
        {
          type: 'TypedToolCall',
          parameters: [
            {
              name: 'type',
              type: "'tool-call'",
              description: 'The type of the call.',
            },
            {
              name: 'toolCallId',
              type: 'string',
              description: 'Unique identifier for this tool call.',
            },
            {
              name: 'toolName',
              type: 'string',
              description: 'Name of the tool that was called.',
            },
            {
              name: 'input',
              type: 'unknown',
              description: 'Input arguments passed to the tool.',
            },
          ],
        },
      ],
    },
    {
      name: 'messages',
      type: 'Array<ModelMessage>',
      description:
        'The conversation messages available at tool execution time.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Signal for cancelling the operation.',
    },
    {
      name: 'durationMs',
      type: 'number',
      description: 'Execution time of the tool call in milliseconds.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'context',
      type: 'CONTEXT',
      description:
        'Tool-specific context object for the tool call that just completed.',
    },
    {
      name: 'success',
      type: 'boolean',
      description:
        'Discriminator indicating whether the tool call succeeded. When true, output is available. When false, error is available.',
    },
    {
      name: 'output',
      type: 'unknown',
      description:
        "The tool's return value (only present when success is true).",
    },
    {
      name: 'error',
      type: 'unknown',
      description:
        'The error that occurred during tool execution (only present when success is false).',
    },
  ]}
/>

#### `onStepFinish`

Called after each step (LLM call) completes. Provides the full `StepResult`.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  onStepFinish: event => {
    console.log('Step:', event.stepNumber);
    console.log('Finish reason:', event.finishReason);
    console.log('Tokens:', event.usage.totalTokens);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'stepNumber',
      type: 'number',
      description: 'Zero-based index of this step.',
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'Information about the model that produced this step.',
    },
    {
      name: 'finishReason',
      type: "'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'",
      description: 'The unified reason why the generation finished.',
    },
    {
      name: 'usage',
      type: 'LanguageModelUsage',
      description: 'The token usage of the generated text.',
      properties: [
        {
          type: 'LanguageModelUsage',
          parameters: [
            {
              name: 'inputTokens',
              type: 'number | undefined',
              description: 'The total number of input (prompt) tokens used.',
            },
            {
              name: 'outputTokens',
              type: 'number | undefined',
              description: 'The number of output (completion) tokens used.',
            },
            {
              name: 'totalTokens',
              type: 'number | undefined',
              description: 'The total number of tokens used.',
            },
          ],
        },
      ],
    },
    {
      name: 'text',
      type: 'string',
      description: 'The generated text.',
    },
    {
      name: 'toolCalls',
      type: 'Array<TypedToolCall>',
      description: 'The tool calls that were made during the generation.',
    },
    {
      name: 'toolResults',
      type: 'Array<TypedToolResult>',
      description: 'The results of the tool calls.',
    },
    {
      name: 'content',
      type: 'Array<ContentPart>',
      description: 'The content that was generated in this step.',
    },
    {
      name: 'reasoning',
      type: 'Array<ReasoningPart | ReasoningFilePart>',
      description: 'The reasoning that was generated during the generation.',
    },
    {
      name: 'reasoningText',
      type: 'string | undefined',
      description: 'The reasoning text that was generated.',
    },
    {
      name: 'files',
      type: 'Array<GeneratedFile>',
      description: 'The files that were generated during the generation.',
    },
    {
      name: 'sources',
      type: 'Array<Source>',
      description: 'The sources that were used to generate the text.',
    },
    {
      name: 'warnings',
      type: 'CallWarning[] | undefined',
      description: 'Warnings from the model provider.',
    },
    {
      name: 'request',
      type: 'LanguageModelRequestMetadata',
      description: 'Additional request information.',
    },
    {
      name: 'response',
      type: 'LanguageModelResponseMetadata',
      description:
        'Additional response information including id, modelId, timestamp, headers, and messages.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'runtimeContext',
      type: 'CONTEXT',
      description:
        'User-defined shared runtime context object flowing through the generation.',
    },
    {
      name: 'toolsContext',
      type: 'InferToolSetContext<TOOLS>',
      description:
        'Per-tool context map for the generation step.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Additional provider-specific metadata.',
    },
  ]}
/>

#### `onFinish`

Called when the entire generation completes (all steps finished). Includes aggregated data.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  onFinish: event => {
    console.log('Total steps:', event.steps.length);
    console.log('Total tokens:', event.totalUsage.totalTokens);
    console.log('Final text:', event.text);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'steps',
      type: 'Array<StepResult>',
      description: 'Array containing results from all steps in the generation.',
    },
    {
      name: 'totalUsage',
      type: 'LanguageModelUsage',
      description: 'Aggregated token usage across all steps.',
      properties: [
        {
          type: 'LanguageModelUsage',
          parameters: [
            {
              name: 'inputTokens',
              type: 'number | undefined',
              description:
                'The total number of input tokens used across all steps.',
            },
            {
              name: 'outputTokens',
              type: 'number | undefined',
              description:
                'The total number of output tokens used across all steps.',
            },
            {
              name: 'totalTokens',
              type: 'number | undefined',
              description: 'The total number of tokens used across all steps.',
            },
          ],
        },
      ],
    },
    {
      name: 'stepNumber',
      type: 'number',
      description: 'Zero-based index of the final step.',
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'Information about the model that produced the final step.',
    },
    {
      name: 'finishReason',
      type: "'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'",
      description: 'The unified reason why the generation finished.',
    },
    {
      name: 'usage',
      type: 'LanguageModelUsage',
      description: 'The token usage from the final step only (not aggregated).',
    },
    {
      name: 'text',
      type: 'string',
      description: 'The full text that has been generated.',
    },
    {
      name: 'toolCalls',
      type: 'Array<TypedToolCall>',
      description: 'The tool calls that were made in the final step.',
    },
    {
      name: 'toolResults',
      type: 'Array<TypedToolResult>',
      description: 'The results of the tool calls from the final step.',
    },
    {
      name: 'content',
      type: 'Array<ContentPart>',
      description: 'The content that was generated in the final step.',
    },
    {
      name: 'reasoning',
      type: 'Array<ReasoningPart | ReasoningFilePart>',
      description: 'The reasoning that was generated.',
    },
    {
      name: 'reasoningText',
      type: 'string | undefined',
      description: 'The reasoning text that was generated.',
    },
    {
      name: 'files',
      type: 'Array<GeneratedFile>',
      description: 'Files that were generated in the final step.',
    },
    {
      name: 'sources',
      type: 'Array<Source>',
      description:
        'Sources that have been used as input to generate the response.',
    },
    {
      name: 'warnings',
      type: 'CallWarning[] | undefined',
      description: 'Warnings from the model provider.',
    },
    {
      name: 'request',
      type: 'LanguageModelRequestMetadata',
      description: 'Additional request information from the final step.',
    },
    {
      name: 'response',
      type: 'LanguageModelResponseMetadata',
      description: 'Additional response information from the final step.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
    {
      name: 'runtimeContext',
      type: 'CONTEXT',
      description:
        'The final state of the user-defined shared runtime context object.',
    },
    {
      name: 'toolsContext',
      type: 'InferToolSetContext<TOOLS>',
      description:
        'The final state of the per-tool context map passed via `toolsContext`.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Additional provider-specific metadata from the final step.',
    },
  ]}
/>

### `embed` / `embedMany`

#### `experimental_onStart`

Called when the embedding operation begins, before the embedding model is called. Both `embed` and `embedMany` share the same event interface; the `operationId` field distinguishes them (`'ai.embed'` vs `'ai.embedMany'`), and the `value` field is a single string for `embed` or an array of strings for `embedMany`.

```ts
import { embed } from 'ai';

const result = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
  experimental_onStart: event => {
    console.log('Operation:', event.operationId);
    console.log('Model:', event.model.modelId);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'callId',
      type: 'string',
      description: 'Unique identifier for this embed call.',
    },
    {
      name: 'operationId',
      type: 'string',
      description:
        "Identifies the operation type ('ai.embed' or 'ai.embedMany').",
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The embedding model being used.',
    },
    {
      name: 'value',
      type: 'string | Array<string>',
      description:
        'The value(s) being embedded. A single string for embed, or an array for embedMany.',
    },
    {
      name: 'maxRetries',
      type: 'number',
      description: 'Maximum number of retries for failed requests.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Abort signal for cancelling the operation.',
    },
    {
      name: 'headers',
      type: 'Record<string, string | undefined> | undefined',
      description: 'Additional HTTP headers sent with the request.',
    },
    {
      name: 'providerOptions',
      type: 'ProviderOptions | undefined',
      description: 'Additional provider-specific options.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
  ]}
/>

#### `experimental_onFinish`

Called when the embedding operation completes. For `embed`, `embedding` is a single vector and `response` is a single response object. For `embedMany`, `embedding` is an array of vectors and `response` is an array of response objects (one per chunk).

```ts
import { embedMany } from 'ai';

const result = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
  values: ['sunny day at the beach', 'rainy afternoon in the city'],
  experimental_onFinish: event => {
    console.log('Operation:', event.operationId);
    console.log('Usage:', event.usage);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'callId',
      type: 'string',
      description: 'Unique identifier for this embed call.',
    },
    {
      name: 'operationId',
      type: 'string',
      description:
        "Identifies the operation type ('ai.embed' or 'ai.embedMany').",
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The embedding model that was used.',
    },
    {
      name: 'value',
      type: 'string | Array<string>',
      description: 'The value(s) that were embedded.',
    },
    {
      name: 'embedding',
      type: 'Embedding | Array<Embedding>',
      description:
        'The resulting embedding(s). A single vector for embed, or an array for embedMany.',
    },
    {
      name: 'usage',
      type: 'EmbeddingModelUsage',
      description: 'Token usage for the embedding operation.',
    },
    {
      name: 'warnings',
      type: 'Array<Warning>',
      description: 'Warnings from the embedding model.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Optional provider-specific metadata.',
    },
    {
      name: 'response',
      type: '{ headers?: Record<string, string>; body?: unknown } | Array<{ headers?: Record<string, string>; body?: unknown } | undefined> | undefined',
      description:
        'Response data. A single response for embed, or an array for embedMany (one per chunk).',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
  ]}
/>

### `rerank`

#### `experimental_onStart`

Called when the reranking operation begins, before the reranking model is called.

```ts
import { rerank } from 'ai';

const result = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  experimental_onStart: event => {
    console.log('Operation:', event.operationId);
    console.log('Model:', event.model.modelId);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'callId',
      type: 'string',
      description: 'Unique identifier for this rerank call.',
    },
    {
      name: 'operationId',
      type: 'string',
      description: "Identifies the operation type ('ai.rerank').",
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The reranking model being used.',
    },
    {
      name: 'documents',
      type: 'Array<JSONObject | string>',
      description: 'The documents being reranked.',
    },
    {
      name: 'query',
      type: 'string',
      description: 'The query to rerank the documents against.',
    },
    {
      name: 'topN',
      type: 'number | undefined',
      description: 'Number of top documents to return.',
    },
    {
      name: 'maxRetries',
      type: 'number',
      description: 'Maximum number of retries for failed requests.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Abort signal for cancelling the operation.',
    },
    {
      name: 'headers',
      type: 'Record<string, string | undefined> | undefined',
      description: 'Additional HTTP headers sent with the request.',
    },
    {
      name: 'providerOptions',
      type: 'ProviderOptions | undefined',
      description: 'Additional provider-specific options.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
  ]}
/>

#### `experimental_onFinish`

Called when the reranking operation completes, after the reranking model returns.

```ts
import { rerank } from 'ai';

const result = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  experimental_onFinish: event => {
    console.log('Operation:', event.operationId);
    console.log('Rankings:', event.ranking.length);
  },
});
```

<PropertiesTable
  content={[
    {
      name: 'callId',
      type: 'string',
      description: 'Unique identifier for this rerank call.',
    },
    {
      name: 'operationId',
      type: 'string',
      description: "Identifies the operation type ('ai.rerank').",
    },
    {
      name: 'model',
      type: '{ provider: string; modelId: string }',
      description: 'The reranking model that was used.',
    },
    {
      name: 'documents',
      type: 'Array<JSONObject | string>',
      description: 'The documents that were reranked.',
    },
    {
      name: 'query',
      type: 'string',
      description: 'The query that documents were reranked against.',
    },
    {
      name: 'ranking',
      type: 'Array<{ originalIndex: number; score: number; document: JSONObject | string }>',
      description:
        'The reranked results sorted by relevance score in descending order.',
    },
    {
      name: 'warnings',
      type: 'Array<Warning>',
      description: 'Warnings from the reranking model.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Optional provider-specific metadata.',
    },
    {
      name: 'response',
      type: '{ id?: string; timestamp: Date; modelId: string; headers?: Record<string, string>; body?: unknown }',
      description: 'Response data including headers and body.',
    },
    {
      name: 'functionId',
      type: 'string | undefined',
      description:
        'Identifier from telemetry settings for grouping related operations.',
    },
  ]}
/>

## Use Cases

### Logging and Debugging

```ts
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  experimental_onStart: event => {
    console.log(`[${new Date().toISOString()}] Generation started`, {
      model: event.model.modelId,
      provider: event.model.provider,
    });
  },
  onStepFinish: event => {
    console.log(
      `[${new Date().toISOString()}] Step ${event.stepNumber} finished`,
      {
        finishReason: event.finishReason,
        tokens: event.usage.totalTokens,
      },
    );
  },
  onFinish: event => {
    console.log(`[${new Date().toISOString()}] Generation complete`, {
      totalSteps: event.steps.length,
      totalTokens: event.totalUsage.totalTokens,
    });
  },
});
```

### Tool Execution Monitoring

```ts
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather?',
  tools: { getWeather },
  experimental_onToolExecutionStart: event => {
    console.log(`Tool "${event.toolCall.toolName}" starting...`);
  },
  experimental_onToolExecutionEnd: event => {
    if (event.success) {
      console.log(
        `Tool "${event.toolCall.toolName}" completed in ${event.durationMs}ms`,
      );
    } else {
      console.error(`Tool "${event.toolCall.toolName}" failed:`, event.error);
    }
  },
});
```

### Embedding Observability

```ts
import { embedMany } from 'ai';

const result = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
  values: ['sunny day at the beach', 'rainy afternoon in the city'],
  experimental_onStart: event => {
    console.log(`Embedding started (${event.operationId})`, {
      model: event.model.modelId,
      valueCount: Array.isArray(event.value) ? event.value.length : 1,
    });
  },
  experimental_onFinish: event => {
    console.log(`Embedding complete (${event.operationId})`, {
      tokens: event.usage.tokens,
    });
  },
});
```

## Error Handling

Errors thrown inside callbacks are caught and do not break the generation, embedding, or reranking flow. This ensures that monitoring code cannot disrupt your application:

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  experimental_onStart: () => {
    throw new Error('This error is caught internally');
    // Generation continues normally
  },
});
```

---
title: Overview
description: An overview of AI SDK UI.
---

# AI SDK UI

AI SDK UI is designed to help you build interactive chat, completion, and assistant applications with ease. It is a **framework-agnostic toolkit**, streamlining the integration of advanced AI functionalities into your applications.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently. With three main hooks — **`useChat`**, **`useCompletion`**, and **`useObject`** — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

- **[`useChat`](/docs/ai-sdk-ui/chatbot)** offers real-time streaming of chat messages, abstracting state management for inputs, messages, loading, and errors, allowing for seamless integration into any UI design.
- **[`useCompletion`](/docs/ai-sdk-ui/completion)** enables you to handle text completions in your applications, managing the prompt input and automatically updating the UI as new completions are streamed.
- **[`useObject`](/docs/ai-sdk-ui/object-generation)** is a hook that allows you to consume streamed JSON objects, providing a simple way to handle and display structured data in your application.

These hooks are designed to reduce the complexity and time required to implement AI interactions, letting you focus on creating exceptional user experiences.

## UI Framework Support

AI SDK UI supports the following frameworks: [React](https://react.dev/), [Svelte](https://svelte.dev/), [Vue.js](https://vuejs.org/),
[Angular](https://angular.dev/), and [SolidJS](https://www.solidjs.com/).

Here is a comparison of the supported functions across these frameworks:

|                                                                 | [useChat](/docs/reference/ai-sdk-ui/use-chat) | [useCompletion](/docs/reference/ai-sdk-ui/use-completion) | [useObject](/docs/reference/ai-sdk-ui/use-object) |
| --------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| React `@ai-sdk/react`                                           | <Check size={18} />                           | <Check size={18} />                                       | <Check size={18} />                               |
| Vue.js `@ai-sdk/vue`                                            | <Check size={18} />                           | <Check size={18} />                                       | <Check size={18} />                               |
| Svelte `@ai-sdk/svelte`                                         | <Check size={18} /> Chat                      | <Check size={18} /> Completion                            | <Check size={18} /> StructuredObject              |
| Angular `@ai-sdk/angular`                                       | <Check size={18} /> Chat                      | <Check size={18} /> Completion                            | <Check size={18} /> StructuredObject              |
| [SolidJS](https://github.com/kodehort/ai-sdk-solid) (community) | <Check size={18} />                           | <Check size={18} />                                       | <Check size={18} />                               |

## Framework Examples

Explore these example implementations for different frameworks:

- [**Next.js**](https://github.com/vercel/ai/tree/main/examples/next-openai)
- [**Nuxt**](https://github.com/vercel/ai/tree/main/examples/nuxt-openai)
- [**SvelteKit**](https://github.com/vercel/ai/tree/main/examples/sveltekit-openai)
- [**Angular**](https://github.com/vercel/ai/tree/main/examples/angular)

## API Reference

Please check out the [AI SDK UI API Reference](/docs/reference/ai-sdk-ui) for more details on each function.

---
title: Chatbot
description: Learn how to use the useChat hook.
---

# Chatbot

The `useChat` hook makes it effortless to create a conversational user interface for your chatbot application. It enables the streaming of chat messages from your AI provider, manages the chat state, and updates the UI automatically as new messages arrive.

To summarize, the `useChat` hook provides the following features:

- **Message Streaming**: All the messages from the AI provider are streamed to the chat UI in real-time.
- **Managed States**: The hook manages the states for input, messages, status, error and more for you.
- **Seamless Integration**: Easily integrate your chat AI into any design or layout with minimal effort.

In this guide, you will learn how to use the `useChat` hook to create a chatbot application with real-time message streaming.
Check out our [chatbot with tools guide](/docs/ai-sdk-ui/chatbot-tool-usage) to learn how to use tools in your chatbot.
Let's start with the following example first.

## Example

```tsx filename='app/page.tsx'
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export default function Page() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });
  const [input, setInput] = useState('');

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}

      <form
        onSubmit={e => {
          e.preventDefault();
          if (input.trim()) {
            sendMessage({ text: input });
            setInput('');
          }
        }}
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={status !== 'ready'}
          placeholder="Say something..."
        />
        <button type="submit" disabled={status !== 'ready'}>
          Submit
        </button>
      </form>
    </>
  );
}
```

```ts filename='app/api/chat/route.ts'
import { convertToModelMessages, streamText, UIMessage } from 'ai';
__PROVIDER_IMPORT__;

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    system: 'You are a helpful assistant.',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

<Note>
  The UI messages have a new `parts` property that contains the message parts.
  We recommend rendering the messages using the `parts` property instead of the
  `content` property. The parts property supports different message types,
  including text, tool invocation, and tool result, and allows for more flexible
  and complex chat UIs.
</Note>

In the `Page` component, the `useChat` hook will request to your AI provider endpoint whenever the user sends a message using `sendMessage`.
The messages are then streamed back in real-time and displayed in the chat UI.

This enables a seamless chat experience where the user can see the AI response as soon as it is available,
without having to wait for the entire response to be received.

## Customized UI

`useChat` also provides ways to manage the chat message states via code, show status, and update messages without being triggered by user interactions.

### Status

The `useChat` hook returns a `status`. It has the following possible values:

- `submitted`: The message has been sent to the API and we're awaiting the start of the response stream.
- `streaming`: The response is actively streaming in from the API, receiving chunks of data.
- `ready`: The full response has been received and processed; a new user message can be submitted.
- `error`: An error occurred during the API request, preventing successful completion.

You can use `status` for e.g. the following purposes:

- To show a loading spinner while the chatbot is processing the user's message.
- To show a "Stop" button to abort the current message.
- To disable the submit button.

```tsx filename='app/page.tsx' highlight="6,22-29,36"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export default function Page() {
  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });
  const [input, setInput] = useState('');

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}

      {(status === 'submitted' || status === 'streaming') && (
        <div>
          {status === 'submitted' && <Spinner />}
          <button type="button" onClick={() => stop()}>
            Stop
          </button>
        </div>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          if (input.trim()) {
            sendMessage({ text: input });
            setInput('');
          }
        }}
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={status !== 'ready'}
          placeholder="Say something..."
        />
        <button type="submit" disabled={status !== 'ready'}>
          Submit
        </button>
      </form>
    </>
  );
}
```

### Error State

Similarly, the `error` state reflects the error object thrown during the fetch request.
It can be used to display an error message, disable the submit button, or show a retry button:

<Note>
  We recommend showing a generic error message to the user, such as "Something
  went wrong." This is a good practice to avoid leaking information from the
  server.
</Note>

```tsx file="app/page.tsx" highlight="6,20-27,33"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export default function Chat() {
  const { messages, sendMessage, error, regenerate } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });
  const [input, setInput] = useState('');

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}:{' '}
          {m.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}

      {error && (
        <>
          <div>An error occurred.</div>
          <button type="button" onClick={() => regenerate()}>
            Retry
          </button>
        </>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          if (input.trim()) {
            sendMessage({ text: input });
            setInput('');
          }
        }}
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={error != null}
        />
      </form>
    </div>
  );
}
```

Please also see the [error handling](/docs/ai-sdk-ui/error-handling) guide for more information.

### Modify messages

Sometimes, you may want to directly modify some existing messages. For example, a delete button can be added to each message to allow users to remove them from the chat history.

The `setMessages` function can help you achieve these tasks:

```tsx
const { messages, setMessages } = useChat()

const handleDelete = (id) => {
  setMessages(messages.filter(message => message.id !== id))
}

return <>
  {messages.map(message => (
    <div key={message.id}>
      {message.role === 'user' ? 'User: ' : 'AI: '}
      {message.parts.map((part, index) => (
        part.type === 'text' ? (
          <span key={index}>{part.text}</span>
        ) : null
      ))}
      <button onClick={() => handleDelete(message.id)}>Delete</button>
    </div>
  ))}
  ...
```

You can think of `messages` and `setMessages` as a pair of `state` and `setState` in React.

### Cancellation and regeneration

It's also a common use case to abort the response message while it's still streaming back from the AI provider. You can do this by calling the `stop` function returned by the `useChat` hook.

```tsx
const { stop, status } = useChat()

return <>
  <button onClick={stop} disabled={!(status === 'streaming' || status === 'submitted')}>Stop</button>
  ...
```

When the user clicks the "Stop" button, the fetch request will be aborted. This avoids consuming unnecessary resources and improves the UX of your chatbot application.

Similarly, you can also request the AI provider to reprocess the last message by calling the `regenerate` function returned by the `useChat` hook:

```tsx
const { regenerate, status } = useChat();

return (
  <>
    <button
      onClick={regenerate}
      disabled={!(status === 'ready' || status === 'error')}
    >
      Regenerate
    </button>
    ...
  </>
);
```

When the user clicks the "Regenerate" button, the AI provider will regenerate the last message and replace the current one correspondingly.

### Throttling UI Updates

<Note>This feature is currently only available for React.</Note>

By default, the `useChat` hook will trigger a render every time a new chunk is received.
You can throttle the UI updates with the `experimental_throttle` option.

```tsx filename="page.tsx" highlight="2-3"
const { messages, ... } = useChat({
  // Throttle the messages and data updates to 50ms:
  experimental_throttle: 50
})
```

## Event Callbacks

`useChat` provides optional event callbacks that you can use to handle different stages of the chatbot lifecycle:

- `onFinish`: Called when the assistant response is completed. The event includes the response message, all messages, and flags for abort, disconnect, and errors.
- `onError`: Called when an error occurs during the fetch request.
- `onData`: Called whenever a data part is received.

These callbacks can be used to trigger additional actions, such as logging, analytics, or custom UI updates.

```tsx
import { UIMessage } from 'ai';

const {
  /* ... */
} = useChat({
  onFinish: ({ message, messages, isAbort, isDisconnect, isError }) => {
    // use information to e.g. update other UI states
  },
  onError: error => {
    console.error('An error occurred:', error);
  },
  onData: data => {
    console.log('Received data part from server:', data);
  },
});
```

It's worth noting that you can abort the processing by throwing an error in the `onData` callback. This will trigger the `onError` callback and stop the message from being appended to the chat UI. This can be useful for handling unexpected responses from the AI provider.

## Request Configuration

### Custom headers, body, and credentials

By default, the `useChat` hook sends a HTTP POST request to the `/api/chat` endpoint with the message list as the request body. You can customize the request in two ways:

#### Hook-Level Configuration (Applied to all requests)

You can configure transport-level options that will be applied to all requests made by the hook:

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/custom-chat',
    headers: {
      Authorization: 'your_token',
    },
    body: {
      user_id: '123',
    },
    credentials: 'same-origin',
  }),
});
```

#### Dynamic Hook-Level Configuration

You can also provide functions that return configuration values. This is useful for authentication tokens that need to be refreshed, or for configuration that depends on runtime conditions:

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/custom-chat',
    headers: () => ({
      Authorization: `Bearer ${getAuthToken()}`,
      'X-User-ID': getCurrentUserId(),
    }),
    body: () => ({
      sessionId: getCurrentSessionId(),
      preferences: getUserPreferences(),
    }),
    credentials: () => 'include',
  }),
});
```

<Note>
  For component state that changes over time, use `useRef` to store the current
  value and reference `ref.current` in your configuration function, or prefer
  request-level options (see next section) for better reliability.
</Note>

#### Request-Level Configuration (Recommended)

<Note>
  **Recommended**: Use request-level options for better flexibility and control.
  Request-level options take precedence over hook-level options and allow you to
  customize each request individually.
</Note>

```tsx
// Pass options as the second parameter to sendMessage
sendMessage(
  { text: input },
  {
    headers: {
      Authorization: 'Bearer token123',
      'X-Custom-Header': 'custom-value',
    },
    body: {
      temperature: 0.7,
      max_tokens: 100,
      user_id: '123',
    },
    metadata: {
      userId: 'user123',
      sessionId: 'session456',
    },
  },
);
```

The request-level options are merged with hook-level options, with request-level options taking precedence. On your server side, you can handle the request with this additional information.

### Setting custom body fields per request

You can configure custom `body` fields on a per-request basis using the second parameter of the `sendMessage` function.
This is useful if you want to pass in additional information to your backend that is not part of the message list.

```tsx filename="app/page.tsx" highlight="20-25"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const { messages, sendMessage } = useChat();
  const [input, setInput] = useState('');

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}:{' '}
          {m.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}

      <form
        onSubmit={event => {
          event.preventDefault();
          if (input.trim()) {
            sendMessage(
              { text: input },
              {
                body: {
                  customKey: 'customValue',
                },
              },
            );
            setInput('');
          }
        }}
      >
        <input value={input} onChange={e => setInput(e.target.value)} />
      </form>
    </div>
  );
}
```

You can retrieve these custom fields on your server side by destructuring the request body:

```ts filename="app/api/chat/route.ts" highlight="3,4"
export async function POST(req: Request) {
  // Extract additional information ("customKey") from the body of the request:
  const { messages, customKey }: { messages: UIMessage[]; customKey: string } =
    await req.json();
  //...
}
```

## Message Metadata

You can attach custom metadata to messages for tracking information like timestamps, model details, and token usage.

```ts
// Server: Send metadata about the message
return result.toUIMessageStreamResponse({
  messageMetadata: ({ part }) => {
    if (part.type === 'start') {
      return {
        createdAt: Date.now(),
        model: 'gpt-5.1',
      };
    }

    if (part.type === 'finish') {
      return {
        totalTokens: part.totalUsage.totalTokens,
      };
    }
  },
});
```

```tsx
// Client: Access metadata via message.metadata
{
  messages.map(message => (
    <div key={message.id}>
      {message.role}:{' '}
      {message.metadata?.createdAt &&
        new Date(message.metadata.createdAt).toLocaleTimeString()}
      {/* Render message content */}
      {message.parts.map((part, index) =>
        part.type === 'text' ? <span key={index}>{part.text}</span> : null,
      )}
      {/* Show token count if available */}
      {message.metadata?.totalTokens && (
        <span>{message.metadata.totalTokens} tokens</span>
      )}
    </div>
  ));
}
```

For complete examples with type safety and advanced use cases, see the [Message Metadata documentation](/docs/ai-sdk-ui/message-metadata).

## Transport Configuration

You can configure custom transport behavior using the `transport` option to customize how messages are sent to your API:

```tsx filename="app/page.tsx"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export default function Chat() {
  const { messages, sendMessage } = useChat({
    id: 'my-chat',
    transport: new DefaultChatTransport({
      prepareSendMessagesRequest: ({ id, messages }) => {
        return {
          body: {
            id,
            message: messages[messages.length - 1],
          },
        };
      },
    }),
  });

  // ... rest of your component
}
```

The corresponding API route receives the custom request format:

```ts filename="app/api/chat/route.ts"
export async function POST(req: Request) {
  const { id, message } = await req.json();

  // Load existing messages and add the new one
  const messages = await loadMessages(id);
  messages.push(message);

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

### Advanced: Trigger-based routing

For more complex scenarios like message regeneration, you can use trigger-based routing:

```tsx filename="app/page.tsx"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export default function Chat() {
  const { messages, sendMessage, regenerate } = useChat({
    id: 'my-chat',
    transport: new DefaultChatTransport({
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => {
        if (trigger === 'submit-user-message') {
          return {
            body: {
              trigger: 'submit-user-message',
              id,
              message: messages[messages.length - 1],
              messageId,
            },
          };
        } else if (trigger === 'regenerate-assistant-message') {
          return {
            body: {
              trigger: 'regenerate-assistant-message',
              id,
              messageId,
            },
          };
        }
        throw new Error(`Unsupported trigger: ${trigger}`);
      },
    }),
  });

  // ... rest of your component
}
```

The corresponding API route would handle different triggers:

```ts filename="app/api/chat/route.ts"
export async function POST(req: Request) {
  const { trigger, id, message, messageId } = await req.json();

  const chat = await readChat(id);
  let messages = chat.messages;

  if (trigger === 'submit-user-message') {
    // Handle new user message
    messages = [...messages, message];
  } else if (trigger === 'regenerate-assistant-message') {
    // Handle message regeneration - remove messages after messageId
    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex !== -1) {
      messages = messages.slice(0, messageIndex);
    }
  }

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

To learn more about building custom transports, refer to the [Transport API documentation](/docs/ai-sdk-ui/transport).

### Direct Agent Transport

For scenarios where you want to communicate directly with an Agent without going through HTTP, you can use `DirectChatTransport`. This is useful for:

- Server-side rendering scenarios
- Testing without network
- Single-process applications

```tsx filename="app/page.tsx"
import { useChat } from '@ai-sdk/react';
import { DirectChatTransport, ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: 'You are a helpful assistant.',
});

export default function Chat() {
  const { messages, sendMessage, status } = useChat({
    transport: new DirectChatTransport({ agent }),
  });

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}

      <button
        onClick={() => sendMessage({ text: 'Hello!' })}
        disabled={status !== 'ready'}
      >
        Send
      </button>
    </>
  );
}
```

The `DirectChatTransport` invokes the agent's `stream()` method directly, converting UI messages to model messages and streaming the response back as UI message chunks.

For more details, see the [DirectChatTransport reference](/docs/reference/ai-sdk-ui/direct-chat-transport).

## Controlling the response stream

With `streamText`, you can control how error messages and usage information are sent back to the client.

### Error Messages

By default, the error message is masked for security reasons.
The default error message is "An error occurred."
You can forward error messages or send your own error message by providing a `getErrorMessage` function:

```ts filename="app/api/chat/route.ts" highlight="13-27"
import { convertToModelMessages, streamText, UIMessage } from 'ai';
__PROVIDER_IMPORT__;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    onError: error => {
      if (error == null) {
        return 'unknown error';
      }

      if (typeof error === 'string') {
        return error;
      }

      if (error instanceof Error) {
        return error.message;
      }

      return JSON.stringify(error);
    },
  });
}
```

### Usage Information

Track token consumption and resource usage with [message metadata](/docs/ai-sdk-ui/message-metadata):

1. Define a custom metadata type with usage fields (optional, for type safety)
2. Attach usage data using `messageMetadata` in your response
3. Display usage metrics in your UI components

Usage data is attached as metadata to messages and becomes available once the model completes its response generation.

```ts
import { openai } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  streamText,
  UIMessage,
  type LanguageModelUsage,
} from 'ai';
__PROVIDER_IMPORT__;

// Create a new metadata type (optional for type-safety)
type MyMetadata = {
  totalUsage: LanguageModelUsage;
};

// Create a new custom message type with your own metadata
export type MyUIMessage = UIMessage<MyMetadata>;

export async function POST(req: Request) {
  const { messages }: { messages: MyUIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    messageMetadata: ({ part }) => {
      // Send total usage when generation is finished
      if (part.type === 'finish') {
        return { totalUsage: part.totalUsage };
      }
    },
  });
}
```

Then, on the client, you can access the message-level metadata.

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import type { MyUIMessage } from './api/chat/route';
import { DefaultChatTransport } from 'ai';

export default function Chat() {
  // Use custom message type defined on the server (optional for type-safety)
  const { messages } = useChat<MyUIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.parts.map(part => {
            if (part.type === 'text') {
              return part.text;
            }
          })}
          {/* Render usage via metadata */}
          {m.metadata?.totalUsage && (
            <div>Total usage: {m.metadata?.totalUsage.totalTokens} tokens</div>
          )}
        </div>
      ))}
    </div>
  );
}
```

You can also access your metadata from the `onFinish` callback of `useChat`:

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import type { MyUIMessage } from './api/chat/route';
import { DefaultChatTransport } from 'ai';

export default function Chat() {
  // Use custom message type defined on the server (optional for type-safety)
  const { messages } = useChat<MyUIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
    onFinish: ({ message }) => {
      // Access message metadata via onFinish callback
      console.log(message.metadata?.totalUsage);
    },
  });
}
```

### Text Streams

`useChat` can handle plain text streams by setting the `streamProtocol` option to `text`:

```tsx filename="app/page.tsx" highlight="7"
'use client';

import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport } from 'ai';

export default function Chat() {
  const { messages } = useChat({
    transport: new TextStreamChatTransport({
      api: '/api/chat',
    }),
  });

  return <>...</>;
}
```

This configuration also works with other backend servers that stream plain text.
Check out the [stream protocol guide](/docs/ai-sdk-ui/stream-protocol) for more information.

<Note>
  When using `TextStreamChatTransport`, tool calls, usage information and finish
  reasons are not available.
</Note>

## Reasoning

Some models such as DeepSeek `deepseek-r1`
and Anthropic `claude-sonnet-4-5-20250929` support reasoning tokens.
These tokens are typically sent before the message content.
You can forward them to the client with the `sendReasoning` option:

```ts filename="app/api/chat/route.ts" highlight="13"
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'deepseek/deepseek-r1',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
```

On the client side, you can access the reasoning parts of the message object.

Reasoning parts have a `text` property that contains the reasoning content.

```tsx filename="app/page.tsx"
messages.map(message => (
  <div key={message.id}>
    {message.role === 'user' ? 'User: ' : 'AI: '}
    {message.parts.map((part, index) => {
      // text parts:
      if (part.type === 'text') {
        return <div key={index}>{part.text}</div>;
      }

      // reasoning parts:
      if (part.type === 'reasoning') {
        return <pre key={index}>{part.text}</pre>;
      }
    })}
  </div>
));
```

Some models may also produce files as part of reasoning (e.g. images).
These are available as `reasoning-file` parts (`ReasoningFileUIPart`) with
`mediaType` and `url` properties, similar to regular file parts.

## Sources

Some providers such as [Perplexity](/providers/ai-sdk-providers/perplexity#sources) and
[Google](/providers/ai-sdk-providers/google#sources) include sources in the response.

Currently sources are limited to web pages that ground the response.
You can forward them to the client with the `sendSources` option:

```ts filename="app/api/chat/route.ts" highlight="13"
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'perplexity/sonar-pro',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    sendSources: true,
  });
}
```

On the client side, you can access source parts of the message object.
There are two types of sources: `source-url` for web pages and `source-document` for documents.
Here is an example that renders both types of sources:

```tsx filename="app/page.tsx"
messages.map(message => (
  <div key={message.id}>
    {message.role === 'user' ? 'User: ' : 'AI: '}

    {/* Render URL sources */}
    {message.parts
      .filter(part => part.type === 'source-url')
      .map(part => (
        <span key={`source-${part.id}`}>
          [
          <a href={part.url} target="_blank">
            {part.title ?? new URL(part.url).hostname}
          </a>
          ]
        </span>
      ))}

    {/* Render document sources */}
    {message.parts
      .filter(part => part.type === 'source-document')
      .map(part => (
        <span key={`source-${part.id}`}>
          [<span>{part.title ?? `Document ${part.id}`}</span>]
        </span>
      ))}
  </div>
));
```

## Image Generation

Some models such as Google `gemini-2.5-flash-image` support image generation.
When images are generated, they are exposed as files to the client.
On the client side, you can access file parts of the message object
and render them as images.

```tsx filename="app/page.tsx"
messages.map(message => (
  <div key={message.id}>
    {message.role === 'user' ? 'User: ' : 'AI: '}
    {message.parts.map((part, index) => {
      if (part.type === 'text') {
        return <div key={index}>{part.text}</div>;
      } else if (part.type === 'file' && part.mediaType.startsWith('image/')) {
        return <img key={index} src={part.url} alt="Generated image" />;
      }
    })}
  </div>
));
```

## Attachments

The `useChat` hook supports sending file attachments along with a message as well as rendering them on the client. This can be useful for building applications that involve sending images, files, or other media content to the AI provider.

There are two ways to send files with a message: using a `FileList` object from file inputs or using an array of file objects.

### FileList

By using `FileList`, you can send multiple files as attachments along with a message using the file input element. The `useChat` hook will automatically convert them into data URLs and send them to the AI provider.

<Note>
  Currently, only `image/*` and `text/*` content types get automatically
  converted into [multi-modal content
  parts](/docs/foundations/prompts#multi-modal-messages). You will need to
  handle other content types manually.
</Note>

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useRef, useState } from 'react';

export default function Page() {
  const { messages, sendMessage, status } = useChat();

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div>
        {messages.map(message => (
          <div key={message.id}>
            <div>{`${message.role}: `}</div>

            <div>
              {message.parts.map((part, index) => {
                if (part.type === 'text') {
                  return <span key={index}>{part.text}</span>;
                }

                if (
                  part.type === 'file' &&
                  part.mediaType?.startsWith('image/')
                ) {
                  return <img key={index} src={part.url} alt={part.filename} />;
                }

                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={event => {
          event.preventDefault();
          if (input.trim()) {
            sendMessage({
              text: input,
              files,
            });
            setInput('');
            setFiles(undefined);

            if (fileInputRef.current) {
              fileInputRef.current.value = '';
            }
          }
        }}
      >
        <input
          type="file"
          onChange={event => {
            if (event.target.files) {
              setFiles(event.target.files);
            }
          }}
          multiple
          ref={fileInputRef}
        />
        <input
          value={input}
          placeholder="Send message..."
          onChange={e => setInput(e.target.value)}
          disabled={status !== 'ready'}
        />
      </form>
    </div>
  );
}
```

### File Objects

You can also send files as objects along with a message. This can be useful for sending pre-uploaded files or data URLs.

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import { FileUIPart } from 'ai';

export default function Page() {
  const { messages, sendMessage, status } = useChat();

  const [input, setInput] = useState('');
  const [files] = useState<FileUIPart[]>([
    {
      type: 'file',
      filename: 'earth.png',
      mediaType: 'image/png',
      url: 'https://example.com/earth.png',
    },
    {
      type: 'file',
      filename: 'moon.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,iVBORw0KGgo...',
    },
  ]);

  return (
    <div>
      <div>
        {messages.map(message => (
          <div key={message.id}>
            <div>{`${message.role}: `}</div>

            <div>
              {message.parts.map((part, index) => {
                if (part.type === 'text') {
                  return <span key={index}>{part.text}</span>;
                }

                if (
                  part.type === 'file' &&
                  part.mediaType?.startsWith('image/')
                ) {
                  return <img key={index} src={part.url} alt={part.filename} />;
                }

                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={event => {
          event.preventDefault();
          if (input.trim()) {
            sendMessage({
              text: input,
              files,
            });
            setInput('');
          }
        }}
      >
        <input
          value={input}
          placeholder="Send message..."
          onChange={e => setInput(e.target.value)}
          disabled={status !== 'ready'}
        />
      </form>
    </div>
  );
}
```

Files generated as part of model reasoning are available as `reasoning-file`
parts (`ReasoningFileUIPart`) with the same `mediaType` and `url` properties.

## Type Inference for Tools

When working with tools in TypeScript, AI SDK UI provides type inference helpers to ensure type safety for your tool inputs and outputs.

### InferUITool

The `InferUITool` type helper infers the input and output types of a single tool for use in UI messages:

```tsx
import { InferUITool } from 'ai';
import { z } from 'zod';

const weatherTool = {
  description: 'Get the current weather',
  inputSchema: z.object({
    location: z.string().describe('The city and state'),
  }),
  execute: async ({ location }) => {
    return `The weather in ${location} is sunny.`;
  },
};

// Infer the types from the tool
type WeatherUITool = InferUITool<typeof weatherTool>;
// This creates a type with:
// {
//   input: { location: string };
//   output: string;
// }
```

### InferUITools

The `InferUITools` type helper infers the input and output types of a `ToolSet`:

```tsx
import { InferUITools, ToolSet } from 'ai';
import { z } from 'zod';

const tools = {
  weather: {
    description: 'Get the current weather',
    inputSchema: z.object({
      location: z.string().describe('The city and state'),
    }),
    execute: async ({ location }) => {
      return `The weather in ${location} is sunny.`;
    },
  },
  calculator: {
    description: 'Perform basic arithmetic',
    inputSchema: z.object({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      a: z.number(),
      b: z.number(),
    }),
    execute: async ({ operation, a, b }) => {
      switch (operation) {
        case 'add':
          return a + b;
        case 'subtract':
          return a - b;
        case 'multiply':
          return a * b;
        case 'divide':
          return a / b;
      }
    },
  },
} satisfies ToolSet;

// Infer the types from the tool set
type MyUITools = InferUITools<typeof tools>;
// This creates a type with:
// {
//   weather: { input: { location: string }; output: string };
//   calculator: { input: { operation: 'add' | 'subtract' | 'multiply' | 'divide'; a: number; b: number }; output: number };
// }
```

### Using Inferred Types

You can use these inferred types to create a custom UIMessage type and pass it to various AI SDK UI functions:

```tsx
import { InferUITools, UIMessage, UIDataTypes } from 'ai';

type MyUITools = InferUITools<typeof tools>;
type MyUIMessage = UIMessage<never, UIDataTypes, MyUITools>;
```

Pass the custom type to `useChat` or `createUIMessageStream`:

```tsx
import { useChat } from '@ai-sdk/react';
import { createUIMessageStream } from 'ai';
import type { MyUIMessage } from './types';

// With useChat
const { messages } = useChat<MyUIMessage>();

// With createUIMessageStream
const stream = createUIMessageStream<MyUIMessage>(/* ... */);
```

This provides full type safety for tool inputs and outputs on the client and server.

---
title: Chatbot Message Persistence
description: Learn how to store and load chat messages in a chatbot.
---

# Chatbot Message Persistence

Being able to store and load chat messages is crucial for most AI chatbots.
In this guide, we'll show how to implement message persistence with `useChat` and `streamText`.

<Note>
  This guide does not cover authorization, error handling, or other real-world
  considerations. It is intended to be a simple example of how to implement
  message persistence.
</Note>

## Starting a new chat

When the user navigates to the chat page without providing a chat ID,
we need to create a new chat and redirect to the chat page with the new chat ID.

```tsx filename="app/chat/page.tsx"
import { redirect } from 'next/navigation';
import { createChat } from '@util/chat-store';

export default async function Page() {
  const id = await createChat(); // create a new chat
  redirect(`/chat/${id}`); // redirect to chat page, see below
}
```

Our example chat store implementation uses files to store the chat messages.
In a real-world application, you would use a database or a cloud storage service,
and get the chat ID from the database.
That being said, the function interfaces are designed to be easily replaced with other implementations.

```tsx filename="util/chat-store.ts"
import { generateId } from 'ai';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';

export async function createChat(): Promise<string> {
  const id = generateId(); // generate a unique chat ID
  await writeFile(getChatFile(id), '[]'); // create an empty chat file
  return id;
}

function getChatFile(id: string): string {
  const chatDir = path.join(process.cwd(), '.chats');
  if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
  return path.join(chatDir, `${id}.json`);
}
```

## Loading an existing chat

When the user navigates to the chat page with a chat ID, we need to load the chat messages from storage.

The `loadChat` function in our file-based chat store is implemented as follows:

```tsx filename="util/chat-store.ts"
import { UIMessage } from 'ai';
import { readFile } from 'fs/promises';

export async function loadChat(id: string): Promise<UIMessage[]> {
  return JSON.parse(await readFile(getChatFile(id), 'utf8'));
}

// ... rest of the file
```

## Validating messages on the server

When processing messages on the server that contain tool calls, custom metadata, or data parts, you should validate them using `validateUIMessages` before sending them to the model.

### Validation with tools

When your messages include tool calls, validate them against your tool definitions:

```tsx filename="app/api/chat/route.ts" highlight="7-25,32-37"
import {
  convertToModelMessages,
  streamText,
  UIMessage,
  validateUIMessages,
  tool,
} from 'ai';
import { z } from 'zod';
import { loadChat, saveChat } from '@util/chat-store';
import { dataPartsSchema, metadataSchema } from '@util/schemas';

// Define your tools
const tools = {
  weather: tool({
    description: 'Get weather information',
    parameters: z.object({
      location: z.string(),
      units: z.enum(['celsius', 'fahrenheit']),
    }),
    execute: async ({ location, units }) => {
      /* tool implementation */
    },
  }),
  // other tools
};

export async function POST(req: Request) {
  const { message, id } = await req.json();

  // Load previous messages from database
  const previousMessages = await loadChat(id);

  // Append new message to previousMessages messages
  const messages = [...previousMessages, message];

  // Validate loaded messages against
  // tools, data parts schema, and metadata schema
  const validatedMessages = await validateUIMessages({
    messages,
    tools, // Ensures tool calls in messages match current schemas
    dataPartsSchema,
    metadataSchema,
  });

  const result = streamText({
    model: 'openai/gpt-5-mini',
    messages: convertToModelMessages(validatedMessages),
    tools,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ messages }) => {
      saveChat({ chatId: id, messages });
    },
  });
}
```

### Handling validation errors

Handle validation errors gracefully when messages from the database don't match current schemas:

```tsx filename="app/api/chat/route.ts" highlight="3,10-24"
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  TypeValidationError,
} from 'ai';
import { type MyUIMessage } from '@/types';

export async function POST(req: Request) {
  const { message, id } = await req.json();

  // Load and validate messages from database
  let validatedMessages: MyUIMessage[];

  try {
    const previousMessages = await loadMessagesFromDB(id);
    validatedMessages = await validateUIMessages({
      // append the new message to the previous messages:
      messages: [...previousMessages, message],
      tools,
      metadataSchema,
    });
  } catch (error) {
    if (error instanceof TypeValidationError) {
      // Log validation error for monitoring
      console.error('Database messages validation failed:', error);
      // Could implement message migration or filtering here
      // For now, start with empty history
      validatedMessages = [];
    } else {
      throw error;
    }
  }

  // Continue with validated messages...
}
```

## Displaying the chat

Once messages are loaded from storage, you can display them in your chat UI. Here's how to set up the page component and the chat display:

```tsx filename="app/chat/[id]/page.tsx"
import { loadChat } from '@util/chat-store';
import Chat from '@ui/chat';

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const messages = await loadChat(id);
  return <Chat id={id} initialMessages={messages} />;
}
```

The chat component uses the `useChat` hook to manage the conversation:

```tsx filename="ui/chat.tsx" highlight="10-16"
'use client';

import { UIMessage, useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export default function Chat({
  id,
  initialMessages,
}: { id?: string | undefined; initialMessages?: UIMessage[] } = {}) {
  const [input, setInput] = useState('');
  const { sendMessage, messages } = useChat({
    id, // use the provided chat ID
    messages: initialMessages, // load initial messages
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage({ text: input });
      setInput('');
    }
  };

  // simplified rendering code, extend as needed:
  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.parts
            .map(part => (part.type === 'text' ? part.text : ''))
            .join('')}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

## Storing messages

`useChat` sends the chat id and the messages to the backend.

<Note>
  The `useChat` message format is different from the `ModelMessage` format. The
  `useChat` message format is designed for frontend display, and contains
  additional fields such as `id` and `createdAt`. We recommend storing the
  messages in the `useChat` message format.

When loading messages from storage that contain tools, metadata, or custom data
parts, validate them using `validateUIMessages` before processing (see the
[validation section](#validating-messages-from-database) above).

</Note>

Storing messages is done in the `onFinish` callback of the `toUIMessageStreamResponse` function.
`onFinish` receives the complete messages including the new AI response as `UIMessage[]`.

```tsx filename="app/api/chat/route.ts" highlight="6,11-17"
import { openai } from '@ai-sdk/openai';
import { saveChat } from '@util/chat-store';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages, chatId }: { messages: UIMessage[]; chatId: string } =
    await req.json();

  const result = streamText({
    model: 'openai/gpt-5-mini',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ messages }) => {
      saveChat({ chatId, messages });
    },
  });
}
```

The actual storage of the messages is done in the `saveChat` function, which in
our file-based chat store is implemented as follows:

```tsx filename="util/chat-store.ts"
import { UIMessage } from 'ai';
import { writeFile } from 'fs/promises';

export async function saveChat({
  chatId,
  messages,
}: {
  chatId: string;
  messages: UIMessage[];
}): Promise<void> {
  const content = JSON.stringify(messages, null, 2);
  await writeFile(getChatFile(chatId), content);
}

// ... rest of the file
```

## Message IDs

In addition to a chat ID, each message has an ID.
You can use this message ID to e.g. manipulate individual messages.

### Client-side vs Server-side ID Generation

By default, message IDs are generated client-side:

- User message IDs are generated by the `useChat` hook on the client
- AI response message IDs are generated by `streamText` on the server

For applications without persistence, client-side ID generation works perfectly.
However, **for persistence, you need server-side generated IDs** to ensure consistency across sessions and prevent ID conflicts when messages are stored and retrieved.

### Setting Up Server-side ID Generation

When implementing persistence, you have two options for generating server-side IDs:

1. **Using `generateMessageId` in `toUIMessageStreamResponse`**
2. **Setting IDs in your start message part with `createUIMessageStream`**

#### Option 1: Using `generateMessageId` in `toUIMessageStreamResponse`

You can control the ID format by providing ID generators using [`createIdGenerator()`](/docs/reference/ai-sdk-core/create-id-generator):

```tsx filename="app/api/chat/route.ts" highlight="7-11"
import { createIdGenerator, streamText } from 'ai';

export async function POST(req: Request) {
  // ...
  const result = streamText({
    // ...
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // Generate consistent server-side IDs for persistence:
    generateMessageId: createIdGenerator({
      prefix: 'msg',
      size: 16,
    }),
    onFinish: ({ messages }) => {
      saveChat({ chatId, messages });
    },
  });
}
```

#### Option 2: Setting IDs with `createUIMessageStream`

Alternatively, you can use `createUIMessageStream` to control the message ID by writing a start message part:

```tsx filename="app/api/chat/route.ts" highlight="8-18"
import {
  generateId,
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // Write start message part with custom ID
      writer.write({
        type: 'start',
        messageId: generateId(), // Generate server-side ID for persistence
      });

      const result = streamText({
        model: 'openai/gpt-5-mini',
        messages: await convertToModelMessages(messages),
      });

      writer.merge(result.toUIMessageStream({ sendStart: false })); // omit start message part
    },
    originalMessages: messages,
    onFinish: ({ responseMessage }) => {
      // save your chat here
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

<Note>
  For client-side applications that don't require persistence, you can still customize client-side ID generation:

```tsx filename="ui/chat.tsx"
import { createIdGenerator } from 'ai';
import { useChat } from '@ai-sdk/react';

const { ... } = useChat({
  generateId: createIdGenerator({
    prefix: 'msgc',
    size: 16,
  }),
  // ...
});
```

</Note>

## Sending only the last message

Once you have implemented message persistence, you might want to send only the last message to the server.
This reduces the amount of data sent to the server on each request and can improve performance.

To achieve this, you can provide a `prepareSendMessagesRequest` function to the transport.
This function receives the messages and the chat ID, and returns the request body to be sent to the server.

```tsx filename="ui/chat.tsx" highlight="7-12"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const {
  // ...
} = useChat({
  // ...
  transport: new DefaultChatTransport({
    api: '/api/chat',
    // only send the last message to the server:
    prepareSendMessagesRequest({ messages, id }) {
      return { body: { message: messages[messages.length - 1], id } };
    },
  }),
});
```

On the server, you can then load the previous messages and append the new message to the previous messages. If your messages contain tools, metadata, or custom data parts, you should validate them:

```tsx filename="app/api/chat/route.ts" highlight="2-11,14-18"
import { convertToModelMessages, UIMessage, validateUIMessages } from 'ai';
// import your tools and schemas

export async function POST(req: Request) {
  // get the last message from the client:
  const { message, id } = await req.json();

  // load the previous messages from the server:
  const previousMessages = await loadChat(id);

  // validate messages if they contain tools, metadata, or data parts:
  const validatedMessages = await validateUIMessages({
    // append the new message to the previous messages:
    messages: [...previousMessages, message],
    tools, // if using tools
    metadataSchema, // if using custom metadata
    dataSchemas, // if using custom data parts
  });

  const result = streamText({
    // ...
    messages: convertToModelMessages(validatedMessages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: validatedMessages,
    onFinish: ({ messages }) => {
      saveChat({ chatId: id, messages });
    },
  });
}
```

## Handling client disconnects

By default, the AI SDK `streamText` function uses backpressure to the language model provider to prevent
the consumption of tokens that are not yet requested.

However, this means that when the client disconnects, e.g. by closing the browser tab or because of a network issue,
the stream from the LLM will be aborted and the conversation may end up in a broken state.

Assuming that you have a [storage solution](#storing-messages) in place, you can use the `consumeStream` method to consume the stream on the backend,
and then save the result as usual.
`consumeStream` effectively removes the backpressure,
meaning that the result is stored even when the client has already disconnected.

```tsx filename="app/api/chat/route.ts" highlight="19-21"
import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { saveChat } from '@util/chat-store';

export async function POST(req: Request) {
  const { messages, chatId }: { messages: UIMessage[]; chatId: string } =
    await req.json();

  const result = streamText({
    model,
    messages: await convertToModelMessages(messages),
  });

  // consume the stream to ensure it runs to completion & triggers onFinish
  // even when the client response is aborted:
  result.consumeStream(); // no await

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ messages }) => {
      saveChat({ chatId, messages });
    },
  });
}
```

When the client reloads the page after a disconnect, the chat will be restored from the storage solution.

<Note>
  In production applications, you would also track the state of the request (in
  progress, complete) in your stored messages and use it on the client to cover
  the case where the client reloads the page after a disconnection, but the
  streaming is not yet complete.
</Note>

For more robust handling of disconnects, you may want to add resumability on disconnects. Check out the [Chatbot Resume Streams](/docs/ai-sdk-ui/chatbot-resume-streams) documentation to learn more.

---
title: Chatbot Resume Streams
description: Learn how to resume chatbot streams after client disconnects.
---

