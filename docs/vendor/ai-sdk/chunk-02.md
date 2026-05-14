# Tool Calling

As covered under Foundations, [tools](/docs/foundations/tools) are objects that can be called by the model to perform a specific task.
AI SDK Core tools contain three elements:

- **`description`**: An optional description of the tool that can influence when the tool is picked.
- **`parameters`**: A [Zod schema](/docs/foundations/tools#schemas) or a [JSON schema](/docs/reference/ai-sdk-core/json-schema) that defines the parameters. The schema is consumed by the LLM, and also used to validate the LLM tool calls.
- **`execute`**: An optional async function that is called with the arguments from the tool call. It produces a value of type `RESULT` (generic type). It is optional because you might want to forward tool calls to the client or to a queue instead of executing them in the same process.

<Note className="mb-2">
  You can use the [`tool`](/docs/reference/ai-sdk-core/tool) helper function to
  infer the types of the `execute` parameters.
</Note>

<Note type="warning">
  **Zod v4 Compatibility**: AI SDK v4 requires Zod v3. If you're using Zod v4,
  you'll encounter schema validation errors. [See troubleshooting
  guide](/docs/troubleshooting/zod-v4-json-schema-type-error).
</Note>

The `tools` parameter of `generateText` and `streamText` is an object that has the tool names as keys and the tools as values:

```ts highlight="6-17"
import { z } from 'zod';
import { generateText, tool } from 'ai';

const result = await generateText({
  model: yourModel,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  },
  prompt: 'What is the weather in San Francisco?',
});
```

<Note>
  When a model uses a tool, it is called a "tool call" and the output of the
  tool is called a "tool result".
</Note>

Tool calling is not restricted to only text generation.
You can also use it to render user interfaces (Generative UI).

## Multi-Step Calls (using maxSteps)

With the `maxSteps` setting, you can enable multi-step calls in `generateText` and `streamText`. When `maxSteps` is set to a number greater than 1 and the model generates a tool call, the AI SDK will trigger a new generation passing in the tool result until there
are no further tool calls or the maximum number of tool steps is reached.

<Note>
  To decide what value to set for `maxSteps`, consider the most complex task the
  call might handle and the number of sequential steps required for completion,
  rather than just the number of available tools.
</Note>

By default, when you use `generateText` or `streamText`, it triggers a single generation (`maxSteps: 1`). This works well for many use cases where you can rely on the model's training data to generate a response. However, when you provide tools, the model now has the choice to either generate a normal text response, or generate a tool call. If the model generates a tool call, it's generation is complete and that step is finished.

You may want the model to generate text after the tool has been executed, either to summarize the tool results in the context of the users query. In many cases, you may also want the model to use multiple tools in a single response. This is where multi-step calls come in.

You can think of multi-step calls in a similar way to a conversation with a human. When you ask a question, if the person does not have the requisite knowledge in their common knowledge (a model's training data), the person may need to look up information (use a tool) before they can provide you with an answer. In the same way, the model may need to call a tool to get the information it needs to answer your question where each generation (tool call or text generation) is a step.

### Example

In the following example, there are two steps:

1. **Step 1**
   1. The prompt `'What is the weather in San Francisco?'` is sent to the model.
   1. The model generates a tool call.
   1. The tool call is executed.
1. **Step 2**
   1. The tool result is sent to the model.
   1. The model generates a response considering the tool result.

```ts highlight="18"
import { z } from 'zod';
import { generateText, tool } from 'ai';

const { text, steps } = await generateText({
  model: yourModel,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  },
  maxSteps: 5, // allow up to 5 steps
  prompt: 'What is the weather in San Francisco?',
});
```

<Note>You can use `streamText` in a similar way.</Note>

### Steps

To access intermediate tool calls and results, you can use the `steps` property in the result object
or the `streamText` `onFinish` callback.
It contains all the text, tool calls, tool results, and more from each step.

#### Example: Extract tool results from all steps

```ts highlight="3,9-10"
import { generateText } from 'ai';

const { steps } = await generateText({
  model: openai('gpt-4-turbo'),
  maxSteps: 10,
  // ...
});

// extract all tool calls from the steps:
const allToolCalls = steps.flatMap(step => step.toolCalls);
```

### `onStepFinish` callback

When using `generateText` or `streamText`, you can provide an `onStepFinish` callback that
is triggered when a step is finished,
i.e. all text deltas, tool calls, and tool results for the step are available.
When you have multiple steps, the callback is triggered for each step.

```tsx highlight="5-7"
import { generateText } from 'ai';

const result = await generateText({
  // ...
  onStepFinish({ text, toolCalls, toolResults, finishReason, usage }) {
    // your own logic, e.g. for saving the chat history or recording usage
  },
});
```

### `experimental_prepareStep` callback

<Note type="warning">
  The `experimental_prepareStep` callback is experimental and may change in the
  future. It is only available in the `generateText` function.
</Note>

The `experimental_prepareStep` callback is called before a step is started.

It is called with the following parameters:

- `model`: The model that was passed into `generateText`.
- `maxSteps`: The maximum number of steps that was passed into `generateText`.
- `stepNumber`: The number of the step that is being executed.
- `steps`: The steps that have been executed so far.

You can use it to provide different settings for a step.

```tsx highlight="5-7"
import { generateText } from 'ai';

const result = await generateText({
  // ...
  experimental_prepareStep: async ({ model, stepNumber, maxSteps, steps }) => {
    if (stepNumber === 0) {
      return {
        // use a different model for this step:
        model: modelForThisParticularStep,
        // force a tool choice for this step:
        toolChoice: { type: 'tool', toolName: 'tool1' },
        // limit the tools that are available for this step:
        experimental_activeTools: ['tool1'],
      };
    }

    // when nothing is returned, the default settings are used
  },
});
```

## Response Messages

Adding the generated assistant and tool messages to your conversation history is a common task,
especially if you are using multi-step tool calls.

Both `generateText` and `streamText` have a `response.messages` property that you can use to
add the assistant and tool messages to your conversation history.
It is also available in the `onFinish` callback of `streamText`.

The `response.messages` property contains an array of `CoreMessage` objects that you can add to your conversation history:

```ts
import { generateText } from 'ai';

const messages: CoreMessage[] = [
  // ...
];

const { response } = await generateText({
  // ...
  messages,
});

// add the response messages to your conversation history:
messages.push(...response.messages); // streamText: ...((await response).messages)
```

## Tool Choice

You can use the `toolChoice` setting to influence when a tool is selected.
It supports the following settings:

- `auto` (default): the model can choose whether and which tools to call.
- `required`: the model must call a tool. It can choose which tool to call.
- `none`: the model must not call tools
- `{ type: 'tool', toolName: string (typed) }`: the model must call the specified tool

```ts highlight="18"
import { z } from 'zod';
import { generateText, tool } from 'ai';

const result = await generateText({
  model: yourModel,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  },
  toolChoice: 'required', // force the model to call a tool
  prompt: 'What is the weather in San Francisco?',
});
```

## Tool Execution Options

When tools are called, they receive additional options as a second parameter.

### Tool Call ID

The ID of the tool call is forwarded to the tool execution.
You can use it e.g. when sending tool-call related information with stream data.

```ts highlight="14-20"
import { StreamData, streamText, tool } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const data = new StreamData();

  const result = streamText({
    // ...
    messages,
    tools: {
      myTool: tool({
        // ...
        execute: async (args, { toolCallId }) => {
          // return e.g. custom status for tool call
          data.appendMessageAnnotation({
            type: 'tool-status',
            toolCallId,
            status: 'in-progress',
          });
          // ...
        },
      }),
    },
    onFinish() {
      data.close();
    },
  });

  return result.toDataStreamResponse({ data });
}
```

### Messages

The messages that were sent to the language model to initiate the response that contained the tool call are forwarded to the tool execution.
You can access them in the second parameter of the `execute` function.
In multi-step calls, the messages contain the text, tool calls, and tool results from all previous steps.

```ts highlight="8-9"
import { generateText, tool } from 'ai';

const result = await generateText({
  // ...
  tools: {
    myTool: tool({
      // ...
      execute: async (args, { messages }) => {
        // use the message history in e.g. calls to other language models
        return something;
      },
    }),
  },
});
```

### Abort Signals

The abort signals from `generateText` and `streamText` are forwarded to the tool execution.
You can access them in the second parameter of the `execute` function and e.g. abort long-running computations or forward them to fetch calls inside tools.

```ts highlight="6,11,14"
import { z } from 'zod';
import { generateText, tool } from 'ai';

const result = await generateText({
  model: yourModel,
  abortSignal: myAbortSignal, // signal that will be forwarded to tools
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }, { abortSignal }) => {
        return fetch(
          `https://api.weatherapi.com/v1/current.json?q=${location}`,
          { signal: abortSignal }, // forward the abort signal to fetch
        );
      },
    }),
  },
  prompt: 'What is the weather in San Francisco?',
});
```

## Types

Modularizing your code often requires defining types to ensure type safety and reusability.
To enable this, the AI SDK provides several helper types for tools, tool calls, and tool results.

You can use them to strongly type your variables, function parameters, and return types
in parts of the code that are not directly related to `streamText` or `generateText`.

Each tool call is typed with `ToolCall<NAME extends string, ARGS>`, depending
on the tool that has been invoked.
Similarly, the tool results are typed with `ToolResult<NAME extends string, ARGS, RESULT>`.

The tools in `streamText` and `generateText` are defined as a `ToolSet`.
The type inference helpers `ToolCallUnion<TOOLS extends ToolSet>`
and `ToolResultUnion<TOOLS extends ToolSet>` can be used to
extract the tool call and tool result types from the tools.

```ts highlight="18-19,23-24"
import { openai } from '@ai-sdk/openai';
import { ToolCallUnion, ToolResultUnion, generateText, tool } from 'ai';
import { z } from 'zod';

const myToolSet = {
  firstTool: tool({
    description: 'Greets the user',
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  }),
  secondTool: tool({
    description: 'Tells the user their age',
    parameters: z.object({ age: z.number() }),
    execute: async ({ age }) => `You are ${age} years old!`,
  }),
};

type MyToolCall = ToolCallUnion<typeof myToolSet>;
type MyToolResult = ToolResultUnion<typeof myToolSet>;

async function generateSomething(prompt: string): Promise<{
  text: string;
  toolCalls: Array<MyToolCall>; // typed tool calls
  toolResults: Array<MyToolResult>; // typed tool results
}> {
  return generateText({
    model: openai('gpt-4o'),
    tools: myToolSet,
    prompt,
  });
}
```

## Handling Errors

The AI SDK has three tool-call related errors:

- [`NoSuchToolError`](/docs/reference/ai-sdk-errors/ai-no-such-tool-error): the model tries to call a tool that is not defined in the tools object
- [`InvalidToolArgumentsError`](/docs/reference/ai-sdk-errors/ai-invalid-tool-arguments-error): the model calls a tool with arguments that do not match the tool's parameters
- [`ToolExecutionError`](/docs/reference/ai-sdk-errors/ai-tool-execution-error): an error that occurred during tool execution
- [`ToolCallRepairError`](/docs/reference/ai-sdk-errors/ai-tool-call-repair-error): an error that occurred during tool call repair

### `generateText`

`generateText` throws errors and can be handled using a `try`/`catch` block:

```ts
try {
  const result = await generateText({
    //...
  });
} catch (error) {
  if (NoSuchToolError.isInstance(error)) {
    // handle the no such tool error
  } else if (InvalidToolArgumentsError.isInstance(error)) {
    // handle the invalid tool arguments error
  } else if (ToolExecutionError.isInstance(error)) {
    // handle the tool execution error
  } else {
    // handle other errors
  }
}
```

### `streamText`

`streamText` sends the errors as part of the full stream. The error parts contain the error object.

When using `toDataStreamResponse`, you can pass an `getErrorMessage` function to extract the error message from the error part and forward it as part of the data stream response:

```ts
const result = streamText({
  // ...
});

return result.toDataStreamResponse({
  getErrorMessage: error => {
    if (NoSuchToolError.isInstance(error)) {
      return 'The model tried to call a unknown tool.';
    } else if (InvalidToolArgumentsError.isInstance(error)) {
      return 'The model called a tool with invalid arguments.';
    } else if (ToolExecutionError.isInstance(error)) {
      return 'An error occurred during tool execution.';
    } else {
      return 'An unknown error occurred.';
    }
  },
});
```

## Tool Call Repair

<Note type="warning">
  The tool call repair feature is experimental and may change in the future.
</Note>

Language models sometimes fail to generate valid tool calls,
especially when the parameters are complex or the model is smaller.

You can use the `experimental_repairToolCall` function to attempt to repair the tool call
with a custom function.

You can use different strategies to repair the tool call:

- Use a model with structured outputs to generate the arguments.
- Send the messages, system prompt, and tool schema to a stronger model to generate the arguments.
- Provide more specific repair instructions based on which tool was called.

### Example: Use a model with structured outputs for repair

```ts
import { openai } from '@ai-sdk/openai';
import { generateObject, generateText, NoSuchToolError, tool } from 'ai';

const result = await generateText({
  model,
  tools,
  prompt,

  experimental_repairToolCall: async ({
    toolCall,
    tools,
    parameterSchema,
    error,
  }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null; // do not attempt to fix invalid tool names
    }

    const tool = tools[toolCall.toolName as keyof typeof tools];

    const { object: repairedArgs } = await generateObject({
      model: openai('gpt-4o', { structuredOutputs: true }),
      schema: tool.parameters,
      prompt: [
        `The model tried to call the tool "${toolCall.toolName}"` +
          ` with the following arguments:`,
        JSON.stringify(toolCall.args),
        `The tool accepts the following schema:`,
        JSON.stringify(parameterSchema(toolCall)),
        'Please fix the arguments.',
      ].join('\n'),
    });

    return { ...toolCall, args: JSON.stringify(repairedArgs) };
  },
});
```

### Example: Use the re-ask strategy for repair

```ts
import { openai } from '@ai-sdk/openai';
import { generateObject, generateText, NoSuchToolError, tool } from 'ai';

const result = await generateText({
  model,
  tools,
  prompt,

  experimental_repairToolCall: async ({
    toolCall,
    tools,
    error,
    messages,
    system,
  }) => {
    const result = await generateText({
      model,
      system,
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              args: toolCall.args,
            },
          ],
        },
        {
          role: 'tool' as const,
          content: [
            {
              type: 'tool-result',
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              result: error.message,
            },
          ],
        },
      ],
      tools,
    });

    const newToolCall = result.toolCalls.find(
      newToolCall => newToolCall.toolName === toolCall.toolName,
    );

    return newToolCall != null
      ? {
          toolCallType: 'function' as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: JSON.stringify(newToolCall.args),
        }
      : null;
  },
});
```

## Active Tools

<Note type="warning">
  The `activeTools` property is experimental and may change in the future.
</Note>

Language models can only handle a limited number of tools at a time, depending on the model.
To allow for static typing using a large number of tools and limiting the available tools to the model at the same time,
the AI SDK provides the `experimental_activeTools` property.

It is an array of tool names that are currently active.
By default, the value is `undefined` and all tools are active.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools: myToolSet,
  experimental_activeTools: ['firstTool'],
});
```

## Multi-modal Tool Results

<Note type="warning">
  Multi-modal tool results are experimental and only supported by Anthropic.
</Note>

In order to send multi-modal tool results, e.g. screenshots, back to the model,
they need to be converted into a specific format.

AI SDK Core tools have an optional `experimental_toToolResultContent` function
that converts the tool result into a content part.

Here is an example for converting a screenshot into a content part:

```ts highlight="22-27"
const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  tools: {
    computer: anthropic.tools.computer_20241022({
      // ...
      async execute({ action, coordinate, text }) {
        switch (action) {
          case 'screenshot': {
            return {
              type: 'image',
              data: fs
                .readFileSync('./data/screenshot-editor.png')
                .toString('base64'),
            };
          }
          default: {
            return `executed ${action}`;
          }
        }
      },

      // map to tool result content for LLM consumption:
      experimental_toToolResultContent(result) {
        return typeof result === 'string'
          ? [{ type: 'text', text: result }]
          : [{ type: 'image', data: result.data, mimeType: 'image/png' }];
      },
    }),
  },
  // ...
});
```

## Extracting Tools

Once you start having many tools, you might want to extract them into separate files.
The `tool` helper function is crucial for this, because it ensures correct type inference.

Here is an example of an extracted tool:

```ts filename="tools/weather-tool.ts" highlight="1,4-5"
import { tool } from 'ai';
import { z } from 'zod';

// the `tool` helper function ensures correct type inference:
export const weatherTool = tool({
  description: 'Get the weather in a location',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => ({
    location,
    temperature: 72 + Math.floor(Math.random() * 21) - 10,
  }),
});
```

## MCP Tools

<Note type="warning">
  The MCP tools feature is experimental and may change in the future.
</Note>

The AI SDK supports connecting to [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers to access their tools.
This enables your AI applications to discover and use tools across various services through a standardized interface.

### Initializing an MCP Client

Create an MCP client using either:

- `SSE` (Server-Sent Events): Uses HTTP-based real-time communication, better suited for remote servers that need to send data over the network
- `stdio`: Uses standard input and output streams for communication, ideal for local tool servers running on the same machine (like CLI tools or local services)
- Custom transport: Bring your own transport by implementing the `MCPTransport` interface, ideal when implementing transports from MCP's official Typescript SDK (e.g. `StreamableHTTPClientTransport`)

#### SSE Transport

The SSE can be configured using a simple object with a `type` and `url` property:

```typescript
import { experimental_createMCPClient as createMCPClient } from 'ai';

const mcpClient = await createMCPClient({
  transport: {
    type: 'sse',
    url: 'https://my-server.com/sse',

    // optional: configure HTTP headers, e.g. for authentication
    headers: {
      Authorization: 'Bearer my-api-key',
    },
  },
});
```

#### Stdio Transport

The Stdio transport requires importing the `StdioMCPTransport` class from the `ai/mcp-stdio` package:

```typescript
import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';

const mcpClient = await createMCPClient({
  transport: new StdioMCPTransport({
    command: 'node',
    args: ['src/stdio/dist/server.js'],
  }),
});
```

#### Custom Transport

You can also bring your own transport, as long as it implements the `MCPTransport` interface. Below is an example of using the new `StreamableHTTPClientTransport` from MCP's official Typescript SDK:

```typescript
import {
  MCPTransport,
  experimental_createMCPClient as createMCPClient,
} from 'ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

const url = new URL('http://localhost:3000/mcp');
const mcpClient = await createMCPClient({
  transport: new StreamableHTTPClientTransport(url, {
    sessionId: 'session_123',
  }),
});
```

<Note>
  The client returned by the `experimental_createMCPClient` function is a
  lightweight client intended for use in tool conversion. It currently does not
  support all features of the full MCP client, such as: authorization, session
  management, resumable streams, and receiving notifications.
</Note>

#### Closing the MCP Client

After initialization, you should close the MCP client based on your usage pattern:

- For short-lived usage (e.g., single requests), close the client when the response is finished
- For long-running clients (e.g., command line apps), keep the client open but ensure it's closed when the application terminates

When streaming responses, you can close the client when the LLM response has finished. For example, when using `streamText`, you should use the `onFinish` callback:

```typescript
const mcpClient = await experimental_createMCPClient({
  // ...
});

const tools = await mcpClient.tools();

const result = await streamText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'What is the weather in Brooklyn, New York?',
  onFinish: async () => {
    await mcpClient.close();
  },
});
```

When generating responses without streaming, you can use try/finally or cleanup functions in your framework:

```typescript
let mcpClient: MCPClient | undefined;

try {
  mcpClient = await experimental_createMCPClient({
    // ...
  });
} finally {
  await mcpClient?.close();
}
```

### Using MCP Tools

The client's `tools` method acts as an adapter between MCP tools and AI SDK tools. It supports two approaches for working with tool schemas:

#### Schema Discovery

The simplest approach where all tools offered by the server are listed, and input parameter types are inferred based the schemas provided by the server:

```typescript
const tools = await mcpClient.tools();
```

**Pros:**

- Simpler to implement
- Automatically stays in sync with server changes

**Cons:**

- No TypeScript type safety during development
- No IDE autocompletion for tool parameters
- Errors only surface at runtime
- Loads all tools from the server

#### Schema Definition

You can also define the tools and their input schemas explicitly in your client code:

```typescript
import { z } from 'zod';

const tools = await mcpClient.tools({
  schemas: {
    'get-data': {
      parameters: z.object({
        query: z.string().describe('The data query'),
        format: z.enum(['json', 'text']).optional(),
      }),
    },
    // For tools with zero arguments, you should use an empty object:
    'tool-with-no-args': {
      parameters: z.object({}),
    },
  },
});
```

**Pros:**

- Control over which tools are loaded
- Full TypeScript type safety
- Better IDE support with autocompletion
- Catch parameter mismatches during development

**Cons:**

- Need to manually keep schemas in sync with server
- More code to maintain

When you define `schemas`, the client will only pull the explicitly defined tools, even if the server offers additional tools. This can be beneficial for:

- Keeping your application focused on the tools it needs
- Reducing unnecessary tool loading
- Making your tool dependencies explicit

## Examples

You can see tools in action using various frameworks in the following examples:

<ExampleLinks
  examples={[
    {
      title: 'Learn to use tools in Node.js',
      link: '/cookbook/node/call-tools',
    },
    {
      title: 'Learn to use tools in Next.js with Route Handlers',
      link: '/cookbook/next/call-tools',
    },
    {
      title: 'Learn to use MCP tools in Node.js',
      link: '/cookbook/node/mcp-tools',
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

1. Use a model that is strong at tool calling, such as `gpt-4` or `gpt-4-turbo`. Weaker models will often struggle to call tools effectively and flawlessly.
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

```ts highlight="7-10"
const result = await generateObject({
  model: openai('gpt-4-turbo'),
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
  prompt: 'List 5 important events from the year 2000.',
});
```

## Debugging

### Inspecting Warnings

Not all providers support all AI SDK features.
Providers either throw exceptions or return warnings when they do not support a feature.
To check if your prompt, tools, and settings are handled correctly by the provider, you can check the call warnings:

```ts
const result = await generateText({
  model: openai('gpt-4o'),
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
  model: openai('gpt-4o'),
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

```ts highlight="3-5"
const result = await generateText({
  model: yourModel,
  maxTokens: 512,
  temperature: 0.3,
  maxRetries: 5,
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

<Note>
  Some providers do not support all common settings. If you use a setting with a
  provider that does not support it, a warning will be generated. You can check
  the `warnings` property in the result object to see if any warnings were
  generated.
</Note>

### `maxTokens`

Maximum number of tokens to generate.

### `temperature`

Temperature setting.

The value is passed through to the provider. The range depends on the provider and model.
For most providers, `0` means almost deterministic results, and higher values mean more randomness.

It is recommended to set either `temperature` or `topP`, but not both.

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

### `maxRetries`

Maximum number of retries. Set to 0 to disable retries. Default: `2`.

### `abortSignal`

An optional abort signal that can be used to cancel the call.

The abort signal can e.g. be forwarded from a user interface to cancel the call,
or to define a timeout.

#### Example: Timeout

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Invent a new holiday and describe its traditions.',
  abortSignal: AbortSignal.timeout(5000), // 5 seconds
});
```

### `headers`

Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

You can use the request headers to provide additional information to the provider,
depending on what the provider supports. For example, some observability providers support
headers such as `Prompt-Id`.

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: openai('gpt-4o'),
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
title: Embeddings
description: Learn how to embed values with the AI SDK.
---

# Embeddings

Embeddings are a way to represent words, phrases, or images as vectors in a high-dimensional space.
In this space, similar words are close to each other, and the distance between words can be used to measure their similarity.

## Embedding a Single Value

The AI SDK provides the [`embed`](/docs/reference/ai-sdk-core/embed) function to embed single values, which is useful for tasks such as finding similar words
or phrases or clustering text.
You can use it with embeddings models, e.g. `openai.embedding('text-embedding-3-large')` or `mistral.embedding('mistral-embed')`.

```tsx
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

// 'embedding' is a single embedding object (number[])
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
});
```

## Embedding Many Values

When loading data, e.g. when preparing a data store for retrieval-augmented generation (RAG),
it is often useful to embed many values at once (batch embedding).

The AI SDK provides the [`embedMany`](/docs/reference/ai-sdk-core/embed-many) function for this purpose.
Similar to `embed`, you can use it with embeddings models,
e.g. `openai.embedding('text-embedding-3-large')` or `mistral.embedding('mistral-embed')`.

```tsx
import { openai } from '@ai-sdk/openai';
import { embedMany } from 'ai';

// 'embeddings' is an array of embedding objects (number[][]).
// It is sorted in the same order as the input values.
const { embeddings } = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
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

```ts highlight={"2,10"}
import { openai } from '@ai-sdk/openai';
import { cosineSimilarity, embedMany } from 'ai';

const { embeddings } = await embedMany({
  model: openai.embedding('text-embedding-3-small'),
  values: ['sunny day at the beach', 'rainy afternoon in the city'],
});

console.log(
  `cosine similarity: ${cosineSimilarity(embeddings[0], embeddings[1])}`,
);
```

## Token Usage

Many providers charge based on the number of tokens used to generate embeddings.
Both `embed` and `embedMany` provide token usage information in the `usage` property of the result object:

```ts highlight={"4,9"}
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding, usage } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
});

console.log(usage); // { tokens: 10 }
```

## Settings

### Retries

Both `embed` and `embedMany` accept an optional `maxRetries` parameter of type `number`
that you can use to set the maximum number of retries for the embedding process.
It defaults to `2` retries (3 attempts in total). You can set it to `0` to disable retries.

```ts highlight={"7"}
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
  maxRetries: 0, // Disable retries
});
```

### Abort Signals and Timeouts

Both `embed` and `embedMany` accept an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the embedding process or set a timeout.

```ts highlight={"7"}
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

Both `embed` and `embedMany` accept an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the embedding request.

```ts highlight={"7"}
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'sunny day at the beach',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

## Embedding Providers & Models

Several providers offer embedding models:

| Provider                                                                                  | Model                           | Embedding Dimensions |
| ----------------------------------------------------------------------------------------- | ------------------------------- | -------------------- |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-3-large`        | 3072                 |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-3-small`        | 1536                 |
| [OpenAI](/providers/ai-sdk-providers/openai#embedding-models)                             | `text-embedding-ada-002`        | 1536                 |
| [Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#embedding-models) | `text-embedding-004`            | 768                  |
| [Mistral](/providers/ai-sdk-providers/mistral#embedding-models)                           | `mistral-embed`                 | 1024                 |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-v3.0`            | 1024                 |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-v3.0`       | 1024                 |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-light-v3.0`      | 384                  |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-light-v3.0` | 384                  |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-v2.0`            | 4096                 |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-english-light-v2.0`      | 1024                 |
| [Cohere](/providers/ai-sdk-providers/cohere#embedding-models)                             | `embed-multilingual-v2.0`       | 768                  |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#embedding-models)             | `amazon.titan-embed-text-v1`    | 1024                 |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#embedding-models)             | `amazon.titan-embed-text-v2:0`  | 1024                 |

---
title: Image Generation
description: Learn how to generate images with the AI SDK.
---

# Image Generation

<Note type="warning">Image generation is an experimental feature.</Note>

The AI SDK provides the [`generateImage`](/docs/reference/ai-sdk-core/generate-image)
function to generate images based on a given prompt using an image model.

```tsx
import { experimental_generateImage as generateImage } from 'ai';
import { openai } from '@ai-sdk/openai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
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
import { experimental_generateImage as generateImage } from 'ai';
import { openai } from '@ai-sdk/openai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt: 'Santa Claus driving a Cadillac',
  size: '1024x1024',
});
```

##### Aspect Ratio

The aspect ratio is specified as a string in the format `{width}:{height}`.
Models only support a few aspect ratios, and the supported aspect ratios are different for each model and provider.

```tsx highlight={"7"}
import { experimental_generateImage as generateImage } from 'ai';
import { vertex } from '@ai-sdk/google-vertex';

const { image } = await generateImage({
  model: vertex.image('imagen-3.0-generate-002'),
  prompt: 'Santa Claus driving a Cadillac',
  aspectRatio: '16:9',
});
```

### Generating Multiple Images

`generateImage` also supports generating multiple images at once:

```tsx highlight={"7"}
import { experimental_generateImage as generateImage } from 'ai';
import { openai } from '@ai-sdk/openai';

const { images } = await generateImage({
  model: openai.image('dall-e-2'),
  prompt: 'Santa Claus driving a Cadillac',
  n: 4, // number of images to generate
});
```

<Note>
  `generateImage` will automatically call the model as often as needed (in
  parallel) to generate the requested number of images.
</Note>

Each image model has an internal limit on how many images it can generate in a single API call. The AI SDK manages this automatically by batching requests appropriately when you request multiple images using the `n` parameter. By default, the SDK uses provider-documented limits (for example, DALL-E 3 can only generate 1 image per call, while DALL-E 2 supports up to 10).

If needed, you can override this behavior using the `maxImagesPerCall` setting when configuring your model. This is particularly useful when working with new or custom models where the default batch size might not be optimal:

```tsx
const model = openai.image('dall-e-2', {
  maxImagesPerCall: 5, // Override the default batch size
});

const { images } = await generateImage({
  model,
  prompt: 'Santa Claus driving a Cadillac',
  n: 10, // Will make 2 calls of 5 images each
});
```

### Providing a Seed

You can provide a seed to the `generateImage` function to control the output of the image generation process.
If supported by the model, the same seed will always produce the same image.

```tsx highlight={"7"}
import { experimental_generateImage as generateImage } from 'ai';
import { openai } from '@ai-sdk/openai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
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
import { experimental_generateImage as generateImage } from 'ai';
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
import { openai } from '@ai-sdk/openai';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt: 'Santa Claus driving a Cadillac',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

`generateImage` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the image generation request.

```ts highlight={"7"}
import { openai } from '@ai-sdk/openai';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: openai.image('dall-e-3'),
  value: 'sunny day at the beach',
  headers: { 'X-Custom-Header': 'custom-value' },
});
```

### Warnings

If the model returns warnings, e.g. for unsupported parameters, they will be available in the `warnings` property of the response.

```tsx
const { image, warnings } = await generateImage({
  model: openai.image('dall-e-3'),
  prompt: 'Santa Claus driving a Cadillac',
});
```

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

## Generating Images with Language Models

Some language models such as Google `gemini-2.0-flash-exp` support multi-modal outputs including images.
With such models, you can access the generated images using the `files` property of the response.

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: google('gemini-2.0-flash-exp'),
  providerOptions: {
    google: { responseModalities: ['TEXT', 'IMAGE'] },
  },
  prompt: 'Generate an image of a comic cat',
});

for (const file of result.files) {
  if (file.mimeType.startsWith('image/')) {
    // The file object provides multiple data formats:
    // Access images as base64 string, Uint8Array binary data, or check type
    // - file.base64: string (data URL format)
    // - file.uint8Array: Uint8Array (binary data)
    // - file.mimeType: string (e.g. "image/png")
  }
}
```

## Image Models

| Provider                                                                  | Model                                                        | Support sizes (`width x height`) or aspect ratios (`width : height`)                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [xAI Grok](/providers/ai-sdk-providers/xai#image-models)                  | `grok-2-image`                                               | 1024x768 (default)                                                                                                                                                  |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                 | `gpt-image-1`                                                | 1024x1024, 1536x1024, 1024x1536                                                                                                                                     |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                 | `dall-e-3`                                                   | 1024x1024, 1792x1024, 1024x1792                                                                                                                                     |
| [OpenAI](/providers/ai-sdk-providers/openai#image-models)                 | `dall-e-2`                                                   | 256x256, 512x512, 1024x1024                                                                                                                                         |
| [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock#image-models) | `amazon.nova-canvas-v1:0`                                    | 320-4096 (multiples of 16), 1:4 to 4:1, max 4.2M pixels                                                                                                             |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/flux/dev`                                            | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/flux-lora`                                           | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/fast-sdxl`                                           | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/flux-pro/v1.1-ultra`                                 | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/ideogram/v2`                                         | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/recraft-v3`                                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/stable-diffusion-3.5-large`                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Fal](/providers/ai-sdk-providers/fal#image-models)                       | `fal-ai/hyper-sdxl`                                          | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `stabilityai/sd3.5`                                          | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `black-forest-labs/FLUX-1.1-pro`                             | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `black-forest-labs/FLUX-1-schnell`                           | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `black-forest-labs/FLUX-1-dev`                               | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `black-forest-labs/FLUX-pro`                                 | 256-1440 (multiples of 32)                                                                                                                                          |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `stabilityai/sd3.5-medium`                                   | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [DeepInfra](/providers/ai-sdk-providers/deepinfra#image-models)           | `stabilityai/sdxl-turbo`                                     | 1:1, 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21                                                                                                                      |
| [Replicate](/providers/ai-sdk-providers/replicate)                        | `black-forest-labs/flux-schnell`                             | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Replicate](/providers/ai-sdk-providers/replicate)                        | `recraft-ai/recraft-v3`                                      | 1024x1024, 1365x1024, 1024x1365, 1536x1024, 1024x1536, 1820x1024, 1024x1820, 1024x2048, 2048x1024, 1434x1024, 1024x1434, 1024x1280, 1280x1024, 1024x1707, 1707x1024 |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)   | `imagen-3.0-generate-002`                                    | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google Vertex](/providers/ai-sdk-providers/google-vertex#image-models)   | `imagen-3.0-fast-generate-001`                               | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/flux-1-dev-fp8`                   | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/flux-1-schnell-fp8`               | 1:1, 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9                                                                                                                     |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/playground-v2-5-1024px-aesthetic` | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/japanese-stable-diffusion-xl`     | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/playground-v2-1024px-aesthetic`   | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/SSD-1B`                           | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Fireworks](/providers/ai-sdk-providers/fireworks#image-models)           | `accounts/fireworks/models/stable-diffusion-xl-1024-v1-0`    | 640x1536, 768x1344, 832x1216, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640                                                                           |
| [Luma](/providers/ai-sdk-providers/luma#image-models)                     | `photon-1`                                                   | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Luma](/providers/ai-sdk-providers/luma#image-models)                     | `photon-flash-1`                                             | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9                                                                                                                               |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `stabilityai/stable-diffusion-xl-base-1.0`                   | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-dev`                               | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-dev-lora`                          | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-schnell`                           | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-canny`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-depth`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-redux`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1.1-pro`                             | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-pro`                               | 512x512, 768x768, 1024x1024                                                                                                                                         |
| [Together.ai](/providers/ai-sdk-providers/togetherai#image-models)        | `black-forest-labs/FLUX.1-schnell-Free`                      | 512x512, 768x768, 1024x1024                                                                                                                                         |

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

### Abort Signals and Timeouts

`transcribe` accepts an optional `abortSignal` parameter of
type [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
that you can use to abort the transcription process or set a timeout.

```ts highlight="8"
import { openai } from '@ai-sdk/openai';
import { experimental_transcribe as transcribe } from 'ai';
import { readFile } from 'fs/promises';

const transcript = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
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

This error can arise for any the following reasons:

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

| Provider                                                                  | Model                        |
| ------------------------------------------------------------------------- | ---------------------------- |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `whisper-1`                  |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `gpt-4o-transcribe`          |
| [OpenAI](/providers/ai-sdk-providers/openai#transcription-models)         | `gpt-4o-mini-transcribe`     |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#transcription-models) | `scribe_v1`                  |
| [ElevenLabs](/providers/ai-sdk-providers/elevenlabs#transcription-models) | `scribe_v1_experimental`     |
| [Groq](/providers/ai-sdk-providers/groq#transcription-models)             | `whisper-large-v3-turbo`     |
| [Groq](/providers/ai-sdk-providers/groq#transcription-models)             | `distil-whisper-large-v3-en` |
| [Groq](/providers/ai-sdk-providers/groq#transcription-models)             | `whisper-large-v3`           |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `whisper-1`                  |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `gpt-4o-transcribe`          |
| [Azure OpenAI](/providers/ai-sdk-providers/azure#transcription-models)    | `gpt-4o-mini-transcribe`     |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `machine`                    |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `low_cost`                   |
| [Rev.ai](/providers/ai-sdk-providers/revai#transcription-models)          | `fusion`                     |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `base` (+ variants)          |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `enhanced` (+ variants)      |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova` (+ variants)          |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova-2` (+ variants)        |
| [Deepgram](/providers/ai-sdk-providers/deepgram#transcription-models)     | `nova-3` (+ variants)        |
| [Gladia](/providers/ai-sdk-providers/gladia#transcription-models)         | `default`                    |
| [AssemblyAI](/providers/ai-sdk-providers/assemblyai#transcription-models) | `best`                       |
| [AssemblyAI](/providers/ai-sdk-providers/assemblyai#transcription-models) | `nano`                       |
| [Fal](/providers/ai-sdk-providers/fal#transcription-models)               | `whisper`                    |
| [Fal](/providers/ai-sdk-providers/fal#transcription-models)               | `wizper`                     |

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
import { readFile } from 'fs/promises';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  voice: 'alloy',
});
```

To access the generated audio:

```ts
const audio = audio.audioData; // audio data e.g. Uint8Array
```

## Settings

### Provider-Specific settings

You can set model-specific settings with the `providerOptions` parameter.

```ts highlight="8-12"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFile } from 'fs/promises';

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

```ts highlight="8"
import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { readFile } from 'fs/promises';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  abortSignal: AbortSignal.timeout(1000), // Abort after 1 second
});
```

### Custom Headers

`generateSpeech` accepts an optional `headers` parameter of type `Record<string, string>`
that you can use to add custom headers to the speech generation request.

```ts highlight="8"
import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { readFile } from 'fs/promises';

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
import { readFile } from 'fs/promises';

const audio = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
});

const warnings = audio.warnings;
```

### Error Handling

When `generateSpeech` cannot generate a valid audio, it throws a [`AI_NoAudioGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-audio-generated-error).

This error can arise for any the following reasons:

- The model failed to generate a response
- The model generated a response that could not be parsed

The error preserves the following information to help you log the issue:

- `responses`: Metadata about the speech model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling.

```ts
import {
  experimental_generateSpeech as generateSpeech,
  AI_NoAudioGeneratedError,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { readFile } from 'fs/promises';

try {
  await generateSpeech({
    model: openai.speech('tts-1'),
    text: 'Hello, world!',
  });
} catch (error) {
  if (AI_NoAudioGeneratedError.isInstance(error)) {
    console.log('AI_NoAudioGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Responses:', error.responses);
  }
}
```

## Speech Models

| Provider                                                   | Model             |
| ---------------------------------------------------------- | ----------------- |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models) | `tts-1`           |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models) | `tts-1-hd`        |
| [OpenAI](/providers/ai-sdk-providers/openai#speech-models) | `gpt-4o-mini-tts` |
| [LMNT](/providers/ai-sdk-providers/lmnt#speech-models)     | `aurora`          |
| [LMNT](/providers/ai-sdk-providers/lmnt#speech-models)     | `blizzard`        |
| [Hume](/providers/ai-sdk-providers/hume#speech-models)     | `default`         |

Above are a small subset of the speech models supported by the AI SDK providers. For more, see the respective provider documentation.

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
import { wrapLanguageModel } from 'ai';

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
- `simulateStreamingMiddleware`: Simulates streaming behavior with responses from non-streaming language models.
- `defaultSettingsMiddleware`: Applies default settings to a language model.

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
For more details, see the [DeepSeek R1 guide](/docs/guides/r1#deepseek-r1-middleware).

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
      maxTokens: 800,
      // note: use providerMetadata instead of providerOptions here:
      providerMetadata: { openai: { store: false } },
    },
  }),
});
```

## Implementing Language Model Middleware

<Note>
  Implementing language model middleware is advanced functionality and requires
  a solid understanding of the [language model
  specification](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v1/language-model-v1.ts).
</Note>

You can implement any of the following three function to modify the behavior of the language model:

1. `transformParams`: Transforms the parameters before they are passed to the language model, for both `doGenerate` and `doStream`.
2. `wrapGenerate`: Wraps the `doGenerate` method of the [language model](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v1/language-model-v1.ts).
   You can modify the parameters, call the language model, and modify the result.
3. `wrapStream`: Wraps the `doStream` method of the [language model](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v1/language-model-v1.ts).
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
import type { LanguageModelV1Middleware, LanguageModelV1StreamPart } from 'ai';

export const yourLogMiddleware: LanguageModelV1Middleware = {
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

    const transformStream = new TransformStream<
      LanguageModelV1StreamPart,
      LanguageModelV1StreamPart
    >({
      transform(chunk, controller) {
        if (chunk.type === 'text-delta') {
          generatedText += chunk.textDelta;
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
import type { LanguageModelV1Middleware } from 'ai';

const cache = new Map<string, any>();

export const yourCacheMiddleware: LanguageModelV1Middleware = {
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
import type { LanguageModelV1Middleware } from 'ai';

export const yourRagMiddleware: LanguageModelV1Middleware = {
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
import type { LanguageModelV1Middleware } from 'ai';

export const yourGuardrailMiddleware: LanguageModelV1Middleware = {
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
import { openai } from '@ai-sdk/openai';
import { generateText, wrapLanguageModel, LanguageModelV1Middleware } from 'ai';

export const yourLogMiddleware: LanguageModelV1Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    console.log('METADATA', params?.providerMetadata?.yourLogMiddleware);
    const result = await doGenerate();
    return result;
  },
};

const { text } = await generateText({
  model: wrapLanguageModel({
    model: openai('gpt-4o'),
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
import { openai as originalOpenAI } from '@ai-sdk/openai';
import { customProvider } from 'ai';

// custom provider with different model settings:
export const openai = customProvider({
  languageModels: {
    // replacement model with custom settings:
    'gpt-4o': originalOpenAI('gpt-4o', { structuredOutputs: true }),
    // alias model with custom settings:
    'gpt-4o-mini-structured': originalOpenAI('gpt-4o-mini', {
      structuredOutputs: true,
    }),
  },
  fallbackProvider: originalOpenAI,
});
```

### Example: model name alias

You can also provide model name aliases, so you can update the model version in one place in the future:

```ts
import { anthropic as originalAnthropic } from '@ai-sdk/anthropic';
import { customProvider } from 'ai';

// custom provider with alias names:
export const anthropic = customProvider({
  languageModels: {
    opus: originalAnthropic('claude-3-opus-20240229'),
    sonnet: originalAnthropic('claude-3-5-sonnet-20240620'),
    haiku: originalAnthropic('claude-3-haiku-20240307'),
  },
  fallbackProvider: originalAnthropic,
});
```

### Example: limit available models

You can limit the available models in the system, even if you have multiple providers.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { customProvider } from 'ai';

export const myProvider = customProvider({
  languageModels: {
    'text-medium': anthropic('claude-3-5-sonnet-20240620'),
    'text-small': openai('gpt-4o-mini'),
    'structure-medium': openai('gpt-4o', { structuredOutputs: true }),
    'structure-fast': openai('gpt-4o-mini', { structuredOutputs: true }),
  },
  embeddingModels: {
    emdedding: openai.textEmbeddingModel('text-embedding-3-small'),
  },
  // no fallback provider
});
```

## Provider Registry

You can create a [provider registry](/docs/reference/ai-sdk-core/provider-registry) with multiple providers and models using `createProviderRegistry`.

### Setup

```ts filename={"registry.ts"}
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createProviderRegistry } from 'ai';

export const registry = createProviderRegistry({
  // register provider with prefix and default setup:
  anthropic,

  // register provider with prefix and custom setup:
  openai: createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  }),
});
```

### Setup with Custom Separator

By default, the registry uses `:` as the separator between provider and model IDs. You can customize this separator:

```ts filename={"registry.ts"}
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

export const customSeparatorRegistry = createProviderRegistry(
  {
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
  model: registry.languageModel('openai:gpt-4-turbo'), // default separator
  // or with custom separator:
  // model: customSeparatorRegistry.languageModel('openai > gpt-4-turbo'),
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

### Example: Use text embedding models

You can access text embedding models by using the `textEmbeddingModel` method on the registry.
The provider id will become the prefix of the model id: `providerId:modelId`.

```ts highlight={"5"}
import { embed } from 'ai';
import { registry } from './registry';

const { embedding } = await embed({
  model: registry.textEmbeddingModel('openai:text-embedding-3-small'),
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

## Combining Custom Providers, Provider Registry, and Middleware

The central idea of provider management is to set up a file that contains all the providers and models you want to use.
You may want to pre-configure model settings, provide model name aliases, limit the available models, and more.

Here is an example that implements the following concepts:

- pass through a full provider with a namespace prefix (here: `xai > *`)
- setup an OpenAI-compatible provider with custom api key and base URL (here: `custom > *`)
- setup model name aliases (here: `anthropic > fast`, `anthropic > writing`, `anthropic > reasoning`)
- pre-configure model settings (here: `anthropic > reasoning`)
- validate the provider-specific options (here: `AnthropicProviderOptions`)
- use a fallback provider (here: `anthropic > *`)
- limit a provider to certain models without a fallback (here: `groq > gemma2-9b-it`, `groq > qwen-qwq-32b`)
- define a custom separator for the provider registry (here: `>`)

```ts
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { xai } from '@ai-sdk/xai';
import { groq } from '@ai-sdk/groq';
import {
  createProviderRegistry,
  customProvider,
  defaultSettingsMiddleware,
  wrapLanguageModel,
} from 'ai';

export const registry = createProviderRegistry(
  {
    // pass through a full provider with a namespace prefix
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
        fast: anthropic('claude-3-haiku-20240307'),

        // simple model
        writing: anthropic('claude-3-7-sonnet-20250219'),

        // extended reasoning model configuration:
        reasoning: wrapLanguageModel({
          model: anthropic('claude-3-7-sonnet-20250219'),
          middleware: defaultSettingsMiddleware({
            settings: {
              maxTokens: 100000, // example default setting
              providerMetadata: {
                anthropic: {
                  thinking: {
                    type: 'enabled',
                    budgetTokens: 32000,
                  },
                } satisfies AnthropicProviderOptions,
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

---
title: Error Handling
description: Learn how to handle errors in the AI SDK Core
---

# Error Handling

## Handling regular errors

Regular errors are thrown and can be handled using the `try/catch` block.

```ts highlight="3,8-10"
import { generateText } from 'ai';

try {
  const { text } = await generateText({
    model: yourModel,
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
import { generateText } from 'ai';

try {
  const { textStream } = streamText({
    model: yourModel,
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

```ts highlight="13-17"
import { generateText } from 'ai';

try {
  const { fullStream } = streamText({
    model: yourModel,
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
    }
  }
} catch (error) {
  // handle error
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

- `MockEmbeddingModelV1`: A mock embedding model using the [embedding model v1 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/embedding-model/v1/embedding-model-v1.ts).
- `MockLanguageModelV1`: A mock language model using the [language model v1 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v1/language-model-v1.ts).
- `mockId`: Provides an incrementing integer ID.
- `mockValues`: Iterates over an array of values with each call. Returns the last value when the array is exhausted.
- [`simulateReadableStream`](/docs/reference/ai-sdk-core/simulate-readable-stream): Simulates a readable stream with delays.

With mock providers and test helpers, you can control the output of the AI SDK
and test your code in a repeatable and deterministic way without actually calling
a language model provider.

## Examples

You can use the test helpers with the AI Core functions in your unit tests:

### generateText

```ts
import { generateText } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';

const result = await generateText({
  model: new MockLanguageModelV1({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
      text: `Hello, world!`,
    }),
  }),
  prompt: 'Hello, test!',
});
```

### streamText

```ts
import { streamText, simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';

const result = streamText({
  model: new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: 'Hello' },
          { type: 'text-delta', textDelta: ', ' },
          { type: 'text-delta', textDelta: `world!` },
          {
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: { completionTokens: 10, promptTokens: 3 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  }),
  prompt: 'Hello, test!',
});
```

### generateObject

```ts
import { generateObject } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';

const result = await generateObject({
  model: new MockLanguageModelV1({
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
      text: `{"content":"Hello, world!"}`,
    }),
  }),
  schema: z.object({ content: z.string() }),
  prompt: 'Hello, test!',
});
```

### streamObject

```ts
import { streamObject, simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { z } from 'zod';

const result = streamObject({
  model: new MockLanguageModelV1({
    defaultObjectGenerationMode: 'json',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-delta', textDelta: '{ ' },
          { type: 'text-delta', textDelta: '"content": ' },
          { type: 'text-delta', textDelta: `"Hello, ` },
          { type: 'text-delta', textDelta: `world` },
          { type: 'text-delta', textDelta: `!"` },
          { type: 'text-delta', textDelta: ' }' },
          {
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: { completionTokens: 10, promptTokens: 3 },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  }),
  schema: z.object({ content: z.string() }),
  prompt: 'Hello, test!',
});
```

### Simulate Data Stream Protocol Responses

You can also simulate [Data Stream Protocol](/docs/ai-sdk-ui/stream-protocol#data-stream-protocol) responses for testing,
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
        `0:"This"\n`,
        `0:" is an"\n`,
        `0:"example."\n`,
        `e:{"finishReason":"stop","usage":{"promptTokens":20,"completionTokens":50},"isContinued":false}\n`,
        `d:{"finishReason":"stop","usage":{"promptTokens":20,"completionTokens":50}}\n`,
      ],
    }).pipeThrough(new TextEncoderStream()),
    {
      status: 200,
      headers: {
        'X-Vercel-AI-Data-Stream': 'v1',
        'Content-Type': 'text/plain; charset=utf-8',
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

For Next.js applications, please follow the [Next.js OpenTelemetry guide](https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry) to enable telemetry first.

You can then use the `experimental_telemetry` option to enable telemetry on specific function calls while the feature is experimental:

```ts highlight="4"
const result = await generateText({
  model: openai('gpt-4-turbo'),
  prompt: 'Write a short story about a cat.',
  experimental_telemetry: { isEnabled: true },
});
```

When telemetry is enabled, you can also control if you want to record the input values and the output values for the function.
By default, both are enabled. You can disable them by setting the `recordInputs` and `recordOutputs` options to `false`.

Disabling the recording of inputs and outputs can be useful for privacy, data transfer, and performance reasons.
You might for example want to disable recording inputs if they contain sensitive information.

## Telemetry Metadata

You can provide a `functionId` to identify the function that the telemetry data is for,
and `metadata` to include additional information in the telemetry data.

```ts highlight="6-10"
const result = await generateText({
  model: openai('gpt-4-turbo'),
  prompt: 'Write a short story about a cat.',
  experimental_telemetry: {
    isEnabled: true,
    functionId: 'my-awesome-function',
    metadata: {
      something: 'custom',
      someOtherThing: 'other-value',
    },
  },
});
```

## Custom Tracer

You may provide a `tracer` which must return an OpenTelemetry `Tracer`. This is useful in situations where
you want your traces to use a `TracerProvider` other than the one provided by the `@opentelemetry/api` singleton.

```ts highlight="7"
const tracerProvider = new NodeTracerProvider();
const result = await generateText({
  model: openai('gpt-4-turbo'),
  prompt: 'Write a short story about a cat.',
  experimental_telemetry: {
    isEnabled: true,
    tracer: tracerProvider.getTracer('ai'),
  },
});
```

## Collected Data

### generateText function

`generateText` records 3 types of spans:

- `ai.generateText` (span): the full length of the generateText call. It contains 1 or more `ai.generateText.doGenerate` spans.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateText` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateText"`
  - `ai.prompt`: the prompt that was used when calling `generateText`
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished
  - `ai.settings.maxSteps`: the maximum number of steps that were set

- `ai.generateText.doGenerate` (span): a provider doGenerate call. It can contain `ai.toolCall` spans.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateText.doGenerate` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateText.doGenerate"`
  - `ai.prompt.format`: the format of the prompt
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.prompt.tools`: array of stringified tool definitions. The tools can be of type `function` or `provider-defined`.
    Function tools have a `name`, `description` (optional), and `parameters` (JSON schema).
    Provider-defined tools have a `name`, `id`, and `args` (Record).
  - `ai.prompt.toolChoice`: the stringified tool choice setting (JSON). It has a `type` property
    (`auto`, `none`, `required`, `tool`), and if the type is `tool`, a `toolName` property with the specific tool.
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished

- `ai.toolCall` (span): a tool call that is made as part of the generateText call. See [Tool call spans](#tool-call-spans) for more details.

### streamText function

`streamText` records 3 types of spans and 2 types of events:

- `ai.streamText` (span): the full length of the streamText call. It contains a `ai.streamText.doStream` span.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamText` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamText"`
  - `ai.prompt`: the prompt that was used when calling `streamText`
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.finishReason`: the reason why the generation finished
  - `ai.settings.maxSteps`: the maximum number of steps that were set

- `ai.streamText.doStream` (span): a provider doStream call.
  This span contains an `ai.stream.firstChunk` event and `ai.toolCall` spans.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamText.doStream` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamText.doStream"`
  - `ai.prompt.format`: the format of the prompt
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.prompt.tools`: array of stringified tool definitions. The tools can be of type `function` or `provider-defined`.
    Function tools have a `name`, `description` (optional), and `parameters` (JSON schema).
    Provider-defined tools have a `name`, `id`, and `args` (Record).
  - `ai.prompt.toolChoice`: the stringified tool choice setting (JSON). It has a `type` property
    (`auto`, `none`, `required`, `tool`), and if the type is `tool`, a `toolName` property with the specific tool.
  - `ai.response.text`: the text that was generated
  - `ai.response.toolCalls`: the tool calls that were made as part of the generation (stringified JSON)
  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk in milliseconds
  - `ai.response.msToFinish`: the time it took to receive the finish part of the LLM stream in milliseconds
  - `ai.response.avgCompletionTokensPerSecond`: the average number of completion tokens per second
  - `ai.response.finishReason`: the reason why the generation finished

- `ai.toolCall` (span): a tool call that is made as part of the generateText call. See [Tool call spans](#tool-call-spans) for more details.

- `ai.stream.firstChunk` (event): an event that is emitted when the first chunk of the stream is received.

  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk

- `ai.stream.finish` (event): an event that is emitted when the finish part of the LLM stream is received.

It also records a `ai.stream.firstChunk` event when the first chunk of the stream is received.

### generateObject function

`generateObject` records 2 types of spans:

- `ai.generateObject` (span): the full length of the generateObject call. It contains 1 or more `ai.generateObject.doGenerate` spans.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateObject` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateObject"`
  - `ai.prompt`: the prompt that was used when calling `generateObject`
  - `ai.schema`: Stringified JSON schema version of the schema that was passed into the `generateObject` function
  - `ai.schema.name`: the name of the schema that was passed into the `generateObject` function
  - `ai.schema.description`: the description of the schema that was passed into the `generateObject` function
  - `ai.response.object`: the object that was generated (stringified JSON)
  - `ai.settings.mode`: the object generation mode, e.g. `json`
  - `ai.settings.output`: the output type that was used, e.g. `object` or `no-schema`

- `ai.generateObject.doGenerate` (span): a provider doGenerate call.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.generateObject.doGenerate` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.generateObject.doGenerate"`
  - `ai.prompt.format`: the format of the prompt
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.response.object`: the object that was generated (stringified JSON)
  - `ai.settings.mode`: the object generation mode
  - `ai.response.finishReason`: the reason why the generation finished

### streamObject function

`streamObject` records 2 types of spans and 1 type of event:

- `ai.streamObject` (span): the full length of the streamObject call. It contains 1 or more `ai.streamObject.doStream` spans.
  It contains the [basic LLM span information](#basic-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamObject` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamObject"`
  - `ai.prompt`: the prompt that was used when calling `streamObject`
  - `ai.schema`: Stringified JSON schema version of the schema that was passed into the `streamObject` function
  - `ai.schema.name`: the name of the schema that was passed into the `streamObject` function
  - `ai.schema.description`: the description of the schema that was passed into the `streamObject` function
  - `ai.response.object`: the object that was generated (stringified JSON)
  - `ai.settings.mode`: the object generation mode, e.g. `json`
  - `ai.settings.output`: the output type that was used, e.g. `object` or `no-schema`

- `ai.streamObject.doStream` (span): a provider doStream call.
  This span contains an `ai.stream.firstChunk` event.
  It contains the [call LLM span information](#call-llm-span-information) and the following attributes:

  - `operation.name`: `ai.streamObject.doStream` and the functionId that was set through `telemetry.functionId`
  - `ai.operationId`: `"ai.streamObject.doStream"`
  - `ai.prompt.format`: the format of the prompt
  - `ai.prompt.messages`: the messages that were passed into the provider
  - `ai.settings.mode`: the object generation mode
  - `ai.response.object`: the object that was generated (stringified JSON)
  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk
  - `ai.response.finishReason`: the reason why the generation finished

- `ai.stream.firstChunk` (event): an event that is emitted when the first chunk of the stream is received.
  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk

### embed function

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

### embedMany function

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

## Span Details

### Basic LLM span information

Many spans that use LLMs (`ai.generateText`, `ai.generateText.doGenerate`, `ai.streamText`, `ai.streamText.doStream`,
`ai.generateObject`, `ai.generateObject.doGenerate`, `ai.streamObject`, `ai.streamObject.doStream`) contain the following attributes:

- `resource.name`: the functionId that was set through `telemetry.functionId`
- `ai.model.id`: the id of the model
- `ai.model.provider`: the provider of the model
- `ai.request.headers.*`: the request headers that were passed in through `headers`
- `ai.response.providerMetadata`: provider specific metadata returned with the generation response
- `ai.settings.maxRetries`: the maximum number of retries that were set
- `ai.telemetry.functionId`: the functionId that was set through `telemetry.functionId`
- `ai.telemetry.metadata.*`: the metadata that was passed in through `telemetry.metadata`
- `ai.usage.completionTokens`: the number of completion tokens that were used
- `ai.usage.promptTokens`: the number of prompt tokens that were used

### Call LLM span information

Spans that correspond to individual LLM calls (`ai.generateText.doGenerate`, `ai.streamText.doStream`, `ai.generateObject.doGenerate`, `ai.streamObject.doStream`) contain
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

### Basic embedding span information

Many spans that use embedding models (`ai.embed`, `ai.embed.doEmbed`, `ai.embedMany`, `ai.embedMany.doEmbed`) contain the following attributes:

- `ai.model.id`: the id of the model
- `ai.model.provider`: the provider of the model
- `ai.request.headers.*`: the request headers that were passed in through `headers`
- `ai.response.providerMetadata`: provider specific metadata returned with the generation response
- `ai.settings.maxRetries`: the maximum number of retries that were set
- `ai.telemetry.functionId`: the functionId that was set through `telemetry.functionId`
- `ai.telemetry.metadata.*`: the metadata that was passed in through `telemetry.metadata`
- `ai.usage.tokens`: the number of tokens that were used
- `resource.name`: the functionId that was set through `telemetry.functionId`

### Tool call spans

Tool call spans (`ai.toolCall`) contain the following attributes:

- `operation.name`: `"ai.toolCall"`
- `ai.operationId`: `"ai.toolCall"`
- `ai.toolCall.name`: the name of the tool
- `ai.toolCall.id`: the id of the tool call
- `ai.toolCall.args`: the parameters of the tool call
- `ai.toolCall.result`: the result of the tool call. Only available if the tool call is successful and the result is serializable.

---
title: Overview
description: An overview of AI SDK UI.
---

# AI SDK UI

AI SDK UI is designed to help you build interactive chat, completion, and assistant applications with ease. It is a **framework-agnostic toolkit**, streamlining the integration of advanced AI functionalities into your applications.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently. With four main hooks — **`useChat`**, **`useCompletion`**, **`useObject`**, and **`useAssistant`** — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

- **[`useChat`](/docs/ai-sdk-ui/chatbot)** offers real-time streaming of chat messages, abstracting state management for inputs, messages, loading, and errors, allowing for seamless integration into any UI design.
- **[`useCompletion`](/docs/ai-sdk-ui/completion)** enables you to handle text completions in your applications, managing the prompt input and automatically updating the UI as new completions are streamed.
- **[`useObject`](/docs/ai-sdk-ui/object-generation)** is a hook that allows you to consume streamed JSON objects, providing a simple way to handle and display structured data in your application.
- **[`useAssistant`](/docs/ai-sdk-ui/openai-assistants)** is designed to facilitate interaction with OpenAI-compatible assistant APIs, managing UI state and updating it automatically as responses are streamed.

These hooks are designed to reduce the complexity and time required to implement AI interactions, letting you focus on creating exceptional user experiences.

## UI Framework Support

AI SDK UI supports the following frameworks: [React](https://react.dev/), [Svelte](https://svelte.dev/), [Vue.js](https://vuejs.org/), and [SolidJS](https://www.solidjs.com/) (deprecated).
Here is a comparison of the supported functions across these frameworks:

| Function                                                  | React               | Svelte                               | Vue.js              | SolidJS (deprecated) |
| --------------------------------------------------------- | ------------------- | ------------------------------------ | ------------------- | -------------------- |
| [useChat](/docs/reference/ai-sdk-ui/use-chat)             | <Check size={18} /> | <Check size={18} /> Chat             | <Check size={18} /> | <Check size={18} />  |
| [useCompletion](/docs/reference/ai-sdk-ui/use-completion) | <Check size={18} /> | <Check size={18} /> Completion       | <Check size={18} /> | <Check size={18} />  |
| [useObject](/docs/reference/ai-sdk-ui/use-object)         | <Check size={18} /> | <Check size={18} /> StructuredObject | <Cross size={18} /> | <Check size={18} />  |
| [useAssistant](/docs/reference/ai-sdk-ui/use-assistant)   | <Check size={18} /> | <Cross size={18} />                  | <Check size={18} /> | <Check size={18} />  |

<Note>
  [Contributions](https://github.com/vercel/ai/blob/main/CONTRIBUTING.md) are
  welcome to implement missing features for non-React frameworks.
</Note>

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
Check out our [chatbot with tools guide](/docs/ai-sdk-ui/chatbot-with-tool-calling) to learn how to use tools in your chatbot.
Let's start with the following example first.

## Example

```tsx filename='app/page.tsx'
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({});

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.content}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input name="prompt" value={input} onChange={handleInputChange} />
        <button type="submit">Submit</button>
      </form>
    </>
  );
}
```

```ts filename='app/api/chat/route.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4-turbo'),
    system: 'You are a helpful assistant.',
    messages,
  });

  return result.toDataStreamResponse();
}
```

<Note>
  The UI messages have a new `parts` property that contains the message parts.
  We recommend rendering the messages using the `parts` property instead of the
  `content` property. The parts property supports different message types,
  including text, tool invocation, and tool result, and allows for more flexible
  and complex chat UIs.
</Note>

In the `Page` component, the `useChat` hook will request to your AI provider endpoint whenever the user submits a message.
The messages are then streamed back in real-time and displayed in the chat UI.

This enables a seamless chat experience where the user can see the AI response as soon as it is available,
without having to wait for the entire response to be received.

## Customized UI

`useChat` also provides ways to manage the chat message and input states via code, show status, and update messages without being triggered by user interactions.

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

```tsx filename='app/page.tsx' highlight="6,20-27,34"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, status, stop } =
    useChat({});

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.content}
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

      <form onSubmit={handleSubmit}>
        <input
          name="prompt"
          value={input}
          onChange={handleInputChange}
          disabled={status !== 'ready'}
        />
        <button type="submit">Submit</button>
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

```tsx file="app/page.tsx" highlight="6,18-25,31"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, error, reload } =
    useChat({});

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      {error && (
        <>
          <div>An error occurred.</div>
          <button type="button" onClick={() => reload()}>
            Retry
          </button>
        </>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
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
const { messages, setMessages, ... } = useChat()

const handleDelete = (id) => {
  setMessages(messages.filter(message => message.id !== id))
}

return <>
  {messages.map(message => (
    <div key={message.id}>
      {message.role === 'user' ? 'User: ' : 'AI: '}
      {message.content}
      <button onClick={() => handleDelete(message.id)}>Delete</button>
    </div>
  ))}
  ...
```

You can think of `messages` and `setMessages` as a pair of `state` and `setState` in React.

### Controlled input

In the initial example, we have `handleSubmit` and `handleInputChange` callbacks that manage the input changes and form submissions. These are handy for common use cases, but you can also use uncontrolled APIs for more advanced scenarios such as form validation or customized components.

The following example demonstrates how to use more granular APIs like `setInput` and `append` with your custom input and submit button components:

```tsx
const { input, setInput, append } = useChat()

return <>
  <MyCustomInput value={input} onChange={value => setInput(value)} />
  <MySubmitButton onClick={() => {
    // Send a new message to the AI provider
    append({
      role: 'user',
      content: input,
    })
  }}/>
  ...
```

### Cancellation and regeneration

It's also a common use case to abort the response message while it's still streaming back from the AI provider. You can do this by calling the `stop` function returned by the `useChat` hook.

```tsx
const { stop, status, ... } = useChat()

return <>
  <button onClick={stop} disabled={!(status === 'streaming' || status === 'submitted')}>Stop</button>
  ...
```

When the user clicks the "Stop" button, the fetch request will be aborted. This avoids consuming unnecessary resources and improves the UX of your chatbot application.

Similarly, you can also request the AI provider to reprocess the last message by calling the `reload` function returned by the `useChat` hook:

```tsx
const { reload, status, ... } = useChat()

return <>
  <button onClick={reload} disabled={!(status === 'ready' || status === 'error')}>Regenerate</button>
  ...
</>
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

- `onFinish`: Called when the assistant message is completed
- `onError`: Called when an error occurs during the fetch request.
- `onResponse`: Called when the response from the API is received.

These callbacks can be used to trigger additional actions, such as logging, analytics, or custom UI updates.

```tsx
import { Message } from '@ai-sdk/react';

const {
  /* ... */
} = useChat({
  onFinish: (message, { usage, finishReason }) => {
    console.log('Finished streaming message:', message);
    console.log('Token usage:', usage);
    console.log('Finish reason:', finishReason);
  },
  onError: error => {
    console.error('An error occurred:', error);
  },
  onResponse: response => {
    console.log('Received HTTP response from server:', response);
  },
});
```

It's worth noting that you can abort the processing by throwing an error in the `onResponse` callback. This will trigger the `onError` callback and stop the message from being appended to the chat UI. This can be useful for handling unexpected responses from the AI provider.

## Request Configuration

### Custom headers, body, and credentials

By default, the `useChat` hook sends a HTTP POST request to the `/api/chat` endpoint with the message list as the request body. You can customize the request by passing additional options to the `useChat` hook:

```tsx
const { messages, input, handleInputChange, handleSubmit } = useChat({
  api: '/api/custom-chat',
  headers: {
    Authorization: 'your_token',
  },
  body: {
    user_id: '123',
  },
  credentials: 'same-origin',
});
```

In this example, the `useChat` hook sends a POST request to the `/api/custom-chat` endpoint with the specified headers, additional body fields, and credentials for that fetch request. On your server side, you can handle the request with these additional information.

### Setting custom body fields per request

You can configure custom `body` fields on a per-request basis using the `body` option of the `handleSubmit` function.
This is useful if you want to pass in additional information to your backend that is not part of the message list.

```tsx filename="app/page.tsx" highlight="18-20"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      <form
        onSubmit={event => {
          handleSubmit(event, {
            body: {
              customKey: 'customValue',
            },
          });
        }}
      >
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

You can retrieve these custom fields on your server side by destructuring the request body:

```ts filename="app/api/chat/route.ts" highlight="3"
export async function POST(req: Request) {
  // Extract addition information ("customKey") from the body of the request:
  const { messages, customKey } = await req.json();
  //...
}
```

## Controlling the response stream

With `streamText`, you can control how error messages and usage information are sent back to the client.

### Error Messages

By default, the error message is masked for security reasons.
The default error message is "An error occurred."
You can forward error messages or send your own error message by providing a `getErrorMessage` function:

```ts filename="app/api/chat/route.ts" highlight="13-27"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
  });

  return result.toDataStreamResponse({
    getErrorMessage: error => {
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

By default, the usage information is sent back to the client. You can disable it by setting the `sendUsage` option to `false`:

```ts filename="app/api/chat/route.ts" highlight="13"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
  });

  return result.toDataStreamResponse({
    sendUsage: false,
  });
}
```

### Text Streams

`useChat` can handle plain text streams by setting the `streamProtocol` option to `text`:

```tsx filename="app/page.tsx" highlight="7"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages } = useChat({
    streamProtocol: 'text',
  });

  return <>...</>;
}
```

This configuration also works with other backend servers that stream plain text.
Check out the [stream protocol guide](/docs/ai-sdk-ui/stream-protocol) for more information.

<Note>
  When using `streamProtocol: 'text'`, tool calls, usage information and finish
  reasons are not available.
</Note>

## Empty Submissions

You can configure the `useChat` hook to allow empty submissions by setting the `allowEmptySubmit` option to `true`.

```tsx filename="app/page.tsx" highlight="18"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      <form
        onSubmit={event => {
          handleSubmit(event, {
            allowEmptySubmit: true,
          });
        }}
      >
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

## Reasoning

Some models such as as DeepSeek `deepseek-reasoner`
and Anthropic `claude-3-7-sonnet-20250219` support reasoning tokens.
These tokens are typically sent before the message content.
You can forward them to the client with the `sendReasoning` option:

```ts filename="app/api/chat/route.ts" highlight="13"
import { deepseek } from '@ai-sdk/deepseek';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: deepseek('deepseek-reasoner'),
    messages,
  });

  return result.toDataStreamResponse({
    sendReasoning: true,
  });
}
```

On the client side, you can access the reasoning parts of the message object.

They have a `details` property that contains the reasoning and redacted reasoning parts.
You can also use `reasoning` to access just the reasoning as a string.

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
        return (
          <pre key={index}>
            {part.details.map(detail =>
              detail.type === 'text' ? detail.text : '<redacted>',
            )}
          </pre>
        );
      }
    })}
  </div>
));
```

## Sources

Some providers such as [Perplexity](/providers/ai-sdk-providers/perplexity#sources) and
[Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#sources) include sources in the response.

Currently sources are limited to web pages that ground the response.
You can forward them to the client with the `sendSources` option:

```ts filename="app/api/chat/route.ts" highlight="13"
import { perplexity } from '@ai-sdk/perplexity';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: perplexity('sonar-pro'),
    messages,
  });

  return result.toDataStreamResponse({
    sendSources: true,
  });
}
```

On the client side, you can access source parts of the message object.
Here is an example that renders the sources as links at the bottom of the message:

```tsx filename="app/page.tsx"
messages.map(message => (
  <div key={message.id}>
    {message.role === 'user' ? 'User: ' : 'AI: '}
    {message.parts
      .filter(part => part.type !== 'source')
      .map((part, index) => {
        if (part.type === 'text') {
          return <div key={index}>{part.text}</div>;
        }
      })}
    {message.parts
      .filter(part => part.type === 'source')
      .map(part => (
        <span key={`source-${part.source.id}`}>
          [
          <a href={part.source.url} target="_blank">
            {part.source.title ?? new URL(part.source.url).hostname}
          </a>
          ]
        </span>
      ))}
  </div>
));
```

## Image Generation

Some models such as Google `gemini-2.0-flash-exp` support image generation.
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
      } else if (part.type === 'file' && part.mimeType.startsWith('image/')) {
        return (
          <img key={index} src={`data:${part.mimeType};base64,${part.data}`} />
        );
      }
    })}
  </div>
));
```

## Attachments (Experimental)

The `useChat` hook supports sending attachments along with a message as well as rendering them on the client. This can be useful for building applications that involve sending images, files, or other media content to the AI provider.

There are two ways to send attachments with a message, either by providing a `FileList` object or a list of URLs to the `handleSubmit` function:

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
  const { messages, input, handleSubmit, handleInputChange, status } =
    useChat();

  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div>
        {messages.map(message => (
          <div key={message.id}>
            <div>{`${message.role}: `}</div>

            <div>
              {message.content}

              <div>
                {message.experimental_attachments
                  ?.filter(attachment =>
                    attachment.contentType.startsWith('image/'),
                  )
                  .map((attachment, index) => (
                    <img
                      key={`${message.id}-${index}`}
                      src={attachment.url}
                      alt={attachment.name}
                    />
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={event => {
          handleSubmit(event, {
            experimental_attachments: files,
          });

          setFiles(undefined);

          if (fileInputRef.current) {
            fileInputRef.current.value = '';
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
          onChange={handleInputChange}
          disabled={status !== 'ready'}
        />
      </form>
    </div>
  );
}
```

### URLs

You can also send URLs as attachments along with a message. This can be useful for sending links to external resources or media content.

> **Note:** The URL can also be a data URL, which is a base64-encoded string that represents the content of a file. Currently, only `image/*` content types get automatically converted into [multi-modal content parts](/docs/foundations/prompts#multi-modal-messages). You will need to handle other content types manually.

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import { Attachment } from '@ai-sdk/ui-utils';

export default function Page() {
  const { messages, input, handleSubmit, handleInputChange, status } =
    useChat();

  const [attachments] = useState<Attachment[]>([
    {
      name: 'earth.png',
      contentType: 'image/png',
      url: 'https://example.com/earth.png',
    },
    {
      name: 'moon.png',
      contentType: 'image/png',
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
              {message.content}

              <div>
                {message.experimental_attachments
                  ?.filter(attachment =>
                    attachment.contentType?.startsWith('image/'),
                  )
                  .map((attachment, index) => (
                    <img
                      key={`${message.id}-${index}`}
                      src={attachment.url}
                      alt={attachment.name}
                    />
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={event => {
          handleSubmit(event, {
            experimental_attachments: attachments,
          });
        }}
      >
        <input
          value={input}
          placeholder="Send message..."
          onChange={handleInputChange}
          disabled={status !== 'ready'}
        />
      </form>
    </div>
  );
}
```

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
import { createChat } from '@tools/chat-store';

export default async function Page() {
  const id = await createChat(); // create a new chat
  redirect(`/chat/${id}`); // redirect to chat page, see below
}
```

Our example chat store implementation uses files to store the chat messages.
In a real-world application, you would use a database or a cloud storage service,
and get the chat ID from the database.
That being said, the function interfaces are designed to be easily replaced with other implementations.

```tsx filename="tools/chat-store.ts"
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

When the user navigates to the chat page with a chat ID, we need to load the chat messages and display them.

```tsx filename="app/chat/[id]/page.tsx"
import { loadChat } from '@tools/chat-store';
import Chat from '@ui/chat';

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params; // get the chat ID from the URL
  const messages = await loadChat(id); // load the chat messages
  return <Chat id={id} initialMessages={messages} />; // display the chat
}
```

The `loadChat` function in our file-based chat store is implemented as follows:

```tsx filename="tools/chat-store.ts"
import { Message } from 'ai';
import { readFile } from 'fs/promises';

export async function loadChat(id: string): Promise<Message[]> {
  return JSON.parse(await readFile(getChatFile(id), 'utf8'));
}

// ... rest of the file
```

The display component is a simple chat component that uses the `useChat` hook to
send and receive messages:

```tsx filename="ui/chat.tsx" highlight="10-12"
'use client';

import { Message, useChat } from '@ai-sdk/react';

export default function Chat({
  id,
  initialMessages,
}: { id?: string | undefined; initialMessages?: Message[] } = {}) {
  const { input, handleInputChange, handleSubmit, messages } = useChat({
    id, // use the provided chat ID
    initialMessages, // initial messages if provided
    sendExtraMessageFields: true, // send id and createdAt for each message
  });

  // simplified rendering code, extend as needed:
  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.content}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

## Storing messages

`useChat` sends the chat id and the messages to the backend.
We have enabled the `sendExtraMessageFields` option to send the id and createdAt fields,
meaning that we store messages in the `useChat` message format.

<Note>
  The `useChat` message format is different from the `CoreMessage` format. The
  `useChat` message format is designed for frontend display, and contains
  additional fields such as `id` and `createdAt`. We recommend storing the
  messages in the `useChat` message format.
</Note>

Storing messages is done in the `onFinish` callback of the `streamText` function.
`onFinish` receives the messages from the AI response as a `CoreMessage[]`,
and we use the [`appendResponseMessages`](/docs/reference/ai-sdk-ui/append-response-messages)
helper to append the AI response messages to the chat messages.

```tsx filename="app/api/chat/route.ts" highlight="6,11-19"
import { openai } from '@ai-sdk/openai';
import { appendResponseMessages, streamText } from 'ai';
import { saveChat } from '@tools/chat-store';

export async function POST(req: Request) {
  const { messages, id } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    messages,
    async onFinish({ response }) {
      await saveChat({
        id,
        messages: appendResponseMessages({
          messages,
          responseMessages: response.messages,
        }),
      });
    },
  });

  return result.toDataStreamResponse();
}
```

The actual storage of the messages is done in the `saveChat` function, which in
our file-based chat store is implemented as follows:

```tsx filename="tools/chat-store.ts"
import { Message } from 'ai';
import { writeFile } from 'fs/promises';

export async function saveChat({
  id,
  messages,
}: {
  id: string;
  messages: Message[];
}): Promise<void> {
  const content = JSON.stringify(messages, null, 2);
  await writeFile(getChatFile(id), content);
}

// ... rest of the file
```

## Message IDs

In addition to a chat ID, each message has an ID.
You can use this message ID to e.g. manipulate individual messages.

The IDs for user messages are generated by the `useChat` hook on the client,
and the IDs for AI response messages are generated by `streamText`.

You can control the ID format by providing ID generators
(see [`createIdGenerator()`](/docs/reference/ai-sdk-core/create-id-generator):

```tsx filename="ui/chat.tsx" highlight="8-12"
import { createIdGenerator } from 'ai';
import { useChat } from '@ai-sdk/react';

const {
  // ...
} = useChat({
  // ...
  // id format for client-side messages:
  generateId: createIdGenerator({
    prefix: 'msgc',
    size: 16,
  }),
});
```

```tsx filename="app/api/chat/route.ts" highlight="7-11"
import { createIdGenerator, streamText } from 'ai';

export async function POST(req: Request) {
  // ...
  const result = streamText({
    // ...
    // id format for server-side messages:
    experimental_generateMessageId: createIdGenerator({
      prefix: 'msgs',
      size: 16,
    }),
  });
  // ...
}
```

## Sending only the last message

Once you have implemented message persistence, you might want to send only the last message to the server.
This reduces the amount of data sent to the server on each request and can improve performance.

To achieve this, you can provide an `experimental_prepareRequestBody` function to the `useChat` hook (React only).
This function receives the messages and the chat ID, and returns the request body to be sent to the server.

```tsx filename="ui/chat.tsx" highlight="7-10"
import { useChat } from '@ai-sdk/react';

const {
  // ...
} = useChat({
  // ...
  // only send the last message to the server:
  experimental_prepareRequestBody({ messages, id }) {
    return { message: messages[messages.length - 1], id };
  },
});
```

On the server, you can then load the previous messages and append the new message to the previous messages:

```tsx filename="app/api/chat/route.ts" highlight="2-9"
import { appendClientMessage } from 'ai';

export async function POST(req: Request) {
  // get the last message from the client:
  const { message, id } = await req.json();

  // load the previous messages from the server:
  const previousMessages = await loadChat(id);

  // append the new message to the previous messages:
  const messages = appendClientMessage({
    messages: previousMessages,
    message,
  });

  const result = streamText({
    // ...
    messages,
  });

  // ...
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

```tsx filename="app/api/chat/route.ts" highlight="21-23"
import { appendResponseMessages, streamText } from 'ai';
import { saveChat } from '@tools/chat-store';

export async function POST(req: Request) {
  const { messages, id } = await req.json();

  const result = streamText({
    model,
    messages,
    async onFinish({ response }) {
      await saveChat({
        id,
        messages: appendResponseMessages({
          messages,
          responseMessages: response.messages,
        }),
      });
    },
  });

  // consume the stream to ensure it runs to completion & triggers onFinish
  // even when the client response is aborted:
  result.consumeStream(); // no await

  return result.toDataStreamResponse();
}
```

When the client reloads the page after a disconnect, the chat will be restored from the storage solution.

<Note>
  In production applications, you would also track the state of the request (in
  progress, complete) in your stored messages and use it on the client to cover
  the case where the client reloads the page after a disconnection, but the
  streaming is not yet complete.
</Note>

## Resuming ongoing streams

<Note>This feature is experimental and may change in future versions.</Note>

The `useChat` hook has experimental support for resuming an ongoing chat generation stream by any client, either after a network disconnect or by reloading the chat page. This can be useful for building applications that involve long-running conversations or for ensuring that messages are not lost in case of network failures.

The following are the pre-requisities for your chat application to support resumable streams:

- Installing the [`resumable-stream`](https://www.npmjs.com/package/resumable-stream) package that helps create and manage the publisher/subscriber mechanism of the streams.
- Creating a [Redis](https://vercel.com/marketplace/redis) instance to store the stream state.
- Creating a table that tracks the stream IDs associated with a chat.

To resume a chat stream, you will use the `experimental_resume` function returned by the `useChat` hook. You will call this function during the initial mount of the hook inside the main chat component.

```tsx filename="app/components/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { Input } from '@/components/input';
import { Messages } from '@/components/messages';

export function Chat() {
  const { experimental_resume } = useChat({ id });

  useEffect(() => {
    experimental_resume();

    // we use an empty dependency array to
    // ensure this effect runs only once
  }, []);

  return (
    <div>
      <Messages />
      <Input />
    </div>
  );
}
```

For a more resilient implementation that handles race conditions that can occur in-flight during a resume request, you can use the following `useAutoResume` hook. This will automatically process the `append-message` SSE data part streamed by the server.

```tsx filename="app/hooks/use-auto-resume.ts"
'use client';

import { useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { UseChatHelpers } from '@ai-sdk/react';

export type DataPart = { type: 'append-message'; message: string };

export interface Props {
  autoResume: boolean;
  initialMessages: UIMessage[];
  experimental_resume: UseChatHelpers['experimental_resume'];
  data: UseChatHelpers['data'];
  setMessages: UseChatHelpers['setMessages'];
}

export function useAutoResume({
  autoResume,
  initialMessages,
  experimental_resume,
  data,
  setMessages,
}: Props) {
  useEffect(() => {
    if (!autoResume) return;

    const mostRecentMessage = initialMessages.at(-1);

    if (mostRecentMessage?.role === 'user') {
      experimental_resume();
    }

    // we intentionally run this once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!data || data.length === 0) return;

    const dataPart = data[0] as DataPart;

    if (dataPart.type === 'append-message') {
      const message = JSON.parse(dataPart.message) as UIMessage;
      setMessages([...initialMessages, message]);
    }
  }, [data, initialMessages, setMessages]);
}
```

You can then use this hook in your chat component as follows.

```tsx filename="app/components/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { Input } from '@/components/input';
import { Messages } from '@/components/messages';
import { useAutoResume } from '@/hooks/use-auto-resume';

export function Chat() {
  const { experimental_resume, data, setMessages } = useChat({ id });

  useAutoResume({
    autoResume: true,
    initialMessages: [],
    experimental_resume,
    data,
    setMessages,
  });

  return (
    <div>
      <Messages />
      <Input />
    </div>
  );
}
```

The `experimental_resume` function makes a `GET` request to your configured chat endpoint (or `/api/chat` by default) whenever your client calls it. If there’s an active stream, it will pick up where it left off, otherwise it simply finishes without error.

The `GET` request automatically appends the `chatId` query parameter to the URL to help identify the chat the request belongs to. Using the `chatId`, you can look up the most recent stream ID from the database and resume the stream.

```bash
GET /api/chat?chatId=<your-chat-id>
```

Earlier, you must've implemented the `POST` handler for the `/api/chat` route to create new chat generations. When using `experimental_resume`, you must also implement the `GET` handler for `/api/chat` route to resume streams.

### 1. Implement the GET handler

Add a `GET` method to `/api/chat` that:

1. Reads `chatId` from the query string
2. Validates it’s present
3. Loads any stored stream IDs for that chat
4. Returns the latest one to `streamContext.resumableStream()`
5. Falls back to an empty stream if it’s already closed

```ts filename="app/api/chat/route.ts"
import { loadStreams } from '@/util/chat-store';
import { createDataStream, getMessagesByChatId } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return new Response('id is required', { status: 400 });
  }

  const streamIds = await loadStreams(chatId);

  if (!streamIds.length) {
    return new Response('No streams found', { status: 404 });
  }

  const recentStreamId = streamIds.at(-1);

  if (!recentStreamId) {
    return new Response('No recent stream found', { status: 404 });
  }

  const emptyDataStream = createDataStream({
    execute: () => {},
  });

  const stream = await streamContext.resumableStream(
    recentStreamId,
    () => emptyDataStream,
  );

  if (stream) {
    return new Response(stream, { status: 200 });
  }

  /*
   * For when the generation is "active" during SSR but the
   * resumable stream has concluded after reaching this point.
   */

  const messages = await getMessagesByChatId({ id: chatId });
  const mostRecentMessage = messages.at(-1);

  if (!mostRecentMessage || mostRecentMessage.role !== 'assistant') {
    return new Response(emptyDataStream, { status: 200 });
  }

  const messageCreatedAt = new Date(mostRecentMessage.createdAt);

  const streamWithMessage = createDataStream({
    execute: buffer => {
      buffer.writeData({
        type: 'append-message',
        message: JSON.stringify(mostRecentMessage),
      });
    },
  });

  return new Response(streamWithMessage, { status: 200 });
}
```

After you've implemented the `GET` handler, you can update the `POST` handler to handle the creation of resumable streams.

### 2. Update the POST handler

When you create a brand-new chat completion, you must:

1. Generate a fresh `streamId`
2. Persist it alongside your `chatId`
3. Kick off a `createDataStream` that pipes tokens as they arrive
4. Hand that new stream to `streamContext.resumableStream()`

```ts filename="app/api/chat/route.ts"
import {
  appendResponseMessages,
  createDataStream,
  generateId,
  streamText,
} from 'ai';
import { appendStreamId, saveChat } from '@/util/chat-store';
import { createResumableStreamContext } from 'resumable-stream';

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

async function POST(request: Request) {
  const { id, messages } = await req.json();
  const streamId = generateId();

  // Record this new stream so we can resume later
  await appendStreamId({ chatId: id, streamId });

  // Build the data stream that will emit tokens
  const stream = createDataStream({
    execute: dataStream => {
      const result = streamText({
        model: openai('gpt-4o'),
        messages,
        onFinish: async ({ response }) => {
          await saveChat({
            id,
            messages: appendResponseMessages({
              messages,
              responseMessages: response.messages,
            }),
          });
        },
      });

      // Return a resumable stream to the client
      result.mergeIntoDataStream(dataStream);
    },
  });

  return new Response(
    await streamContext.resumableStream(streamId, () => stream),
  );
}
```

With both handlers, your clients can now gracefully resume ongoing streams.

---
title: Chatbot Tool Usage
description: Learn how to use tools with the useChat hook.
---

# Chatbot Tool Usage

With [`useChat`](/docs/reference/ai-sdk-ui/use-chat) and [`streamText`](/docs/reference/ai-sdk-core/stream-text), you can use tools in your chatbot application.
The AI SDK supports three types of tools in this context:

1. Automatically executed server-side tools
2. Automatically executed client-side tools
3. Tools that require user interaction, such as confirmation dialogs

The flow is as follows:

1. The user enters a message in the chat UI.
1. The message is sent to the API route.
1. In your server side route, the language model generates tool calls during the `streamText` call.
1. All tool calls are forwarded to the client.
1. Server-side tools are executed using their `execute` method and their results are forwarded to the client.
1. Client-side tools that should be automatically executed are handled with the `onToolCall` callback.
   You can return the tool result from the callback.
1. Client-side tool that require user interactions can be displayed in the UI.
   The tool calls and results are available as tool invocation parts in the `parts` property of the last assistant message.
1. When the user interaction is done, `addToolResult` can be used to add the tool result to the chat.
1. When there are tool calls in the last assistant message and all tool results are available, the client sends the updated messages back to the server.
   This triggers another iteration of this flow.

The tool call and tool executions are integrated into the assistant message as tool invocation parts.
A tool invocation is at first a tool call, and then it becomes a tool result when the tool is executed.
The tool result contains all information about the tool call as well as the result of the tool execution.

<Note>
  In order to automatically send another request to the server when all tool
  calls are server-side, you need to set
  [`maxSteps`](/docs/reference/ai-sdk-ui/use-chat#max-steps) to a value greater
  than 1 in the `useChat` options. It is disabled by default for backward
  compatibility.
</Note>

## Example

In this example, we'll use three tools:

- `getWeatherInformation`: An automatically executed server-side tool that returns the weather in a given city.
- `askForConfirmation`: A user-interaction client-side tool that asks the user for confirmation.
- `getLocation`: An automatically executed client-side tool that returns a random city.

### API route

```tsx filename='app/api/chat/route.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { z } from 'zod';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      // server-side tool with execute function:
      getWeatherInformation: {
        description: 'show the weather in a given city to the user',
        parameters: z.object({ city: z.string() }),
        execute: async ({}: { city: string }) => {
          const weatherOptions = ['sunny', 'cloudy', 'rainy', 'snowy', 'windy'];
          return weatherOptions[
            Math.floor(Math.random() * weatherOptions.length)
          ];
        },
      },
      // client-side tool that starts user interaction:
      askForConfirmation: {
        description: 'Ask the user for confirmation.',
        parameters: z.object({
          message: z.string().describe('The message to ask for confirmation.'),
        }),
      },
      // client-side tool that is automatically executed on the client:
      getLocation: {
        description:
          'Get the user location. Always ask for confirmation before using this tool.',
        parameters: z.object({}),
      },
    },
  });

  return result.toDataStreamResponse();
}
```

### Client-side page

The client-side page uses the `useChat` hook to create a chatbot application with real-time message streaming.
Tool invocations are displayed in the chat UI as tool invocation parts.
Please make sure to render the messages using the `parts` property of the message.

There are three things worth mentioning:

1. The [`onToolCall`](/docs/reference/ai-sdk-ui/use-chat#on-tool-call) callback is used to handle client-side tools that should be automatically executed.
   In this example, the `getLocation` tool is a client-side tool that returns a random city.

2. The `toolInvocations` property of the last assistant message contains all tool calls and results.
   The client-side tool `askForConfirmation` is displayed in the UI.
   It asks the user for confirmation and displays the result once the user confirms or denies the execution.
   The result is added to the chat using `addToolResult`.

3. The [`maxSteps`](/docs/reference/ai-sdk-ui/use-chat#max-steps) option is set to 5.
   This enables several tool use iterations between the client and the server.

```tsx filename='app/page.tsx' highlight="9,12,31"
'use client';

import { ToolInvocation } from 'ai';
import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, addToolResult } =
    useChat({
      maxSteps: 5,

      // run client-side tools that are automatically executed:
      async onToolCall({ toolCall }) {
        if (toolCall.toolName === 'getLocation') {
          const cities = [
            'New York',
            'Los Angeles',
            'Chicago',
            'San Francisco',
          ];
          return cities[Math.floor(Math.random() * cities.length)];
        }
      },
    });

  return (
    <>
      {messages?.map(message => (
        <div key={message.id}>
          <strong>{`${message.role}: `}</strong>
          {message.parts.map(part => {
            switch (part.type) {
              // render text parts as simple text:
              case 'text':
                return part.text;

              // for tool invocations, distinguish between the tools and the state:
              case 'tool-invocation': {
                const callId = part.toolInvocation.toolCallId;

                switch (part.toolInvocation.toolName) {
                  case 'askForConfirmation': {
                    switch (part.toolInvocation.state) {
                      case 'call':
                        return (
                          <div key={callId}>
                            {part.toolInvocation.args.message}
                            <div>
                              <button
                                onClick={() =>
                                  addToolResult({
                                    toolCallId: callId,
                                    result: 'Yes, confirmed.',
                                  })
                                }
                              >
                                Yes
                              </button>
                              <button
                                onClick={() =>
                                  addToolResult({
                                    toolCallId: callId,
                                    result: 'No, denied',
                                  })
                                }
                              >
                                No
                              </button>
                            </div>
                          </div>
                        );
                      case 'result':
                        return (
                          <div key={callId}>
                            Location access allowed:{' '}
                            {part.toolInvocation.result}
                          </div>
                        );
                    }
                    break;
                  }

                  case 'getLocation': {
                    switch (part.toolInvocation.state) {
                      case 'call':
                        return <div key={callId}>Getting location...</div>;
                      case 'result':
                        return (
                          <div key={callId}>
                            Location: {part.toolInvocation.result}
                          </div>
                        );
                    }
                    break;
                  }

                  case 'getWeatherInformation': {
                    switch (part.toolInvocation.state) {
                      // example of pre-rendering streaming tool calls:
                      case 'partial-call':
                        return (
                          <pre key={callId}>
                            {JSON.stringify(part.toolInvocation, null, 2)}
                          </pre>
                        );
                      case 'call':
                        return (
                          <div key={callId}>
                            Getting weather information for{' '}
                            {part.toolInvocation.args.city}...
                          </div>
                        );
                      case 'result':
                        return (
                          <div key={callId}>
                            Weather in {part.toolInvocation.args.city}:{' '}
                            {part.toolInvocation.result}
                          </div>
                        );
                    }
                    break;
                  }
                }
              }
            }
          })}
          <br />
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </>
  );
}
```

## Tool call streaming

You can stream tool calls while they are being generated by enabling the
`toolCallStreaming` option in `streamText`.

```tsx filename='app/api/chat/route.ts' highlight="5"
export async function POST(req: Request) {
  // ...

  const result = streamText({
    toolCallStreaming: true,
    // ...
  });

  return result.toDataStreamResponse();
}
```

When the flag is enabled, partial tool calls will be streamed as part of the data stream.
They are available through the `useChat` hook.
The tool invocation parts of assistant messages will also contain partial tool calls.
You can use the `state` property of the tool invocation to render the correct UI.

```tsx filename='app/page.tsx' highlight="9,10"
export default function Chat() {
  // ...
  return (
    <>
      {messages?.map(message => (
        <div key={message.id}>
          {message.parts.map(part => {
            if (part.type === 'tool-invocation') {
              switch (part.toolInvocation.state) {
                case 'partial-call':
                  return <>render partial tool call</>;
                case 'call':
                  return <>render full tool call</>;
                case 'result':
                  return <>render tool result</>;
              }
            }
          })}
        </div>
      ))}
    </>
  );
}
```

## Step start parts

When you are using multi-step tool calls, the AI SDK will add step start parts to the assistant messages.
If you want to display boundaries between tool invocations, you can use the `step-start` parts as follows:

```tsx filename='app/page.tsx'
// ...
// where you render the message parts:
message.parts.map((part, index) => {
  switch (part.type) {
    case 'step-start':
      // show step boundaries as horizontal lines:
      return index > 0 ? (
        <div key={index} className="text-gray-500">
          <hr className="my-2 border-gray-300" />
        </div>
      ) : null;
    case 'text':
    // ...
    case 'tool-invocation':
    // ...
  }
});
// ...
```

## Server-side Multi-Step Calls

You can also use multi-step calls on the server-side with `streamText`.
This works when all invoked tools have an `execute` function on the server side.

```tsx filename='app/api/chat/route.ts' highlight="15-21,24"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      getWeatherInformation: {
        description: 'show the weather in a given city to the user',
        parameters: z.object({ city: z.string() }),
        // tool has execute function:
        execute: async ({}: { city: string }) => {
          const weatherOptions = ['sunny', 'cloudy', 'rainy', 'snowy', 'windy'];
          return weatherOptions[
            Math.floor(Math.random() * weatherOptions.length)
          ];
        },
      },
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
```

## Errors

Language models can make errors when calling tools.
By default, these errors are masked for security reasons, and show up as "An error occurred" in the UI.

To surface the errors, you can use the `getErrorMessage` function when calling `toDataStreamResponse`.

```tsx
export function errorHandler(error: unknown) {
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
}
```

```tsx
const result = streamText({
  // ...
});

return result.toDataStreamResponse({
  getErrorMessage: errorHandler,
});
```

In case you are using `createDataStreamResponse`, you can use the `onError` function when calling `toDataStreamResponse`:

```tsx
const response = createDataStreamResponse({
  // ...
  async execute(dataStream) {
    // ...
  },
  onError: error => `Custom error: ${error.message}`,
});
```

---
title: Generative User Interfaces
description: Learn how to build Generative UI with AI SDK UI.
---

# Generative User Interfaces

Generative user interfaces (generative UI) is the process of allowing a large language model (LLM) to go beyond text and "generate UI". This creates a more engaging and AI-native experience for users.

<WeatherSearch />

At the core of generative UI are [ tools ](/docs/ai-sdk-core/tools-and-tool-calling), which are functions you provide to the model to perform specialized tasks like getting the weather in a location. The model can decide when and how to use these tools based on the context of the conversation.

Generative UI is the process of connecting the results of a tool call to a React component. Here's how it works:

1. You provide the model with a prompt or conversation history, along with a set of tools.
2. Based on the context, the model may decide to call a tool.
3. If a tool is called, it will execute and return data.
4. This data can then be passed to a React component for rendering.

By passing the tool results to React components, you can create a generative UI experience that's more engaging and adaptive to your needs.

## Build a Generative UI Chat Interface

Let's create a chat interface that handles text-based conversations and incorporates dynamic UI elements based on model responses.

### Basic Chat Implementation

Start with a basic chat implementation using the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role === 'user' ? 'User: ' : 'AI: '}</div>
          <div>{message.content}</div>
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

To handle the chat requests and model responses, set up an API route:

```ts filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(request: Request) {
  const { messages } = await request.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: 'You are a friendly assistant!',
    messages,
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
```

This API route uses the `streamText` function to process chat messages and stream the model's responses back to the client.

### Create a Tool

Before enhancing your chat interface with dynamic UI elements, you need to create a tool and corresponding React component. A tool will allow the model to perform a specific action, such as fetching weather information.

Create a new file called `ai/tools.ts` with the following content:

```ts filename="ai/tools.ts"
import { tool as createTool } from 'ai';
import { z } from 'zod';

export const weatherTool = createTool({
  description: 'Display the weather for a location',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async function ({ location }) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { weather: 'Sunny', temperature: 75, location };
  },
});

export const tools = {
  displayWeather: weatherTool,
};
```

In this file, you've created a tool called `weatherTool`. This tool simulates fetching weather information for a given location. This tool will return simulated data after a 2-second delay. In a real-world application, you would replace this simulation with an actual API call to a weather service.

### Update the API Route

Update the API route to include the tool you've defined:

```ts filename="app/api/chat/route.ts" highlight="3,13"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { tools } from '@/ai/tools';

export async function POST(request: Request) {
  const { messages } = await request.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: 'You are a friendly assistant!',
    messages,
    maxSteps: 5,
    tools,
  });

  return result.toDataStreamResponse();
}
```

Now that you've defined the tool and added it to your `streamText` call, let's build a React component to display the weather information it returns.

### Create UI Components

Create a new file called `components/weather.tsx`:

```tsx filename="components/weather.tsx"
type WeatherProps = {
  temperature: number;
  weather: string;
  location: string;
};

export const Weather = ({ temperature, weather, location }: WeatherProps) => {
  return (
    <div>
      <h2>Current Weather for {location}</h2>
      <p>Condition: {weather}</p>
      <p>Temperature: {temperature}°C</p>
    </div>
  );
};
```

This component will display the weather information for a given location. It takes three props: `temperature`, `weather`, and `location` (exactly what the `weatherTool` returns).

### Render the Weather Component

Now that you have your tool and corresponding React component, let's integrate them into your chat interface. You'll render the Weather component when the model calls the weather tool.

To check if the model has called a tool, you can use the `toolInvocations` property of the message object. This property contains information about any tools that were invoked in that generation including `toolCallId`, `toolName`, `args`, `toolState`, and `result`.

Update your `page.tsx` file:

```tsx filename="app/page.tsx" highlight="4,16-39"
'use client';

import { useChat } from '@ai-sdk/react';
import { Weather } from '@/components/weather';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role === 'user' ? 'User: ' : 'AI: '}</div>
          <div>{message.content}</div>

          <div>
            {message.toolInvocations?.map(toolInvocation => {
              const { toolName, toolCallId, state } = toolInvocation;

              if (state === 'result') {
                if (toolName === 'displayWeather') {
                  const { result } = toolInvocation;
                  return (
                    <div key={toolCallId}>
                      <Weather {...result} />
                    </div>
                  );
                }
              } else {
                return (
                  <div key={toolCallId}>
                    {toolName === 'displayWeather' ? (
                      <div>Loading weather...</div>
                    ) : null}
                  </div>
                );
              }
            })}
          </div>
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

In this updated code snippet, you:

1. Check if the message has `toolInvocations`.
2. Check if the tool invocation state is 'result'.
3. If it's a result and the tool name is 'displayWeather', render the Weather component.
4. If the tool invocation state is not 'result', show a loading message.

This approach allows you to dynamically render UI components based on the model's responses, creating a more interactive and context-aware chat experience.

## Expanding Your Generative UI Application

You can enhance your chat application by adding more tools and components, creating a richer and more versatile user experience. Here's how you can expand your application:

### Adding More Tools

To add more tools, simply define them in your `ai/tools.ts` file:

```ts
// Add a new stock tool
export const stockTool = createTool({
  description: 'Get price for a stock',
  parameters: z.object({
    symbol: z.string().describe('The stock symbol to get the price for'),
  }),
  execute: async function ({ symbol }) {
    // Simulated API call
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { symbol, price: 100 };
  },
});

// Update the tools object
export const tools = {
  displayWeather: weatherTool,
  getStockPrice: stockTool,
};
```

Now, create a new file called `components/stock.tsx`:

```tsx
type StockProps = {
  price: number;
  symbol: string;
};

export const Stock = ({ price, symbol }: StockProps) => {
  return (
    <div>
      <h2>Stock Information</h2>
      <p>Symbol: {symbol}</p>
      <p>Price: ${price}</p>
    </div>
  );
};
```

Finally, update your `page.tsx` file to include the new Stock component:

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { Weather } from '@/components/weather';
import { Stock } from '@/components/stock';

export default function Page() {
  const { messages, input, setInput, handleSubmit } = useChat();

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role}</div>
          <div>{message.content}</div>

          <div>
            {message.toolInvocations?.map(toolInvocation => {
              const { toolName, toolCallId, state } = toolInvocation;

              if (state === 'result') {
                if (toolName === 'displayWeather') {
                  const { result } = toolInvocation;
                  return (
                    <div key={toolCallId}>
                      <Weather {...result} />
                    </div>
                  );
                } else if (toolName === 'getStockPrice') {
                  const { result } = toolInvocation;
                  return <Stock key={toolCallId} {...result} />;
                }
              } else {
                return (
                  <div key={toolCallId}>
                    {toolName === 'displayWeather' ? (
                      <div>Loading weather...</div>
                    ) : toolName === 'getStockPrice' ? (
                      <div>Loading stock price...</div>
                    ) : (
                      <div>Loading...</div>
                    )}
                  </div>
                );
              }
            })}
          </div>
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={event => {
            setInput(event.target.value);
          }}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

By following this pattern, you can continue to add more tools and components, expanding the capabilities of your Generative UI application.

---
title: Completion
description: Learn how to use the useCompletion hook.
---

# Completion

The `useCompletion` hook allows you to create a user interface to handle text completions in your application. It enables the streaming of text completions from your AI provider, manages the state for chat input, and updates the UI automatically as new messages are received.

In this guide, you will learn how to use the `useCompletion` hook in your application to generate text completions and stream them in real-time to your users.

## Example

```tsx filename='app/page.tsx'
'use client';

import { useCompletion } from '@ai-sdk/react';

export default function Page() {
  const { completion, input, handleInputChange, handleSubmit } = useCompletion({
    api: '/api/completion',
  });

  return (
    <form onSubmit={handleSubmit}>
      <input
        name="prompt"
        value={input}
        onChange={handleInputChange}
        id="input"
      />
      <button type="submit">Submit</button>
      <div>{completion}</div>
    </form>
  );
}
```

```ts filename='app/api/completion/route.ts'
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { prompt }: { prompt: string } = await req.json();

  const result = streamText({
    model: openai('gpt-3.5-turbo'),
    prompt,
  });

  return result.toDataStreamResponse();
}
```

In the `Page` component, the `useCompletion` hook will request to your AI provider endpoint whenever the user submits a message. The completion is then streamed back in real-time and displayed in the UI.

This enables a seamless text completion experience where the user can see the AI response as soon as it is available, without having to wait for the entire response to be received.

## Customized UI

`useCompletion` also provides ways to manage the prompt via code, show loading and error states, and update messages without being triggered by user interactions.

### Loading and error states

To show a loading spinner while the chatbot is processing the user's message, you can use the `isLoading` state returned by the `useCompletion` hook:

```tsx
const { isLoading, ... } = useCompletion()

return(
  <>
    {isLoading ? <Spinner /> : null}
  </>
)
```

Similarly, the `error` state reflects the error object thrown during the fetch request. It can be used to display an error message, or show a toast notification:

```tsx
const { error, ... } = useCompletion()

useEffect(() => {
  if (error) {
    toast.error(error.message)
  }
}, [error])

// Or display the error message in the UI:
return (
  <>
    {error ? <div>{error.message}</div> : null}
  </>
)
```

### Controlled input

In the initial example, we have `handleSubmit` and `handleInputChange` callbacks that manage the input changes and form submissions. These are handy for common use cases, but you can also use uncontrolled APIs for more advanced scenarios such as form validation or customized components.

The following example demonstrates how to use more granular APIs like `setInput` with your custom input and submit button components:

```tsx
const { input, setInput } = useCompletion();

return (
  <>
    <MyCustomInput value={input} onChange={value => setInput(value)} />
  </>
);
```

### Cancelation

It's also a common use case to abort the response message while it's still streaming back from the AI provider. You can do this by calling the `stop` function returned by the `useCompletion` hook.

```tsx
const { stop, isLoading, ... } = useCompletion()

return (
  <>
    <button onClick={stop} disabled={!isLoading}>Stop</button>
  </>
)
```

When the user clicks the "Stop" button, the fetch request will be aborted. This avoids consuming unnecessary resources and improves the UX of your application.

### Throttling UI Updates

<Note>This feature is currently only available for React.</Note>

By default, the `useCompletion` hook will trigger a render every time a new chunk is received.
You can throttle the UI updates with the `experimental_throttle` option.

```tsx filename="page.tsx" highlight="2-3"
const { completion, ... } = useCompletion({
  // Throttle the completion and data updates to 50ms:
  experimental_throttle: 50
})
```

## Event Callbacks

`useCompletion` also provides optional event callbacks that you can use to handle different stages of the chatbot lifecycle. These callbacks can be used to trigger additional actions, such as logging, analytics, or custom UI updates.

```tsx
const { ... } = useCompletion({
  onResponse: (response: Response) => {
    console.log('Received response from server:', response)
  },
  onFinish: (message: Message) => {
    console.log('Finished streaming message:', message)
  },
  onError: (error: Error) => {
    console.error('An error occurred:', error)
  },
})
```

It's worth noting that you can abort the processing by throwing an error in the `onResponse` callback. This will trigger the `onError` callback and stop the message from being appended to the chat UI. This can be useful for handling unexpected responses from the AI provider.

## Configure Request Options

By default, the `useCompletion` hook sends a HTTP POST request to the `/api/completion` endpoint with the prompt as part of the request body. You can customize the request by passing additional options to the `useCompletion` hook:

```tsx
const { messages, input, handleInputChange, handleSubmit } = useCompletion({
  api: '/api/custom-completion',
  headers: {
    Authorization: 'your_token',
  },
  body: {
    user_id: '123',
  },
  credentials: 'same-origin',
});
```

In this example, the `useCompletion` hook sends a POST request to the `/api/completion` endpoint with the specified headers, additional body fields, and credentials for that fetch request. On your server side, you can handle the request with these additional information.

---
title: Object Generation
description: Learn how to use the useObject hook.
---

# Object Generation

<Note>`useObject` is an experimental feature and only available in React.</Note>

The [`useObject`](/docs/reference/ai-sdk-ui/use-object) hook allows you to create interfaces that represent a structured JSON object that is being streamed.

In this guide, you will learn how to use the `useObject` hook in your application to generate UIs for structured data on the fly.

## Example

The example shows a small notifications demo app that generates fake notifications in real-time.

### Schema

It is helpful to set up the schema in a separate file that is imported on both the client and server.

```ts filename='app/api/notifications/schema.ts'
import { z } from 'zod';

// define a schema for the notifications
export const notificationSchema = z.object({
  notifications: z.array(
    z.object({
      name: z.string().describe('Name of a fictional person.'),
      message: z.string().describe('Message. Do not use emojis or links.'),
    }),
  ),
});
```

### Client

The client uses [`useObject`](/docs/reference/ai-sdk-ui/use-object) to stream the object generation process.

The results are partial and are displayed as they are received.
Please note the code for handling `undefined` values in the JSX.

```tsx filename='app/page.tsx'
'use client';

import { experimental_useObject as useObject } from '@ai-sdk/react';
import { notificationSchema } from './api/notifications/schema';

export default function Page() {
  const { object, submit } = useObject({
    api: '/api/notifications',
    schema: notificationSchema,
  });

  return (
    <>
      <button onClick={() => submit('Messages during finals week.')}>
        Generate notifications
      </button>

      {object?.notifications?.map((notification, index) => (
        <div key={index}>
          <p>{notification?.name}</p>
          <p>{notification?.message}</p>
        </div>
      ))}
    </>
  );
}
```

### Server

On the server, we use [`streamObject`](/docs/reference/ai-sdk-core/stream-object) to stream the object generation process.

```typescript filename='app/api/notifications/route.ts'
import { openai } from '@ai-sdk/openai';
import { streamObject } from 'ai';
import { notificationSchema } from './schema';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const context = await req.json();

  const result = streamObject({
    model: openai('gpt-4-turbo'),
    schema: notificationSchema,
    prompt:
      `Generate 3 notifications for a messages app in this context:` + context,
  });

  return result.toTextStreamResponse();
}
```

## Customized UI

`useObject` also provides ways to show loading and error states:

### Loading State

The `isLoading` state returned by the `useObject` hook can be used for several
purposes:

- To show a loading spinner while the object is generated.
- To disable the submit button.

```tsx filename='app/page.tsx' highlight="6,13-20,24"
'use client';

import { useObject } from '@ai-sdk/react';

export default function Page() {
  const { isLoading, object, submit } = useObject({
    api: '/api/notifications',
    schema: notificationSchema,
  });

  return (
    <>
      {isLoading && <Spinner />}

      <button
        onClick={() => submit('Messages during finals week.')}
        disabled={isLoading}
      >
        Generate notifications
      </button>

      {object?.notifications?.map((notification, index) => (
        <div key={index}>
          <p>{notification?.name}</p>
          <p>{notification?.message}</p>
        </div>
      ))}
    </>
  );
}
```

### Stop Handler

The `stop` function can be used to stop the object generation process. This can be useful if the user wants to cancel the request or if the server is taking too long to respond.

```tsx filename='app/page.tsx' highlight="6,14-16"
'use client';

import { useObject } from '@ai-sdk/react';

export default function Page() {
  const { isLoading, stop, object, submit } = useObject({
    api: '/api/notifications',
    schema: notificationSchema,
  });

  return (
    <>
      {isLoading && (
        <button type="button" onClick={() => stop()}>
          Stop
        </button>
      )}

      <button onClick={() => submit('Messages during finals week.')}>
        Generate notifications
      </button>

      {object?.notifications?.map((notification, index) => (
        <div key={index}>
          <p>{notification?.name}</p>
          <p>{notification?.message}</p>
        </div>
      ))}
    </>
  );
}
```

### Error State

Similarly, the `error` state reflects the error object thrown during the fetch request.
It can be used to display an error message, or to disable the submit button:

<Note>
  We recommend showing a generic error message to the user, such as "Something
  went wrong." This is a good practice to avoid leaking information from the
  server.
</Note>

```tsx file="app/page.tsx" highlight="6,13"
'use client';

import { useObject } from '@ai-sdk/react';

export default function Page() {
  const { error, object, submit } = useObject({
    api: '/api/notifications',
    schema: notificationSchema,
  });

  return (
    <>
      {error && <div>An error occurred.</div>}

      <button onClick={() => submit('Messages during finals week.')}>
        Generate notifications
      </button>

      {object?.notifications?.map((notification, index) => (
        <div key={index}>
          <p>{notification?.name}</p>
          <p>{notification?.message}</p>
        </div>
      ))}
    </>
  );
}
```

## Event Callbacks

`useObject` provides optional event callbacks that you can use to handle life-cycle events.

- `onFinish`: Called when the object generation is completed.
- `onError`: Called when an error occurs during the fetch request.

These callbacks can be used to trigger additional actions, such as logging, analytics, or custom UI updates.

```tsx filename='app/page.tsx' highlight="10-20"
'use client';

import { experimental_useObject as useObject } from '@ai-sdk/react';
import { notificationSchema } from './api/notifications/schema';

export default function Page() {
  const { object, submit } = useObject({
    api: '/api/notifications',
    schema: notificationSchema,
    onFinish({ object, error }) {
      // typed object, undefined if schema validation fails:
      console.log('Object generation completed:', object);

      // error, undefined if schema validation succeeds:
      console.log('Schema validation error:', error);
    },
    onError(error) {
      // error during fetch request:
      console.error('An error occurred:', error);
    },
  });

  return (
    <div>
      <button onClick={() => submit('Messages during finals week.')}>
        Generate notifications
      </button>

      {object?.notifications?.map((notification, index) => (
        <div key={index}>
          <p>{notification?.name}</p>
          <p>{notification?.message}</p>
        </div>
      ))}
    </div>
  );
}
```

## Configure Request Options

You can configure the API endpoint, optional headers and credentials using the `api`, `headers` and `credentials` settings.

```tsx highlight="2-5"
const { submit, object } = useObject({
  api: '/api/use-object',
  headers: {
    'X-Custom-Header': 'CustomValue',
  },
  credentials: 'include',
  schema: yourSchema,
});
```

---
title: OpenAI Assistants
description: Learn how to use the useAssistant hook.
---

# OpenAI Assistants

The `useAssistant` hook allows you to handle the client state when interacting with an OpenAI compatible assistant API.
This hook is useful when you want to integrate assistant capabilities into your application,
with the UI updated automatically as the assistant is streaming its execution.

The `useAssistant` hook is supported in `@ai-sdk/react`, `ai/svelte`, and `ai/vue`.

## Example

```tsx filename='app/page.tsx'
'use client';

import { Message, useAssistant } from '@ai-sdk/react';

export default function Chat() {
  const { status, messages, input, submitMessage, handleInputChange } =
    useAssistant({ api: '/api/assistant' });

  return (
    <div>
      {messages.map((m: Message) => (
        <div key={m.id}>
          <strong>{`${m.role}: `}</strong>
          {m.role !== 'data' && m.content}
          {m.role === 'data' && (
            <>
              {(m.data as any).description}
              <br />
              <pre className={'bg-gray-200'}>
                {JSON.stringify(m.data, null, 2)}
              </pre>
            </>
          )}
        </div>
      ))}

      {status === 'in_progress' && <div />}

      <form onSubmit={submitMessage}>
        <input
          disabled={status !== 'awaiting_message'}
          value={input}
          placeholder="What is the temperature in the living room?"
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

```tsx filename='app/api/assistant/route.ts'
import { AssistantResponse } from 'ai';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  // Parse the request body
  const input: {
    threadId: string | null;
    message: string;
  } = await req.json();

  // Create a thread if needed
  const threadId = input.threadId ?? (await openai.beta.threads.create({})).id;

  // Add a message to the thread
  const createdMessage = await openai.beta.threads.messages.create(threadId, {
    role: 'user',
    content: input.message,
  });

  return AssistantResponse(
    { threadId, messageId: createdMessage.id },
    async ({ forwardStream, sendDataMessage }) => {
      // Run the assistant on the thread
      const runStream = openai.beta.threads.runs.stream(threadId, {
        assistant_id:
          process.env.ASSISTANT_ID ??
          (() => {
            throw new Error('ASSISTANT_ID is not set');
          })(),
      });

      // forward run status would stream message deltas
      let runResult = await forwardStream(runStream);

      // status can be: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired
      while (
        runResult?.status === 'requires_action' &&
        runResult.required_action?.type === 'submit_tool_outputs'
      ) {
        const tool_outputs =
          runResult.required_action.submit_tool_outputs.tool_calls.map(
            (toolCall: any) => {
              const parameters = JSON.parse(toolCall.function.arguments);

              switch (toolCall.function.name) {
                // configure your tool calls here

                default:
                  throw new Error(
                    `Unknown tool call function: ${toolCall.function.name}`,
                  );
              }
            },
          );

        runResult = await forwardStream(
          openai.beta.threads.runs.submitToolOutputsStream(
            threadId,
            runResult.id,
            { tool_outputs },
          ),
        );
      }
    },
  );
}
```

## Customized UI

`useAssistant` also provides ways to manage the chat message and input states via code and show loading and error states.

### Loading and error states

To show a loading spinner while the assistant is running the thread, you can use the `status` state returned by the `useAssistant` hook:

```tsx
const { status, ... } = useAssistant()

return(
  <>
    {status === "in_progress" ? <Spinner /> : null}
  </>
)
```

Similarly, the `error` state reflects the error object thrown during the fetch request. It can be used to display an error message, or show a toast notification:

```tsx
const { error, ... } = useAssistant()

useEffect(() => {
  if (error) {
    toast.error(error.message)
  }
}, [error])

// Or display the error message in the UI:
return (
  <>
    {error ? <div>{error.message}</div> : null}
  </>
)
```

### Controlled input

In the initial example, we have `handleSubmit` and `handleInputChange` callbacks that manage the input changes and form submissions. These are handy for common use cases, but you can also use uncontrolled APIs for more advanced scenarios such as form validation or customized components.

The following example demonstrates how to use more granular APIs like `append` with your custom input and submit button components:

```tsx
const { append } = useAssistant();

return (
  <>
    <MySubmitButton
      onClick={() => {
        // Send a new message to the AI provider
        append({
          role: 'user',
          content: input,
        });
      }}
    />
  </>
);
```

## Configure Request Options

By default, the `useAssistant` hook sends a HTTP POST request to the `/api/assistant` endpoint with the prompt as part of the request body. You can customize the request by passing additional options to the `useAssistant` hook:

```tsx
const { messages, input, handleInputChange, handleSubmit } = useAssistant({
  api: '/api/custom-completion',
  headers: {
    Authorization: 'your_token',
  },
  body: {
    user_id: '123',
  },
  credentials: 'same-origin',
});
```

In this example, the `useAssistant` hook sends a POST request to the `/api/custom-completion` endpoint with the specified headers, additional body fields, and credentials for that fetch request. On your server side, you can handle the request with these additional information.

---
title: Streaming Custom Data
description: Learn how to stream custom data to the client.
---

# Streaming Custom Data

It is often useful to send additional data alongside the model's response.
For example, you may want to send status information, the message ids after storing them,
or references to content that the language model is referring to.

The AI SDK provides several helpers that allows you to stream additional data to the client
and attach it either to the `Message` or to the `data` object of the `useChat` hook:

- `createDataStream`: creates a data stream
- `createDataStreamResponse`: creates a response object that streams data
- `pipeDataStreamToResponse`: pipes a data stream to a server response object

The data is streamed as part of the response stream.

## Sending Custom Data from the Server

In your server-side route handler, you can use `createDataStreamResponse` and `pipeDataStreamToResponse` in combination with `streamText`.
You need to:

1. Call `createDataStreamResponse` or `pipeDataStreamToResponse` to get a callback function with a `DataStreamWriter`.
2. Write to the `DataStreamWriter` to stream additional data.
3. Merge the `streamText` result into the `DataStreamWriter`.
4. Return the response from `createDataStreamResponse` (if that method is used)

Here is an example:

```tsx filename="route.ts" highlight="7-10,16,19-23,25-26,30"
import { openai } from '@ai-sdk/openai';
import { generateId, createDataStreamResponse, streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  // immediately start streaming (solves RAG issues with status, etc.)
  return createDataStreamResponse({
    execute: dataStream => {
      dataStream.writeData('initialized call');

      const result = streamText({
        model: openai('gpt-4o'),
        messages,
        onChunk() {
          dataStream.writeMessageAnnotation({ chunk: '123' });
        },
        onFinish() {
          // message annotation:
          dataStream.writeMessageAnnotation({
            id: generateId(), // e.g. id from saved DB record
            other: 'information',
          });

          // call annotation:
          dataStream.writeData('call completed');
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });
}
```

<Note>
  You can also send stream data from custom backends, e.g. Python / FastAPI,
  using the [Data Stream
  Protocol](/docs/ai-sdk-ui/stream-protocol#data-stream-protocol).
</Note>

## Sending Custom Sources

You can send custom sources to the client using the `writeSource` method on the `DataStreamWriter`:

```tsx filename="route.ts" highlight="9-15"
import { openai } from '@ai-sdk/openai';
import { createDataStreamResponse, streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  return createDataStreamResponse({
    execute: dataStream => {
      // write a custom url source to the stream:
      dataStream.writeSource({
        sourceType: 'url',
        id: 'source-1',
        url: 'https://example.com',
        title: 'Example Source',
      });

      const result = streamText({
        model: openai('gpt-4o'),
        messages,
      });

      result.mergeIntoDataStream(dataStream);
    },
  });
}
```

## Processing Custom Data in `useChat`

The `useChat` hook automatically processes the streamed data and makes it available to you.

### Accessing Data

On the client, you can destructure `data` from the `useChat` hook which stores all `StreamData`
as a `JSONValue[]`.

```tsx filename="page.tsx"
import { useChat } from '@ai-sdk/react';

const { data } = useChat();
```

### Accessing Message Annotations

Each message from the `useChat` hook has an optional `annotations` property that contains
the message annotations sent from the server.

Since the shape of the annotations depends on what you send from the server,
you have to destructure them in a type-safe way on the client side.

Here we just show the annotations as a JSON string:

```tsx filename="page.tsx" highlight="9"
import { Message, useChat } from '@ai-sdk/react';

const { messages } = useChat();

const result = (
  <>
    {messages?.map((m: Message) => (
      <div key={m.id}>
        {m.annotations && <>{JSON.stringify(m.annotations)}</>}
      </div>
    ))}
  </>
);
```

### Updating and Clearing Data

You can update and clear the `data` object of the `useChat` hook using the `setData` function.

```tsx filename="page.tsx"
const { setData } = useChat();

// clear existing data
setData(undefined);

// set new data
setData([{ test: 'value' }]);

// transform existing data, e.g. adding additional values:
setData(currentData => [...currentData, { test: 'value' }]);
```

#### Example: Clear on Submit

```tsx filename="page.tsx" highlight="18-21"
'use client';

import { Message, useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, data, setData } =
    useChat();

  return (
    <>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}

      {messages?.map((m: Message) => (
        <div key={m.id}>{`${m.role}: ${m.content}`}</div>
      ))}

      <form
        onSubmit={e => {
          setData(undefined); // clear stream data
          handleSubmit(e);
        }}
      >
        <input value={input} onChange={handleInputChange} />
      </form>
    </>
  );
}
```

---
title: Error Handling
description: Learn how to handle errors in the AI SDK UI
---

# Error Handling

### Error Helper Object

Each AI SDK UI hook also returns an [error](/docs/reference/ai-sdk-ui/use-chat#error) object that you can use to render the error in your UI.
You can use the error object to show an error message, disable the submit button, or show a retry button.

<Note>
  We recommend showing a generic error message to the user, such as "Something
  went wrong." This is a good practice to avoid leaking information from the
  server.
</Note>

```tsx file="app/page.tsx" highlight="7,17-24,30"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, error, reload } =
    useChat({});

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      {error && (
        <>
          <div>An error occurred.</div>
          <button type="button" onClick={() => reload()}>
            Retry
          </button>
        </>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          disabled={error != null}
        />
      </form>
    </div>
  );
}
```

#### Alternative: replace last message

Alternatively you can write a custom submit handler that replaces the last message when an error is present.

```tsx file="app/page.tsx" highlight="15-21,33"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const {
    handleInputChange,
    handleSubmit,
    error,
    input,
    messages,
    setMessages,
  } = useChat({});

  function customSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (error != null) {
      setMessages(messages.slice(0, -1)); // remove last message
    }

    handleSubmit(event);
  }

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}: {m.content}
        </div>
      ))}

      {error && <div>An error occurred.</div>}

      <form onSubmit={customSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

### Error Handling Callback

Errors can be processed by passing an [`onError`](/docs/reference/ai-sdk-ui/use-chat#on-error) callback function as an option to the [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion) or [`useAssistant`](/docs/reference/ai-sdk-ui/use-assistant) hooks.
The callback function receives an error object as an argument.

```tsx file="app/page.tsx" highlight="8-11"
import { useChat } from '@ai-sdk/react';

export default function Page() {
  const {
    /* ... */
  } = useChat({
    // handle error:
    onError: error => {
      console.error(error);
    },
  });
}
```

### Injecting Errors for Testing

You might want to create errors for testing.
You can easily do so by throwing an error in your route handler:

```ts file="app/api/chat/route.ts"
export async function POST(req: Request) {
  throw new Error('This is a test error');
}
```

---
title: Smooth streaming japanese text
description: Learn how to stream smooth stream japanese text
---

# Smooth streaming japanese text

You can smooth stream japanese text by using the `smoothStream` function, and the following regex that splits either on words of japanese characters:

```tsx filename="page.tsx"
import { smoothStream } from 'ai';
import { useChat } from '@ai-sdk/react';

const { data } = useChat({
  experimental_transform: smoothStream({
    chunking: /[\u3040-\u309F\u30A0-\u30FF]|\S+\s+/,
  }),
});
```

---
title: Smooth streaming chinese text
description: Learn how to stream smooth stream chinese text
---

# Smooth streaming chinese text

You can smooth stream chinese text by using the `smoothStream` function, and the following regex that splits either on words of chinese characters:

```tsx filename="page.tsx"
import { smoothStream } from 'ai';
import { useChat } from '@ai-sdk/react';

const { data } = useChat({
  experimental_transform: smoothStream({
    chunking: /[\u4E00-\u9FFF]|\S+\s+/,
  }),
});
```

---
title: AI_APICallError
description: Learn how to fix AI_APICallError
---

# AI_APICallError

This error occurs when an API call fails.

## Properties

- `url`: The URL of the API request that failed
- `requestBodyValues`: The request body values sent to the API
- `statusCode`: The HTTP status code returned by the API
- `responseHeaders`: The response headers returned by the API
- `responseBody`: The response body returned by the API
- `isRetryable`: Whether the request can be retried based on the status code
- `data`: Any additional data associated with the error

## Checking for this Error

You can check if an error is an instance of `AI_APICallError` using:

```typescript
import { APICallError } from 'ai';

if (APICallError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_DownloadError
description: Learn how to fix AI_DownloadError
---

# AI_DownloadError

This error occurs when a download fails.

## Properties

- `url`: The URL that failed to download
- `statusCode`: The HTTP status code returned by the server
- `statusText`: The HTTP status text returned by the server
- `message`: The error message containing details about the download failure

## Checking for this Error

You can check if an error is an instance of `AI_DownloadError` using:

```typescript
import { DownloadError } from 'ai';

if (DownloadError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_EmptyResponseBodyError
description: Learn how to fix AI_EmptyResponseBodyError
---

# AI_EmptyResponseBodyError

This error occurs when the server returns an empty response body.

## Properties

- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_EmptyResponseBodyError` using:

```typescript
import { EmptyResponseBodyError } from 'ai';

if (EmptyResponseBodyError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidArgumentError
description: Learn how to fix AI_InvalidArgumentError
---

# AI_InvalidArgumentError

This error occurs when an invalid argument was provided.

## Properties

- `parameter`: The name of the parameter that is invalid
- `value`: The invalid value
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_InvalidArgumentError` using:

```typescript
import { InvalidArgumentError } from 'ai';

if (InvalidArgumentError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidDataContentError
description: How to fix AI_InvalidDataContentError
---

# AI_InvalidDataContentError

This error occurs when the data content provided in a multi-modal message part is invalid. Check out the [ prompt examples for multi-modal messages ](/docs/foundations/prompts#message-prompts).

## Properties

- `content`: The invalid content value
- `message`: The error message describing the expected and received content types

## Checking for this Error

You can check if an error is an instance of `AI_InvalidDataContentError` using:

```typescript
import { InvalidDataContentError } from 'ai';

if (InvalidDataContentError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidDataContent
description: Learn how to fix AI_InvalidDataContent
---

# AI_InvalidDataContent

This error occurs when invalid data content is provided.

## Properties

- `content`: The invalid content value
- `message`: The error message
- `cause`: The cause of the error

## Checking for this Error

You can check if an error is an instance of `AI_InvalidDataContent` using:

```typescript
import { InvalidDataContent } from 'ai';

if (InvalidDataContent.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidMessageRoleError
description: Learn how to fix AI_InvalidMessageRoleError
---

# AI_InvalidMessageRoleError

This error occurs when an invalid message role is provided.

## Properties

- `role`: The invalid role value
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_InvalidMessageRoleError` using:

```typescript
import { InvalidMessageRoleError } from 'ai';

if (InvalidMessageRoleError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidPromptError
description: Learn how to fix AI_InvalidPromptError
---

# AI_InvalidPromptError

This error occurs when the prompt provided is invalid.

## Properties

- `prompt`: The invalid prompt value
- `message`: The error message
- `cause`: The cause of the error

## Checking for this Error

You can check if an error is an instance of `AI_InvalidPromptError` using:

```typescript
import { InvalidPromptError } from 'ai';

if (InvalidPromptError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidResponseDataError
description: Learn how to fix AI_InvalidResponseDataError
---

# AI_InvalidResponseDataError

This error occurs when the server returns a response with invalid data content.

## Properties

- `data`: The invalid response data value
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_InvalidResponseDataError` using:

```typescript
import { InvalidResponseDataError } from 'ai';

if (InvalidResponseDataError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidToolArgumentsError
description: Learn how to fix AI_InvalidToolArgumentsError
---

# AI_InvalidToolArgumentsError

This error occurs when invalid tool argument was provided.

## Properties

- `toolName`: The name of the tool with invalid arguments
- `toolArgs`: The invalid tool arguments
- `message`: The error message
- `cause`: The cause of the error

## Checking for this Error

You can check if an error is an instance of `AI_InvalidToolArgumentsError` using:

```typescript
import { InvalidToolArgumentsError } from 'ai';

if (InvalidToolArgumentsError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_JSONParseError
description: Learn how to fix AI_JSONParseError
---

# AI_JSONParseError

This error occurs when JSON fails to parse.

## Properties

- `text`: The text value that could not be parsed
- `message`: The error message including parse error details

## Checking for this Error

You can check if an error is an instance of `AI_JSONParseError` using:

```typescript
import { JSONParseError } from 'ai';

if (JSONParseError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_LoadAPIKeyError
description: Learn how to fix AI_LoadAPIKeyError
---

# AI_LoadAPIKeyError

This error occurs when API key is not loaded successfully.

## Properties

- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_LoadAPIKeyError` using:

```typescript
import { LoadAPIKeyError } from 'ai';

if (LoadAPIKeyError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_LoadSettingError
description: Learn how to fix AI_LoadSettingError
---

# AI_LoadSettingError

This error occurs when a setting is not loaded successfully.

## Properties

- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_LoadSettingError` using:

```typescript
import { LoadSettingError } from 'ai';

if (LoadSettingError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_MessageConversionError
description: Learn how to fix AI_MessageConversionError
---

# AI_MessageConversionError

This error occurs when message conversion fails.

## Properties

- `originalMessage`: The original message that failed conversion
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_MessageConversionError` using:

```typescript
import { MessageConversionError } from 'ai';

if (MessageConversionError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoAudioGeneratedError
description: Learn how to fix AI_NoAudioGeneratedError
---

# AI_NoAudioGeneratedError

This error occurs when no audio could be generated from the input.

## Properties

- `responses`: Array of responses
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoAudioGeneratedError` using:

```typescript
import { NoAudioGeneratedError } from 'ai';

if (NoAudioGeneratedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoContentGeneratedError
description: Learn how to fix AI_NoContentGeneratedError
---

# AI_NoContentGeneratedError

This error occurs when the AI provider fails to generate content.

## Properties

- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoContentGeneratedError` using:

```typescript
import { NoContentGeneratedError } from 'ai';

if (NoContentGeneratedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoImageGeneratedError
description: Learn how to fix AI_NoImageGeneratedError
---

# AI_NoImageGeneratedError

This error occurs when the AI provider fails to generate an image.
It can arise due to the following reasons:

- The model failed to generate a response.
- The model generated an invalid response.

## Properties

- `message`: The error message.
- `responses`: Metadata about the image model responses, including timestamp, model, and headers.
- `cause`: The cause of the error. You can use this for more detailed error handling.

## Checking for this Error

You can check if an error is an instance of `AI_NoImageGeneratedError` using:

```typescript
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

---
title: AI_NoObjectGeneratedError
description: Learn how to fix AI_NoObjectGeneratedError
---

# AI_NoObjectGeneratedError

This error occurs when the AI provider fails to generate a parsable object that conforms to the schema.
It can arise due to the following reasons:

- The model failed to generate a response.
- The model generated a response that could not be parsed.
- The model generated a response that could not be validated against the schema.

## Properties

- `message`: The error message.
- `text`: The text that was generated by the model. This can be the raw text or the tool call text, depending on the object generation mode.
- `response`: Metadata about the language model response, including response id, timestamp, and model.
- `usage`: Request token usage.
- `finishReason`: Request finish reason. For example 'length' if model generated maximum number of tokens, this could result in a JSON parsing error.
- `cause`: The cause of the error (e.g. a JSON parsing error). You can use this for more detailed error handling.

## Checking for this Error

You can check if an error is an instance of `AI_NoObjectGeneratedError` using:

```typescript
import { generateObject, NoObjectGeneratedError } from 'ai';

try {
  await generateObject({ model, schema, prompt });
} catch (error) {
  if (NoObjectGeneratedError.isInstance(error)) {
    console.log('NoObjectGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Text:', error.text);
    console.log('Response:', error.response);
    console.log('Usage:', error.usage);
    console.log('Finish Reason:', error.finishReason);
  }
}
```

---
title: AI_NoOutputSpecifiedError
description: Learn how to fix AI_NoOutputSpecifiedError
---

# AI_NoOutputSpecifiedError

This error occurs when no output format was specified for the AI response, and output-related methods are called.

## Properties

- `message`: The error message (defaults to 'No output specified.')

## Checking for this Error

You can check if an error is an instance of `AI_NoOutputSpecifiedError` using:

```typescript
import { NoOutputSpecifiedError } from 'ai';

if (NoOutputSpecifiedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoSuchModelError
description: Learn how to fix AI_NoSuchModelError
---

# AI_NoSuchModelError

This error occurs when a model ID is not found.

## Properties

- `modelId`: The ID of the model that was not found
- `modelType`: The type of model
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoSuchModelError` using:

```typescript
import { NoSuchModelError } from 'ai';

if (NoSuchModelError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoSuchProviderError
description: Learn how to fix AI_NoSuchProviderError
---

# AI_NoSuchProviderError

This error occurs when a provider ID is not found.

## Properties

- `providerId`: The ID of the provider that was not found
- `availableProviders`: Array of available provider IDs
- `modelId`: The ID of the model
- `modelType`: The type of model
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoSuchProviderError` using:

```typescript
import { NoSuchProviderError } from 'ai';

if (NoSuchProviderError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoSuchToolError
description: Learn how to fix AI_NoSuchToolError
---

# AI_NoSuchToolError

This error occurs when a model tries to call an unavailable tool.

## Properties

- `toolName`: The name of the tool that was not found
- `availableTools`: Array of available tool names
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoSuchToolError` using:

```typescript
import { NoSuchToolError } from 'ai';

if (NoSuchToolError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoTranscriptGeneratedError
description: Learn how to fix AI_NoTranscriptGeneratedError
---

# AI_NoTranscriptGeneratedError

This error occurs when no transcript could be generated from the input.

## Properties

- `responses`: Array of responses
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoTranscriptGeneratedError` using:

```typescript
import { NoTranscriptGeneratedError } from 'ai';

if (NoTranscriptGeneratedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_RetryError
description: Learn how to fix AI_RetryError
---

# AI_RetryError

This error occurs when a retry operation fails.

## Properties

- `reason`: The reason for the retry failure
- `lastError`: The most recent error that occurred during retries
- `errors`: Array of all errors that occurred during retry attempts
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_RetryError` using:

```typescript
import { RetryError } from 'ai';

if (RetryError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_TooManyEmbeddingValuesForCallError
description: Learn how to fix AI_TooManyEmbeddingValuesForCallError
---

# AI_TooManyEmbeddingValuesForCallError

This error occurs when too many values are provided in a single embedding call.

## Properties

- `provider`: The AI provider name
- `modelId`: The ID of the embedding model
- `maxEmbeddingsPerCall`: The maximum number of embeddings allowed per call
- `values`: The array of values that was provided

## Checking for this Error

You can check if an error is an instance of `AI_TooManyEmbeddingValuesForCallError` using:

```typescript
import { TooManyEmbeddingValuesForCallError } from 'ai';

if (TooManyEmbeddingValuesForCallError.isInstance(error)) {
  // Handle the error
}
```

---
title: ToolCallRepairError
description: Learn how to fix AI SDK ToolCallRepairError
---

# ToolCallRepairError

This error occurs when there is a failure while attempting to repair an invalid tool call.
This typically happens when the AI attempts to fix either
a `NoSuchToolError` or `InvalidToolArgumentsError`.

## Properties

- `originalError`: The original error that triggered the repair attempt (either `NoSuchToolError` or `InvalidToolArgumentsError`)
- `message`: The error message
- `cause`: The underlying error that caused the repair to fail

## Checking for this Error

You can check if an error is an instance of `ToolCallRepairError` using:

```typescript
import { ToolCallRepairError } from 'ai';

if (ToolCallRepairError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_ToolExecutionError
description: Learn how to fix AI_ToolExecutionError
---

# AI_ToolExecutionError

This error occurs when there is a failure during the execution of a tool.

## Properties

- `toolName`: The name of the tool that failed
- `toolArgs`: The arguments passed to the tool
- `toolCallId`: The ID of the tool call that failed
- `message`: The error message
- `cause`: The underlying error that caused the tool execution to fail

## Checking for this Error

You can check if an error is an instance of `AI_ToolExecutionError` using:

```typescript
import { ToolExecutionError } from 'ai';

if (ToolExecutionError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_TypeValidationError
description: Learn how to fix AI_TypeValidationError
---

# AI_TypeValidationError

This error occurs when type validation fails.

## Properties

- `value`: The value that failed validation
- `message`: The error message including validation details

## Checking for this Error

You can check if an error is an instance of `AI_TypeValidationError` using:

```typescript
import { TypeValidationError } from 'ai';

if (TypeValidationError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_UnsupportedFunctionalityError
description: Learn how to fix AI_UnsupportedFunctionalityError
---

# AI_UnsupportedFunctionalityError

This error occurs when functionality is not unsupported.

## Properties

- `functionality`: The name of the unsupported functionality
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_UnsupportedFunctionalityError` using:

```typescript
import { UnsupportedFunctionalityError } from 'ai';

if (UnsupportedFunctionalityError.isInstance(error)) {
  // Handle the error
}
```

---
title: xAI Grok
description: Learn how to use xAI Grok.
---

# xAI Grok Provider

The [xAI Grok](https://x.ai) provider contains language model support for the [xAI API](https://x.ai/api).

## Setup

The xAI Grok provider is available via the `@ai-sdk/xai` module. You can
install it with

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/xai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/xai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/xai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `xai` from `@ai-sdk/xai`:

```ts
import { xai } from '@ai-sdk/xai';
```

If you need a customized setup, you can import `createXai` from `@ai-sdk/xai`
and create a provider instance with your settings:

```ts
import { createXai } from '@ai-sdk/xai';

const xai = createXai({
  apiKey: 'your-api-key',
});
```

You can use the following optional settings to customize the xAI provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.x.ai/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `XAI_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create [xAI models](https://console.x.ai) using a provider instance. The
first argument is the model id, e.g. `grok-beta`.

```ts
const model = xai('grok-3');
```

### Example

You can use xAI language models to generate text with the `generateText` function:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: xai('grok-3'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

xAI language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions
(see [AI SDK Core](/docs/ai-sdk-core)).

### Chat Models

xAI chat models also support some model specific settings that are not part of
the [standard call settings](/docs/ai-sdk-core/settings). You can pass them as
an options argument:

```ts
const model = xai('grok-3', {
  user: 'test-user', // optional unique user identifier
});
```

The following optional settings are available for xAI chat models:

- **user** _string_

  A unique identifier representing your end-user, which can help xAI to
  monitor and detect abuse.

xAI chat models also support some model specific provider options. You can pass them in `providerOptions` argument:

```ts
const model = xai('grok-3');

await generateText({
  model,
  providerOptions: {
    xai: {
      reasoningEffort: 'high',
    },
  },
});
```

The following optional provider options are available for xAI chat models:

- **reasoningEffort** _'low' | 'medium' | 'high'_

  Reasoning effort for reasoning models. Defaults to `medium`. If you use
  `providerOptions` to set the `reasoningEffort` option, this
  model setting will be ignored.

## Model Capabilities

| Model                | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| -------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `grok-3`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-fast`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-mini`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-mini-fast`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-2-1212`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-2-vision-1212` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-beta`          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-vision-beta`   | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. Please see the [xAI
  docs](https://docs.x.ai/docs#models) for a full list of available models. The
  table above lists popular models. You can also pass any available provider
  model ID as a string if needed.
</Note>

## Image Models

You can create xAI image models using the `.imageModel()` factory method. For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

```ts
import { xai } from '@ai-sdk/xai';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: xai.image('grok-2-image'),
  prompt: 'A futuristic cityscape at sunset',
});
```

<Note>
  The xAI image model does not currently support the `aspectRatio` or `size`
  parameters. Image size defaults to 1024x768.
</Note>

### Model-specific options

You can customize the image generation behavior with model-specific settings:

```ts
import { xai } from '@ai-sdk/xai';
import { experimental_generateImage as generateImage } from 'ai';

const { images } = await generateImage({
  model: xai.image('grok-2-image', {
    maxImagesPerCall: 5, // Default is 10
  }),
  prompt: 'A futuristic cityscape at sunset',
  n: 2, // Generate 2 images
});
```

### Model Capabilities

| Model          | Sizes              | Notes                                                                                                                                                                                                    |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grok-2-image` | 1024x768 (default) | xAI's text-to-image generation model, designed to create high-quality images from text prompts. It's trained on a diverse dataset and can generate images across various styles, subjects, and settings. |

---
title: Vercel
description: Learn how to use Vercel's v0 models with the AI SDK.
---

# Vercel Provider

The [Vercel](https://vercel.com) provider gives you access to the [v0 API](https://vercel.com/docs/v0/api), designed for building modern web applications. The `v0-1.0-md` model supports text and image inputs and provides fast streaming responses.

You can create your Vercel API key at [v0.dev](https://v0.dev/chat/settings/keys).

<Note>
  The v0 API is currently in beta and requires a Premium or Team plan with
  usage-based billing enabled. For details, visit the [pricing
  page](https://v0.dev/pricing). To request a higher limit, contact Vercel at
  support@v0.dev.
</Note>

## Features

- **Framework aware completions**: Evaluated on modern stacks like Next.js and Vercel
- **Auto-fix**: Identifies and corrects common coding issues during generation
- **Quick edit**: Streams inline edits as they're available
- **OpenAI compatible**: Can be used with any tool or SDK that supports OpenAI's API format
- **Multimodal**: Supports both text and image inputs

## Setup

The Vercel provider is available via the `@ai-sdk/vercel` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/vercel" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/vercel" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/vercel" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `vercel` from `@ai-sdk/vercel`:

```ts
import { vercel } from '@ai-sdk/vercel';
```

If you need a customized setup, you can import `createVercel` from `@ai-sdk/vercel` and create a provider instance with your settings:

```ts
import { createVercel } from '@ai-sdk/vercel';

const vercel = createVercel({
  apiKey: process.env.VERCEL_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Vercel provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls. The default prefix is `https://api.v0.dev/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `VERCEL_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create language models using a provider instance. The first argument is the model ID, for example:

```ts
import { vercel } from '@ai-sdk/vercel';
import { generateText } from 'ai';

const { text } = await generateText({
  model: vercel('v0-1.0-md'),
  prompt: 'Create a Next.js AI chatbot',
});
```

Vercel language models can also be used in the `streamText` function (see [AI SDK Core](/docs/ai-sdk-core)).

## Example with AI SDK

```ts
import { generateText } from 'ai';
import { createVercel } from '@ai-sdk/vercel';

const vercel = createVercel({
  baseURL: 'https://api.v0.dev/v1',
  apiKey: process.env.VERCEL_API_KEY,
});

const { text } = await generateText({
  model: vercel('v0-1.0-md'),
  prompt: 'Create a Next.js AI chatbot with authentication',
});
```

## Models

### v0-1.0-md

The `v0-1.0-md` model is the default model served by the v0 API.

Capabilities:

- Supports text and image inputs (multimodal)
- Supports function/tool calls
- Streaming responses with low latency
- Optimized for frontend and full-stack web development

## Model Capabilities

| Model       | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `v0-1.0-md` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: OpenAI
description: Learn how to use the OpenAI provider for the AI SDK.
---

# OpenAI Provider

The [OpenAI](https://openai.com/) provider contains language model support for the OpenAI responses, chat, and completion APIs, as well as embedding model support for the OpenAI embeddings API.

## Setup

The OpenAI provider is available in the `@ai-sdk/openai` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `openai` from `@ai-sdk/openai`:

```ts
import { openai } from '@ai-sdk/openai';
```

If you need a customized setup, you can import `createOpenAI` from `@ai-sdk/openai` and create a provider instance with your settings:

```ts
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  // custom settings, e.g.
  compatibility: 'strict', // strict mode, enable when using the OpenAI API
});
```

You can use the following optional settings to customize the OpenAI provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.openai.com/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `OPENAI_API_KEY` environment variable.

- **name** _string_

  The provider name. You can set this when using OpenAI compatible providers
  to change the model provider property. Defaults to `openai`.

- **organization** _string_

  OpenAI Organization.

- **project** _string_

  OpenAI project.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **compatibility** _"strict" | "compatible"_

  OpenAI compatibility mode. Should be set to `strict` when using the OpenAI API,
  and `compatible` when using 3rd party providers. In `compatible` mode, newer
  information such as `streamOptions` are not being sent, resulting in `NaN`
  token usage. Defaults to 'compatible'.

## Language Models

The OpenAI provider instance is a function that you can invoke to create a language model:

```ts
const model = openai('gpt-4-turbo');
```

It automatically selects the correct API based on the model id.
You can also pass additional settings in the second argument:

```ts
const model = openai('gpt-4-turbo', {
  // additional settings
});
```

The available options depend on the API that's automatically chosen for the model (see below).
If you want to explicitly select a specific model API, you can use `.chat` or `.completion`.

### Example

You can use OpenAI language models to generate text with the `generateText` function:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: openai('gpt-4-turbo'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

OpenAI language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions
(see [AI SDK Core](/docs/ai-sdk-core)).

### Chat Models

You can create models that call the [OpenAI chat API](https://platform.openai.com/docs/api-reference/chat) using the `.chat()` factory method.
The first argument is the model id, e.g. `gpt-4`.
The OpenAI chat models support tool calls and some have multi-modal capabilities.

```ts
const model = openai.chat('gpt-3.5-turbo');
```

OpenAI chat models support also some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
const model = openai.chat('gpt-3.5-turbo', {
  logitBias: {
    // optional likelihood for specific tokens
    '50256': -100,
  },
  user: 'test-user', // optional unique user identifier
});
```

The following optional settings are available for OpenAI chat models:

- **logitBias** _Record&lt;number, number&gt;_

  Modifies the likelihood of specified tokens appearing in the completion.

  Accepts a JSON object that maps tokens (specified by their token ID in
  the GPT tokenizer) to an associated bias value from -100 to 100. You
  can use this tokenizer tool to convert text to token IDs. Mathematically,
  the bias is added to the logits generated by the model prior to sampling.
  The exact effect will vary per model, but values between -1 and 1 should
  decrease or increase likelihood of selection; values like -100 or 100
  should result in a ban or exclusive selection of the relevant token.

  As an example, you can pass `{"50256": -100}` to prevent the token from being generated.

- **logprobs** _boolean | number_

  Return the log probabilities of the tokens. Including logprobs will increase
  the response size and can slow down response times. However, it can
  be useful to better understand how the model is behaving.

  Setting to true will return the log probabilities of the tokens that
  were generated.

  Setting to a number will return the log probabilities of the top n
  tokens that were generated.

- **parallelToolCalls** _boolean_

  Whether to enable parallel function calling during tool use. Defaults to `true`.

- **useLegacyFunctionCalls** _boolean_

  Whether to use legacy function calling. Defaults to false.

  Required by some open source inference engines which do not support the `tools` API. May also
  provide a workaround for `parallelToolCalls` resulting in the provider buffering tool calls,
  which causes `streamObject` to be non-streaming.

  Prefer setting `parallelToolCalls: false` over this option.

- **structuredOutputs** _boolean_

  Whether to use [structured outputs](#structured-outputs).
  Defaults to `false` for normal models, and `true` for reasoning models.

  When enabled, tool calls and object generation will be strict and follow the provided schema.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. [Learn more](https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids).

- **downloadImages** _boolean_

  Automatically download images and pass the image as data to the model.
  OpenAI supports image URLs for public models, so this is only needed for
  private models or when the images are not publicly accessible.
  Defaults to `false`.

- **simulateStreaming** _boolean_

  Simulates streaming by using a normal generate call and returning it as a stream.
  Enable this if the model that you are using does not support streaming.
  Defaults to `false`.

- **reasoningEffort** _'low' | 'medium' | 'high'_

  Reasoning effort for reasoning models. Defaults to `medium`. If you use
  `providerOptions` to set the `reasoningEffort` option, this
  model setting will be ignored.

#### Reasoning

OpenAI has introduced the `o1`,`o3`, and `o4` series of [reasoning models](https://platform.openai.com/docs/guides/reasoning).
Currently, `o4-mini`, `o3`, `o3-mini`, `o1`, `o1-mini`, and `o1-preview` are available.

Reasoning models currently only generate text, have several limitations, and are only supported using `generateText` and `streamText`.

They support additional settings and response metadata:

- You can use `providerOptions` to set

  - the `reasoningEffort` option (or alternatively the `reasoningEffort` model setting), which determines the amount of reasoning the model performs.

- You can use response `providerMetadata` to access the number of reasoning tokens that the model generated.

```ts highlight="4,7-11,17"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai('o3-mini'),
  prompt: 'Invent a new holiday and describe its traditions.',
  providerOptions: {
    openai: {
      reasoningEffort: 'low',
    },
  },
});

console.log(text);
console.log('Usage:', {
  ...usage,
  reasoningTokens: providerMetadata?.openai?.reasoningTokens,
});
```

<Note>
  System messages are automatically converted to OpenAI developer messages for
  reasoning models when supported. For models that do not support developer
  messages, such as `o1-preview`, system messages are removed and a warning is
  added.
</Note>

<Note>
  Reasoning models like `o1-mini` and `o1-preview` require additional runtime
  inference to complete their reasoning phase before generating a response. This
  introduces longer latency compared to other models, with `o1-preview`
  exhibiting significantly more inference time than `o1-mini`.
</Note>

<Note>
  `maxTokens` is automatically mapped to `max_completion_tokens` for reasoning
  models.
</Note>

#### Structured Outputs

You can enable [OpenAI structured outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) by setting the `structuredOutputs` option to `true`.
Structured outputs are a form of grammar-guided generation.
The JSON schema is used as a grammar and the outputs will always conform to the schema.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

const result = await generateObject({
  model: openai('gpt-4o-2024-08-06', {
    structuredOutputs: true,
  }),
  schemaName: 'recipe',
  schemaDescription: 'A recipe for lasagna.',
  schema: z.object({
    name: z.string(),
    ingredients: z.array(
      z.object({
        name: z.string(),
        amount: z.string(),
      }),
    ),
    steps: z.array(z.string()),
  }),
  prompt: 'Generate a lasagna recipe.',
});

console.log(JSON.stringify(result.object, null, 2));
```

<Note type="warning">
  OpenAI structured outputs have several
  [limitations](https://openai.com/index/introducing-structured-outputs-in-the-api),
  in particular around the [supported schemas](https://platform.openai.com/docs/guides/structured-outputs/supported-schemas),
  and are therefore opt-in.

For example, optional schema properties are not supported.
You need to change Zod `.nullish()` and `.optional()` to `.nullable()`.

</Note>

#### PDF support

The OpenAI Chat API supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is an embedding model?',
        },
        {
          type: 'file',
          data: fs.readFileSync('./data/ai.pdf'),
          mimeType: 'application/pdf',
          filename: 'ai.pdf', // optional
        },
      ],
    },
  ],
});
```

The model will have access to the contents of the PDF file and
respond to questions about it.
The PDF file should be passed using the `data` field,
and the `mimeType` should be set to `'application/pdf'`.

#### Predicted Outputs

OpenAI supports [predicted outputs](https://platform.openai.com/docs/guides/latency-optimization#use-predicted-outputs) for `gpt-4o` and `gpt-4o-mini`.
Predicted outputs help you reduce latency by allowing you to specify a base text that the model should modify.
You can enable predicted outputs by adding the `prediction` option to the `providerOptions.openai` object:

```ts highlight="15-18"
const result = streamText({
  model: openai('gpt-4o'),
  messages: [
    {
      role: 'user',
      content: 'Replace the Username property with an Email property.',
    },
    {
      role: 'user',
      content: existingCode,
    },
  ],
  providerOptions: {
    openai: {
      prediction: {
        type: 'content',
        content: existingCode,
      },
    },
  },
});
```

OpenAI provides usage information for predicted outputs (`acceptedPredictionTokens` and `rejectedPredictionTokens`).
You can access it in the `providerMetadata` object.

```ts highlight="11"
const openaiMetadata = (await result.providerMetadata)?.openai;

const acceptedPredictionTokens = openaiMetadata?.acceptedPredictionTokens;
const rejectedPredictionTokens = openaiMetadata?.rejectedPredictionTokens;
```

<Note type="warning">
  OpenAI Predicted Outputs have several
  [limitations](https://platform.openai.com/docs/guides/predicted-outputs#limitations),
  e.g. unsupported API parameters and no tool calling support.
</Note>

#### Image Detail

You can use the `openai` provider option to set the [image input detail](https://platform.openai.com/docs/guides/images-vision?api-mode=responses#specify-image-input-detail-level) to `high`, `low`, or `auto`:

```ts highlight="13-16"
const result = await generateText({
  model: openai('gpt-4o'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the image in detail.' },
        {
          type: 'image',
          image:
            'https://github.com/vercel/ai/blob/main/examples/ai-core/data/comic-cat.png?raw=true',

          // OpenAI specific options - image detail:
          providerOptions: {
            openai: { imageDetail: 'low' },
          },
        },
      ],
    },
  ],
});
```

<Note type="warning">
  Because the `UIMessage` type (used by AI SDK UI hooks like `useChat`) does not
  support the `providerOptions` property, you can use `convertToCoreMessages`
  first before passing the messages to functions like `generateText` or
  `streamText`. For more details on `providerOptions` usage, see
  [here](/docs/foundations/prompts#provider-options).
</Note>

#### Distillation

OpenAI supports model distillation for some models.
If you want to store a generation for use in the distillation process, you can add the `store` option to the `providerOptions.openai` object.
This will save the generation to the OpenAI platform for later use in distillation.

```typescript highlight="9-16"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import 'dotenv/config';

async function main() {
  const { text, usage } = await generateText({
    model: openai('gpt-4o-mini'),
    prompt: 'Who worked on the original macintosh?',
    providerOptions: {
      openai: {
        store: true,
        metadata: {
          custom: 'value',
        },
      },
    },
  });

  console.log(text);
  console.log();
  console.log('Usage:', usage);
}

main().catch(console.error);
```

#### Prompt Caching

OpenAI has introduced [Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching) for supported models
including `gpt-4o`, `gpt-4o-mini`, `o1-preview`, and `o1-mini`.

- Prompt caching is automatically enabled for these models, when the prompt is 1024 tokens or longer. It does
  not need to be explicitly enabled.
- You can use response `providerMetadata` to access the number of prompt tokens that were a cache hit.
- Note that caching behavior is dependent on load on OpenAI's infrastructure. Prompt prefixes generally remain in the
  cache following 5-10 minutes of inactivity before they are evicted, but during off-peak periods they may persist for up
  to an hour.

```ts highlight="11"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai('gpt-4o-mini'),
  prompt: `A 1024-token or longer prompt...`,
});

console.log(`usage:`, {
  ...usage,
  cachedPromptTokens: providerMetadata?.openai?.cachedPromptTokens,
});
```

#### Audio Input

With the `gpt-4o-audio-preview` model, you can pass audio files to the model.

<Note type="warning">
  The `gpt-4o-audio-preview` model is currently in preview and requires at least
  some audio inputs. It will not work with non-audio data.
</Note>

```ts highlight="12-14"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4o-audio-preview'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is the audio saying?' },
        {
          type: 'file',
          mimeType: 'audio/mpeg',
          data: fs.readFileSync('./data/galileo.mp3'),
        },
      ],
    },
  ],
});
```

### Responses Models

You can use the OpenAI responses API with the `openai.responses(modelId)` factory method.

```ts
const model = openai.responses('gpt-4o-mini');
```

Further configuration can be done using OpenAI provider options.
You can validate the provider options using the `OpenAIResponsesProviderOptions` type.

```ts
import { openai, OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-4o-mini'),
  providerOptions: {
    openai: {
      parallelToolCalls: false,
      store: false,
      user: 'user_123',
      // ...
    } satisfies OpenAIResponsesProviderOptions,
  },
  // ...
});
```

The following provider options are available:

- **parallelToolCalls** _boolean_
  Whether to use parallel tool calls. Defaults to `true`.

- **store** _boolean_
  Whether to store the generation. Defaults to `true`.

- **metadata** _Record&lt;string, string&gt;_
  Additional metadata to store with the generation.

- **previousResponseId** _string_
  The ID of the previous response. You can use it to continue a conversation. Defaults to `undefined`.

- **instructions** _string_
  Instructions for the model.
  They can be used to change the system or developer message when continuing a conversation using the `previousResponseId` option.
  Defaults to `undefined`.

- **user** _string_
  A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. Defaults to `undefined`.

- **reasoningEffort** _'low' | 'medium' | 'high'_
  Reasoning effort for reasoning models. Defaults to `medium`. If you use `providerOptions` to set the `reasoningEffort` option, this model setting will be ignored.

- **reasoningSummary** _'auto' | 'detailed'_
  Controls whether the model returns its reasoning process. Set to `'auto'` for a condensed summary, `'detailed'` for more comprehensive reasoning. Defaults to `undefined` (no reasoning summaries). When enabled, reasoning summaries appear in the stream as events with type `'reasoning'` and in non-streaming responses within the `reasoning` field.

- **strictSchemas** _boolean_
  Whether to use strict JSON schemas in tools and when generating JSON outputs. Defaults to `true`.

The OpenAI responses provider also returns provider-specific metadata:

```ts
const { providerMetadata } = await generateText({
  model: openai.responses('gpt-4o-mini'),
});

const openaiMetadata = providerMetadata?.openai;
```

The following OpenAI-specific metadata is returned:

- **responseId** _string_
  The ID of the response. Can be used to continue a conversation.

- **cachedPromptTokens** _number_
  The number of prompt tokens that were a cache hit.

- **reasoningTokens** _number_
  The number of reasoning tokens that the model generated.

#### Web Search

The OpenAI responses provider supports web search through the `openai.tools.webSearchPreview` tool.

You can force the use of the web search tool by setting the `toolChoice` parameter to `{ type: 'tool', toolName: 'web_search_preview' }`.

```ts
const result = await generateText({
  model: openai.responses('gpt-4o-mini'),
  prompt: 'What happened in San Francisco last week?',
  tools: {
    web_search_preview: openai.tools.webSearchPreview({
      // optional configuration:
      searchContextSize: 'high',
      userLocation: {
        type: 'approximate',
        city: 'San Francisco',
        region: 'California',
      },
    }),
  },
  // Force web search tool:
  toolChoice: { type: 'tool', toolName: 'web_search_preview' },
});

// URL sources
const sources = result.sources;
```

#### Reasoning Summaries

For reasoning models like `o3-mini`, `o3`, and `o4-mini`, you can enable reasoning summaries to see the model's thought process. Different models support different summarizers—for example, `o4-mini` supports detailed summaries. Set `reasoningSummary: "auto"` to automatically receive the richest level available.

```ts highlight="8-9,16"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai.responses('o4-mini'),
  prompt: 'Tell me about the Mission burrito debate in San Francisco.',
  providerOptions: {
    openai: {
      reasoningSummary: 'detailed', // 'auto' for condensed or 'detailed' for comprehensive
    },
  },
});

for await (const part of result.fullStream) {
  if (part.type === 'reasoning') {
    console.log(`Reasoning: ${part.textDelta}`);
  } else if (part.type === 'text-delta') {
    process.stdout.write(part.textDelta);
  }
}
```

For non-streaming calls with `generateText`, the reasoning summaries are available in the `reasoning` field of the response:

```ts highlight="8-9,13"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('o3-mini'),
  prompt: 'Tell me about the Mission burrito debate in San Francisco.',
  providerOptions: {
    openai: {
      reasoningSummary: 'auto',
    },
  },
});
console.log('Reasoning:', result.reasoning);
```

Learn more about reasoning summaries in the [OpenAI documentation](https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries).

#### PDF support

The OpenAI Responses API supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: openai.responses('gpt-4o'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is an embedding model?',
        },
        {
          type: 'file',
          data: fs.readFileSync('./data/ai.pdf'),
          mimeType: 'application/pdf',
          filename: 'ai.pdf', // optional
        },
      ],
    },
  ],
});
```

The model will have access to the contents of the PDF file and
respond to questions about it.
The PDF file should be passed using the `data` field,
and the `mimeType` should be set to `'application/pdf'`.

#### Structured Outputs

The OpenAI Responses API supports structured outputs. You can enforce structured outputs using `generateObject` or `streamObject`, which expose a `schema` option. Additionally, you can pass a Zod or JSON Schema object to the `experimental_output` option when using `generateText` or `streamText`.

```ts
// Using generateObject
const result = await generateObject({
  model: openai.responses('gpt-4.1'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(
        z.object({
          name: z.string(),
          amount: z.string(),
        }),
      ),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});

// Using generateText
const result = await generateText({
  model: openai.responses('gpt-4.1'),
  prompt: 'How do I make a pizza?',
  experimental_output: Output.object({
    schema: z.object({
      ingredients: z.array(z.string()),
      steps: z.array(z.string()),
    }),
  }),
});
```

### Completion Models

You can create models that call the [OpenAI completions API](https://platform.openai.com/docs/api-reference/completions) using the `.completion()` factory method.
The first argument is the model id.
Currently only `gpt-3.5-turbo-instruct` is supported.

```ts
const model = openai.completion('gpt-3.5-turbo-instruct');
```

OpenAI completion models support also some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
const model = openai.completion('gpt-3.5-turbo-instruct', {
  echo: true, // optional, echo the prompt in addition to the completion
  logitBias: {
    // optional likelihood for specific tokens
    '50256': -100,
  },
  suffix: 'some text', // optional suffix that comes after a completion of inserted text
  user: 'test-user', // optional unique user identifier
});
```

The following optional settings are available for OpenAI completion models:

- **echo**: _boolean_

  Echo back the prompt in addition to the completion.

- **logitBias** _Record&lt;number, number&gt;_

  Modifies the likelihood of specified tokens appearing in the completion.

  Accepts a JSON object that maps tokens (specified by their token ID in
  the GPT tokenizer) to an associated bias value from -100 to 100. You
  can use this tokenizer tool to convert text to token IDs. Mathematically,
  the bias is added to the logits generated by the model prior to sampling.
  The exact effect will vary per model, but values between -1 and 1 should
  decrease or increase likelihood of selection; values like -100 or 100
  should result in a ban or exclusive selection of the relevant token.

  As an example, you can pass `{"50256": -100}` to prevent the &lt;|endoftext|&gt;
  token from being generated.

- **logprobs** _boolean | number_

  Return the log probabilities of the tokens. Including logprobs will increase
  the response size and can slow down response times. However, it can
  be useful to better understand how the model is behaving.

  Setting to true will return the log probabilities of the tokens that
  were generated.

  Setting to a number will return the log probabilities of the top n
  tokens that were generated.

- **suffix** _string_

  The suffix that comes after a completion of inserted text.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. [Learn more](https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids).

### Model Capabilities

| Model                  | Image Input         | Audio Input         | Object Generation   | Tool Usage          |
| ---------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `gpt-4.1`              | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4.1-mini`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4.1-nano`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o`               | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o-mini`          | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o-audio-preview` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4-turbo`          | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4`                | <Cross size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-3.5-turbo`        | <Cross size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `o1`                   | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `o1-mini`              | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `o1-preview`           | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `o3-mini`              | <Cross size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `o3`                   | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `o4-mini`              | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `chatgpt-4o-latest`    | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `gpt-5`                | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-mini`           | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-nano`           | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [OpenAI
  docs](https://platform.openai.com/docs/models) for a full list of available
  models. The table above lists popular models. You can also pass any available
  provider model ID as a string if needed.
</Note>

## Embedding Models

You can create models that call the [OpenAI embeddings API](https://platform.openai.com/docs/api-reference/embeddings)
using the `.embedding()` factory method.

```ts
const model = openai.embedding('text-embedding-3-large');
```

OpenAI embedding models support several additional settings.
You can pass them as an options argument:

```ts
const model = openai.embedding('text-embedding-3-large', {
  dimensions: 512 // optional, number of dimensions for the embedding
  user: 'test-user' // optional unique user identifier
})
```

The following optional settings are available for OpenAI embedding models:

- **dimensions**: _number_

  The number of dimensions the resulting output embeddings should have.
  Only supported in text-embedding-3 and later models.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. [Learn more](https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids).

### Model Capabilities

| Model                    | Default Dimensions | Custom Dimensions   |
| ------------------------ | ------------------ | ------------------- |
| `text-embedding-3-large` | 3072               | <Check size={18} /> |
| `text-embedding-3-small` | 1536               | <Check size={18} /> |
| `text-embedding-ada-002` | 1536               | <Cross size={18} /> |

## Image Models

You can create models that call the [OpenAI image generation API](https://platform.openai.com/docs/api-reference/images)
using the `.image()` factory method.

```ts
const model = openai.image('dall-e-3');
```

<Note>
  Dall-E models do not support the `aspectRatio` parameter. Use the `size`
  parameter instead.
</Note>

### Model Capabilities

| Model         | Sizes                           |
| ------------- | ------------------------------- |
| `gpt-image-1` | 1024x1024, 1536x1024, 1024x1536 |
| `dall-e-3`    | 1024x1024, 1792x1024, 1024x1792 |
| `dall-e-2`    | 256x256, 512x512, 1024x1024     |

You can pass optional `providerOptions` to the image model. These are prone to change by OpenAI and are model dependent. For example, the `gpt-image-1` model supports the `quality` option:

```ts
const { image } = await generateImage({
  model: openai.image('gpt-image-1'),
  prompt: 'A salamander at sunrise in a forest pond in the Seychelles.',
  providerOptions: {
    openai: { quality: 'high' },
  },
});
```

For more on `generateImage()` see [Image Generation](/docs/ai-sdk-core/image-generation).

For more information on the available OpenAI image model options, see the [OpenAI API reference](https://platform.openai.com/docs/api-reference/images/create).

## Transcription Models

You can create models that call the [OpenAI transcription API](https://platform.openai.com/docs/api-reference/audio/transcribe)
using the `.transcription()` factory method.

The first argument is the model id e.g. `whisper-1`.

```ts
const model = openai.transcription('whisper-1');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the input language in ISO-639-1 (e.g. `en`) format will improve accuracy and latency.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: { openai: { language: 'en' } },
});
```

The following provider options are available:

- **timestampGranularities** _string[]_
  The granularity of the timestamps in the transcription.
  Defaults to `['segment']`.
  Possible values are `['word']`, `['segment']`, and `['word', 'segment']`.
  Note: There is no additional latency for segment timestamps, but generating word timestamps incurs additional latency.

- **language** _string_
  The language of the input audio. Supplying the input language in ISO-639-1 format (e.g. 'en') will improve accuracy and latency.
  Optional.

- **prompt** _string_
  An optional text to guide the model's style or continue a previous audio segment. The prompt should match the audio language.
  Optional.

- **temperature** _number_
  The sampling temperature, between 0 and 1. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic. If set to 0, the model will use log probability to automatically increase the temperature until certain thresholds are hit.
  Defaults to 0.
  Optional.

- **include** _string[]_
  Additional information to include in the transcription response.

### Model Capabilities

| Model                    | Transcription       | Duration            | Segments            | Language            |
| ------------------------ | ------------------- | ------------------- | ------------------- | ------------------- |
| `whisper-1`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o-mini-transcribe` | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `gpt-4o-transcribe`      | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

## Speech Models

You can create models that call the [OpenAI speech API](https://platform.openai.com/docs/api-reference/audio/speech)
using the `.speech()` factory method.

The first argument is the model id e.g. `tts-1`.

```ts
const model = openai.speech('tts-1');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying a voice to use for the generated audio.

```ts highlight="6"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  providerOptions: { openai: {} },
});
```

- **instructions** _string_
  Control the voice of your generated audio with additional instructions e.g. "Speak in a slow and steady tone".
  Does not work with `tts-1` or `tts-1-hd`.
  Optional.

- **response_format** _string_
  The format to audio in.
  Supported formats are `mp3`, `opus`, `aac`, `flac`, `wav`, and `pcm`.
  Defaults to `mp3`.
  Optional.

- **speed** _number_
  The speed of the generated audio.
  Select a value from 0.25 to 4.0.
  Defaults to 1.0.
  Optional.

### Model Capabilities

| Model             | Instructions        |
| ----------------- | ------------------- |
| `tts-1`           | <Check size={18} /> |
| `tts-1-hd`        | <Check size={18} /> |
| `gpt-4o-mini-tts` | <Check size={18} /> |

---
title: Azure OpenAI
description: Learn how to use the Azure OpenAI provider for the AI SDK.
---

