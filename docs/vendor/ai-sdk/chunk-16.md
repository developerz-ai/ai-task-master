# Chatbot Resume Streams

`useChat` supports resuming ongoing streams after page reloads. Use this feature to build applications with long-running generations.

<Note type="warning">
  Stream resumption is not compatible with abort functionality. Closing a tab or
  refreshing the page triggers an abort signal that will break the resumption
  mechanism. Do not use `resume: true` if you need abort functionality in your
  application. See
  [troubleshooting](/docs/troubleshooting/abort-breaks-resumable-streams) for
  more details.
</Note>

## How stream resumption works

Stream resumption requires persistence for messages and active streams in your application. The AI SDK provides tools to connect to storage, but you need to set up the storage yourself.

**The AI SDK provides:**

- A `resume` option in `useChat` that automatically reconnects to active streams
- Access to the outgoing stream through the `consumeSseStream` callback
- Automatic HTTP requests to your resume endpoints

**You build:**

- Storage to track which stream belongs to each chat
- Redis to store the UIMessage stream
- Two API endpoints: POST to create streams, GET to resume them
- Integration with [`resumable-stream`](https://www.npmjs.com/package/resumable-stream) to manage Redis storage

## Prerequisites

To implement resumable streams in your chat application, you need:

1. **The `resumable-stream` package** - Handles the publisher/subscriber mechanism for streams
2. **A Redis instance** - Stores stream data (e.g. [Redis through Vercel](https://vercel.com/marketplace/redis))
3. **A persistence layer** - Tracks which stream ID is active for each chat (e.g. database)

## Implementation

### 1. Client-side: Enable stream resumption

Use the `resume` option in the `useChat` hook to enable stream resumption. When `resume` is true, the hook automatically attempts to reconnect to any active stream for the chat on mount:

```tsx filename="app/chat/[chatId]/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';

export function Chat({
  chatData,
  resume = false,
}: {
  chatData: { id: string; messages: UIMessage[] };
  resume?: boolean;
}) {
  const { messages, sendMessage, status } = useChat({
    id: chatData.id,
    messages: chatData.messages,
    resume, // Enable automatic stream resumption
    transport: new DefaultChatTransport({
      // You must send the id of the chat
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

  return <div>{/* Your chat UI */}</div>;
}
```

<Note>
  You must send the chat ID with each request (see
  `prepareSendMessagesRequest`).
</Note>

When you enable `resume`, the `useChat` hook makes a `GET` request to `/api/chat/[id]/stream` on mount to check for and resume any active streams.

Let's start by creating the POST handler to create the resumable stream.

### 2. Create the POST handler

The POST handler creates resumable streams using the `consumeSseStream` callback:

```ts filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { readChat, saveChat } from '@util/chat-store';
import {
  convertToModelMessages,
  generateId,
  streamText,
  type UIMessage,
} from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function POST(req: Request) {
  const {
    message,
    id,
  }: {
    message: UIMessage | undefined;
    id: string;
  } = await req.json();

  const chat = await readChat(id);
  let messages = chat.messages;

  messages = [...messages, message!];

  // Clear any previous active stream and save the user message
  saveChat({ id, messages, activeStreamId: null });

  const result = streamText({
    model: 'openai/gpt-5-mini',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: generateId,
    onFinish: ({ messages }) => {
      // Clear the active stream when finished
      saveChat({ id, messages, activeStreamId: null });
    },
    async consumeSseStream({ stream }) {
      const streamId = generateId();

      // Create a resumable stream from the SSE stream
      const streamContext = createResumableStreamContext({ waitUntil: after });
      await streamContext.createNewResumableStream(streamId, () => stream);

      // Update the chat with the active stream ID
      saveChat({ id, activeStreamId: streamId });
    },
  });
}
```

### 3. Implement the GET handler

Create a GET handler at `/api/chat/[id]/stream` that:

1. Reads the chat ID from the route params
2. Loads the chat data to check for an active stream
3. Returns 204 (No Content) if no stream is active
4. Resumes the existing stream if one is found

```ts filename="app/api/chat/[id]/stream/route.ts"
import { readChat } from '@util/chat-store';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const chat = await readChat(id);

  if (chat.activeStreamId == null) {
    // no content response when there is no active stream
    return new Response(null, { status: 204 });
  }

  const streamContext = createResumableStreamContext({
    waitUntil: after,
  });

  return new Response(
    await streamContext.resumeExistingStream(chat.activeStreamId),
    { headers: UI_MESSAGE_STREAM_HEADERS },
  );
}
```

<Note>
  The `after` function from Next.js allows work to continue after the response
  has been sent. This ensures that the resumable stream persists in Redis even
  after the initial response is returned to the client, enabling reconnection
  later.
</Note>

## How it works

### Request lifecycle

![Diagram showing the architecture and lifecycle of resumable stream requests](https://e742qlubrjnjqpp0.public.blob.vercel-storage.com/resume-stream-diagram.png)

The diagram above shows the complete lifecycle of a resumable stream:

1. **Stream creation**: When you send a new message, the POST handler uses `streamText` to generate the response. The `consumeSseStream` callback creates a resumable stream with a unique ID and stores it in Redis through the `resumable-stream` package
2. **Stream tracking**: Your persistence layer saves the `activeStreamId` in the chat data
3. **Client reconnection**: When the client reconnects (page reload), the `resume` option triggers a GET request to `/api/chat/[id]/stream`
4. **Stream recovery**: The GET handler checks for an `activeStreamId` and uses `resumeExistingStream` to reconnect. If no active stream exists, it returns a 204 (No Content) response
5. **Completion cleanup**: When the stream finishes, the `onFinish` callback clears the `activeStreamId` by setting it to `null`

## Customize the resume endpoint

By default, the `useChat` hook makes a GET request to `/api/chat/[id]/stream` when resuming. Customize this endpoint, credentials, and headers, using the `prepareReconnectToStreamRequest` option in `DefaultChatTransport`:

```tsx filename="app/chat/[chatId]/chat.tsx"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export function Chat({ chatData, resume }) {
  const { messages, sendMessage } = useChat({
    id: chatData.id,
    messages: chatData.messages,
    resume,
    transport: new DefaultChatTransport({
      // Customize reconnect settings (optional)
      prepareReconnectToStreamRequest: ({ id }) => {
        return {
          api: `/api/chat/${id}/stream`, // Default pattern
          // Or use a different pattern:
          // api: `/api/streams/${id}/resume`,
          // api: `/api/resume-chat?id=${id}`,
          credentials: 'include', // Include cookies/auth
          headers: {
            Authorization: 'Bearer token',
            'X-Custom-Header': 'value',
          },
        };
      },
    }),
  });

  return <div>{/* Your chat UI */}</div>;
}
```

This lets you:

- Match your existing API route structure
- Add query parameters or custom paths
- Integrate with different backend architectures

## Important considerations

- **Incompatibility with abort**: Stream resumption is not compatible with abort functionality. Closing a tab or refreshing the page triggers an abort signal that will break the resumption mechanism. Do not use `resume: true` if you need abort functionality in your application
- **Stream expiration**: Streams in Redis expire after a set time (configurable in the `resumable-stream` package)
- **Multiple clients**: Multiple clients can connect to the same stream simultaneously
- **Error handling**: When no active stream exists, the GET handler returns a 204 (No Content) status code
- **Security**: Ensure proper authentication and authorization for both creating and resuming streams
- **Race conditions**: Clear the `activeStreamId` when starting a new stream to prevent resuming outdated streams

<br />
<GithubLink link="https://github.com/vercel/ai/blob/main/examples/next" />

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
   You must call `addToolOutput` to provide the tool result.
1. Client-side tool that require user interactions can be displayed in the UI.
   The tool calls and results are available as tool invocation parts in the `parts` property of the last assistant message.
1. When the user interaction is done, `addToolOutput` can be used to add the tool result to the chat.
1. The chat can be configured to automatically submit when all tool results are available using `sendAutomaticallyWhen`.
   This triggers another iteration of this flow.

The tool calls and tool executions are integrated into the assistant message as typed tool parts.
A tool part is at first a tool call, and then it becomes a tool result when the tool is executed.
The tool result contains all information about the tool call as well as the result of the tool execution.

<Note>
  Tool result submission can be configured using the `sendAutomaticallyWhen`
  option. You can use the `lastAssistantMessageIsCompleteWithToolCalls` helper
  to automatically submit when all tool results are available. This simplifies
  the client-side code while still allowing full control when needed.
</Note>

## Example

In this example, we'll use three tools:

- `getWeatherInformation`: An automatically executed server-side tool that returns the weather in a given city.
- `askForConfirmation`: A user-interaction client-side tool that asks the user for confirmation.
- `getLocation`: An automatically executed client-side tool that returns a random city.

### API route

```tsx filename='app/api/chat/route.ts'
import { convertToModelMessages, streamText, UIMessage } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
    tools: {
      // server-side tool with execute function:
      getWeatherInformation: {
        description: 'show the weather in a given city to the user',
        inputSchema: z.object({ city: z.string() }),
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
        inputSchema: z.object({
          message: z.string().describe('The message to ask for confirmation.'),
        }),
      },
      // client-side tool that is automatically executed on the client:
      getLocation: {
        description:
          'Get the user location. Always ask for confirmation before using this tool.',
        inputSchema: z.object({}),
      },
    },
  });

  return result.toUIMessageStreamResponse();
}
```

### Client-side page

The client-side page uses the `useChat` hook to create a chatbot application with real-time message streaming.
Tool calls are displayed in the chat UI as typed tool parts.
Please make sure to render the messages using the `parts` property of the message.

There are three things worth mentioning:

1. The [`onToolCall`](/docs/reference/ai-sdk-ui/use-chat#on-tool-call) callback is used to handle client-side tools that should be automatically executed.
   In this example, the `getLocation` tool is a client-side tool that returns a random city.
   You call `addToolOutput` to provide the result (without `await` to avoid potential deadlocks).

   <Note>
     Always check `if (toolCall.dynamic)` first in your `onToolCall` handler.
     Without this check, TypeScript will throw an error like: `Type 'string' is
     not assignable to type '"toolName1" | "toolName2"'` when you try to use
     `toolCall.toolName` in `addToolOutput`.
   </Note>

2. The [`sendAutomaticallyWhen`](/docs/reference/ai-sdk-ui/use-chat#send-automatically-when) option with `lastAssistantMessageIsCompleteWithToolCalls` helper automatically submits when all tool results are available.

3. The `parts` array of assistant messages contains tool parts with typed names like `tool-askForConfirmation`.
   The client-side tool `askForConfirmation` is displayed in the UI.
   It asks the user for confirmation and displays the result once the user confirms or denies the execution.
   The result is added to the chat using `addToolOutput` with the `tool` parameter for type safety.

```tsx filename='app/page.tsx' highlight="2,6,10,14-20"
'use client';

import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { useState } from 'react';

export default function Chat() {
  const { messages, sendMessage, addToolOutput } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),

    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,

    // run client-side tools that are automatically executed:
    async onToolCall({ toolCall }) {
      // Check if it's a dynamic tool first for proper type narrowing
      if (toolCall.dynamic) {
        return;
      }

      if (toolCall.toolName === 'getLocation') {
        const cities = ['New York', 'Los Angeles', 'Chicago', 'San Francisco'];

        // No await - avoids potential deadlocks
        addToolOutput({
          tool: 'getLocation',
          toolCallId: toolCall.toolCallId,
          output: cities[Math.floor(Math.random() * cities.length)],
        });
      }
    },
  });
  const [input, setInput] = useState('');

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

              // for tool parts, use the typed tool part names:
              case 'tool-askForConfirmation': {
                const callId = part.toolCallId;

                switch (part.state) {
                  case 'input-streaming':
                    return (
                      <div key={callId}>Loading confirmation request...</div>
                    );
                  case 'input-available':
                    return (
                      <div key={callId}>
                        {part.input.message}
                        <div>
                          <button
                            onClick={() =>
                              addToolOutput({
                                tool: 'askForConfirmation',
                                toolCallId: callId,
                                output: 'Yes, confirmed.',
                              })
                            }
                          >
                            Yes
                          </button>
                          <button
                            onClick={() =>
                              addToolOutput({
                                tool: 'askForConfirmation',
                                toolCallId: callId,
                                output: 'No, denied',
                              })
                            }
                          >
                            No
                          </button>
                        </div>
                      </div>
                    );
                  case 'output-available':
                    return (
                      <div key={callId}>
                        Location access allowed: {part.output}
                      </div>
                    );
                  case 'output-error':
                    return <div key={callId}>Error: {part.errorText}</div>;
                }
                break;
              }

              case 'tool-getLocation': {
                const callId = part.toolCallId;

                switch (part.state) {
                  case 'input-streaming':
                    return (
                      <div key={callId}>Preparing location request...</div>
                    );
                  case 'input-available':
                    return <div key={callId}>Getting location...</div>;
                  case 'output-available':
                    return <div key={callId}>Location: {part.output}</div>;
                  case 'output-error':
                    return (
                      <div key={callId}>
                        Error getting location: {part.errorText}
                      </div>
                    );
                }
                break;
              }

              case 'tool-getWeatherInformation': {
                const callId = part.toolCallId;

                switch (part.state) {
                  // example of pre-rendering streaming tool inputs:
                  case 'input-streaming':
                    return (
                      <pre key={callId}>{JSON.stringify(part, null, 2)}</pre>
                    );
                  case 'input-available':
                    return (
                      <div key={callId}>
                        Getting weather information for {part.input.city}...
                      </div>
                    );
                  case 'output-available':
                    return (
                      <div key={callId}>
                        Weather in {part.input.city}: {part.output}
                      </div>
                    );
                  case 'output-error':
                    return (
                      <div key={callId}>
                        Error getting weather for {part.input.city}:{' '}
                        {part.errorText}
                      </div>
                    );
                }
                break;
              }
            }
          })}
          <br />
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
        <input value={input} onChange={e => setInput(e.target.value)} />
      </form>
    </>
  );
}
```

### Error handling

Sometimes an error may occur during client-side tool execution. Use the `addToolOutput` method with a `state` of `output-error` and `errorText` value instead of `output` record the error.

```tsx filename='app/page.tsx' highlight="19,36-41"
'use client';

import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { useState } from 'react';

export default function Chat() {
  const { messages, sendMessage, addToolOutput } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),

    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,

    // run client-side tools that are automatically executed:
    async onToolCall({ toolCall }) {
      // Check if it's a dynamic tool first for proper type narrowing
      if (toolCall.dynamic) {
        return;
      }

      if (toolCall.toolName === 'getWeatherInformation') {
        try {
          const weather = await getWeatherInformation(toolCall.input);

          // No await - avoids potential deadlocks
          addToolOutput({
            tool: 'getWeatherInformation',
            toolCallId: toolCall.toolCallId,
            output: weather,
          });
        } catch (err) {
          addToolOutput({
            tool: 'getWeatherInformation',
            toolCallId: toolCall.toolCallId,
            state: 'output-error',
            errorText: 'Unable to get the weather information',
          });
        }
      }
    },
  });
}
```

## Tool Execution Approval

Tool execution approval lets you require user confirmation before a server-side tool runs. Unlike [client-side tools](#example) that execute in the browser, tools with approval still execute on the server—but only after the user approves.

Use tool execution approval when you want to:

- Confirm sensitive operations (payments, deletions, external API calls)
- Let users review tool inputs before execution
- Add human oversight to automated workflows

For tools that need to run in the browser (updating UI state, accessing browser APIs), use client-side tools instead.

### Server Setup

Enable approval by setting `needsApproval` on your tool. See [Tool Execution Approval](/docs/ai-sdk-core/tools-and-tool-calling#tool-execution-approval) for configuration options including dynamic approval based on input.

```tsx filename='app/api/chat/route.ts'
import { streamText, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages,
    tools: {
      getWeather: tool({
        description: 'Get the weather in a location',
        inputSchema: z.object({
          city: z.string(),
        }),
        needsApproval: true,
        execute: async ({ city }) => {
          const weather = await fetchWeather(city);
          return weather;
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

### Client-Side Approval UI

When a tool requires approval, the tool part state is `approval-requested`. Use `addToolApprovalResponse` to approve or deny:

```tsx filename='app/page.tsx'
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, addToolApprovalResponse } = useChat();

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.parts.map(part => {
            if (part.type === 'tool-getWeather') {
              switch (part.state) {
                case 'approval-requested':
                  return (
                    <div key={part.toolCallId}>
                      <p>Get weather for {part.input.city}?</p>
                      <button
                        onClick={() =>
                          addToolApprovalResponse({
                            id: part.approval.id,
                            approved: true,
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        onClick={() =>
                          addToolApprovalResponse({
                            id: part.approval.id,
                            approved: false,
                          })
                        }
                      >
                        Deny
                      </button>
                    </div>
                  );
                case 'output-available':
                  return (
                    <div key={part.toolCallId}>
                      Weather in {part.input.city}: {part.output}
                    </div>
                  );
              }
            }
            // Handle other part types...
          })}
        </div>
      ))}
    </>
  );
}
```

### Auto-Submit After Approval

<Note>
  If nothing happens after you approve a tool execution, make sure you either
  call `sendMessage` manually or configure `sendAutomaticallyWhen` on the
  `useChat` hook.
</Note>

Use `lastAssistantMessageIsCompleteWithApprovalResponses` to automatically continue the conversation after approvals:

```tsx
import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';

const { messages, addToolApprovalResponse } = useChat({
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});
```

## Dynamic Tools

When using dynamic tools (tools with unknown types at compile time), the UI parts use a generic `dynamic-tool` type instead of specific tool types:

```tsx filename='app/page.tsx'
{
  message.parts.map((part, index) => {
    switch (part.type) {
      // Static tools with specific (`tool-${toolName}`) types
      case 'tool-getWeatherInformation':
        return <WeatherDisplay part={part} />;

      // Dynamic tools use generic `dynamic-tool` type
      case 'dynamic-tool':
        return (
          <div key={index}>
            <h4>Tool: {part.toolName}</h4>
            {part.state === 'input-streaming' && (
              <pre>{JSON.stringify(part.input, null, 2)}</pre>
            )}
            {part.state === 'output-available' && (
              <pre>{JSON.stringify(part.output, null, 2)}</pre>
            )}
            {part.state === 'output-error' && (
              <div>Error: {part.errorText}</div>
            )}
          </div>
        );
    }
  });
}
```

Dynamic tools are useful when integrating with:

- MCP (Model Context Protocol) tools without schemas
- User-defined functions loaded at runtime
- External tool providers

## Tool call streaming

Tool call streaming is **enabled by default** in AI SDK 5.0, allowing you to stream tool calls while they are being generated. This provides a better user experience by showing tool inputs as they are generated in real-time.

```tsx filename='app/api/chat/route.ts'
export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
    // toolCallStreaming is enabled by default in v5
    // ...
  });

  return result.toUIMessageStreamResponse();
}
```

With tool call streaming enabled, partial tool calls are streamed as part of the data stream.
They are available through the `useChat` hook.
The typed tool parts of assistant messages will also contain partial tool calls.
You can use the `state` property of the tool part to render the correct UI.

```tsx filename='app/page.tsx' highlight="9,10"
export default function Chat() {
  // ...
  return (
    <>
      {messages?.map(message => (
        <div key={message.id}>
          {message.parts.map(part => {
            switch (part.type) {
              case 'tool-askForConfirmation':
              case 'tool-getLocation':
              case 'tool-getWeatherInformation':
                switch (part.state) {
                  case 'input-streaming':
                    return <pre>{JSON.stringify(part.input, null, 2)}</pre>;
                  case 'input-available':
                    return <pre>{JSON.stringify(part.input, null, 2)}</pre>;
                  case 'output-available':
                    return <pre>{JSON.stringify(part.output, null, 2)}</pre>;
                  case 'output-error':
                    return <div>Error: {part.errorText}</div>;
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
If you want to display boundaries between tool calls, you can use the `step-start` parts as follows:

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
    case 'tool-askForConfirmation':
    case 'tool-getLocation':
    case 'tool-getWeatherInformation':
    // ...
  }
});
// ...
```

## Server-side Multi-Step Calls

You can also use multi-step calls on the server-side with `streamText`.
This works when all invoked tools have an `execute` function on the server side.

```tsx filename='app/api/chat/route.ts' highlight="15-21,24"
import { convertToModelMessages, streamText, UIMessage, isStepCount } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
    tools: {
      getWeatherInformation: {
        description: 'show the weather in a given city to the user',
        inputSchema: z.object({ city: z.string() }),
        // tool has execute function:
        execute: async ({}: { city: string }) => {
          const weatherOptions = ['sunny', 'cloudy', 'rainy', 'snowy', 'windy'];
          return weatherOptions[
            Math.floor(Math.random() * weatherOptions.length)
          ];
        },
      },
    },
    stopWhen: isStepCount(5),
  });

  return result.toUIMessageStreamResponse();
}
```

## Errors

Language models can make errors when calling tools.
By default, these errors are masked for security reasons, and show up as "An error occurred" in the UI.

To surface the errors, you can use the `onError` function when calling `toUIMessageResponse`.

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

return result.toUIMessageStreamResponse({
  onError: errorHandler,
});
```

In case you are using `createUIMessageResponse`, you can use the `onError` function when calling `toUIMessageResponse`:

```tsx
const response = createUIMessageResponse({
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
import { useState } from 'react';

export default function Page() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role === 'user' ? 'User: ' : 'AI: '}</div>
          <div>
            {message.parts.map((part, index) => {
              if (part.type === 'text') {
                return <span key={index}>{part.text}</span>;
              }
              return null;
            })}
          </div>
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

To handle the chat requests and model responses, set up an API route:

```ts filename="app/api/chat/route.ts"
import { streamText, convertToModelMessages, UIMessage, isStepCount } from 'ai';
__PROVIDER_IMPORT__;

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const result = streamText({
    model: __MODEL__,
    system: 'You are a friendly assistant!',
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
  });

  return result.toUIMessageStreamResponse();
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
  inputSchema: z.object({
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

```ts filename="app/api/chat/route.ts" highlight="3,8,14"
import { streamText, convertToModelMessages, UIMessage, isStepCount } from 'ai';
__PROVIDER_IMPORT__;
import { tools } from '@/ai/tools';

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const result = streamText({
    model: __MODEL__,
    system: 'You are a friendly assistant!',
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
    tools,
  });

  return result.toUIMessageStreamResponse();
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

To check if the model has called a tool, you can check the `parts` array of the UIMessage object for tool-specific parts. In AI SDK 5.0, tool parts use typed naming: `tool-${toolName}` instead of generic types.

Update your `page.tsx` file:

```tsx filename="app/page.tsx" highlight="4,9,14-15,19-46"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import { Weather } from '@/components/weather';

export default function Page() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role === 'user' ? 'User: ' : 'AI: '}</div>
          <div>
            {message.parts.map((part, index) => {
              if (part.type === 'text') {
                return <span key={index}>{part.text}</span>;
              }

              if (part.type === 'tool-displayWeather') {
                switch (part.state) {
                  case 'input-available':
                    return <div key={index}>Loading weather...</div>;
                  case 'output-available':
                    return (
                      <div key={index}>
                        <Weather {...part.output} />
                      </div>
                    );
                  case 'output-error':
                    return <div key={index}>Error: {part.errorText}</div>;
                  default:
                    return null;
                }
              }

              return null;
            })}
          </div>
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

In this updated code snippet, you:

1. Use manual input state management with `useState` instead of the built-in `input` and `handleInputChange`.
2. Use `sendMessage` instead of `handleSubmit` to send messages.
3. Check the `parts` array of each message for different content types.
4. Handle tool parts with type `tool-displayWeather` and their different states (`input-available`, `output-available`, `output-error`).

This approach allows you to dynamically render UI components based on the model's responses, creating a more interactive and context-aware chat experience.

## Expanding Your Generative UI Application

You can enhance your chat application by adding more tools and components, creating a richer and more versatile user experience. Here's how you can expand your application:

### Adding More Tools

To add more tools, simply define them in your `ai/tools.ts` file:

```ts
// Add a new stock tool
export const stockTool = createTool({
  description: 'Get price for a stock',
  inputSchema: z.object({
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
import { useState } from 'react';
import { Weather } from '@/components/weather';
import { Stock } from '@/components/stock';

export default function Page() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>{message.role}</div>
          <div>
            {message.parts.map((part, index) => {
              if (part.type === 'text') {
                return <span key={index}>{part.text}</span>;
              }

              if (part.type === 'tool-displayWeather') {
                switch (part.state) {
                  case 'input-available':
                    return <div key={index}>Loading weather...</div>;
                  case 'output-available':
                    return (
                      <div key={index}>
                        <Weather {...part.output} />
                      </div>
                    );
                  case 'output-error':
                    return <div key={index}>Error: {part.errorText}</div>;
                  default:
                    return null;
                }
              }

              if (part.type === 'tool-getStockPrice') {
                switch (part.state) {
                  case 'input-available':
                    return <div key={index}>Loading stock price...</div>;
                  case 'output-available':
                    return (
                      <div key={index}>
                        <Stock {...part.output} />
                      </div>
                    );
                  case 'output-error':
                    return <div key={index}>Error: {part.errorText}</div>;
                  default:
                    return null;
                }
              }

              return null;
            })}
          </div>
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
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

<Note>
  The `useCompletion` hook is now part of the `@ai-sdk/react` package.
</Note>

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
__PROVIDER_IMPORT__;

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { prompt }: { prompt: string } = await req.json();

  const result = streamText({
    model: __MODEL__,
    prompt,
  });

  return result.toUIMessageStreamResponse();
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
  onFinish: (prompt: string, completion: string) => {
    console.log('Finished streaming completion:', completion)
  },
  onError: (error: Error) => {
    console.error('An error occurred:', error)
  },
})
```

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

<Note>
  `useObject` is an experimental feature and only available in React, Svelte,
  and Vue.
</Note>

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

On the server, we use [`streamText`](/docs/reference/ai-sdk-core/stream-text) with [`Output.object()`](/docs/reference/ai-sdk-core/output#output-object) to stream the object generation process.

```typescript filename='app/api/notifications/route.ts'
import { streamText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { notificationSchema } from './schema';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const context = await req.json();

  const result = streamText({
    model: __MODEL__,
    output: Output.object({ schema: notificationSchema }),
    prompt:
      `Generate 3 notifications for a messages app in this context:` + context,
  });

  return result.toTextStreamResponse();
}
```

## Enum Output Mode

When you need to classify or categorize input into predefined options, you can use the `enum` output mode with `useObject`. This requires a specific schema structure where the object has `enum` as a key with `z.enum` containing your possible values.

### Example: Text Classification

This example shows how to build a simple text classifier that categorizes statements as true or false.

#### Client

When using `useObject` with enum output mode, your schema must be an object with `enum` as the key:

```tsx filename='app/classify/page.tsx'
'use client';

import { experimental_useObject as useObject } from '@ai-sdk/react';
import { z } from 'zod';

export default function ClassifyPage() {
  const { object, submit, isLoading } = useObject({
    api: '/api/classify',
    schema: z.object({ enum: z.enum(['true', 'false']) }),
  });

  return (
    <>
      <button onClick={() => submit('The earth is flat')} disabled={isLoading}>
        Classify statement
      </button>

      {object && <div>Classification: {object.enum}</div>}
    </>
  );
}
```

#### Server

On the server, use `streamText` with `Output.choice()` to stream the classification result:

```typescript filename='app/api/classify/route.ts'
import { streamText, Output } from 'ai';
__PROVIDER_IMPORT__;

export async function POST(req: Request) {
  const context = await req.json();

  const result = streamText({
    model: __MODEL__,
    output: Output.choice({ options: ['true', 'false'] }),
    prompt: `Classify this statement as true or false: ${context}`,
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

import { experimental_useObject as useObject } from '@ai-sdk/react';

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

import { experimental_useObject as useObject } from '@ai-sdk/react';

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

import { experimental_useObject as useObject } from '@ai-sdk/react';

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
title: Streaming Custom Data
description: Learn how to stream custom data from the server to the client.
---

# Streaming Custom Data

It is often useful to send additional data alongside the model's response.
For example, you may want to send status information, the message ids after storing them,
or references to content that the language model is referring to.

The AI SDK provides several helpers that allows you to stream additional data to the client
and attach it to the `UIMessage` parts array:

- `createUIMessageStream`: creates a data stream
- `createUIMessageStreamResponse`: creates a response object that streams data
- `pipeUIMessageStreamToResponse`: pipes a data stream to a server response object

The data is streamed as part of the response stream using Server-Sent Events.

## Setting Up Type-Safe Data Streaming

First, define your custom message type with data part schemas for type safety:

```tsx filename="ai/types.ts"
import { UIMessage } from 'ai';

// Define your custom message type with data part schemas
export type MyUIMessage = UIMessage<
  never, // metadata type
  {
    weather: {
      city: string;
      weather?: string;
      status: 'loading' | 'success';
    };
    notification: {
      message: string;
      level: 'info' | 'warning' | 'error';
    };
  } // data parts type
>;
```

## Streaming Data from the Server

In your server-side route handler, you can create a `UIMessageStream` and then pass it to `createUIMessageStreamResponse`:

```tsx filename="route.ts"
import { openai } from '@ai-sdk/openai';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  convertToModelMessages,
} from 'ai';
__PROVIDER_IMPORT__;
import type { MyUIMessage } from '@/ai/types';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = createUIMessageStream<MyUIMessage>({
    execute: ({ writer }) => {
      // 1. Send initial status (transient - won't be added to message history)
      writer.write({
        type: 'data-notification',
        data: { message: 'Processing your request...', level: 'info' },
        transient: true, // This part won't be added to message history
      });

      // 2. Send sources (useful for RAG use cases)
      writer.write({
        type: 'source',
        value: {
          type: 'source',
          sourceType: 'url',
          id: 'source-1',
          url: 'https://weather.com',
          title: 'Weather Data Source',
        },
      });

      // 3. Send data parts with loading state
      writer.write({
        type: 'data-weather',
        id: 'weather-1',
        data: { city: 'San Francisco', status: 'loading' },
      });

      const result = streamText({
        model: __MODEL__,
        messages: await convertToModelMessages(messages),
        onFinish() {
          // 4. Update the same data part (reconciliation)
          writer.write({
            type: 'data-weather',
            id: 'weather-1', // Same ID = update existing part
            data: {
              city: 'San Francisco',
              weather: 'sunny',
              status: 'success',
            },
          });

          // 5. Send completion notification (transient)
          writer.write({
            type: 'data-notification',
            data: { message: 'Request completed', level: 'info' },
            transient: true, // Won't be added to message history
          });
        },
      });

      writer.merge(result.toUIMessageStream());
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

<Note>
  You can also send stream data from custom backends, e.g. Python / FastAPI,
  using the [UI Message Stream
  Protocol](/docs/ai-sdk-ui/stream-protocol#ui-message-stream-protocol).
</Note>

## Types of Streamable Data

### Data Parts (Persistent)

Regular data parts are added to the message history and appear in `message.parts`:

```tsx
writer.write({
  type: 'data-weather',
  id: 'weather-1', // Optional: enables reconciliation
  data: { city: 'San Francisco', status: 'loading' },
});
```

### Sources

Sources are useful for RAG implementations where you want to show which documents or URLs were referenced:

```tsx
writer.write({
  type: 'source',
  value: {
    type: 'source',
    sourceType: 'url',
    id: 'source-1',
    url: 'https://example.com',
    title: 'Example Source',
  },
});
```

### Transient Data Parts (Ephemeral)

Transient parts are sent to the client but not added to the message history. They are only accessible via the `onData` useChat handler:

```tsx
// server
writer.write({
  type: 'data-notification',
  data: { message: 'Processing...', level: 'info' },
  transient: true, // Won't be added to message history
});

// client
const [notification, setNotification] = useState();

const { messages } = useChat({
  onData: ({ data, type }) => {
    if (type === 'data-notification') {
      setNotification({ message: data.message, level: data.level });
    }
  },
});
```

## Data Part Reconciliation

When you write to a data part with the same ID, the client automatically reconciles and updates that part. This enables powerful dynamic experiences like:

- **Collaborative artifacts** - Update code, documents, or designs in real-time
- **Progressive data loading** - Show loading states that transform into final results
- **Live status updates** - Update progress bars, counters, or status indicators
- **Interactive components** - Build UI elements that evolve based on user interaction

The reconciliation happens automatically - simply use the same `id` when writing to the stream.

## Processing Data on the Client

### Using the onData Callback

The `onData` callback is essential for handling streaming data, especially transient parts:

```tsx filename="page.tsx"
import { useChat } from '@ai-sdk/react';
import type { MyUIMessage } from '@/ai/types';

const { messages } = useChat<MyUIMessage>({
  api: '/api/chat',
  onData: dataPart => {
    // Handle all data parts as they arrive (including transient parts)
    console.log('Received data part:', dataPart);

    // Handle different data part types
    if (dataPart.type === 'data-weather') {
      console.log('Weather update:', dataPart.data);
    }

    // Handle transient notifications (ONLY available here, not in message.parts)
    if (dataPart.type === 'data-notification') {
      showToast(dataPart.data.message, dataPart.data.level);
    }
  },
});
```

**Important:** Transient data parts are **only** available through the `onData` callback. They will not appear in the `message.parts` array since they're not added to message history.

### Rendering Persistent Data Parts

You can filter and render data parts from the message parts array:

```tsx filename="page.tsx"
const result = (
  <>
    {messages?.map(message => (
      <div key={message.id}>
        {/* Render weather data parts */}
        {message.parts
          .filter(part => part.type === 'data-weather')
          .map((part, index) => (
            <div key={index} className="weather-widget">
              {part.data.status === 'loading' ? (
                <>Getting weather for {part.data.city}...</>
              ) : (
                <>
                  Weather in {part.data.city}: {part.data.weather}
                </>
              )}
            </div>
          ))}

        {/* Render text content */}
        {message.parts
          .filter(part => part.type === 'text')
          .map((part, index) => (
            <div key={index}>{part.text}</div>
          ))}

        {/* Render sources */}
        {message.parts
          .filter(part => part.type === 'source')
          .map((part, index) => (
            <div key={index} className="source">
              Source: <a href={part.url}>{part.title}</a>
            </div>
          ))}
      </div>
    ))}
  </>
);
```

### Complete Example

```tsx filename="page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import type { MyUIMessage } from '@/ai/types';

export default function Chat() {
  const [input, setInput] = useState('');

  const { messages, sendMessage } = useChat<MyUIMessage>({
    api: '/api/chat',
    onData: dataPart => {
      // Handle transient notifications
      if (dataPart.type === 'data-notification') {
        console.log('Notification:', dataPart.data.message);
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <>
      {messages?.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}

          {/* Render weather data */}
          {message.parts
            .filter(part => part.type === 'data-weather')
            .map((part, index) => (
              <span key={index} className="weather-update">
                {part.data.status === 'loading' ? (
                  <>Getting weather for {part.data.city}...</>
                ) : (
                  <>
                    Weather in {part.data.city}: {part.data.weather}
                  </>
                )}
              </span>
            ))}

          {/* Render text content */}
          {message.parts
            .filter(part => part.type === 'text')
            .map((part, index) => (
              <div key={index}>{part.text}</div>
            ))}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about the weather..."
        />
        <button type="submit">Send</button>
      </form>
    </>
  );
}
```

## Use Cases

- **RAG Applications** - Stream sources and retrieved documents
- **Real-time Status** - Show loading states and progress updates
- **Collaborative Tools** - Stream live updates to shared artifacts
- **Analytics** - Send usage data without cluttering message history
- **Notifications** - Display temporary alerts and status messages

## Message Metadata vs Data Parts

Both [message metadata](/docs/ai-sdk-ui/message-metadata) and data parts allow you to send additional information alongside messages, but they serve different purposes:

### Message Metadata

Message metadata is best for **message-level information** that describes the message as a whole:

- Attached at the message level via `message.metadata`
- Sent using the `messageMetadata` callback in `toUIMessageStreamResponse`
- Ideal for: timestamps, model info, token usage, user context
- Type-safe with custom metadata types

```ts
// Server: Send metadata about the message
return result.toUIMessageStreamResponse({
  messageMetadata: ({ part }) => {
    if (part.type === 'finish') {
      return {
        model: part.response.modelId,
        totalTokens: part.totalUsage.totalTokens,
        createdAt: Date.now(),
      };
    }
  },
});
```

### Data Parts

Data parts are best for streaming **dynamic arbitrary data**:

- Added to the message parts array via `message.parts`
- Streamed using `createUIMessageStream` and `writer.write()`
- Can be reconciled/updated using the same ID
- Support transient parts that don't persist
- Ideal for: dynamic content, loading states, interactive components

```ts
// Server: Stream data as part of message content
writer.write({
  type: 'data-weather',
  id: 'weather-1',
  data: { city: 'San Francisco', status: 'loading' },
});
```

For more details on message metadata, see the [Message Metadata documentation](/docs/ai-sdk-ui/message-metadata).

---
title: Error Handling
description: Learn how to handle errors in the AI SDK UI
---

# Error Handling and warnings

## Warnings

The AI SDK shows warnings when something might not work as expected.
These warnings help you fix problems before they cause errors.

### When Warnings Appear

Warnings are shown in the browser console when:

- **Unsupported features**: You use a feature or setting that is not supported by the AI model (e.g., certain options or parameters).
- **Compatibility warnings**: A feature is used in a compatibility mode, which might work differently or less optimally than intended.
- **Other warnings**: The AI model reports another type of issue, such as general problems or advisory messages.

### Warning Messages

All warnings start with "AI SDK Warning:" so you can easily find them. For example:

```
AI SDK Warning: The feature "temperature" is not supported by this model
```

### Turning Off Warnings

By default, warnings are shown in the console. You can control this behavior:

#### Turn Off All Warnings

Set a global variable to turn off warnings completely:

```ts
globalThis.AI_SDK_LOG_WARNINGS = false;
```

#### Custom Warning Handler

You can also provide your own function to handle warnings.
It receives provider id, model id, and a list of warnings.

```ts
globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
  // Handle warnings your own way
};
```

## Error Handling

### Error Helper Object

Each AI SDK UI hook also returns an [error](/docs/reference/ai-sdk-ui/use-chat#error) object that you can use to render the error in your UI.
You can use the error object to show an error message, disable the submit button, or show a retry button.

<Note>
  We recommend showing a generic error message to the user, such as "Something
  went wrong." This is a good practice to avoid leaking information from the
  server.
</Note>

```tsx file="app/page.tsx" highlight="7,18-25,31"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, error, regenerate } = useChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}:{' '}
          {m.parts
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('')}
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

      <form onSubmit={handleSubmit}>
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

#### Alternative: replace last message

Alternatively you can write a custom submit handler that replaces the last message when an error is present.

```tsx file="app/page.tsx" highlight="17-23,35"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');
  const { sendMessage, error, messages, setMessages } = useChat();

  function customSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (error != null) {
      setMessages(messages.slice(0, -1)); // remove last message
    }

    sendMessage({ text: input });
    setInput('');
  }

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>
          {m.role}:{' '}
          {m.parts
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('')}
        </div>
      ))}

      {error && <div>An error occurred.</div>}

      <form onSubmit={customSubmit}>
        <input value={input} onChange={e => setInput(e.target.value)} />
      </form>
    </div>
  );
}
```

### Error Handling Callback

Errors can be processed by passing an [`onError`](/docs/reference/ai-sdk-ui/use-chat#on-error) callback function as an option to the [`useChat`](/docs/reference/ai-sdk-ui/use-chat) or [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion) hooks.
The callback function receives an error object as an argument.

```tsx file="app/page.tsx" highlight="6-9"
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
title: Transport
description: Learn how to use custom transports with useChat.
---

# Transport

The `useChat` transport system provides fine-grained control over how messages are sent to your API endpoints and how responses are processed. This is particularly useful for alternative communication protocols like WebSockets, custom authentication patterns, or specialized backend integrations.

## Default Transport

By default, `useChat` uses HTTP POST requests to send messages to `/api/chat`:

```tsx
import { useChat } from '@ai-sdk/react';

// Uses default HTTP transport
const { messages, sendMessage } = useChat();
```

This is equivalent to:

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/chat',
  }),
});
```

## Custom Transport Configuration

Configure the default transport with custom options:

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/custom-chat',
    headers: {
      Authorization: 'Bearer your-token',
      'X-API-Version': '2024-01',
    },
    credentials: 'include',
  }),
});
```

### Dynamic Configuration

You can also provide functions that return configuration values. This is useful for authentication tokens that need to be refreshed, or for configuration that depends on runtime conditions:

```tsx
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/chat',
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

### Request Transformation

Transform requests before sending to your API:

```tsx
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => {
      return {
        headers: {
          'X-Session-ID': id,
        },
        body: {
          messages: messages.slice(-10), // Only send last 10 messages
          trigger,
          messageId,
        },
      };
    },
  }),
});
```

## Direct Agent Transport

For scenarios where you want to communicate directly with an [Agent](/docs/reference/ai-sdk-core/agent) without going through HTTP, you can use `DirectChatTransport`. This transport invokes the agent's `stream()` method directly in-process.

This is useful for:

- **Server-side rendering**: Run the agent on the server without an API endpoint
- **Testing**: Test chat functionality without network requests
- **Single-process applications**: Desktop or CLI apps where client and agent run together

```tsx
import { useChat } from '@ai-sdk/react';
import { DirectChatTransport, ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: 'You are a helpful assistant.',
  tools: {
    weather: weatherTool,
  },
});

const { messages, sendMessage } = useChat({
  transport: new DirectChatTransport({ agent }),
});
```

### How It Works

Unlike `DefaultChatTransport` which sends HTTP requests:

1. `DirectChatTransport` validates incoming UI messages
2. Converts them to model messages using `convertToModelMessages`
3. Calls the agent's `stream()` method directly
4. Returns the result as a UI message stream via `toUIMessageStream()`

### Configuration Options

You can pass additional options to customize the stream output:

```tsx
const transport = new DirectChatTransport({
  agent,
  // Pass options to the agent
  options: { customOption: 'value' },
  // Configure what's sent to the client
  sendReasoning: true,
  sendSources: true,
});
```

<Note>
  `DirectChatTransport` does not support stream reconnection since there is no
  persistent server-side stream. The `reconnectToStream()` method always returns
  `null`.
</Note>

For complete API details, see the [DirectChatTransport reference](/docs/reference/ai-sdk-ui/direct-chat-transport).

## Workflow Transport

For chat apps built on [Vercel Workflows](/docs/agents/workflow-agent), `WorkflowChatTransport` from `@ai-sdk/workflow` provides automatic stream reconnection. It handles the common scenario where a workflow function times out mid-stream — the transport detects the missing `finish` event and reconnects to resume from where it left off.

```tsx
import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { useMemo } from 'react';

export default function Chat() {
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: '/api/chat',
        maxConsecutiveErrors: 5,
        initialStartIndex: -50, // On page refresh, fetch last 50 chunks
        onChatEnd: ({ chatId, chunkIndex }) => {
          console.log(`Chat complete: ${chunkIndex} chunks`);
        },
      }),
    [],
  );

  const { messages, sendMessage } = useChat({ transport });

  // ... render chat UI
}
```

Key features:

- **Automatic reconnection**: Detects interrupted streams (no `finish` event) and reconnects via GET to `{api}/{runId}/stream`
- **Page refresh recovery**: `initialStartIndex` with negative values (e.g., `-50`) fetches only the tail of the stream instead of replaying everything
- **Configurable retries**: `maxConsecutiveErrors` controls how many consecutive reconnection failures to tolerate
- **Lifecycle callbacks**: `onChatSendMessage` and `onChatEnd` for tracking chat state

For the full API reference, see [`WorkflowChatTransport`](/docs/reference/ai-sdk-workflow/workflow-chat-transport). For server-side endpoint setup, see the [WorkflowAgent guide](/docs/agents/workflow-agent#resumable-streaming-with-workflowchattransport).

## Building Custom Transports

To understand how to build your own transport, refer to the source code of the default implementation:

- **[DefaultChatTransport](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/default-chat-transport.ts)** - The complete default HTTP transport implementation
- **[HttpChatTransport](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/http-chat-transport.ts)** - Base HTTP transport with request handling
- **[ChatTransport Interface](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts)** - The transport interface you need to implement

These implementations show you exactly how to:

- Handle the `sendMessages` method
- Process UI message streams
- Transform requests and responses
- Handle errors and connection management

The transport system gives you complete control over how your chat application communicates, enabling integration with any backend protocol or service.

---
title: Reading UIMessage Streams
description: Learn how to read UIMessage streams.
---

# Reading UI Message Streams

`UIMessage` streams are useful outside of traditional chat use cases. You can consume them for terminal UIs, custom stream processing on the client, or React Server Components (RSC).

The `readUIMessageStream` helper transforms a stream of `UIMessageChunk` objects into an `AsyncIterableStream` of `UIMessage` objects, allowing you to process messages as they're being constructed.

## Basic Usage

```tsx
import { readUIMessageStream, streamText } from 'ai';
__PROVIDER_IMPORT__;

async function main() {
  const result = streamText({
    model: __MODEL__,
    prompt: 'Write a short story about a robot.',
  });

  for await (const uiMessage of readUIMessageStream({
    stream: result.toUIMessageStream(),
  })) {
    console.log('Current message state:', uiMessage);
  }
}
```

## Tool Calls Integration

Handle streaming responses that include tool calls:

```tsx
import { readUIMessageStream, streamText, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

async function handleToolCalls() {
  const result = streamText({
    model: __MODEL__,
    tools: {
      weather: tool({
        description: 'Get the weather in a location',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: ({ location }) => ({
          location,
          temperature: 72 + Math.floor(Math.random() * 21) - 10,
        }),
      }),
    },
    prompt: 'What is the weather in Tokyo?',
  });

  for await (const uiMessage of readUIMessageStream({
    stream: result.toUIMessageStream(),
  })) {
    // Handle different part types
    uiMessage.parts.forEach(part => {
      switch (part.type) {
        case 'text':
          console.log('Text:', part.text);
          break;
        case 'tool-call':
          console.log('Tool called:', part.toolName, 'with args:', part.args);
          break;
        case 'tool-result':
          console.log('Tool result:', part.result);
          break;
      }
    });
  }
}
```

## Resuming Conversations

Resume streaming from a previous message state:

```tsx
import { readUIMessageStream, streamText } from 'ai';
__PROVIDER_IMPORT__;

async function resumeConversation(lastMessage: UIMessage) {
  const result = streamText({
    model: __MODEL__,
    messages: [
      { role: 'user', content: 'Continue our previous conversation.' },
    ],
  });

  // Resume from the last message
  for await (const uiMessage of readUIMessageStream({
    stream: result.toUIMessageStream(),
    message: lastMessage, // Resume from this message
  })) {
    console.log('Resumed message:', uiMessage);
  }
}
```

---
title: Message Metadata
description: Learn how to attach and use metadata with messages in AI SDK UI
---

# Message Metadata

Message metadata allows you to attach custom information to messages at the message level. This is useful for tracking timestamps, model information, token usage, user context, and other message-level data.

## Overview

Message metadata differs from [data parts](/docs/ai-sdk-ui/streaming-data) in that it's attached at the message level rather than being part of the message content. While data parts are ideal for dynamic content that forms part of the message, metadata is perfect for information about the message itself.

## Getting Started

Here's a simple example of using message metadata to track timestamps and model information:

### Defining Metadata Types

First, define your metadata type for type safety:

```tsx filename="app/types.ts"
import { UIMessage } from 'ai';
import { z } from 'zod';

// Define your metadata schema
export const messageMetadataSchema = z.object({
  createdAt: z.number().optional(),
  model: z.string().optional(),
  totalTokens: z.number().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

// Create a typed UIMessage
export type MyUIMessage = UIMessage<MessageMetadata>;
```

### Sending Metadata from the Server

Use the `messageMetadata` callback in `toUIMessageStreamResponse` to send metadata at different streaming stages:

```ts filename="app/api/chat/route.ts" highlight="11-20"
import { convertToModelMessages, streamText } from 'ai';
__PROVIDER_IMPORT__;
import type { MyUIMessage } from '@/types';

export async function POST(req: Request) {
  const { messages }: { messages: MyUIMessage[] } = await req.json();

  const result = streamText({
    model: __MODEL__,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages, // pass this in for type-safe return objects
    messageMetadata: ({ part }) => {
      // Send metadata when streaming starts
      if (part.type === 'start') {
        return {
          createdAt: Date.now(),
          model: 'your-model-id',
        };
      }

      // Send additional metadata when streaming completes
      if (part.type === 'finish') {
        return {
          totalTokens: part.totalUsage.totalTokens,
        };
      }
    },
  });
}
```

<Note>
  To enable type-safe metadata return object in `messageMetadata`, pass in the
  `originalMessages` parameter typed to your UIMessage type.
</Note>

### Accessing Metadata on the Client

Access metadata through the `message.metadata` property:

```tsx filename="app/page.tsx" highlight="8,18-23"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { MyUIMessage } from '@/types';

export default function Chat() {
  const { messages } = useChat<MyUIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>
            {message.role === 'user' ? 'User: ' : 'AI: '}
            {message.metadata?.createdAt && (
              <span className="text-sm text-gray-500">
                {new Date(message.metadata.createdAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Render message content */}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <div key={index}>{part.text}</div> : null,
          )}

          {/* Display additional metadata */}
          {message.metadata?.totalTokens && (
            <div className="text-xs text-gray-400">
              {message.metadata.totalTokens} tokens
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

<Note>
  For streaming arbitrary data that changes during generation, consider using
  [data parts](/docs/ai-sdk-ui/streaming-data) instead.
</Note>

## Common Use Cases

Message metadata is ideal for:

- **Timestamps**: When messages were created or completed
- **Model Information**: Which AI model was used
- **Token Usage**: Track costs and usage limits
- **User Context**: User IDs, session information
- **Performance Metrics**: Generation time, time to first token
- **Quality Indicators**: Finish reason, confidence scores

## See Also

- [Chatbot Guide](/docs/ai-sdk-ui/chatbot#message-metadata) - Message metadata in the context of building chatbots
- [Streaming Data](/docs/ai-sdk-ui/streaming-data#message-metadata-vs-data-parts) - Comparison with data parts
- [UIMessage Reference](/docs/reference/ai-sdk-core/ui-message) - Complete UIMessage type reference

---
title: WorkflowAgent
description: API Reference for the WorkflowAgent class.
---

# `WorkflowAgent`

Creates a durable, resumable AI agent for use inside Vercel Workflows. `WorkflowAgent` handles the agent loop, tool schema serialization across workflow step boundaries, and built-in tool approval flows.

Unlike [`ToolLoopAgent`](/docs/reference/ai-sdk-core/tool-loop-agent) from the `ai` package, `WorkflowAgent` is designed to survive process restarts, pause for human approval, and integrate with the Workflow DevKit's step mechanism.

```ts
import { WorkflowAgent } from '@ai-sdk/workflow';
import { tool } from 'ai';
import { z } from 'zod';

const agent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'You are a helpful assistant.',
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72,
      }),
    }),
  },
});

const result = await agent.stream({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in NYC?' }] }],
});

console.log(result.messages);
```

To see `WorkflowAgent` in action, check out [these examples](#examples).

## Import

<Snippet text={`import { WorkflowAgent } from "@ai-sdk/workflow"`} prompt={false} />

## Constructor

### Parameters

<PropertiesTable
  content={[
    {
      name: 'id',
      type: 'string',
      isOptional: true,
      description: 'The id of the agent.',
    },
    {
      name: 'model',
      type: 'LanguageModel',
      isRequired: true,
      description:
        'The language model to use. A string compatible with the Vercel AI Gateway (e.g., \'anthropic/claude-sonnet-4-6\') or a provider instance (e.g., `openai(\'gpt-4o\')`).',
    },
    {
      name: 'instructions',
      type: 'string | SystemModelMessage | SystemModelMessage[]',
      isOptional: true,
      description:
        'Instructions for the agent, used as the system prompt. Supports provider-specific options (e.g., caching) when using the SystemModelMessage form.',
    },
    {
      name: 'tools',
      type: 'Record<string, Tool>',
      isOptional: true,
      description:
        'A set of tools the agent can call. Keys are tool names. Tools are serialized to JSON Schema across workflow step boundaries and validated with Ajv at runtime.',
    },
    {
      name: 'toolChoice',
      type: 'ToolChoice',
      isOptional: true,
      description:
        "Tool call selection strategy. Options: 'auto' | 'none' | 'required' | { type: 'tool', toolName: string }. Default: 'auto'.",
    },
    {
      name: 'stopWhen',
      type: 'StopCondition | StopCondition[]',
      isOptional: true,
      description: 'Default stop condition for the agent loop. Per-stream values override this default. Use `isLoopFinished()` to let the agent run until all tool calls have completed, but beware of potential runaway loops. See https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/loop-finished#isloopfinished.',
    },
    {
      name: 'activeTools',
      type: 'Array<string>',
      isOptional: true,
      description: 'Default set of active tools. Limits which tools the model can call. Per-stream values override this default.',
    },
    {
      name: 'output',
      type: 'OutputSpecification',
      isOptional: true,
      description: 'Default structured output specification. Per-stream values override this default.',
    },
    {
      name: 'experimental_repairToolCall',
      type: 'ToolCallRepairFunction',
      isOptional: true,
      description: 'Default function to repair tool calls that fail to parse. Per-stream values override this default.',
    },
    {
      name: 'experimental_download',
      type: 'DownloadFunction',
      isOptional: true,
      description: 'Default custom download function for URLs. Per-stream values override this default.',
    },
    {
      name: 'prepareStep',
      type: 'PrepareStepCallback',
      isOptional: true,
      description:
        'Callback called before each step in the agent loop. Use it to modify settings, manage context, or inject messages dynamically. Receives step number, previous steps, messages, and context.',
    },
    {
      name: 'prepareCall',
      type: 'PrepareCallCallback',
      isOptional: true,
      description:
        'Callback called once before the agent loop starts. Use it to transform model, instructions, tools configuration, or other settings based on runtime context. Cannot override `tools` (bound at construction for type safety).',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      isOptional: true,
      description:
        'Default context passed into tool execution and lifecycle callbacks for every stream call. Per-call values override this default. Experimental (can break in patch releases).',
    },
    {
      name: 'telemetry',
      type: 'TelemetryOptions',
      isOptional: true,
      description:
        'Telemetry configuration with options for enabling/disabling telemetry, setting a function ID, and recording inputs/outputs.',
    },
    {
      name: 'experimental_onStart',
      type: 'WorkflowAgentOnStartCallback',
      isOptional: true,
      description:
        'Callback called when the agent starts streaming, before any LLM calls. Receives the model and messages. If also specified in `stream()`, both callbacks fire (constructor first). Experimental (can break in patch releases).',
      properties: [
        {
          type: 'OnStartEvent',
          parameters: [
            {
              name: 'model',
              type: 'LanguageModel',
              description: 'The model being used for the generation.',
            },
            {
              name: 'messages',
              type: 'Array<ModelMessage>',
              description: 'The messages being sent to the model.',
            },
          ],
        },
      ],
    },
    {
      name: 'experimental_onStepStart',
      type: 'WorkflowAgentOnStepStartCallback',
      isOptional: true,
      description:
        'Callback called before each step (LLM call) begins. Receives step number, model, and messages. If also specified in `stream()`, both callbacks fire (constructor first). Experimental (can break in patch releases).',
      properties: [
        {
          type: 'OnStepStartEvent',
          parameters: [
            {
              name: 'stepNumber',
              type: 'number',
              description: 'Zero-based index of the current step.',
            },
            {
              name: 'model',
              type: 'LanguageModel',
              description: 'The model being used for this step.',
            },
            {
              name: 'messages',
              type: 'Array<ModelMessage>',
              description: 'The messages that will be sent to the model for this step.',
            },
            {
              name: 'steps',
              type: 'ReadonlyArray<StepResult>',
              description: 'Results from all previously finished steps.',
            },
          ],
        },
      ],
    },
    {
      name: 'experimental_onToolExecutionStart',
      type: 'WorkflowAgentonToolExecutionStartCallback',
      isOptional: true,
      description:
        "Callback called right before a tool's execute function runs. If also specified in `stream()`, both callbacks fire (constructor first). Experimental (can break in patch releases).",
      properties: [
        {
          type: 'ToolExecutionStartEvent',
          parameters: [
            {
              name: 'toolCall',
              type: '{ type: "tool-call"; toolCallId: string; toolName: string; input: unknown }',
              description: 'The tool call being executed.',
            },
            {
              name: 'stepNumber',
              type: 'number',
              description: 'Zero-based index of the current step.',
            },
          ],
        },
      ],
    },
    {
      name: 'experimental_onToolExecutionEnd',
      type: 'WorkflowAgentonToolExecutionEndCallback',
      isOptional: true,
      description:
        "Callback called right after a tool's execute function completes or errors. Uses a discriminated union: check `success` to determine whether `output` or `error` is available. If also specified in `stream()`, both callbacks fire (constructor first). Experimental (can break in patch releases).",
      properties: [
        {
          type: 'ToolExecutionEndEvent',
          parameters: [
            {
              name: 'toolCall',
              type: '{ type: "tool-call"; toolCallId: string; toolName: string; input: unknown }',
              description: 'The tool call that was executed.',
            },
            {
              name: 'stepNumber',
              type: 'number',
              description: 'Zero-based index of the current step.',
            },
            {
              name: 'durationMs',
              type: 'number',
              description: 'Tool execution time in milliseconds.',
            },
            {
              name: 'success',
              type: 'boolean',
              description: 'Whether the tool call succeeded. When true, `output` is available. When false, `error` is available.',
            },
            {
              name: 'output',
              type: 'unknown',
              description: 'The tool result (only when success is true).',
            },
            {
              name: 'error',
              type: 'unknown',
              description: 'The error that occurred (only when success is false).',
            },
          ],
        },
      ],
    },
    {
      name: 'onStepFinish',
      type: 'WorkflowAgentOnStepFinishCallback',
      isOptional: true,
      description:
        'Callback invoked after each agent step completes. If also specified in `stream()`, both callbacks fire (constructor first).',
    },
    {
      name: 'onFinish',
      type: 'WorkflowAgentOnFinishCallback',
      isOptional: true,
      description:
        'Callback called when all agent steps are finished and the response is complete. Receives steps, messages, text, finish reason, total usage, and context. If also specified in `stream()`, both callbacks fire (constructor first).',
    },
    {
      name: 'maxOutputTokens',
      type: 'number',
      isOptional: true,
      description: 'Maximum number of tokens the model is allowed to generate.',
    },
    {
      name: 'temperature',
      type: 'number',
      isOptional: true,
      description: 'Sampling temperature, controls randomness.',
    },
    {
      name: 'topP',
      type: 'number',
      isOptional: true,
      description: 'Top-p (nucleus) sampling parameter.',
    },
    {
      name: 'topK',
      type: 'number',
      isOptional: true,
      description: 'Top-k sampling parameter.',
    },
    {
      name: 'presencePenalty',
      type: 'number',
      isOptional: true,
      description: 'Presence penalty parameter.',
    },
    {
      name: 'frequencyPenalty',
      type: 'number',
      isOptional: true,
      description: 'Frequency penalty parameter.',
    },
    {
      name: 'stopSequences',
      type: 'string[]',
      isOptional: true,
      description: 'Custom token sequences which stop the model output.',
    },
    {
      name: 'seed',
      type: 'number',
      isOptional: true,
      description: 'Seed for deterministic generation (if supported).',
    },
    {
      name: 'maxRetries',
      type: 'number',
      isOptional: true,
      description: 'How many times to retry on failure. Default: 2.',
    },
    {
      name: 'headers',
      type: 'Record<string, string | undefined>',
      isOptional: true,
      description: 'Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.',
    },
    {
      name: 'providerOptions',
      type: 'ProviderOptions',
      isOptional: true,
      description: 'Additional provider-specific configuration.',
    },
  ]}
/>

## Properties

<PropertiesTable
  content={[
    {
      name: 'id',
      type: 'string | undefined',
      description: 'The id of the agent. Used for telemetry identification. Read-only.',
    },
    {
      name: 'tools',
      type: 'Record<string, Tool>',
      description: 'The tool set configured for this agent. Read-only.',
    },
  ]}
/>

## Methods

### `stream()`

Runs the agent loop, streaming responses and executing tool calls as needed. Returns a promise resolving to a `WorkflowAgentStreamResult`.

```ts
const result = await agent.stream({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
});
```

<PropertiesTable
  content={[
    {
      name: 'prompt',
      type: 'string | Array<ModelMessage>',
      description: 'A prompt string or a list of messages. You can either use `prompt` or `messages` but not both.',
    },
    {
      name: 'messages',
      type: 'Array<ModelMessage>',
      description: 'The conversation messages to process. You can either use `prompt` or `messages` but not both.',
    },
    {
      name: 'writable',
      type: 'WritableStream<ModelCallStreamPart>',
      isOptional: true,
      description:
        'A writable stream that receives raw model stream parts in real-time. Convert to UI message chunks at the response boundary using `createModelCallToUIChunkTransform()`.',
    },
    {
      name: 'system',
      type: 'string',
      isOptional: true,
      description: 'Override the system prompt for this call.',
    },
    {
      name: 'stopWhen',
      type: 'StopCondition | StopCondition[]',
      isOptional: true,
      description: 'Condition(s) for ending the agent loop. Use `isLoopFinished()` to let the agent run until all tool calls have completed, but beware of potential runaway loops. See https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/loop-finished#isloopfinished.',
    },

    {
      name: 'toolChoice',
      type: 'ToolChoice',
      isOptional: true,
      description: "Override the tool choice strategy for this call. Default: 'auto'.",
    },
    {
      name: 'activeTools',
      type: 'Array<string>',
      isOptional: true,
      description: 'Limits the subset of tools available for this call.',
    },
    {
      name: 'output',
      type: 'OutputSpecification',
      isOptional: true,
      description:
        'Structured output specification. Use `Output.object({ schema })` for typed objects or `Output.text()` for text.',
    },
    {
      name: 'timeout',
      type: 'number',
      isOptional: true,
      description: 'Timeout in milliseconds. Creates an AbortSignal that aborts the operation after the given time.',
    },
    {
      name: 'sendFinish',
      type: 'boolean',
      isOptional: true,
      description: "Whether to send a 'finish' chunk to the writable stream when streaming completes. Default: true.",
    },
    {
      name: 'preventClose',
      type: 'boolean',
      isOptional: true,
      description: 'Whether to prevent the writable stream from being closed after streaming completes. Default: false.',
    },
    {
      name: 'includeRawChunks',
      type: 'boolean',
      isOptional: true,
      description: 'Include raw, unprocessed chunks from the provider in the stream. Default: false.',
    },
    {
      name: 'experimental_repairToolCall',
      type: 'ToolCallRepairFunction',
      isOptional: true,
      description: 'Callback to attempt automatic recovery when a tool call cannot be parsed.',
    },
    {
      name: 'experimental_transform',
      type: 'StreamTextTransform | Array<StreamTextTransform>',
      isOptional: true,
      description: 'Stream transformations applied in order. Must maintain the stream structure.',
    },
    {
      name: 'experimental_download',
      type: 'DownloadFunction',
      isOptional: true,
      description: 'Custom download function for fetching files/URLs.',
    },
    {
      name: 'telemetry',
      type: 'TelemetryOptions',
      isOptional: true,
      description: 'Per-call telemetry configuration.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      isOptional: true,
      description: 'Per-call context override. Overrides the constructor default.',
    },
    {
      name: 'prepareStep',
      type: 'PrepareStepCallback',
      isOptional: true,
      description: 'Per-call prepareStep override.',
    },
    {
      name: 'experimental_onStart',
      type: 'WorkflowAgentOnStartCallback',
      isOptional: true,
      description:
        'Per-call onStart callback. If also specified in the constructor, both fire (constructor first). Experimental.',
    },
    {
      name: 'experimental_onStepStart',
      type: 'WorkflowAgentOnStepStartCallback',
      isOptional: true,
      description:
        'Per-call onStepStart callback. If also specified in the constructor, both fire (constructor first). Experimental.',
    },
    {
      name: 'experimental_onToolExecutionStart',
      type: 'WorkflowAgentonToolExecutionStartCallback',
      isOptional: true,
      description:
        'Per-call onToolExecutionStart callback. If also specified in the constructor, both fire (constructor first). Experimental.',
    },
    {
      name: 'experimental_onToolExecutionEnd',
      type: 'WorkflowAgentonToolExecutionEndCallback',
      isOptional: true,
      description:
        'Per-call onToolExecutionEnd callback. If also specified in the constructor, both fire (constructor first). Experimental.',
    },
    {
      name: 'onStepFinish',
      type: 'WorkflowAgentOnStepFinishCallback',
      isOptional: true,
      description:
        'Per-call onStepFinish callback. If also specified in the constructor, both fire (constructor first).',
    },
    {
      name: 'onFinish',
      type: 'WorkflowAgentOnFinishCallback',
      isOptional: true,
      description:
        'Per-call onFinish callback. If also specified in the constructor, both fire (constructor first).',
    },
    {
      name: 'onError',
      type: 'WorkflowAgentOnErrorCallback',
      isOptional: true,
      description: 'Callback invoked when an error occurs during streaming.',
    },
    {
      name: 'onAbort',
      type: 'WorkflowAgentOnAbortCallback',
      isOptional: true,
      description: 'Callback invoked when the operation is aborted. Receives all previously finished steps.',
    },
  ]}
/>

#### Returns

Returns a `Promise<WorkflowAgentStreamResult>` with the following properties:

<PropertiesTable
  content={[
    {
      name: 'messages',
      type: 'Array<ModelMessage>',
      description: 'The final messages including all tool calls and results.',
    },
    {
      name: 'steps',
      type: 'Array<StepResult>',
      description: 'Details for all steps taken by the agent.',
    },
    {
      name: 'toolCalls',
      type: 'Array<ToolCall>',
      description: 'Tool calls from the last step, including unexecuted calls (e.g., tools requiring approval).',
    },
    {
      name: 'toolResults',
      type: 'Array<ToolResult>',
      description: 'Tool results from the last step. Only includes results for tools that were executed.',
    },
    {
      name: 'output',
      type: 'OUTPUT',
      description: 'The structured output if an `output` specification was provided.',
    },
  ]}
/>

## Utilities

### `createModelCallToUIChunkTransform()`

Creates a `TransformStream` that converts raw `ModelCallStreamPart` chunks (written by the agent to the `writable` stream) into `UIMessageChunk` objects suitable for client consumption.

```ts
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';

return createUIMessageStreamResponse({
  stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
});
```

### `toUIMessageChunk()`

Converts a single `ModelCallStreamPart` to a `UIMessageChunk`. Returns `undefined` for parts that don't map to UI chunks.

```ts
import { toUIMessageChunk } from '@ai-sdk/workflow';

const uiChunk = toUIMessageChunk(modelCallPart);
```

## Types

### `InferWorkflowAgentUIMessage`

Infers the UI message type for a `WorkflowAgent` instance. Optionally accepts a second type argument for custom message metadata.

```ts
import { WorkflowAgent, InferWorkflowAgentUIMessage } from '@ai-sdk/workflow';

const agent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
  tools: { weather: weatherTool },
});

type MyAgentUIMessage = InferWorkflowAgentUIMessage<typeof agent>;
```

### `InferWorkflowAgentTools`

Infers the tool set type of a `WorkflowAgent` instance.

```ts
import { WorkflowAgent, InferWorkflowAgentTools } from '@ai-sdk/workflow';

type MyTools = InferWorkflowAgentTools<typeof myAgent>;
```

## Examples

### Basic Agent with Tools

```ts
import { WorkflowAgent } from '@ai-sdk/workflow';
import { tool } from 'ai';
import { z } from 'zod';

const agent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'You are a helpful assistant.',
  tools: {
    weather: tool({
      description: 'Get weather for a location',
      inputSchema: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72,
        condition: 'sunny',
      }),
    }),
  },
});

const result = await agent.stream({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is the weather in NYC?' }] },
  ],
});

console.log(result.messages);
console.log(result.steps);
```

### Agent in a Workflow with Durable Tools

```ts filename="workflow/agent-chat.ts"
import { WorkflowAgent, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { convertToModelMessages, tool, type UIMessage } from 'ai';
import { getWritable } from 'workflow';
import { z } from 'zod';

// Tool execute functions marked with 'use step' become durable workflow steps
// with automatic retries and persistence
async function searchFlightsStep(input: {
  origin: string;
  destination: string;
}) {
  'use step';
  const response = await fetch(`https://api.flights.example/search?...`);
  return response.json();
}

export async function chat(messages: UIMessage[]) {
  'use workflow';

  const modelMessages = await convertToModelMessages(messages);

  const agent = new WorkflowAgent({
    model: 'anthropic/claude-sonnet-4-6',
    instructions: 'You are a flight booking assistant.',
    tools: {
      searchFlights: tool({
        description: 'Search for available flights',
        inputSchema: z.object({
          origin: z.string(),
          destination: z.string(),
        }),
        execute: searchFlightsStep,
      }),
    },
  });

  const result = await agent.stream({
    messages: modelMessages,
    writable: getWritable<ModelCallStreamPart>(),
  });

  return { messages: result.messages };
}
```

```ts filename="app/api/chat/route.ts"
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';
import { chat } from '@/workflow/agent-chat';

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const run = await start(chat, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
  });
}
```

### Agent with Structured Output

```ts
import { WorkflowAgent, Output } from '@ai-sdk/workflow';
import { z } from 'zod';

const analysisAgent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
});

const result = await analysisAgent.stream({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Analyze: "The product exceeded my expectations!"' }] },
  ],
  output: Output.object({
    schema: z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      score: z.number(),
      summary: z.string(),
    }),
  }),
});

console.log(result.output);
// { sentiment: 'positive', score: 9, summary: '...' }
```

### Agent with Tool Approval

```ts
import { WorkflowAgent } from '@ai-sdk/workflow';
import { tool } from 'ai';
import { z } from 'zod';

const agent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
  tools: {
    bookFlight: tool({
      description: 'Book a flight',
      inputSchema: z.object({
        flightId: z.string(),
        passengerName: z.string(),
      }),
      needsApproval: true, // Pauses the agent until user approves
      execute: bookFlightStep,
    }),
  },
});
```

### Agent with Lifecycle Callbacks

```ts
import { WorkflowAgent } from '@ai-sdk/workflow';

const agent = new WorkflowAgent({
  model: 'anthropic/claude-sonnet-4-6',
  tools: { weather: weatherTool },

  // Agent-wide callbacks
  onStepFinish({ usage }) {
    console.log('Tokens used:', usage.totalTokens);
  },
});

const result = await agent.stream({
  messages,

  // Per-call callbacks (both fire)
  onStepFinish({ usage }) {
    await trackUsage(usage);
  },

  onFinish({ steps, totalUsage }) {
    console.log(`Done in ${steps.length} steps, ${totalUsage.totalTokens} tokens`);
  },
});
```

---
title: WorkflowChatTransport
description: API Reference for the WorkflowChatTransport class.
---

# `WorkflowChatTransport`

A [`ChatTransport`](/docs/ai-sdk-ui/transport) implementation for [`useChat`](/docs/reference/ai-sdk-ui/use-chat) that enables automatic stream reconnection for workflow-based chat apps. It posts messages to a chat endpoint, extracts the `x-workflow-run-id` response header, and reconnects to a `/{runId}/stream` endpoint on interruption (network failures, page refreshes, function timeouts).

Unlike [`DefaultChatTransport`](/docs/ai-sdk-ui/transport) which assumes the full response arrives in a single HTTP request, `WorkflowChatTransport` is designed for [Vercel Workflows](https://vercel.com/docs/workflow) where the initial response stream may be interrupted by function timeouts. The transport automatically detects missing `finish` events and reconnects to resume from where the stream left off.

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';

export default function Chat() {
  const { messages, sendMessage } = useChat({
    transport: new WorkflowChatTransport({
      api: '/api/chat',
      maxConsecutiveErrors: 5,
      initialStartIndex: -50,
    }),
  });

  // ... render chat UI
}
```

## Import

<Snippet text={`import { WorkflowChatTransport } from "@ai-sdk/workflow"`} prompt={false} />

## Constructor

### Parameters

<PropertiesTable
  content={[
    {
      name: 'api',
      type: 'string',
      isOptional: true,
      description:
        "API endpoint for chat requests. The reconnection endpoint is derived from this as `{api}/{runId}/stream`. Default: '/api/chat'.",
    },
    {
      name: 'fetch',
      type: 'typeof fetch',
      isOptional: true,
      description:
        'Custom fetch implementation to use for HTTP requests. Default: global fetch.',
    },
    {
      name: 'maxConsecutiveErrors',
      type: 'number',
      isOptional: true,
      description:
        'Maximum number of consecutive errors allowed during reconnection attempts before giving up. Default: 3.',
    },
    {
      name: 'initialStartIndex',
      type: 'number',
      isOptional: true,
      description:
        'Default chunk index to start from when reconnecting. Negative values read from the end of the stream (e.g., -50 fetches the last 50 chunks), useful for resuming after a page refresh without replaying the full conversation. Can be overridden per-call via reconnectToStream options. Default: 0.',
    },
    {
      name: 'onChatSendMessage',
      type: '(response: Response, options: SendMessagesOptions) => void | Promise<void>',
      isOptional: true,
      description:
        'Callback invoked after the initial POST request succeeds. Useful for inspecting response headers (e.g., extracting workflow run ID) or tracking chat history on the client side.',
    },
    {
      name: 'onChatEnd',
      type: '({ chatId, chunkIndex }) => void | Promise<void>',
      isOptional: true,
      description:
        'Callback invoked when the stream ends (receives a finish chunk). Receives the chat ID and total chunk count. Useful for cleanup or state updates.',
    },
    {
      name: 'prepareSendMessagesRequest',
      type: 'PrepareSendMessagesRequest',
      isOptional: true,
      description:
        'Function to customize the POST request before sending. Can override the API endpoint, headers, credentials, and body.',
    },
    {
      name: 'prepareReconnectToStreamRequest',
      type: 'PrepareReconnectToStreamRequest',
      isOptional: true,
      description:
        'Function to customize the reconnection GET request. Can override the API endpoint, headers, and credentials.',
    },
  ]}
/>

## Methods

### `sendMessages()`

Sends messages to the chat endpoint via POST and returns a streaming response. If the stream is interrupted (no `finish` event received), the transport automatically reconnects via GET to `{api}/{runId}/stream?startIndex={chunkIndex}` to resume from where it left off.

The POST request includes the messages as JSON and expects the response to include an `x-workflow-run-id` header identifying the workflow run.

```ts
const stream = await transport.sendMessages({
  chatId: 'chat-123',
  trigger: 'submit-message',
  messages: [...],
  abortSignal: controller.signal,
});
```

<PropertiesTable
  content={[
    {
      name: 'chatId',
      type: 'string',
      description: 'Unique identifier for the chat session.',
    },
    {
      name: 'trigger',
      type: "'submit-message' | 'regenerate-message'",
      description:
        'The type of message submission.',
    },
    {
      name: 'messageId',
      type: 'string | undefined',
      description:
        'ID of the message to regenerate, or undefined for new messages.',
    },
    {
      name: 'messages',
      type: 'UIMessage[]',
      description:
        'Array of UI messages representing the conversation history.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Signal to abort the request. Propagated to both the initial POST and any reconnection GET requests.',
    },
  ]}
/>

#### Returns

Returns a `Promise<ReadableStream<UIMessageChunk>>` that includes chunks from both the initial POST response and any automatic reconnection.

### `reconnectToStream()`

Reconnects to an existing chat stream that was previously interrupted. Useful for resuming after a page refresh or when the client needs to re-establish a connection.

```ts
const stream = await transport.reconnectToStream({
  chatId: 'chat-123',
  startIndex: -50, // Optional: fetch last 50 chunks
});
```

<PropertiesTable
  content={[
    {
      name: 'chatId',
      type: 'string',
      description: 'The chat ID to reconnect to. Used to construct the reconnection URL.',
    },
    {
      name: 'abortSignal',
      type: 'AbortSignal | undefined',
      description: 'Signal to abort the reconnection request.',
    },
    {
      name: 'startIndex',
      type: 'number',
      isOptional: true,
      description: "Override the start index for this reconnection. Negative values read from the end of the stream. When omitted, falls back to the constructor's initialStartIndex.",
    },
  ]}
/>

#### Returns

Returns a `Promise<ReadableStream<UIMessageChunk> | null>`.

## How Reconnection Works

The transport follows this flow:

1. **POST** to `{api}` with messages. The response must include an `x-workflow-run-id` header.
2. **Stream** the SSE response, counting chunks as they arrive.
3. **Detect interruption**: If the stream closes without a `finish` event (e.g., function timeout, network error), the transport knows the response is incomplete.
4. **Reconnect** via GET to `{api}/{runId}/stream?startIndex={chunkIndex}` to resume from the last received chunk.
5. **Retry**: If the reconnection stream also interrupts, retry up to `maxConsecutiveErrors` times.
6. **Complete**: Once a `finish` event is received, call `onChatEnd` and close the stream.

### Negative Start Index

When `initialStartIndex` is negative (e.g., `-50`), the transport sends it as-is in the first reconnection request. The server should resolve this to an absolute position and return the `x-workflow-stream-tail-index` response header so the transport can compute the correct position for subsequent retries.

If the header is missing or invalid, the transport falls back to replaying from the beginning (`startIndex=0`).

## Server Requirements

For `WorkflowChatTransport` to work, your server must provide two endpoints:

### POST `{api}` (e.g., `/api/chat`)

- Accept messages as JSON body
- Return an SSE stream of `UIMessageChunk` events
- Include an `x-workflow-run-id` response header

### GET `{api}/{runId}/stream` (e.g., `/api/chat/{runId}/stream`)

- Accept a `startIndex` query parameter
- Return the SSE stream starting from the given chunk index
- For negative `startIndex`, resolve to the tail and include `x-workflow-stream-tail-index` response header

See the [WorkflowAgent guide](/docs/agents/workflow-agent) for complete endpoint examples.

## Examples

### Basic Usage with useChat

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { useMemo } from 'react';

export default function Chat() {
  const transport = useMemo(
    () => new WorkflowChatTransport({ api: '/api/chat' }),
    [],
  );

  const { messages, sendMessage, status } = useChat({ transport });

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <span key={index}>{part.text}</span> : null,
          )}
        </div>
      ))}
      <button onClick={() => sendMessage({ text: 'Hello!' })}>Send</button>
    </div>
  );
}
```

### With Callbacks and Page Refresh Recovery

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { useMemo } from 'react';

export default function Chat() {
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: '/api/chat',
        maxConsecutiveErrors: 5,
        initialStartIndex: -50, // Resume from last 50 chunks on page refresh
        onChatSendMessage: (response) => {
          const runId = response.headers.get('x-workflow-run-id');
          console.log('Workflow run started:', runId);
        },
        onChatEnd: ({ chatId, chunkIndex }) => {
          console.log(`Chat ${chatId} complete, ${chunkIndex} chunks`);
        },
      }),
    [],
  );

  const { messages, sendMessage } = useChat({ transport });

  // ... render chat UI
}
```

### Server-Side Endpoints (Next.js)

```ts filename="app/api/chat/route.ts"
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start } from 'workflow/api';
import { chat } from '@/workflow/agent-chat';

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();
  const run = await start(chat, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: {
      'x-workflow-run-id': run.runId,
    },
  });
}
```

```ts filename="app/api/chat/[runId]/stream/route.ts"
import { createModelCallToUIChunkTransform } from '@ai-sdk/workflow';
import type { NextRequest } from 'next/server';
import { getRun } from 'workflow/api';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const startIndex = Number(
    new URL(request.url).searchParams.get('startIndex') ?? '0',
  );

  const run = await getRun(runId);
  const readable = run
    .getReadable({ startIndex })
    .pipeThrough(createModelCallToUIChunkTransform());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-workflow-run-id': runId,
    },
  });
}
```

---
title: AI SDK Workflow
description: Reference documentation for @ai-sdk/workflow
collapsed: true
---

# AI SDK Workflow

[`@ai-sdk/workflow`](/docs/agents/workflow-agent) provides the `WorkflowAgent` class for building durable, resumable AI agents that run inside Vercel Workflows. It handles tool schema serialization, workflow step boundaries, and built-in tool approval flows.

<IndexCards
  cards={[
    {
      title: 'WorkflowAgent',
      description:
        'Create durable AI agents with tool calling, streaming, and workflow integration.',
      href: '/docs/reference/ai-sdk-workflow/workflow-agent',
    },
    {
      title: 'WorkflowChatTransport',
      description:
        'Chat transport with automatic stream reconnection for workflow-based apps.',
      href: '/docs/reference/ai-sdk-workflow/workflow-chat-transport',
    },
  ]}
/>

---
title: AI_APICallError
description: Learn how to fix AI_APICallError
---

# AI_APICallError

This error occurs when an API call fails.

## Properties

- `url`: The URL of the API request that failed
- `requestBodyValues`: The request body values sent to the API
- `statusCode`: The HTTP status code returned by the API (optional)
- `responseHeaders`: The response headers returned by the API (optional)
- `responseBody`: The response body returned by the API (optional)
- `isRetryable`: Whether the request can be retried based on the status code
- `data`: Any additional data associated with the error (optional)
- `cause`: The underlying error that caused the API call to fail (optional)

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
- `statusCode`: The HTTP status code returned by the server (optional)
- `statusText`: The HTTP status text returned by the server (optional)
- `cause`: The underlying error that caused the download to fail (optional)
- `message`: The error message containing details about the download failure (optional, auto-generated)

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
- `cause`: The underlying error that caused this error (optional)
- `message`: The error message describing the expected and received content types (optional, auto-generated)

## Checking for this Error

You can check if an error is an instance of `AI_InvalidDataContentError` using:

```typescript
import { InvalidDataContentError } from 'ai';

if (InvalidDataContentError.isInstance(error)) {
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
- `message`: The error message (optional, auto-generated from `role`)

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

## Potential Causes

### UI Messages

You are passing a `UIMessage[]` as messages into e.g. `streamText`.

You need to first convert them to a `ModelMessage[]` using `convertToModelMessages()`.

```typescript
import { type UIMessage, generateText, convertToModelMessages } from 'ai';

const messages: UIMessage[] = [
  /* ... */
];

const result = await generateText({
  // ...
  messages: await convertToModelMessages(messages),
});
```

## Properties

- `prompt`: The invalid prompt value
- `message`: The error message (required in constructor)
- `cause`: The cause of the error (optional)

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
title: AI_InvalidToolApprovalError
description: Learn how to fix AI_InvalidToolApprovalError
---

# AI_InvalidToolApprovalError

This error occurs when a tool approval response references an unknown `approvalId`. No matching `tool-approval-request` was found in the message history.

## Properties

- `approvalId`: The approval ID that was not found

## Checking for this Error

You can check if an error is an instance of `AI_InvalidToolApprovalError` using:

```typescript
import { InvalidToolApprovalError } from 'ai';

if (InvalidToolApprovalError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_InvalidToolInputError
description: Learn how to fix AI_InvalidToolInputError
---

# AI_InvalidToolInputError

This error occurs when invalid tool input was provided.

## Properties

- `toolName`: The name of the tool with invalid inputs
- `toolInput`: The invalid tool inputs
- `message`: The error message
- `cause`: The cause of the error

## Checking for this Error

You can check if an error is an instance of `AI_InvalidToolInputError` using:

```typescript
import { InvalidToolInputError } from 'ai';

if (InvalidToolInputError.isInstance(error)) {
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
- `cause`: The underlying parsing error (required in constructor)

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
title: AI_NoContentGeneratedError
description: Learn how to fix AI_NoContentGeneratedError
---

# AI_NoContentGeneratedError

This error occurs when the AI provider fails to generate content.

## Properties

- `message`: The error message (optional, defaults to `'No content generated.'`)

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

- `message`: The error message (optional, defaults to `'No image generated.'`).
- `responses`: Metadata about the image model responses, including timestamp, model, and headers (optional).
- `cause`: The cause of the error. You can use this for more detailed error handling (optional).

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

- `message`: The error message (optional, defaults to `'No object generated.'`).
- `text`: The text that was generated by the model. This can be the raw text or the tool call text, depending on the object generation mode (optional).
- `response`: Metadata about the language model response, including response id, timestamp, and model (required in constructor).
- `usage`: Request token usage (required in constructor).
- `finishReason`: Request finish reason. For example 'length' if model generated maximum number of tokens, this could result in a JSON parsing error (required in constructor).
- `cause`: The cause of the error (e.g. a JSON parsing error). You can use this for more detailed error handling (optional).

## Checking for this Error

You can check if an error is an instance of `AI_NoObjectGeneratedError` using:

```typescript
import { generateText, NoObjectGeneratedError, Output } from 'ai';

try {
  await generateText({ model, output: Output.object({ schema }), prompt });
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
title: AI_NoOutputGeneratedError
description: Learn how to fix AI_NoOutputGeneratedError
---

# AI_NoOutputGeneratedError

This error is thrown when no LLM output was generated, e.g. because of errors.

## Properties

- `message`: The error message (optional, defaults to `'No output generated.'`)
- `cause`: The underlying error that caused no output to be generated (optional)

## Checking for this Error

You can check if an error is an instance of `AI_NoOutputGeneratedError` using:

```typescript
import { NoOutputGeneratedError } from 'ai';

if (NoOutputGeneratedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoSpeechGeneratedError
description: Learn how to fix AI_NoSpeechGeneratedError
---

# AI_NoSpeechGeneratedError

This error occurs when no audio could be generated from the input.

## Properties

- `responses`: Array of speech model response metadata (required in constructor)

## Checking for this Error

You can check if an error is an instance of `AI_NoSpeechGeneratedError` using:

```typescript
import { NoSpeechGeneratedError } from 'ai';

if (NoSpeechGeneratedError.isInstance(error)) {
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
- `modelType`: The type of model (`'languageModel'`, `'embeddingModel'`, `'imageModel'`, `'transcriptionModel'`, `'speechModel'`, or `'rerankingModel'`)
- `message`: The error message (optional, auto-generated from `modelId` and `modelType`)

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
title: AI_NoSuchProviderReferenceError
description: Learn how to fix AI_NoSuchProviderReferenceError
---

# AI_NoSuchProviderReferenceError

This error occurs when a provider reference cannot be resolved because the
specified provider is not found in the provider reference mapping.

## Properties

- `provider`: The provider that was not found
- `reference`: The full provider reference mapping that was searched
- `message`: The error message

## Checking for this Error

You can check if an error is an instance of `AI_NoSuchProviderReferenceError` using:

```typescript
import { NoSuchProviderReferenceError } from 'ai';

if (NoSuchProviderReferenceError.isInstance(error)) {
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
- `availableTools`: Array of available tool names (optional)
- `message`: The error message (optional, auto-generated from `toolName` and `availableTools`)

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

- `responses`: Array of transcription model response metadata (required in constructor)

## Checking for this Error

You can check if an error is an instance of `AI_NoTranscriptGeneratedError` using:

```typescript
import { NoTranscriptGeneratedError } from 'ai';

if (NoTranscriptGeneratedError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_NoVideoGeneratedError
description: Learn how to fix AI_NoVideoGeneratedError
---

# AI_NoVideoGeneratedError

This error occurs when the AI provider fails to generate a video.
It can arise due to the following reasons:

- The model failed to generate a response.
- The model generated an invalid response.

## Properties

- `message`: The error message (optional, defaults to `'No video generated.'`).
- `responses`: Metadata about the video model responses, including timestamp, model, and headers (optional).
- `cause`: The cause of the error. You can use this for more detailed error handling (optional).

## Checking for this Error

You can check if an error is an instance of `AI_NoVideoGeneratedError` using:

```typescript
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
title: AI_ToolCallNotFoundForApprovalError
description: Learn how to fix AI_ToolCallNotFoundForApprovalError
---

# AI_ToolCallNotFoundForApprovalError

This error occurs when a tool approval request references a tool call that was not found. This can happen when processing provider-emitted approval requests (e.g., MCP flows) where the referenced tool call ID does not exist.

## Properties

- `toolCallId`: The tool call ID that was not found
- `approvalId`: The approval request ID

## Checking for this Error

You can check if an error is an instance of `AI_ToolCallNotFoundForApprovalError` using:

```typescript
import { ToolCallNotFoundForApprovalError } from 'ai';

if (ToolCallNotFoundForApprovalError.isInstance(error)) {
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
a `NoSuchToolError` or `InvalidToolInputError`.

## Properties

- `originalError`: The original error that triggered the repair attempt (either `NoSuchToolError` or `InvalidToolInputError`)
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
title: AI_TypeValidationError
description: Learn how to fix AI_TypeValidationError
---

# AI_TypeValidationError

This error occurs when type validation fails.

## Properties

- `value`: The value that failed validation
- `cause`: The underlying validation error (required in constructor)

## Checking for this Error

You can check if an error is an instance of `AI_TypeValidationError` using:

```typescript
import { TypeValidationError } from 'ai';

if (TypeValidationError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI_UIMessageStreamError
description: Learn how to fix AI_UIMessageStreamError
---

# AI_UIMessageStreamError

This error occurs when a UI message stream contains invalid or out-of-sequence chunks.

Common causes:

- Receiving a `text-delta` chunk without a preceding `text-start` chunk
- Receiving a `text-end` chunk without a preceding `text-start` chunk
- Receiving a `reasoning-delta` chunk without a preceding `reasoning-start` chunk
- Receiving a `reasoning-end` chunk without a preceding `reasoning-start` chunk
- Receiving a `tool-input-delta` chunk without a preceding `tool-input-start` chunk
- Attempting to access a tool invocation that doesn't exist

This error often surfaces when an upstream request fails **before any tokens are streamed** and a custom transport tries to write an inline error message to the UI stream without the proper start chunk.

## Properties

- `chunkType`: The type of chunk that caused the error (e.g., `text-delta`, `reasoning-end`, `tool-input-delta`)
- `chunkId`: The ID associated with the failing chunk (part ID or toolCallId)
- `message`: The error message with details about what went wrong

## Checking for this Error

You can check if an error is an instance of `AI_UIMessageStreamError` using:

```typescript
import { UIMessageStreamError } from 'ai';

if (UIMessageStreamError.isInstance(error)) {
  console.log('Chunk type:', error.chunkType);
  console.log('Chunk ID:', error.chunkId);
  // Handle the error
}
```

## Common Solutions

1. **Ensure proper chunk ordering**: Always send a `*-start` chunk before any `*-delta` or `*-end` chunks for the same ID:

   ```typescript
   // Correct order
   writer.write({ type: 'text-start', id: 'my-text' });
   writer.write({ type: 'text-delta', id: 'my-text', delta: 'Hello' });
   writer.write({ type: 'text-end', id: 'my-text' });
   ```

2. **Verify IDs match**: Ensure the `id` used in `*-delta` and `*-end` chunks matches the `id` used in the corresponding `*-start` chunk.

3. **Handle error paths correctly**: When writing error messages in custom transports, ensure you emit the full start/delta/end sequence:

   ```typescript
   // When handling errors in custom transports
   writer.write({ type: 'text-start', id: errorId });
   writer.write({
     type: 'text-delta',
     id: errorId,
     delta: 'Request failed...',
   });
   writer.write({ type: 'text-end', id: errorId });
   ```

4. **Check stream producer logic**: Review your streaming implementation to ensure chunks are sent in the correct order, especially when dealing with concurrent operations or merged streams.

---
title: AI_UnsupportedFunctionalityError
description: Learn how to fix AI_UnsupportedFunctionalityError
---

# AI_UnsupportedFunctionalityError

This error occurs when functionality is not supported.

## Properties

- `functionality`: The name of the unsupported functionality
- `message`: The error message (optional, auto-generated from `functionality`)

## Checking for this Error

You can check if an error is an instance of `AI_UnsupportedFunctionalityError` using:

```typescript
import { UnsupportedFunctionalityError } from 'ai';

if (UnsupportedFunctionalityError.isInstance(error)) {
  // Handle the error
}
```

---
title: AI Gateway
description: Learn how to use the AI Gateway provider with the AI SDK.
---

# AI Gateway Provider

The [AI Gateway](https://vercel.com/docs/ai-gateway) provider connects you to models from multiple AI providers through a single interface. Instead of integrating with each provider separately, you can access OpenAI, Anthropic, Google, Meta, xAI, and other providers and their models.

## Features

- Access models from multiple providers without having to install additional provider modules/dependencies
- Use the same code structure across different AI providers
- Switch between models and providers easily
- Automatic authentication when deployed on Vercel
- View pricing information across providers
- Observability for AI model usage through the Vercel dashboard

## Setup

The Vercel AI Gateway provider is part of the AI SDK.

## Basic Usage

For most use cases, you can use the AI Gateway directly with a model string:

```ts
// use plain model string with global provider
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.4',
  prompt: 'Hello world',
});
```

```ts
// use provider instance (requires version 5.0.36 or later)
import { generateText, gateway } from 'ai';

const { text } = await generateText({
  model: gateway('openai/gpt-5.4'),
  prompt: 'Hello world',
});
```

The AI SDK automatically uses the AI Gateway when you pass a model string in the `creator/model-name` format.

## Provider Instance

<Note>
  The `gateway` provider instance is available from the `ai` package in version
  5.0.36 and later.
</Note>

You can also import the default provider instance `gateway` from `ai`:

```ts
import { gateway } from 'ai';
```

You may want to create a custom provider instance when you need to:

- Set custom configuration options (API key, base URL, headers)
- Use the provider in a [provider registry](/docs/ai-sdk-core/provider-management)
- Wrap the provider with [middleware](/docs/ai-sdk-core/middleware)
- Use different settings for different parts of your application

To create a custom provider instance, import `createGateway` from `ai`:

```ts
import { createGateway } from 'ai';

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? '',
});
```

You can use the following optional settings to customize the AI Gateway provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls. The default prefix is `https://ai-gateway.vercel.sh/v4/ai`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `AI_GATEWAY_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **metadataCacheRefreshMillis** _number_

  How frequently to refresh the metadata cache in milliseconds. Defaults to 5 minutes (300,000ms).

## Authentication

The Gateway provider supports two authentication methods:

### API Key Authentication

Set your API key via environment variable:

```bash
AI_GATEWAY_API_KEY=your_api_key_here
```

Or pass it directly to the provider:

```ts
import { createGateway } from 'ai';

const gateway = createGateway({
  apiKey: 'your_api_key_here',
});
```

### OIDC Authentication (Vercel Deployments)

When deployed to Vercel, the AI Gateway provider supports authenticating using [OIDC (OpenID Connect)
tokens](https://vercel.com/docs/oidc) without API Keys.

#### How OIDC Authentication Works

1. **In Production/Preview Deployments**:

   - OIDC authentication is automatically handled
   - No manual configuration needed
   - Tokens are automatically obtained and refreshed

2. **In Local Development**:
   - First, install and authenticate with the [Vercel CLI](https://vercel.com/docs/cli)
   - Run `vercel env pull` to download your project's OIDC token locally
   - For automatic token management:
     - Use `vercel dev` to start your development server - this will handle token refreshing automatically
   - For manual token management:
     - If not using `vercel dev`, note that OIDC tokens expire after 12 hours
     - You'll need to run `vercel env pull` again to refresh the token before it expires

<Note>
  If an API Key is present (either passed directly or via environment), it will
  always be used, even if invalid.
</Note>

Read more about using OIDC tokens in the [Vercel AI Gateway docs](https://vercel.com/docs/ai-gateway#using-the-ai-gateway-with-a-vercel-oidc-token).

## Bring Your Own Key (BYOK)

You can connect your own provider credentials to use with Vercel AI Gateway. This lets you use your existing provider accounts and access private resources.

To set up BYOK, add your provider credentials in your Vercel team's AI Gateway settings. Once configured, AI Gateway automatically uses your credentials. No code changes are needed.

For providers like Azure where you can use custom deployment names, you can configure model mappings to map gateway model slugs to your deployment names. See [model mappings](https://vercel.com/docs/ai-gateway/byok#model-mappings) for details.

Learn more in the [BYOK documentation](https://vercel.com/docs/ai-gateway/byok).

## Language Models

You can create language models using a provider instance. The first argument is the model ID in the format `creator/model-name`:

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.4',
  prompt: 'Explain quantum computing in simple terms',
});
```

AI Gateway language models can also be used in the `streamText` function and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output) (see [AI SDK Core](/docs/ai-sdk-core)).

## Reranking Models

You can create reranking models using the `rerankingModel` method on the provider instance:

```ts
import { rerank } from 'ai';
import { gateway } from '@ai-sdk/gateway';

const { ranking } = await rerank({
  model: gateway.rerankingModel('cohere/rerank-v3.5'),
  query: 'What is the capital of France?',
  documents: [
    'Paris is the capital of France.',
    'Berlin is the capital of Germany.',
    'Madrid is the capital of Spain.',
  ],
  topN: 2,
});

console.log(ranking);
// [
//   { originalIndex: 0, score: 0.89, document: 'Paris is the capital of France.' },
//   { originalIndex: 2, score: 0.15, document: 'Madrid is the capital of Spain.' },
// ]
```

Reranking models are useful for improving search results in retrieval-augmented generation (RAG) pipelines by re-scoring candidate documents after an initial retrieval step.

## Available Models

The AI Gateway supports models from OpenAI, Anthropic, Google, Meta, xAI, Mistral, DeepSeek, Amazon Bedrock, Cohere, Perplexity, Alibaba, and other providers.

For the complete list of available models, see the [AI Gateway documentation](https://vercel.com/docs/ai-gateway).

## Dynamic Model Discovery

You can discover available models programmatically:

```ts
import { gateway, generateText } from 'ai';

const availableModels = await gateway.getAvailableModels();

// List all available models
availableModels.models.forEach(model => {
  console.log(`${model.id}: ${model.name}`);
  if (model.description) {
    console.log(`  Description: ${model.description}`);
  }
  if (model.pricing) {
    console.log(`  Input: $${model.pricing.input}/token`);
    console.log(`  Output: $${model.pricing.output}/token`);
    if (model.pricing.cachedInputTokens) {
      console.log(
        `  Cached input (read): $${model.pricing.cachedInputTokens}/token`,
      );
    }
    if (model.pricing.cacheCreationInputTokens) {
      console.log(
        `  Cache creation (write): $${model.pricing.cacheCreationInputTokens}/token`,
      );
    }
  }
});

// Use any discovered model with plain string
const { text } = await generateText({
  model: availableModels.models[0].id, // e.g., 'openai/gpt-5.4'
  prompt: 'Hello world',
});
```

## Credit Usage

You can check your team's current credit balance and usage:

```ts
import { gateway } from 'ai';

const credits = await gateway.getCredits();

console.log(`Team balance: ${credits.balance} credits`);
console.log(`Team total used: ${credits.total_used} credits`);
```

The `getCredits()` method returns your team's credit information based on the authenticated API key or OIDC token:

- **balance** _number_ - Your team's current available credit balance
- **total_used** _number_ - Total credits consumed by your team

## Generation Lookup

Look up detailed information about a specific generation by its ID, including cost, token usage, latency, and provider details. Generation IDs are available in `providerMetadata.gateway.generationId` on both `generateText` and `streamText` responses.

When streaming, the generation ID is injected on the first content chunk, so you can capture it early in the stream without waiting for completion. This is especially useful in cases where a network interruption or mid-stream error could prevent you from receiving the final response — since the gateway records the final status server-side, you can use the generation ID to look up the results (including cost, token usage, and finish reason) later via `getGenerationInfo()`.

```ts
import { gateway, generateText } from 'ai';

// Make a request
const result = await generateText({
  model: gateway('anthropic/claude-sonnet-4'),
  prompt: 'Explain quantum entanglement briefly',
});

// Get the generation ID from provider metadata
const generationId = result.providerMetadata?.gateway?.generationId;

// Look up detailed generation info
const generation = await gateway.getGenerationInfo({ id: generationId });

console.log(`Model: ${generation.model}`);
console.log(`Cost: $${generation.totalCost.toFixed(6)}`);
console.log(`Latency: ${generation.latency}ms`);
console.log(`Prompt tokens: ${generation.promptTokens}`);
console.log(`Completion tokens: ${generation.completionTokens}`);
```

With `streamText`, you can capture the generation ID from the first chunk via `fullStream`:

```ts
import { gateway, streamText } from 'ai';

const result = streamText({
  model: gateway('anthropic/claude-sonnet-4'),
  prompt: 'Explain quantum entanglement briefly',
});

let generationId: string | undefined;

for await (const part of result.fullStream) {
  if (!generationId && part.providerMetadata?.gateway?.generationId) {
    generationId = part.providerMetadata.gateway.generationId as string;
    console.log(`Generation ID (early): ${generationId}`);
  }
}

// Look up cost and usage after the stream completes
if (generationId) {
  const generation = await gateway.getGenerationInfo({ id: generationId });
  console.log(`Cost: $${generation.totalCost.toFixed(6)}`);
  console.log(`Finish reason: ${generation.finishReason}`);
}
```

The `getGenerationInfo()` method accepts:

- **id** _string_ - The generation ID to look up (format: `gen_<ulid>`, required)

It returns a `GatewayGenerationInfo` object with the following fields:

- **id** _string_ - The generation ID
- **totalCost** _number_ - Total cost in USD
- **upstreamInferenceCost** _number_ - Upstream inference cost in USD (relevant for BYOK)
- **usage** _number_ - Usage cost in USD (same as totalCost)
- **createdAt** _string_ - ISO 8601 timestamp when the generation was created
- **model** _string_ - Model identifier used
- **isByok** _boolean_ - Whether Bring Your Own Key credentials were used
- **providerName** _string_ - The provider that served this generation
- **streamed** _boolean_ - Whether streaming was used
- **finishReason** _string_ - Finish reason (e.g. `'stop'`)
- **latency** _number_ - Time to first token in milliseconds
- **generationTime** _number_ - Total generation time in milliseconds
- **promptTokens** _number_ - Number of prompt tokens
- **completionTokens** _number_ - Number of completion tokens
- **reasoningTokens** _number_ - Reasoning tokens used (if applicable)
- **cachedTokens** _number_ - Cached tokens used (if applicable)
- **cacheCreationTokens** _number_ - Cache creation input tokens
- **billableWebSearchCalls** _number_ - Number of billable web search calls

## Examples

### Basic Text Generation

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Write a haiku about programming',
});

console.log(text);
```

### Streaming

```ts
import { streamText } from 'ai';

const { textStream } = await streamText({
  model: 'openai/gpt-5.4',
  prompt: 'Explain the benefits of serverless architecture',
});

for await (const textPart of textStream) {
  process.stdout.write(textPart);
}
```

### Tool Usage

```ts
import { generateText, tool } from 'ai';
import { z } from 'zod';

const { text } = await generateText({
  model: 'xai/grok-4',
  prompt: 'What is the weather like in San Francisco?',
  tools: {
    getWeather: tool({
      description: 'Get the current weather for a location',
      parameters: z.object({
        location: z.string().describe('The location to get weather for'),
      }),
      execute: async ({ location }) => {
        // Your weather API call here
        return `It's sunny in ${location}`;
      },
    }),
  },
});
```

### Provider-Executed Tools

Some providers offer tools that are executed by the provider itself, such as [OpenAI's web search tool](/providers/ai-sdk-providers/openai#web-search-tool). To use these tools through AI Gateway, import the provider to access the tool definitions:

```ts
import { generateText, isStepCount } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: 'openai/gpt-5.4-mini',
  prompt: 'What is the Vercel AI Gateway?',
  stopWhen: isStepCount(10),
  tools: {
    web_search: openai.tools.webSearch({}),
  },
});

console.dir(result.text);
```

<Note>
  Some provider-executed tools require account-specific configuration (such as
  Claude Agent Skills) and may not work through AI Gateway. To use these tools,
  you must bring your own key (BYOK) directly to the provider.
</Note>

### Gateway Tools

The AI Gateway provider includes built-in tools that are executed by the gateway itself. These tools can be used with any model through the gateway.

#### Perplexity Search

The Perplexity Search tool enables models to search the web using [Perplexity's search API](https://docs.perplexity.ai/guides/search-quickstart). This tool is executed by the AI Gateway and returns web search results that the model can use to provide up-to-date information.

```ts
import { gateway, generateText } from 'ai';

const result = await generateText({
  model: 'openai/gpt-5.4-nano',
  prompt: 'Search for news about AI regulations in January 2025.',
  tools: {
    perplexity_search: gateway.tools.perplexitySearch(),
  },
});

console.log(result.text);
console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
console.log('Tool results:', JSON.stringify(result.toolResults, null, 2));
```

You can also configure the search with optional parameters:

```ts
import { gateway, generateText } from 'ai';

const result = await generateText({
  model: 'openai/gpt-5.4-nano',
  prompt:
    'Search for news about AI regulations from the first week of January 2025.',
  tools: {
    perplexity_search: gateway.tools.perplexitySearch({
      maxResults: 5,
      searchLanguageFilter: ['en'],
      country: 'US',
      searchDomainFilter: ['reuters.com', 'bbc.com', 'nytimes.com'],
    }),
  },
});

console.log(result.text);
console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
console.log('Tool results:', JSON.stringify(result.toolResults, null, 2));
```

The Perplexity Search tool supports the following optional configuration options:

- **maxResults** _number_

  The maximum number of search results to return (1-20, default: 10).

- **maxTokensPerPage** _number_

  The maximum number of tokens to extract per search result page (256-2048, default: 2048).

- **maxTokens** _number_

  The maximum total tokens across all search results (default: 25000, max: 1000000).

- **searchLanguageFilter** _string[]_

  Filter search results by language using ISO 639-1 language codes (e.g., `['en']` for English, `['en', 'es']` for English and Spanish).

- **country** _string_

  Filter search results by country using ISO 3166-1 alpha-2 country codes (e.g., `'US'` for United States, `'GB'` for United Kingdom).

- **searchDomainFilter** _string[]_

  Limit search results to specific domains (e.g., `['reuters.com', 'bbc.com']`). This is useful for restricting results to trusted sources.

- **searchRecencyFilter** _'day' | 'week' | 'month' | 'year'_

  Filter search results by relative time period. Useful for always getting recent results (e.g., 'week' for results from the last week).

The tool works with both `generateText` and `streamText`:

```ts
import { gateway, streamText } from 'ai';

const result = streamText({
  model: 'openai/gpt-5.4-nano',
  prompt: 'Search for the latest news about AI regulations.',
  tools: {
    perplexity_search: gateway.tools.perplexitySearch(),
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta':
      process.stdout.write(part.text);
      break;
    case 'tool-call':
      console.log('\nTool call:', JSON.stringify(part, null, 2));
      break;
    case 'tool-result':
      console.log('\nTool result:', JSON.stringify(part, null, 2));
      break;
  }
}
```

#### Parallel Search

The Parallel Search tool enables models to search the web using [Parallel AI's Search API](https://docs.parallel.ai/api-reference/search-beta/search). This tool is optimized for LLM consumption, returning relevant excerpts from web pages that can replace multiple keyword searches with a single call.

```ts
import { gateway, generateText } from 'ai';

const result = await generateText({
  model: 'openai/gpt-5.4-nano',
  prompt: 'Research the latest developments in quantum computing.',
  tools: {
    parallel_search: gateway.tools.parallelSearch(),
  },
});

console.log(result.text);
console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
console.log('Tool results:', JSON.stringify(result.toolResults, null, 2));
```

You can also configure the search with optional parameters:

```ts
import { gateway, generateText } from 'ai';

const result = await generateText({
  model: 'openai/gpt-5.4-nano',
  prompt: 'Find detailed information about TypeScript 5.0 features.',
  tools: {
    parallel_search: gateway.tools.parallelSearch({
      mode: 'agentic',
      maxResults: 5,
      sourcePolicy: {
        includeDomains: ['typescriptlang.org', 'github.com'],
      },
      excerpts: {
        maxCharsPerResult: 8000,
      },
    }),
  },
});

console.log(result.text);
console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
console.log('Tool results:', JSON.stringify(result.toolResults, null, 2));
```

The Parallel Search tool supports the following optional configuration options:

- **mode** _'one-shot' | 'agentic'_

  Mode preset for different use cases:

  - `'one-shot'` - Comprehensive results with longer excerpts for single-response answers (default)
  - `'agentic'` - Concise, token-efficient results optimized for multi-step agentic workflows

- **maxResults** _number_

  Maximum number of results to return (1-20). Defaults to 10 if not specified.

- **sourcePolicy** _object_

  Source policy for controlling which domains to include/exclude:

  - `includeDomains` - List of domains to include in search results
  - `excludeDomains` - List of domains to exclude from search results
  - `afterDate` - Only include results published after this date (ISO 8601 format)

- **excerpts** _object_

  Excerpt configuration for controlling result length:

  - `maxCharsPerResult` - Maximum characters per result
  - `maxCharsTotal` - Maximum total characters across all results

- **fetchPolicy** _object_

  Fetch policy for controlling content freshness:

  - `maxAgeSeconds` - Maximum age in seconds for cached content (set to 0 for always fresh)

The tool works with both `generateText` and `streamText`:

```ts
import { gateway, streamText } from 'ai';

const result = streamText({
  model: 'openai/gpt-5.4-nano',
  prompt: 'Research the latest AI safety guidelines.',
  tools: {
    parallel_search: gateway.tools.parallelSearch(),
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta':
      process.stdout.write(part.text);
      break;
    case 'tool-call':
      console.log('\nTool call:', JSON.stringify(part, null, 2));
      break;
    case 'tool-result':
      console.log('\nTool result:', JSON.stringify(part, null, 2));
      break;
  }
}
```

### Custom Reporting

Track usage per end-user and categorize requests with tags, then query the data through the reporting API.

#### Usage Tracking with User and Tags

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.4',
  prompt: 'Summarize this document...',
  providerOptions: {
    gateway: {
      user: 'user-abc-123', // Track usage for this specific end-user
      tags: ['document-summary', 'premium-feature'], // Categorize for reporting
    } satisfies GatewayProviderOptions,
  },
});
```

This allows you to:

- View usage and costs broken down by end-user in your analytics
- Filter and analyze spending by feature or use case using tags
- Track which users or features are driving the most AI usage

#### Querying Spend Reports

Use the `getSpendReport()` method to query usage data programmatically. The reporting API is only available for Vercel Pro and Enterprise plans. For pricing, see the [Custom Reporting docs](https://vercel.com/docs/ai-gateway/capabilities/custom-reporting).

```ts
import { gateway } from 'ai';

const report = await gateway.getSpendReport({
  startDate: '2026-03-01',
  endDate: '2026-03-25',
  groupBy: 'model',
});

for (const row of report.results) {
  console.log(`${row.model}: $${row.totalCost.toFixed(4)}`);
}
```

The `getSpendReport()` method accepts the following parameters:

- **startDate** _string_ - Start date in `YYYY-MM-DD` format (inclusive, required)
- **endDate** _string_ - End date in `YYYY-MM-DD` format (inclusive, required)
- **groupBy** _string_ - Aggregation dimension: `'day'` (default), `'user'`, `'model'`, `'tag'`, `'provider'`, or `'credential_type'`
- **datePart** _string_ - Time granularity when `groupBy` is `'day'`: `'day'` or `'hour'`
- **userId** _string_ - Filter to a specific user
- **model** _string_ - Filter to a specific model (e.g. `'anthropic/claude-sonnet-4.5'`)
- **provider** _string_ - Filter to a specific provider (e.g. `'anthropic'`)
- **credentialType** _string_ - Filter by `'byok'` or `'system'` credentials
- **tags** _string[]_ - Filter to requests matching these tags

Each row in `results` contains a grouping field (matching your `groupBy` choice) and metrics:

- **totalCost** _number_ - Total cost in USD
- **marketCost** _number_ - Market cost in USD
- **inputTokens** _number_ - Number of input tokens
- **outputTokens** _number_ - Number of output tokens
- **cachedInputTokens** _number_ - Number of cached input tokens
- **cacheCreationInputTokens** _number_ - Number of cache creation input tokens
- **reasoningTokens** _number_ - Number of reasoning tokens
- **requestCount** _number_ - Number of requests

You can combine tracking and querying to analyze spend by tags you defined:

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { gateway, streamText } from 'ai';

// 1. Make requests with tags
const result = streamText({
  model: gateway('anthropic/claude-haiku-4.5'),
  prompt: 'Summarize this quarter's results',
  providerOptions: {
    gateway: {
      tags: ['team:finance', 'feature:summaries'],
    } satisfies GatewayProviderOptions,
  },
});

// 2. Later, query spend filtered by those tags
const report = await gateway.getSpendReport({
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  groupBy: 'tag',
  tags: ['team:finance'],
});

for (const row of report.results) {
  console.log(`${row.tag}: $${row.totalCost.toFixed(4)} (${row.requestCount} requests)`);
}
```

## Provider Options

The AI Gateway provider accepts provider options that control routing behavior and provider-specific configurations.

### Gateway Provider Options

You can use the `gateway` key in `providerOptions` to control how AI Gateway routes requests:

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Explain quantum computing',
  providerOptions: {
    gateway: {
      order: ['vertex', 'anthropic'], // Try Vertex AI first, then Anthropic
      only: ['vertex', 'anthropic'], // Only use these providers
    } satisfies GatewayProviderOptions,
  },
});
```

The following gateway provider options are available:

- **order** _string[]_

  Specifies the sequence of providers to attempt when routing requests. The gateway will try providers in the order specified. If a provider fails or is unavailable, it will move to the next provider in the list.

  Example: `order: ['bedrock', 'anthropic']` will attempt Amazon Bedrock first, then fall back to Anthropic.

- **only** _string[]_

  Restricts routing to only the specified providers. When set, the gateway will never route to providers not in this list, even if they would otherwise be available.

  Example: `only: ['anthropic', 'vertex']` will only allow routing to Anthropic or Vertex AI.

- **sort** _'cost' | 'ttft' | 'tps'_

  Sorts available providers by a performance or cost metric before routing. The gateway will try the best-scoring provider first and fall back through the rest in sorted order. If unspecified, providers are ordered using the gateway's default system ranking.

  - `'cost'` — lowest cost first
  - `'ttft'` — lowest time-to-first-token first
  - `'tps'` — highest tokens-per-second first

  When combined with `order`, the user-specified providers are promoted to the front while remaining providers follow the sorted order.

  Example: `sort: 'ttft'` will route to the provider with the fastest time-to-first-token.

  When `sort` is active, the response's `providerMetadata.gateway.routing.sort` object contains the sort option used, the resulting execution order, per-provider metric values, and any providers that were deprioritized.

- **models** _string[]_

  Specifies fallback models to use when the primary model fails or is unavailable. The gateway will try the primary model first (specified in the `model` parameter), then try each model in this array in order until one succeeds.

  Example: `models: ['openai/gpt-5.4-nano', 'gemini-3-flash-preview']` will try the fallback models in order if the primary model fails.

- **user** _string_

  Optional identifier for the end user on whose behalf the request is being made. This is used for spend tracking and attribution purposes, allowing you to track usage per end-user in your application.

  Example: `user: 'user-123'` will associate this request with end-user ID "user-123" in usage reports.

- **tags** _string[]_

  Optional array of tags for categorizing and filtering usage in reports. Useful for tracking spend by feature, prompt version, or any other dimension relevant to your application.

  Example: `tags: ['chat', 'v2']` will tag this request with "chat" and "v2" for filtering in usage analytics.

- **byok** _Record&lt;string, Array&lt;Record&lt;string, unknown&gt;&gt;&gt;_

  Request-scoped BYOK (Bring Your Own Key) credentials to use for this request. When provided, any cached BYOK credentials configured in the gateway system are not considered. Requests may still fall back to use system credentials if the provided credentials fail.

  Each provider can have multiple credentials (tried in order). The structure is a record where keys are provider slugs and values are arrays of credential objects.

  Each credential can optionally include a `modelMappings` array to map AI Gateway model slugs to your deployment names (for example, custom Azure deployment names). If a BYOK request fails, the gateway falls back to system credentials using the default model name.

  Examples:

  - Single provider: `byok: { 'anthropic': [{ apiKey: 'sk-ant-...' }] }`
  - Multiple credentials: `byok: { 'vertex': [{ project: 'proj-1', googleCredentials: { privateKey: '...', clientEmail: '...' } }, { project: 'proj-2', googleCredentials: { privateKey: '...', clientEmail: '...' } }] }`
  - Multiple providers: `byok: { 'anthropic': [{ apiKey: '...' }], 'bedrock': [{ accessKeyId: '...', secretAccessKey: '...' }] }`
  - With model mappings: `byok: { 'azure': [{ apiKey: '...', resourceName: '...', modelMappings: [{ gatewayModelSlug: 'openai/gpt-5.4-nano', customModelId: 'my-deployment' }] }] }`

- **zeroDataRetention** _boolean_

  Restricts routing to providers that have zero data retention agreements with Vercel for AI Gateway. When using BYOK credentials, this filter is not applied. If BYOK credentials fail and the request falls back to system credentials, only providers with zero data retention agreements will be used. If there are no providers available for the model with zero data retention, the request will fail. Request-level ZDR is only available for Vercel Pro and Enterprise plans.

- **disallowPromptTraining** _boolean_

  Restricts routing to providers that have agreements with Vercel for AI Gateway to not use prompts for model training. When using BYOK credentials, this filter is not applied. If BYOK credentials fail and the request falls back to system credentials, only providers that do not train on prompt data will be used. If there are no providers available for the model that disallow prompt training, the request will fail.

- **hipaaCompliant** _boolean_

  Restricts routing to models and tools from providers that have signed a BAA with Vercel for the use of AI Gateway (requires Vercel HIPAA BAA add on). BYOK credentials are skipped when `hipaaCompliant` is set to `true` to ensure that requests are only routed to providers that support HIPAA compliance.

- **quotaEntityId** _string_

  The unique identifier for the entity against which quota is tracked. Used for quota management and enforcement purposes.

- **providerTimeouts** _object_

  Per-provider timeouts for BYOK credentials in milliseconds. Controls how long to wait for a provider to start responding before falling back to the next available provider.

  Example: `providerTimeouts: { byok: { openai: 5000, anthropic: 2000 } }`

  For full details, see [Provider Timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts).

You can combine these options to have fine-grained control over routing and tracking:

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Write a haiku about programming',
  providerOptions: {
    gateway: {
      order: ['vertex'], // Prefer Vertex AI
      only: ['anthropic', 'vertex'], // Only allow these providers
    } satisfies GatewayProviderOptions,
  },
});
```

#### Model Fallbacks Example

The `models` option enables automatic fallback to alternative models when the primary model fails:

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.4', // Primary model
  prompt: 'Write a TypeScript haiku',
  providerOptions: {
    gateway: {
      models: ['openai/gpt-5.4-nano', 'gemini-3-flash-preview'], // Fallback models
    } satisfies GatewayProviderOptions,
  },
});

// This will:
// 1. Try openai/gpt-5.4 first
// 2. If it fails, try openai/gpt-5.4-nano
// 3. If that fails, try gemini-3-flash-preview
// 4. Return the result from the first model that succeeds
```

#### Zero Data Retention Example

Set `zeroDataRetention` to true to route requests to providers that have zero data retention agreements with Vercel for AI Gateway. When using BYOK credentials, this filter is not applied. If BYOK credentials fail and the request falls back to system credentials, only providers with zero data retention agreements will be used. If there are no providers available for the model with zero data retention, the request will fail. When `zeroDataRetention` is `false` or not specified, there is no enforcement of restricting routing. Request-level ZDR is only available for Vercel Pro and Enterprise plans.

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Analyze this sensitive document...',
  providerOptions: {
    gateway: {
      zeroDataRetention: true,
    } satisfies GatewayProviderOptions,
  },
});
```

#### Disallow Prompt Training Example

Set `disallowPromptTraining` to true to route requests to providers that have agreements with Vercel for AI Gateway to not use prompts for model training. When using BYOK credentials, this filter is not applied. If BYOK credentials fail and the request falls back to system credentials, only providers that do not train on prompt data will be used. If there are no providers available for the model that disallow prompt training, the request will fail. When `disallowPromptTraining` is `false` or not specified, there is no enforcement of restricting routing.

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Analyze this proprietary business data...',
  providerOptions: {
    gateway: {
      disallowPromptTraining: true,
    } satisfies GatewayProviderOptions,
  },
});
```

#### HIPAA Compliance Example

Set `hipaaCompliant` to true to route requests only to models or tools by providers that have signed a BAA with Vercel for the use of AI Gateway. If the model or tool does not have a HIPAA-compliant provider, the request will fail. When `hipaaCompliant` is `false` or not specified, there is no enforcement of restricting routing. BYOK credentials are skipped when `hipaaCompliant` is set to `true` to ensure that requests are only routed to providers that support HIPAA compliance.

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Analyze this patient data...',
  providerOptions: {
    gateway: {
      hipaaCompliant: true,
    } satisfies GatewayProviderOptions,
  },
});
```

#### Quota Entity ID Example

Set `quotaEntityId` to track and enforce quota against a specific entity. This is useful for multi-tenant applications where you need to manage quota at the entity level (e.g., per organization or team).

```ts
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Summarize this report...',
  providerOptions: {
    gateway: {
      quotaEntityId: 'org-123',
    } satisfies GatewayProviderOptions,
  },
});
```

### Provider-Specific Options

When using provider-specific options through AI Gateway, use the actual provider name (e.g. `anthropic`, `openai`, not `gateway`) as the key:

```ts
import type { AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'Explain quantum computing',
  providerOptions: {
    gateway: {
      order: ['vertex', 'anthropic'],
    } satisfies GatewayProviderOptions,
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

This works with any provider supported by AI Gateway. Each provider has its own set of options - see the individual [provider documentation pages](/providers/ai-sdk-providers) for details on provider-specific options.

### Available Providers

AI Gateway supports routing to 20+ providers.

For a complete list of available providers and their slugs, see the [AI Gateway documentation](https://vercel.com/docs/ai-gateway/provider-options#available-providers).

## Model Capabilities

Model capabilities depend on the specific provider and model you're using. For detailed capability information, see:

- [AI Gateway provider options](https://vercel.com/docs/ai-gateway/provider-options#available-providers) for an overview of available providers
- Individual [AI SDK provider pages](/providers/ai-sdk-providers) for specific model capabilities and features

---
title: xAI Grok
description: Learn how to use xAI Grok and Imagine.
---

# xAI Grok Provider

The [xAI Grok](https://x.ai) provider contains language model support for the [xAI API](https://x.ai/api).

## Setup

The xAI Grok provider is available via the `@ai-sdk/xai` module. You can
install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/xai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/xai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/xai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/xai" dark />
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
first argument is the model id, e.g. `grok-4.20-non-reasoning`.

```ts
const model = xai('grok-4.20-non-reasoning');
```

By default, `xai(modelId)` uses the Responses API. To use the [Chat Completions API](https://docs.x.ai/docs/api-reference#chat-completions) (legacy), use `xai.chat(modelId)`.

### Example

You can use xAI language models to generate text with the `generateText` function:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: xai('grok-4.20-non-reasoning'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

xAI language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

## Responses API (Agentic Tools)

The xAI Responses API is the default when using `xai(modelId)`. You can also use `xai.responses(modelId)` explicitly. This enables the model to autonomously orchestrate tool calls and research on xAI's servers.

```ts
const model = xai.responses('grok-4.20-non-reasoning');
```

The Responses API provides server-side tools that the model can autonomously execute during its reasoning process:

- **web_search**: Real-time web search and page browsing
- **x_search**: Search X (Twitter) posts, users, and threads
- **code_execution**: Execute Python code for calculations and data analysis
- **view_image**: View and analyze images
- **view_x_video**: View and analyze videos from X posts
- **mcp_server**: Connect to remote MCP servers and use their tools
- **file_search**: Search through documents in vector stores (collections)

### Vision

The Responses API supports image input with vision models:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: xai.responses('grok-3'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What do you see in this image?' },
        { type: 'image', image: fs.readFileSync('./image.png') },
      ],
    },
  ],
});
```

### Web Search Tool

The web search tool enables autonomous web research with optional domain filtering and image understanding:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text, sources } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'What are the latest developments in AI?',
  tools: {
    web_search: xai.tools.webSearch({
      allowedDomains: ['arxiv.org', 'openai.com'],
      enableImageUnderstanding: true,
    }),
  },
});

console.log(text);
console.log('Citations:', sources);
```

#### Web Search Parameters

- **allowedDomains** _string[]_

  Only search within specified domains (max 5). Cannot be used with `excludedDomains`.

- **excludedDomains** _string[]_

  Exclude specified domains from search (max 5). Cannot be used with `allowedDomains`.

- **enableImageUnderstanding** _boolean_

  Enable the model to view and analyze images found during search. Increases token usage.

### X Search Tool

The X search tool enables searching X (Twitter) for posts, with filtering by handles and date ranges:

```ts
const { text, sources } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'What are people saying about AI on X this week?',
  tools: {
    x_search: xai.tools.xSearch({
      allowedXHandles: ['elonmusk', 'xai'],
      fromDate: '2025-10-23',
      toDate: '2025-10-30',
      enableImageUnderstanding: true,
      enableVideoUnderstanding: true,
    }),
  },
});
```

#### X Search Parameters

- **allowedXHandles** _string[]_

  Only search posts from specified X handles (max 10). Cannot be used with `excludedXHandles`.

- **excludedXHandles** _string[]_

  Exclude posts from specified X handles (max 10). Cannot be used with `allowedXHandles`.

- **fromDate** _string_

  Start date for posts in ISO8601 format (`YYYY-MM-DD`).

- **toDate** _string_

  End date for posts in ISO8601 format (`YYYY-MM-DD`).

- **enableImageUnderstanding** _boolean_

  Enable the model to view and analyze images in X posts.

- **enableVideoUnderstanding** _boolean_

  Enable the model to view and analyze videos in X posts.

### Code Execution Tool

The code execution tool enables the model to write and execute Python code for calculations and data analysis:

```ts
const { text } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt:
    'Calculate the compound interest for $10,000 at 5% annually for 10 years',
  tools: {
    code_execution: xai.tools.codeExecution(),
  },
});
```

### View Image Tool

The view image tool enables the model to view and analyze images:

```ts
const { text } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'Describe what you see in the image',
  tools: {
    view_image: xai.tools.viewImage(),
  },
});
```

### View X Video Tool

The view X video tool enables the model to view and analyze videos from X (Twitter) posts:

```ts
const { text } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'Summarize the content of this X video',
  tools: {
    view_x_video: xai.tools.viewXVideo(),
  },
});
```

### MCP Server Tool

The MCP server tool enables the model to connect to remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers and use their tools:

```ts
const { text } = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'Use the weather tool to check conditions in San Francisco',
  tools: {
    weather_server: xai.tools.mcpServer({
      serverUrl: 'https://example.com/mcp',
      serverLabel: 'weather-service',
      serverDescription: 'Weather data provider',
      allowedTools: ['get_weather', 'get_forecast'],
    }),
  },
});
```

#### MCP Server Parameters

- **serverUrl** _string_ (required)

  The URL of the remote MCP server.

- **serverLabel** _string_

  A label to identify the MCP server.

- **serverDescription** _string_

  A description of what the MCP server provides.

- **allowedTools** _string[]_

  List of tool names that the model is allowed to use from the MCP server. If not specified, all tools are allowed.

- **headers** _Record&lt;string, string&gt;_

  Custom headers to include when connecting to the MCP server.

- **authorization** _string_

  Authorization header value for authenticating with the MCP server (e.g., `'Bearer token123'`).

### File Search Tool

The file search tool enables searching through documents stored in xAI vector stores (collections):

```ts
import { xai, type XaiLanguageModelResponsesOptions } from '@ai-sdk/xai';
import { streamText } from 'ai';

const result = streamText({
  model: xai.responses('grok-4.20-reasoning'),
  prompt: 'What documents do you have access to?',
  tools: {
    file_search: xai.tools.fileSearch({
      vectorStoreIds: ['collection_your-collection-id'],
      maxNumResults: 10,
    }),
  },
  providerOptions: {
    xai: {
      include: ['file_search_call.results'],
    } satisfies XaiLanguageModelResponsesOptions,
  },
});
```

#### File Search Parameters

- **vectorStoreIds** _string[]_ (required)

  The IDs of the vector stores (collections) to search.

- **maxNumResults** _number_

  The maximum number of results to return from the search.

#### Provider Options for File Search

- **include** _Array&lt;'file_search_call.results'&gt;_

  Include file search results in the response. When set to `['file_search_call.results']`, the response will contain the actual search results with file content and scores.

<Note>
  File search requires grok-4 family models (including grok-4.20) and the Responses API. Vector stores
  can be created using the [xAI
  API](https://docs.x.ai/docs/guides/using-collections/api).
</Note>

### Multiple Tools

You can combine multiple server-side tools for comprehensive research:

```ts
import { xai } from '@ai-sdk/xai';
import { streamText } from 'ai';

const { fullStream } = streamText({
  model: xai.responses('grok-4.20-non-reasoning'),
  prompt: 'Research AI safety developments and calculate risk metrics',
  tools: {
    web_search: xai.tools.webSearch(),
    x_search: xai.tools.xSearch(),
    code_execution: xai.tools.codeExecution(),
    file_search: xai.tools.fileSearch({
      vectorStoreIds: ['collection_your-documents'],
    }),
    data_service: xai.tools.mcpServer({
      serverUrl: 'https://data.example.com/mcp',
      serverLabel: 'data-service',
    }),
  },
});

for await (const part of fullStream) {
  if (part.type === 'text-delta') {
    process.stdout.write(part.text);
  } else if (part.type === 'source' && part.sourceType === 'url') {
    console.log('\nSource:', part.url);
  }
}
```

### Provider Options

The Responses API supports the following provider options:

```ts
import { xai, type XaiLanguageModelResponsesOptions } from '@ai-sdk/xai';
import { generateText } from 'ai';

const result = await generateText({
  model: xai.responses('grok-4.20-non-reasoning'),
  providerOptions: {
    xai: {
      reasoningEffort: 'high',
    } satisfies XaiLanguageModelResponsesOptions,
  },
  // ...
});
```

The following provider options are available:

- **reasoningEffort** _'low' | 'medium' | 'high'_

  Control the reasoning effort for the model. Higher effort may produce more thorough results at the cost of increased latency and token usage.

- **logprobs** _boolean_

  Return log probabilities for output tokens.

- **topLogprobs** _number_

  Number of most likely tokens to return per token position (0-8). When set, `logprobs` is automatically enabled.

- **include** _Array&lt;'file_search_call.results'&gt;_

  Specify additional output data to include in the model response. Use `['file_search_call.results']` to include file search results with scores and content.

- **store** _boolean_

  Whether to store the input message(s) and model response for later retrieval. Defaults to `true`.

- **previousResponseId** _string_

  The ID of the previous response from the model. You can use it to continue a conversation.

<Note>
  The Responses API only supports server-side tools. You cannot mix server-side
  tools with client-side function tools in the same request.
</Note>

## Model Capabilities

| Model                         | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      | Reasoning           |
| ----------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `grok-4.20-reasoning`         | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-4.20-non-reasoning`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-4-1-fast-reasoning`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-4-1-fast-non-reasoning` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-4-1`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-4-fast-reasoning`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-4-fast-non-reasoning`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-code-fast-1`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3`                      | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3-mini`                 | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [xAI
  docs](https://docs.x.ai/docs#models) for a full list of available models. You
  can also pass any available provider model ID as a string if needed.
</Note>

## Image Models

You can create xAI image models using the `.image()` factory method. For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

```ts
import { xai } from '@ai-sdk/xai';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: xai.image('grok-imagine-image'),
  prompt: 'A futuristic cityscape at sunset',
});
```

<Note>
  The xAI image model does not support the `size` parameter. Use `aspectRatio`
  instead. Supported aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`,
  `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, and `auto`.
</Note>

### Image Editing

xAI supports image editing through the `grok-imagine-image` model. Pass input images via `prompt.images` to transform or edit existing images.

<Note>
  xAI image editing does not support masks. Editing is prompt-driven - describe
  what you want to change in the text prompt.
</Note>

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
import { xai } from '@ai-sdk/xai';
import { generateImage } from 'ai';
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: xai.image('grok-imagine-image'),
  prompt: {
    text: 'Turn the cat into a golden retriever dog',
    images: [imageBuffer],
  },
});
```

#### Multi-Image Editing

Combine or reference multiple input images in the prompt:

```ts
import { xai } from '@ai-sdk/xai';
import { generateImage } from 'ai';
import { readFileSync } from 'fs';

const cat = readFileSync('./cat.png');
const dog = readFileSync('./dog.png');

const { images } = await generateImage({
  model: xai.image('grok-imagine-image'),
  prompt: {
    text: 'Combine these two animals into a group photo',
    images: [cat, dog],
  },
});
```

#### Style Transfer

Apply artistic styles to an image:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: xai.image('grok-imagine-image'),
  prompt: {
    text: 'Transform this into a watercolor painting style',
    images: [imageBuffer],
  },
  aspectRatio: '1:1',
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings.
</Note>

### Image Provider Options

You can customize the image generation behavior with provider-specific settings via `providerOptions.xai`:

```ts
import { xai, type XaiImageModelOptions } from '@ai-sdk/xai';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: xai.image('grok-imagine-image-pro'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
  providerOptions: {
    xai: {
      resolution: '2k',
      quality: 'high',
    } satisfies XaiImageModelOptions,
  },
});
```

- **resolution** _'1k' | '2k'_

  Output resolution. `1k` produces ~1024×1024 images, `2k` produces ~2048×2048
  images (actual dimensions vary based on aspect ratio). Available for
  `grok-imagine-image-pro`.

- **quality** _'low' | 'medium' | 'high'_

  Image quality level. Higher quality may increase generation time.

### Image Model Capabilities

| Model                    | Resolution   | Aspect Ratios                                                                                               | Image Editing       |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| `grok-imagine-image-pro` | `1k`, `2k`   | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto` | <Check size={18} /> |
| `grok-imagine-image`     | `1k`         | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto` | <Check size={18} /> |

## Video Models

You can create xAI video models using the `.video()` factory method.
For more on video generation with the AI SDK see [generateVideo()](/docs/reference/ai-sdk-core/generate-video).

This provider supports standard video generation from text prompts or image input, plus explicit video editing, video extension, and reference-to-video (R2V) operations.

### Text-to-Video

Generate videos from text prompts:

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: 'A chicken flying into the sunset in the style of 90s anime.',
  aspectRatio: '16:9',
  duration: 5,
  providerOptions: {
    xai: {
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies XaiVideoModelOptions,
  },
});
```

### Generation with Image Input

Generate videos using an image as the starting frame with an optional text prompt. This uses the standard generation path rather than a separate provider mode:

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: {
    image: 'https://example.com/start-frame.png',
    text: 'The cat slowly turns its head and blinks',
  },
  duration: 5,
  providerOptions: {
    xai: {
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies XaiVideoModelOptions,
  },
});
```

### Video Editing

Edit an existing video using a text prompt by providing a source video URL via provider options:

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: 'Give the person sunglasses and a hat',
  providerOptions: {
    xai: {
      mode: 'edit-video',
      videoUrl: 'https://example.com/source-video.mp4',
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies XaiVideoModelOptions,
  },
});
```

<Note>
  Video editing accepts input videos up to 8.7 seconds long. The `duration`,
  `aspectRatio`, and `resolution` parameters are not supported for editing - the
  output matches the input video's properties (capped at 720p).
</Note>

### Chaining and Concurrent Edits

The xAI-hosted video URL is available in `providerMetadata.xai.videoUrl`.
You can use it to chain sequential edits or branch into concurrent edits
using `Promise.all`:

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

const providerOptions = {
  xai: {
    mode: 'edit-video',
    videoUrl: 'https://example.com/source-video.mp4',
    pollTimeoutMs: 600000,
  } satisfies XaiVideoModelOptions,
};

// Step 1: Apply an initial edit
const step1 = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: 'Add a party hat to the person',
  providerOptions,
});

// Get the xAI-hosted URL from provider metadata
const step1VideoUrl = step1.providerMetadata?.xai?.videoUrl as string;

// Step 2: Apply two more edits concurrently, building on step 1
const [withSunglasses, withScarf] = await Promise.all([
  generateVideo({
    model: xai.video('grok-imagine-video'),
    prompt: 'Add sunglasses',
    providerOptions: {
      xai: { mode: 'edit-video', videoUrl: step1VideoUrl, pollTimeoutMs: 600000 },
    },
  }),
  generateVideo({
    model: xai.video('grok-imagine-video'),
    prompt: 'Add a scarf',
    providerOptions: {
      xai: { mode: 'edit-video', videoUrl: step1VideoUrl, pollTimeoutMs: 600000 },
    },
  }),
]);
```

### Video Extension

Extend an existing video from its last frame. The `duration` controls the length of the extension only, not the total output. The output inherits `aspectRatio` and `resolution` from the source video.

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

// Step 1: Generate a source video
const source = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: 'A cat sitting on a sunlit windowsill, tail gently swishing.',
  duration: 5,
  aspectRatio: '16:9',
  providerOptions: {
    xai: {
      pollTimeoutMs: 600000,
    } satisfies XaiVideoModelOptions,
  },
});

const sourceUrl = source.providerMetadata?.xai?.videoUrl as string;

// Step 2: Extend the video with a new scene
const extended = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt: 'The cat turns its head, notices a butterfly, and leaps off.',
  duration: 6,
  providerOptions: {
    xai: {
      mode: 'extend-video',
      videoUrl: sourceUrl,
      pollTimeoutMs: 600000,
    } satisfies XaiVideoModelOptions,
  },
});
```

<Note>
  Video extension does not support custom `aspectRatio` or `resolution` — the
  output inherits those from the source video. `duration` is supported and
  controls how long the extension is (not the total video length).
</Note>

### Reference-to-Video (R2V)

Provide reference images to guide the video's style and content. Unlike image-to-video, reference images are not used as the first frame — the model incorporates their visual elements into the generated video. Each reference image can be a public HTTPS URL or a base64 data URI.

```ts
import { xai, type XaiVideoModelOptions } from '@ai-sdk/xai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: xai.video('grok-imagine-video'),
  prompt:
    'The comic cat from <IMAGE_1> and the comic dog from <IMAGE_2> ' +
    'are having a playful chase through a sunlit park. ' +
    'Cinematic slow-motion, warm afternoon light.',
  duration: 8,
  aspectRatio: '16:9',
  providerOptions: {
    xai: {
      mode: 'reference-to-video',
      referenceImageUrls: [
        'https://example.com/comic-cat.png',
        'https://example.com/comic-dog.png',
      ],
      pollTimeoutMs: 600000,
    } satisfies XaiVideoModelOptions,
  },
});
```

Use `<IMAGE_1>`, `<IMAGE_2>`, etc. in your prompt to reference specific images. Up to 7 reference images are supported per request.

<Note>
  Reference-to-video supports `duration`, `aspectRatio`, and `resolution`. Use
  `mode` to select the operation — each mode is mutually exclusive.
</Note>

### Video Provider Options

The following provider options are available via `providerOptions.xai`.
You can validate the provider options using the `XaiVideoModelOptions` type.

- **pollIntervalMs** _number_

  Polling interval in milliseconds for checking task status. Defaults to 5000.

- **pollTimeoutMs** _number_

  Maximum wait time in milliseconds for video generation. Defaults to 600000 (10 minutes).

- **resolution** _'480p' | '720p'_

  Video resolution. When using the SDK's standard `resolution` parameter,
  `1280x720` maps to `720p` and `854x480` maps to `480p`.
  Use this provider option to pass the native format directly.

- **mode** _'edit-video' | 'extend-video' | 'reference-to-video'_

  Selects the explicit video operation. Each mode is mutually exclusive:
  - `'edit-video'` — edit an existing video (requires `videoUrl`)
  - `'extend-video'` — extend a video from its last frame (requires `videoUrl`)
  - `'reference-to-video'` — generate from reference images (requires `referenceImageUrls`)

  When omitted, standard generation is used. Legacy inputs are still auto-detected from fields for backward compatibility.

- **videoUrl** _string_

  URL of a source video. Used with `mode: 'edit-video'` for video editing
  and `mode: 'extend-video'` for video extension.

- **referenceImageUrls** _string[]_

  Array of reference image URLs (1–7 images) or base64 data URIs for
  reference-to-video (R2V) generation. The model incorporates visual
  elements from these images without using them as the first frame. Use
  `<IMAGE_1>`, `<IMAGE_2>`, etc. in the prompt to reference specific
  images. Used with `mode: 'reference-to-video'`.

<Note>
  Video generation is an asynchronous process that can take several minutes.
  Consider setting `pollTimeoutMs` to at least 10 minutes (600000ms) for
  reliable operation. Generated video URLs are ephemeral and should be
  downloaded promptly.
</Note>

### Aspect Ratio and Resolution

For **text-to-video**, you can specify both `aspectRatio` and `resolution`.
The default aspect ratio is `16:9` and the default resolution is `480p`.

For **image-to-video**, the output defaults to the input image's aspect ratio.
If you specify `aspectRatio`, it will override this and stretch the image to the
desired ratio.

For **video editing**, the output matches the input video's aspect ratio and
resolution. Custom `duration`, `aspectRatio`, and `resolution` are not
supported — the output resolution is capped at 720p (e.g., a 1080p input
will be downsized to 720p).

For **video extension**, the output inherits `aspectRatio` and `resolution`
from the source video. `duration` is supported and controls only the
extension length.

For **reference-to-video (R2V)**, you can specify `duration`, `aspectRatio`,
and `resolution` just like text-to-video.

### Video Model Capabilities

| Model                | Duration | Aspect Ratios                                     | Resolution     | Image-to-Video      | Editing             | Extension           | R2V                 |
| -------------------- | -------- | ------------------------------------------------- | -------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `grok-imagine-video` | 1–15s    | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` | `480p`, `720p` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  You can also pass any available provider model ID as a string if needed.
</Note>

---
title: Vercel
description: Learn how to use Vercel's v0 models with the AI SDK.
---

# Vercel Provider

The [Vercel](https://vercel.com) provider gives you access to the [v0 API](https://v0.app/docs/api/model), designed for building modern web applications. The v0 models support text and image inputs and provide fast streaming responses.

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
- **Multimodal**: Supports both text and image inputs

## Setup

The Vercel provider is available via the `@ai-sdk/vercel` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/vercel" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/vercel" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/vercel" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/vercel" dark />
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
  model: vercel('v0-1.5-md'),
  prompt: 'Create a Next.js AI chatbot',
});
```

Vercel language models can also be used in the `streamText` function (see [AI SDK Core](/docs/ai-sdk-core)).

## Models

### v0-1.5-md

The `v0-1.5-md` model is for everyday tasks and UI generation.

### v0-1.5-lg

The `v0-1.5-lg` model is for advanced thinking or reasoning.

### v0-1.0-md (legacy)

The `v0-1.0-md` model is the legacy model served by the v0 API.

All v0 models have the following capabilities:

- Supports text and image inputs (multimodal)
- Supports function/tool calls
- Streaming responses with low latency
- Optimized for frontend and full-stack web development

## Model Capabilities

| Model       | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `v0-1.5-md` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `v0-1.5-lg` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `v0-1.0-md` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: OpenAI
description: Learn how to use the OpenAI provider for the AI SDK.
---

# OpenAI Provider

The [OpenAI](https://openai.com/) provider contains language model support for the OpenAI responses, chat, and completion APIs, as well as embedding model support for the OpenAI embeddings API.

## Setup

The OpenAI provider is available in the `@ai-sdk/openai` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/openai" dark />
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
  headers: {
    'header-name': 'header-value',
  },
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

## Language Models

The OpenAI provider instance is a function that you can invoke to create a language model:

```ts
const model = openai('gpt-5');
```

It automatically selects the correct API based on the model id.
You can also pass additional settings in the second argument:

```ts
const model = openai('gpt-5', {
  // additional settings
});
```

The available options depend on the API that's automatically chosen for the model (see below).
If you want to explicitly select a specific model API, you can use `.responses`, `.chat`, or `.completion`.

<Note>
  Since AI SDK 5, the OpenAI responses API is called by default (unless you
  specify e.g. 'openai.chat')
</Note>

### Example

You can use OpenAI language models to generate text with the `generateText` function:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: openai('gpt-5'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

OpenAI language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

### Responses Models

You can use the OpenAI responses API with the `openai(modelId)` or `openai.responses(modelId)` factory methods. It is the default API that is used by the OpenAI provider (since AI SDK 5).

```ts
const model = openai('gpt-5');
```

Further configuration can be done using OpenAI provider options.
You can validate the provider options using the `OpenAILanguageModelResponsesOptions` type.

```ts
import { openai, OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'), // or openai.responses('gpt-5')
  providerOptions: {
    openai: {
      parallelToolCalls: false,
      store: false,
      user: 'user_123',
      // ...
    } satisfies OpenAILanguageModelResponsesOptions,
  },
  // ...
});
```

The following provider options are available:

- **parallelToolCalls** _boolean_
  Whether to use parallel tool calls. Defaults to `true`.

- **store** _boolean_

  Whether to store the generation. Defaults to `true`.

- **maxToolCalls** _integer_
  The maximum number of total calls to built-in tools that can be processed in a response.
  This maximum number applies across all built-in tool calls, not per individual tool.
  Any further attempts to call a tool by the model will be ignored.

- **metadata** _Record&lt;string, string&gt;_
  Additional metadata to store with the generation.

- **conversation** _string_
  The ID of the OpenAI Conversation to continue.
  You must create a conversation first via the [OpenAI API](https://platform.openai.com/docs/api-reference/conversations/create).
  Cannot be used in conjunction with `previousResponseId`.
  Defaults to `undefined`.

- **previousResponseId** _string_
  The ID of the previous response. You can use it to continue a conversation. Defaults to `undefined`.

- **instructions** _string_
  Instructions for the model.
  They can be used to change the system or developer message when continuing a conversation using the `previousResponseId` option.
  Defaults to `undefined`.

- **logprobs** _boolean | number_
  Return the log probabilities of the tokens. Including logprobs will increase the response size and can slow down response times. However, it can be useful to better understand how the model is behaving. Setting to `true` returns the log probabilities of the tokens that were generated. Setting to a number (1-20) returns the log probabilities of the top n tokens that were generated.

- **user** _string_
  A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. Defaults to `undefined`.

- **reasoningEffort** _'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'_
  Reasoning effort for reasoning models. Defaults to `medium`. If you use `providerOptions` to set the `reasoningEffort` option, this model setting will be ignored.

<Note>
  The 'none' type for `reasoningEffort` is only available for OpenAI's GPT-5.1
  models. Also, the 'xhigh' type for `reasoningEffort` is only available for
  OpenAI's GPT-5.1-Codex-Max model. Setting `reasoningEffort` to 'none' or
  'xhigh' with unsupported models will result in an error.
</Note>

- **reasoningSummary** _'auto' | 'detailed'_
  Controls whether the model returns its reasoning process. Set to `'auto'` for a condensed summary, `'detailed'` for more comprehensive reasoning. Defaults to `undefined` (no reasoning summaries). When enabled, reasoning summaries appear in the stream as events with type `'reasoning'` and in non-streaming responses within the `reasoning` field.

- **strictJsonSchema** _boolean_
  Whether to use strict JSON schema validation. Defaults to `true`.

<Note type="warning">
  OpenAI structured outputs have several
  [limitations](https://openai.com/index/introducing-structured-outputs-in-the-api),
  in particular around the [supported
  schemas](https://platform.openai.com/docs/guides/structured-outputs/supported-schemas),
  and are therefore opt-in. For example, optional schema properties are not
  supported. You need to change Zod `.nullish()` and `.optional()` to
  `.nullable()`.
</Note>

- **serviceTier** _'auto' | 'flex' | 'priority' | 'default'_
  Service tier for the request. Set to 'flex' for 50% cheaper processing
  at the cost of increased latency (available for o3, o4-mini, and gpt-5 models).
  Set to 'priority' for faster processing with Enterprise access (available for gpt-4, gpt-5, gpt-5-mini, o3, o4-mini; gpt-5-nano is not supported).

  Defaults to 'auto'.

- **textVerbosity** _'low' | 'medium' | 'high'_
  Controls the verbosity of the model's response. Lower values result in more concise responses,
  while higher values result in more verbose responses. Defaults to `'medium'`.

- **include** _Array&lt;string&gt;_
  Specifies additional content to include in the response. Supported values:
  `['file_search_call.results']` for including file search results in responses.
  `['message.output_text.logprobs']` for logprobs.
  Defaults to `undefined`.

- **truncation** _string_
  The truncation strategy to use for the model response.

  - Auto: If the input to this Response exceeds the model's context window size, the model will truncate the response to fit the context window by dropping items from the beginning of the conversation.
  - disabled (default): If the input size will exceed the context window size for a model, the request will fail with a 400 error.

- **promptCacheKey** _string_
  A cache key for manual prompt caching control. Used by OpenAI to cache responses for similar requests to optimize your cache hit rates.

- **promptCacheRetention** _'in_memory' | '24h'_
  The retention policy for the prompt cache. Set to `'24h'` to enable extended prompt caching, which keeps cached prefixes active for up to 24 hours. Defaults to `'in_memory'` for standard prompt caching. Note: `'24h'` is currently only available for the 5.1 series of models.

- **safetyIdentifier** _string_
  A stable identifier used to help detect users of your application that may be violating OpenAI's usage policies. The IDs should be a string that uniquely identifies each user.

- **systemMessageMode** _'system' | 'developer' | 'remove'_
  Controls the role of the system message when making requests. By default (when omitted), for models that support reasoning the `system` message is automatically converted to a `developer` message. Setting `systemMessageMode` to `system` passes the system message as a system-level instruction; `developer` passes it as a developer message; `remove` omits the system message from the request.

- **forceReasoning** _boolean_
  Force treating this model as a reasoning model. This is useful for "stealth" reasoning models (e.g. via a custom baseURL) where the model ID is not recognized by the SDK's allowlist. When enabled, the SDK applies reasoning-model parameter compatibility rules and defaults `systemMessageMode` to `developer` unless overridden.

- **contextManagement** _Array&lt;object&gt;_
  Enable server-side context management (compaction). When configured, the server automatically compresses conversation context when token usage crosses a specified threshold. Each object in the array should have:
  - `type`: `'compaction'`
  - `compactThreshold`: _number_ — the token count at which compaction is triggered

The OpenAI responses provider also returns provider-specific metadata:

For Responses models, you can type this metadata using `OpenaiResponsesProviderMetadata`:

```ts
import { openai, type OpenaiResponsesProviderMetadata } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
});

const providerMetadata = result.providerMetadata as
  | OpenaiResponsesProviderMetadata
  | undefined;

const { responseId, logprobs, serviceTier } = providerMetadata?.openai ?? {};

// responseId can be used to continue a conversation (previousResponseId).
console.log(responseId);
```

The following OpenAI-specific metadata may be returned:

- **responseId** _string | null | undefined_
  The ID of the response. Can be used to continue a conversation.
- **logprobs** _(optional)_
  Log probabilities of output tokens (when enabled).
- **serviceTier** _(optional)_
  Service tier information returned by the API.

#### Reasoning Output

For reasoning models like `gpt-5`, you can enable reasoning summaries to see the model's thought process. Different models support different summarizers—for example, `o4-mini` supports detailed summaries. Set `reasoningSummary: "auto"` to automatically receive the richest level available.

```ts highlight="8-9,16"
import {
  openai,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai('gpt-5'),
  prompt: 'Tell me about the Mission burrito debate in San Francisco.',
  providerOptions: {
    openai: {
      reasoningSummary: 'detailed', // 'auto' for condensed or 'detailed' for comprehensive
    } satisfies OpenAILanguageModelResponsesOptions,
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
import {
  openai,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Tell me about the Mission burrito debate in San Francisco.',
  providerOptions: {
    openai: {
      reasoningSummary: 'auto',
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});
console.log('Reasoning:', result.reasoning);
```

Learn more about reasoning summaries in the [OpenAI documentation](https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries).

#### WebSocket Transport

OpenAI's [WebSocket API](https://developers.openai.com/api/docs/guides/websocket-mode) keeps a persistent connection open, which can significantly
reduce Time-to-First-Byte (TTFB) in agentic workflows with many tool calls.
After the initial connection, subsequent requests skip TCP/TLS/HTTP negotiation entirely.

The [`ai-sdk-openai-websocket-fetch`](https://www.npmjs.com/package/ai-sdk-openai-websocket-fetch)
package provides a drop-in `fetch` replacement that routes streaming requests
through a persistent WebSocket connection.

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add ai-sdk-openai-websocket-fetch" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install ai-sdk-openai-websocket-fetch" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add ai-sdk-openai-websocket-fetch" dark />
  </Tab>
  <Tab>
    <Snippet text="bun add ai-sdk-openai-websocket-fetch" dark />
  </Tab>
</Tabs>

Pass the WebSocket fetch to `createOpenAI` via the `fetch` option:

```ts highlight="2,6-7,15"
import { createOpenAI } from '@ai-sdk/openai';
import { createWebSocketFetch } from 'ai-sdk-openai-websocket-fetch';
import { streamText } from 'ai';

// Create a WebSocket-backed fetch instance
const wsFetch = createWebSocketFetch();
const openai = createOpenAI({ fetch: wsFetch });

const result = streamText({
  model: openai('gpt-4.1-mini'),
  prompt: 'Hello!',
  tools: {
    // ...
  },
  onFinish: () => wsFetch.close(), // close the WebSocket when done
});
```

The first request will be slower because it must establish the WebSocket connection
(DNS + TCP + TLS + WebSocket upgrade). After that, subsequent steps in a
multi-step tool-calling loop reuse the open connection, resulting in lower TTFB
per step.

<Note>
  The WebSocket transport only routes streaming requests to the OpenAI Responses
  API (`POST /responses` with `stream: true`) through the WebSocket. All other
  requests (non-streaming, embeddings, etc.) fall through to the standard
  `fetch` implementation.
</Note>

You can see a live side-by-side comparison of HTTP vs WebSocket streaming performance
in the [demo app](https://github.com/vercel-labs/ai-sdk-openai-websocket).

#### Verbosity Control

You can control the length and detail of model responses using the `textVerbosity` parameter:

```ts
import {
  openai,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5-mini'),
  prompt: 'Write a poem about a boy and his first pet dog.',
  providerOptions: {
    openai: {
      textVerbosity: 'low', // 'low' for concise, 'medium' (default), or 'high' for verbose
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});
```

The `textVerbosity` parameter scales output length without changing the underlying prompt:

- `'low'`: Produces terse, minimal responses
- `'medium'`: Balanced detail (default)
- `'high'`: Verbose responses with comprehensive detail

#### Web Search Tool

The OpenAI responses API supports web search through the `openai.tools.webSearch` tool.

```ts
const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'What happened in San Francisco last week?',
  tools: {
    web_search: openai.tools.webSearch({
      // optional configuration:
      externalWebAccess: true,
      searchContextSize: 'high',
      userLocation: {
        type: 'approximate',
        city: 'San Francisco',
        region: 'California',
      },
      filters: {
        allowedDomains: ['sfchronicle.com', 'sfgate.com'],
      },
    }),
  },
  // Force web search tool (optional):
  toolChoice: { type: 'tool', toolName: 'web_search' },
});

// URL sources directly from `results`
const sources = result.sources;

// Or access sources from tool results
for (const toolResult of result.toolResults) {
  if (toolResult.toolName === 'web_search') {
    console.log('Query:', toolResult.output.action.query);
    console.log('Sources:', toolResult.output.sources);
    // `sources` is an array of object: { type: 'url', url: string }
  }
}
```

The web search tool supports the following configuration options:

- **externalWebAccess** _boolean_ - Whether to use external web access for fetching live content. Defaults to `true`.
- **searchContextSize** _'low' | 'medium' | 'high'_ - Controls the amount of context used for the search. Higher values provide more comprehensive results but may have higher latency and cost.
- **userLocation** - Optional location information to provide geographically relevant results. Includes `type` (always `'approximate'`), `country`, `city`, `region`, and `timezone`.
- **filters** - Optional filter configuration to restrict search results.
  - **allowedDomains** _string[]_ - Array of allowed domains for the search. Subdomains of the provided domains are automatically included.

For detailed information on configuration options see the [OpenAI Web Search Tool documentation](https://platform.openai.com/docs/guides/tools-web-search?api-mode=responses).

#### File Search Tool

The OpenAI responses API supports file search through the `openai.tools.fileSearch` tool.

You can force the use of the file search tool by setting the `toolChoice` parameter to `{ type: 'tool', toolName: 'file_search' }`.

```ts
const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'What does the document say about user authentication?',
  tools: {
    file_search: openai.tools.fileSearch({
      vectorStoreIds: ['vs_123'],
      // configuration below is optional:
      maxNumResults: 5,
      filters: {
        key: 'author',
        type: 'eq',
        value: 'Jane Smith',
      },
      ranking: {
        ranker: 'auto',
        scoreThreshold: 0.5,
      },
    }),
  },
  providerOptions: {
    openai: {
      // optional: include results
      include: ['file_search_call.results'],
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});
```

The file search tool supports filtering with both comparison and compound filters:

**Comparison filters** - Filter by a single attribute:

- `eq` - Equal to
- `ne` - Not equal to
- `gt` - Greater than
- `gte` - Greater than or equal to
- `lt` - Less than
- `lte` - Less than or equal to
- `in` - Value is in array
- `nin` - Value is not in array

```ts
// Single comparison filter
filters: { key: 'year', type: 'gte', value: 2023 }

// Filter with array values
filters: { key: 'status', type: 'in', value: ['published', 'reviewed'] }
```

**Compound filters** - Combine multiple filters with `and` or `or`:

```ts
// Compound filter with AND
filters: {
  type: 'and',
  filters: [
    { key: 'author', type: 'eq', value: 'Jane Smith' },
    { key: 'year', type: 'gte', value: 2023 },
  ],
}

// Compound filter with OR
filters: {
  type: 'or',
  filters: [
    { key: 'department', type: 'eq', value: 'Engineering' },
    { key: 'department', type: 'eq', value: 'Research' },
  ],
}
```

#### Image Generation Tool

OpenAI's Responses API supports multi-modal image generation as a provider-defined tool.
Availability is restricted to specific models (for example, `gpt-5` variants).

You can use the image tool with either `generateText` or `streamText`:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt:
    'Generate an image of an echidna swimming across the Mozambique channel.',
  tools: {
    image_generation: openai.tools.imageGeneration({ outputFormat: 'webp' }),
  },
});

for (const toolResult of result.staticToolResults) {
  if (toolResult.toolName === 'image_generation') {
    const base64Image = toolResult.output.result;
  }
}
```

```ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai('gpt-5'),
  prompt:
    'Generate an image of an echidna swimming across the Mozambique channel.',
  tools: {
    image_generation: openai.tools.imageGeneration({
      outputFormat: 'webp',
      quality: 'low',
    }),
  },
});

for await (const part of result.fullStream) {
  if (part.type == 'tool-result' && !part.dynamic) {
    const base64Image = part.output.result;
  }
}
```

<Note>
  When you set `store: false`, then previously generated images will not be
  accessible by the model. We recommend using the image generation tool without
  setting `store: false`.
</Note>

For complete details on model availability, image quality controls, supported sizes, and tool-specific parameters,
refer to the OpenAI documentation:

- Image generation overview and models: [OpenAI Image Generation](https://platform.openai.com/docs/guides/image-generation)
- Image generation tool parameters (background, size, quality, format, etc.): [Image Generation Tool Options](https://platform.openai.com/docs/guides/tools-image-generation#tool-options)

#### Code Interpreter Tool

The OpenAI responses API supports the code interpreter tool through the `openai.tools.codeInterpreter` tool.
This allows models to write and execute Python code.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Write and run Python code to calculate the factorial of 10',
  tools: {
    code_interpreter: openai.tools.codeInterpreter({
      // optional configuration:
      container: {
        fileIds: ['file-123', 'file-456'], // optional file IDs to make available
      },
    }),
  },
});
```

The code interpreter tool can be configured with:

- **container**: Either a container ID string or an object with `fileIds` to specify uploaded files that should be available to the code interpreter

<Note>
  When working with files generated by the Code Interpreter, reference
  information can be obtained from both [annotations in Text
  Parts](#typed-providermetadata-in-text-parts) and [`providerMetadata` in
  Source Document Parts](#typed-providermetadata-in-source-document-parts).
</Note>

#### MCP Tool

The OpenAI responses API supports connecting to [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers through the `openai.tools.mcp` tool. This allows models to call tools exposed by remote MCP servers or service connectors.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'Search the web for the latest news about AI developments',
  tools: {
    mcp: openai.tools.mcp({
      serverLabel: 'web-search',
      serverUrl: 'https://mcp.exa.ai/mcp',
      serverDescription: 'A web-search API for AI agents',
    }),
  },
});
```

The MCP tool can be configured with:

- **serverLabel** _string_ (required)

  A label to identify the MCP server. This label is used in tool calls to distinguish between multiple MCP servers.

- **serverUrl** _string_ (required if `connectorId` is not provided)

  The URL for the MCP server. Either `serverUrl` or `connectorId` must be provided.

- **connectorId** _string_ (required if `serverUrl` is not provided)

  Identifier for a service connector. Either `serverUrl` or `connectorId` must be provided.

- **serverDescription** _string_ (optional)

  Optional description of the MCP server that helps the model understand its purpose.

- **allowedTools** _string[] | object_ (optional)

  Controls which tools from the MCP server are available. Can be:

  - An array of tool names: `['tool1', 'tool2']`
  - An object with filters:
    ```ts
    {
      readOnly: true, // Only allow read-only tools
      toolNames: ['tool1', 'tool2'] // Specific tool names
    }
    ```

- **authorization** _string_ (optional)

  OAuth access token for authenticating with the MCP server or connector.

- **headers** _Record&lt;string, string&gt;_ (optional)

  Optional HTTP headers to include in requests to the MCP server.

- **requireApproval** _'always' | 'never' | object_ (optional)

  Controls which MCP tool calls require user approval before execution. Can be:

  - `'always'`: All MCP tool calls require approval
  - `'never'`: No MCP tool calls require approval (default)
  - An object with filters:
    ```ts
    {
      never: {
        toolNames: ['safe_tool', 'another_safe_tool']; // Skip approval for these tools
      }
    }
    ```

  When approval is required, the model will return a `tool-approval-request` content part that you can use to prompt the user for approval. See [Human in the Loop](/cookbook/next/human-in-the-loop) for more details on implementing approval workflows.

<Note>
  When `requireApproval` is not set, tool calls are approved by default. Be sure
  to connect to only trusted MCP servers, who you trust to share your data with.
</Note>

<Note>
  The OpenAI MCP tool is different from the general MCP client approach
  documented in [MCP Tools](/docs/ai-sdk-core/mcp-tools). The OpenAI MCP tool is
  a built-in provider-defined tool that allows OpenAI models to directly connect
  to MCP servers, while the general MCP client requires you to convert MCP tools
  to AI SDK tools first.
</Note>

#### Local Shell Tool

The OpenAI responses API support the local shell tool for Codex models through the `openai.tools.localShell` tool.
Local shell is a tool that allows agents to run shell commands locally on a machine you or the user provides.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-5-codex'),
  tools: {
    local_shell: openai.tools.localShell({
      execute: async ({ action }) => {
        // ... your implementation, e.g. sandbox access ...
        return { output: stdout };
      },
    }),
  },
  prompt: 'List the files in my home directory.',
  stopWhen: isStepCount(2),
});
```

#### Shell Tool

The OpenAI Responses API supports the shell tool through the `openai.tools.shell` tool.
The shell tool allows running bash commands and interacting with a command line.
The model proposes shell commands; your integration executes them and returns the outputs.

<Note type="warning">
  Running arbitrary shell commands can be dangerous. Always sandbox execution or
  add strict allow-/deny-lists before forwarding a command to the system shell.
</Note>

The shell tool supports three environment modes that control where commands are executed:

##### Local Execution (default)

When no `environment` is specified (or `type: 'local'` is used), commands are executed locally via your `execute` callback:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      execute: async ({ action }) => {
        // ... your implementation, e.g. sandbox access ...
        return { output: results };
      },
    }),
  },
  prompt: 'List the files in the current directory and show disk usage.',
});
```

##### Hosted Container (auto)

Set `environment.type` to `'containerAuto'` to run commands in an OpenAI-hosted container. No `execute` callback is needed — OpenAI handles execution server-side:

```ts
const result = await generateText({
  model: openai('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      environment: {
        type: 'containerAuto',
        // optional configuration:
        memoryLimit: '4g',
        fileIds: ['file-abc123'],
        networkPolicy: {
          type: 'allowlist',
          allowedDomains: ['example.com'],
        },
      },
    }),
  },
  prompt: 'Install numpy and compute the eigenvalues of a 3x3 matrix.',
});
```

The `containerAuto` environment supports:

- **fileIds** _string[]_ - File IDs to make available in the container
- **memoryLimit** _'1g' | '4g' | '16g' | '64g'_ - Memory limit for the container
- **networkPolicy** - Network access policy:
  - `{ type: 'disabled' }` — no network access
  - `{ type: 'allowlist', allowedDomains: string[], domainSecrets?: Array<{ domain, name, value }> }` — allow specific domains with optional secrets

##### Existing Container Reference

Set `environment.type` to `'containerReference'` to use an existing container by ID:

```ts
const result = await generateText({
  model: openai('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      environment: {
        type: 'containerReference',
        containerId: 'cntr_abc123',
      },
    }),
  },
  prompt: 'Check the status of running processes.',
});
```

##### Execute Callback

For local execution (default or `type: 'local'`), your execute function must return an output array with results for each command:

- **stdout** _string_ - Standard output from the command
- **stderr** _string_ - Standard error from the command
- **outcome** - Either `{ type: 'timeout' }` or `{ type: 'exit', exitCode: number }`

##### Skills

[Skills](https://platform.openai.com/docs/guides/tools-skills) are versioned bundles of files with a `SKILL.md` manifest that extend the shell tool's capabilities. They can be attached to both `containerAuto` and `local` environments.

**Container skills** support two formats — by reference (for skills uploaded to OpenAI) or inline (as a base64-encoded zip):

```ts
const result = await generateText({
  model: openai('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      environment: {
        type: 'containerAuto',
        skills: [
          // By reference:
          { type: 'skillReference', skillId: 'skill_abc123' },
          // Or inline:
          {
            type: 'inline',
            name: 'my-skill',
            description: 'What this skill does',
            source: {
              type: 'base64',
              mediaType: 'application/zip',
              data: readFileSync('./my-skill.zip').toString('base64'),
            },
          },
        ],
      },
    }),
  },
  prompt: 'Use the skill to solve this problem.',
});
```

**Local skills** point to a directory on disk containing a `SKILL.md` file:

```ts
const result = await generateText({
  model: openai('gpt-5.2'),
  tools: {
    shell: openai.tools.shell({
      execute: async ({ action }) => {
        // ... your local execution implementation ...
        return { output: results };
      },
      environment: {
        type: 'local',
        skills: [
          {
            name: 'my-skill',
            description: 'What this skill does',
            path: resolve('path/to/skill-directory'),
          },
        ],
      },
    }),
  },
  prompt: 'Use the skill to solve this problem.',
  stopWhen: isStepCount(5),
});
```

For more details on creating skills, see the [OpenAI Skills documentation](https://platform.openai.com/docs/guides/tools-skills).

#### Apply Patch Tool

The OpenAI Responses API supports the apply patch tool for GPT-5.1 models through the `openai.tools.applyPatch` tool.
The apply patch tool lets the model create, update, and delete files in your codebase using structured diffs.
Instead of just suggesting edits, the model emits patch operations that your application applies and reports back on,
enabling iterative, multi-step code editing workflows.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, isStepCount } from 'ai';

const result = await generateText({
  model: openai('gpt-5.1'),
  tools: {
    apply_patch: openai.tools.applyPatch({
      execute: async ({ callId, operation }) => {
        // ... your implementation for applying the diffs.
      },
    }),
  },
  prompt: 'Create a python file that calculates the factorial of a number',
  stopWhen: isStepCount(5),
});
```

Your execute function must return:

- **status** _'completed' | 'failed'_ - Whether the patch was applied successfully
- **output** _string_ (optional) - Human-readable log text (e.g., results or error messages)

#### Tool Search

Tool search allows the model to dynamically search for and load tools into context as needed,
rather than loading all tool definitions up front. This can reduce token usage, cost, and latency
when you have many tools. Mark the tools you want to make searchable with `deferLoading: true`
in their `providerOptions`.

There are two execution modes:

- **Server-executed (hosted):** OpenAI searches across the deferred tools declared in the request and returns the loaded subset in the same response. No extra round-trip is needed.
- **Client-executed:** The model emits a `tool_search_call`, your application performs the lookup, and you return the matching tools via the `execute` callback.

##### Server-Executed (Hosted) Tool Search

Use hosted tool search when the candidate tools are already known at request time.
Add `openai.tools.toolSearch()` with no arguments and mark your tools with `deferLoading: true`:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, tool, isStepCount } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: openai.responses('gpt-5.4'),
  prompt: 'What is the weather in San Francisco?',
  stopWhen: isStepCount(10),
  tools: {
    toolSearch: openai.tools.toolSearch(),

    get_weather: tool({
      description: 'Get the current weather at a specific location',
      inputSchema: z.object({
        location: z.string(),
        unit: z.enum(['celsius', 'fahrenheit']),
      }),
      execute: async ({ location, unit }) => ({
        location,
        temperature: unit === 'celsius' ? 18 : 64,
      }),
      providerOptions: {
        openai: { deferLoading: true },
      },
    }),

    search_files: tool({
      description: 'Search through files in the workspace',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({
        results: [`Found 3 files matching "${query}"`],
      }),
      providerOptions: {
        openai: { deferLoading: true },
      },
    }),
  },
});
```

In hosted mode, the model internally searches the deferred tools, loads the relevant ones, and
proceeds to call them — all within a single response. The `tool_search_call` and
`tool_search_output` items appear in the response with `execution: 'server'` and `call_id: null`.

##### Client-Executed Tool Search

Use client-executed tool search when tool discovery depends on runtime state — for example,
tools that vary per tenant, project, or external system. Pass `execution: 'client'` along with
a `description`, `parameters` schema, and an `execute` callback:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, tool, isStepCount } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: openai.responses('gpt-5.4'),
  prompt: 'What is the weather in San Francisco?',
  stopWhen: isStepCount(10),
  tools: {
    toolSearch: openai.tools.toolSearch({
      execution: 'client',
      description: 'Search for available tools based on what the user needs.',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'What the user is trying to accomplish',
          },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      execute: async ({ arguments: args }) => {
        // Your custom tool discovery logic here.
        // Return the tools that match the search goal.
        return {
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get the current weather at a specific location',
              deferLoading: true,
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
                required: ['location'],
                additionalProperties: false,
              },
            },
          ],
        };
      },
    }),

    get_weather: tool({
      description: 'Get the current weather at a specific location',
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({
        location,
        temperature: 64,
        condition: 'Partly cloudy',
      }),
      providerOptions: {
        openai: { deferLoading: true },
      },
    }),
  },
});
```

In client mode, the flow spans two steps:

1. **Step 1:** The model emits a `tool_search_call` with `execution: 'client'` and a non-null `call_id`. The SDK calls your `execute` callback with the search arguments. Your callback returns the discovered tools.
2. **Step 2:** The SDK sends the `tool_search_output` (with the matching `call_id`) back to the model. The model can now call the loaded tools as normal function calls.

For more details, see the [OpenAI Tool Search documentation](https://platform.openai.com/docs/guides/tools-tool-search).

#### Custom Tool

The OpenAI Responses API supports
[custom tools](https://developers.openai.com/api/docs/guides/function-calling/#custom-tools)
through the `openai.tools.customTool` tool.
Custom tools return a raw string instead of JSON, optionally constrained to a grammar
(regex or Lark syntax). This makes them useful for generating structured text like
SQL queries, code snippets, or any output that must match a specific pattern.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, isStepCount } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-5.2-codex'),
  tools: {
    write_sql: openai.tools.customTool({
      description: 'Write a SQL SELECT query to answer the user question.',
      format: {
        type: 'grammar',
        syntax: 'regex',
        definition: 'SELECT .+',
      },
      execute: async input => {
        // input is a raw string matching the grammar, e.g. "SELECT * FROM users WHERE age > 25"
        const rows = await db.query(input);
        return JSON.stringify(rows);
      },
    }),
  },
  toolChoice: 'required',
  prompt: 'Write a SQL query to get all users older than 25.',
  stopWhen: isStepCount(3),
});
```

Custom tools also work with `streamText`:

```ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai.responses('gpt-5.2-codex'),
  tools: {
    write_sql: openai.tools.customTool({
      description: 'Write a SQL SELECT query to answer the user question.',
      format: {
        type: 'grammar',
        syntax: 'regex',
        definition: 'SELECT .+',
      },
    }),
  },
  toolChoice: 'required',
  prompt: 'Write a SQL query to get all users older than 25.',
});

for await (const chunk of result.fullStream) {
  if (chunk.type === 'tool-call') {
    console.log(`Tool: ${chunk.toolName}`);
    console.log(`Input: ${chunk.input}`);
  }
}
```

The custom tool can be configured with:

- **description** _string_ (optional) - A description of what the tool does, to help the model understand when to use it.
- **format** _object_ (optional) - The output format constraint. Omit for unconstrained text output.
  - **type** _'grammar' | 'text'_ - The format type. Use `'grammar'` for constrained output or `'text'` for explicit unconstrained text.
  - **syntax** _'regex' | 'lark'_ - (grammar only) The grammar syntax. Use `'regex'` for regular expression patterns or `'lark'` for [Lark parser grammar](https://lark-parser.readthedocs.io/).
  - **definition** _string_ - (grammar only) The grammar definition string (a regex pattern or Lark grammar).
- **execute** _function_ (optional) - An async function that receives the raw string input and returns a string result. Enables multi-turn tool calling.

#### Image Inputs

The OpenAI Responses API supports Image inputs for appropriate models.
You can pass Image files as part of the message content using the 'image' type:

```ts
const result = await generateText({
  model: openai('gpt-5'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Please describe the image.',
        },
        {
          type: 'image',
          image: readFileSync('./data/image.png'),
        },
      ],
    },
  ],
});
```

The model will have access to the image and will respond to questions about it.
The image should be passed using the `image` field.

You can also pass a file-id from the OpenAI Files API.

```ts
{
  type: 'image',
  image: 'file-8EFBcWHsQxZV7YGezBC1fq'
}
```

You can also pass the URL of an image.

```ts
{
  type: 'image',
  image: 'https://sample.edu/image.png',
}
```

#### PDF Inputs

The OpenAI Responses API supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: openai('gpt-5'),
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
          data: readFileSync('./data/ai.pdf'),
          mediaType: 'application/pdf',
          filename: 'ai.pdf', // optional
        },
      ],
    },
  ],
});
```

You can also pass a file-id from the OpenAI Files API.

```ts
{
  type: 'file',
  data: 'file-8EFBcWHsQxZV7YGezBC1fq',
  mediaType: 'application/pdf',
}
```

You can also pass the URL of a pdf.

```ts
{
  type: 'file',
  data: 'https://sample.edu/example.pdf',
  mediaType: 'application/pdf',
  filename: 'ai.pdf', // optional
}
```

The model will have access to the contents of the PDF file and
respond to questions about it.
The PDF file should be passed using the `data` field,
and the `mediaType` should be set to `'application/pdf'`.

#### Structured Outputs

The OpenAI Responses API supports structured outputs. You can use `generateText` or `streamText` with [`Output`](/docs/reference/ai-sdk-core/output) to enforce structured outputs.

```ts
const result = await generateText({
  model: openai('gpt-4.1'),
  output: Output.object({
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
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

#### Typed providerMetadata in Text Parts

When using the OpenAI Responses API, the SDK attaches OpenAI-specific metadata to output parts via `providerMetadata`.

This metadata can be used on the client side for tasks such as rendering citations or downloading files generated by the Code Interpreter.
To enable type-safe handling of this metadata, the AI SDK exports dedicated TypeScript types.

For text parts, when `part.type === 'text'`, the `providerMetadata` is provided in the form of `OpenaiResponsesTextProviderMetadata`.

This metadata includes the following fields:

- `itemId`
  The ID of the output item in the Responses API.
- `annotations` (optional)
  An array of annotation objects generated by the model.
  If no annotations are present, this property itself may be omitted (`undefined`).

  Each element in `annotations` is a discriminated union with a required `type` field. Supported types include, for example:

  - `url_citation`
  - `file_citation`
  - `container_file_citation`
  - `file_path`

  These annotations directly correspond to the annotation objects defined by the Responses API and can be used for inline reference rendering or output analysis.
  For details, see the official OpenAI documentation:
  [Responses API – output text annotations](https://platform.openai.com/docs/api-reference/responses/object?lang=javascript#responses-object-output-output_message-content-output_text-annotations).

```ts
import {
  openai,
  type OpenaiResponsesTextProviderMetadata,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4.1-mini'),
  prompt:
    'Create a program that generates five random numbers between 1 and 100 with two decimal places, and show me the execution results. Also save the result to a file.',
  tools: {
    code_interpreter: openai.tools.codeInterpreter(),
    web_search: openai.tools.webSearch(),
    file_search: openai.tools.fileSearch({ vectorStoreIds: ['vs_1234'] }), // requires a configured vector store
  },
});

for (const part of result.content) {
  if (part.type === 'text') {
    const providerMetadata = part.providerMetadata as
      | OpenaiResponsesTextProviderMetadata
      | undefined;
    if (!providerMetadata) continue;
    const { itemId: _itemId, annotations } = providerMetadata.openai;

    if (!annotations) continue;
    for (const annotation of annotations) {
      switch (annotation.type) {
        case 'url_citation':
          // url_citation is returned from web_search and provides:
          // properties: type, url, title, start_index and end_index
          break;
        case 'file_citation':
          // file_citation is returned from file_search and provides:
          // properties: type, file_id, filename and index
          break;
        case 'container_file_citation':
          // container_file_citation is returned from code_interpreter and provides:
          // properties: type, container_id, file_id, filename, start_index and end_index
          break;
        case 'file_path':
          // file_path provides:
          // properties: type, file_id and index
          break;
        default: {
          const _exhaustiveCheck: never = annotation;
          throw new Error(
            `Unhandled annotation: ${JSON.stringify(_exhaustiveCheck)}`,
          );
        }
      }
    }
  }
}
```

<Note>
  When implementing file downloads for files generated by the Code Interpreter,
  the `container_id` and `file_id` available in `providerMetadata` can be used
  to retrieve the file content. For details, see the [Retrieve container file
  content](https://platform.openai.com/docs/api-reference/container-files/retrieveContainerFileContent)
  API.
</Note>

#### Typed providerMetadata in Reasoning Parts

When using the OpenAI Responses API, reasoning output parts can include provider metadata.
To handle this metadata in a type-safe way, use `OpenaiResponsesReasoningProviderMetadata`.

For reasoning parts, when `part.type === 'reasoning'`, the `providerMetadata` is provided in the form of `OpenaiResponsesReasoningProviderMetadata`.

This metadata includes the following fields:

- `itemId`  
  The ID of the reasoning item in the Responses API.
- `reasoningEncryptedContent` (optional)  
  Encrypted reasoning content (only returned when requested via `include: ['reasoning.encrypted_content']`).

```ts
import {
  openai,
  type OpenaiResponsesReasoningProviderMetadata,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'),
  prompt: 'How many "r"s are in the word "strawberry"?',
  providerOptions: {
    openai: {
      store: false,
      include: ['reasoning.encrypted_content'],
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});

for (const part of result.content) {
  if (part.type === 'reasoning') {
    const providerMetadata = part.providerMetadata as
      | OpenaiResponsesReasoningProviderMetadata
      | undefined;

    const { itemId, reasoningEncryptedContent } =
      providerMetadata?.openai ?? {};
    console.log(itemId, reasoningEncryptedContent);
  }
}
```

#### Typed providerMetadata in Source Document Parts

For source document parts, when `part.type === 'source'` and `sourceType === 'document'`, the `providerMetadata` is provided as `OpenaiResponsesSourceDocumentProviderMetadata`.

This metadata is also a discriminated union with a required `type` field. Supported types include:

- `file_citation`
- `container_file_citation`
- `file_path`

Each type includes the identifiers required to work with the referenced resource, such as `fileId` and `containerId`.

```ts
import {
  openai,
  type OpenaiResponsesSourceDocumentProviderMetadata,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-4.1-mini'),
  prompt:
    'Create a program that generates five random numbers between 1 and 100 with two decimal places, and show me the execution results. Also save the result to a file.',
  tools: {
    code_interpreter: openai.tools.codeInterpreter(),
    web_search: openai.tools.webSearch(),
    file_search: openai.tools.fileSearch({ vectorStoreIds: ['vs_1234'] }), // requires a configured vector store
  },
});

for (const part of result.content) {
  if (part.type === 'source') {
    if (part.sourceType === 'document') {
      const providerMetadata = part.providerMetadata as
        | OpenaiResponsesSourceDocumentProviderMetadata
        | undefined;
      if (!providerMetadata) continue;
      const annotation = providerMetadata.openai;
      switch (annotation.type) {
        case 'file_citation':
          // file_citation is returned from file_search and provides:
          // properties: type, fileId and index
          // The filename can be accessed via part.filename.
          break;
        case 'container_file_citation':
          // container_file_citation is returned from code_interpreter and provides:
          // properties: type, containerId and fileId
          // The filename can be accessed via part.filename.
          break;
        case 'file_path':
          // file_path provides:
          // properties: type, fileId and index
          break;
        default: {
          const _exhaustiveCheck: never = annotation;
          throw new Error(
            `Unhandled annotation: ${JSON.stringify(_exhaustiveCheck)}`,
          );
        }
      }
    }
  }
}
```

<Note>
  Annotations in text parts follow the OpenAI Responses API specification and
  therefore use snake_case properties (e.g. `file_id`, `container_id`). In
  contrast, `providerMetadata` for source document parts is normalized by the
  SDK to camelCase (e.g. `fileId`, `containerId`). Fields that depend on the
  original text content, such as `start_index` and `end_index`, are omitted, as
  are fields like `filename` that are directly available on the source object.
</Note>

#### Compaction

The OpenAI Responses API supports server-side context compaction. When enabled, the server automatically compresses conversation context when token usage crosses a configured threshold. This is useful for long-running conversations or agent loops where you want to stay within token limits without manually managing context.

The compaction item returned by the server is opaque and encrypted — it carries forward key prior state and reasoning into the next turn using fewer tokens. The AI SDK handles this automatically: compaction items are returned as text parts with special `providerMetadata`, and when passed back in subsequent requests they are sent as compaction input items.

```ts highlight="7-11"
import {
  openai,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-5.2'),
  messages: conversationHistory,
  providerOptions: {
    openai: {
      store: false,
      contextManagement: [{ type: 'compaction', compactThreshold: 50000 }],
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});
```

**Configuration:**

- **type** — Must be `'compaction'`
- **compactThreshold** — The token count at which compaction is triggered. When the rendered input token count crosses this threshold, the server runs a compaction pass before continuing inference.

<Note>
  Server-side compaction is ZDR-friendly when you set `store: false` on your
  requests.
</Note>

##### Detecting Compaction in Streams

When using `streamText`, you can detect compaction by checking the `providerMetadata` on `text-start` and `text-end` events:

```ts
import {
  openai,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai.responses('gpt-5.2'),
  messages: conversationHistory,
  providerOptions: {
    openai: {
      store: false,
      contextManagement: [{ type: 'compaction', compactThreshold: 50000 }],
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-start': {
      const isCompaction = part.providerMetadata?.openai?.type === 'compaction';
      if (isCompaction) {
        // ... your logic
      }
      break;
    }
    case 'text-end': {
      const isCompaction = part.providerMetadata?.openai?.type === 'compaction';
      if (isCompaction) {
        // ... your logic
      }
      break;
    }
    case 'text-delta': {
      process.stdout.write(part.text);
      break;
    }
  }
}
```

##### Compaction in UI Applications

When using `useChat` or other UI hooks, compaction items appear as text parts with `providerMetadata`. You can detect and style them differently in your UI:

```tsx
{
  message.parts.map((part, index) => {
    if (part.type === 'text') {
      const isCompaction =
        (part.providerMetadata?.openai as { type?: string } | undefined)
          ?.type === 'compaction';

      if (isCompaction) {
        return (
          <div
            key={index}
            className="bg-yellow-100 border-l-4 border-yellow-500 p-2"
          >
            <span className="font-bold">[Context Compacted]</span>
            <p className="text-sm text-yellow-700">
              The server compressed the conversation context to reduce token
              usage.
            </p>
          </div>
        );
      }
      return <div key={index}>{part.text}</div>;
    }
  });
}
```

The metadata includes the following fields:

- **type** — Always `'compaction'`
- **itemId** _string_ — The ID of the compaction item in the Responses API
- **encryptedContent** _string_ (optional) — The encrypted compaction state. This is automatically sent back to the API when the message is included in subsequent requests.

### Chat Models

You can create models that call the [OpenAI chat API](https://platform.openai.com/docs/api-reference/chat) using the `.chat()` factory method.
The first argument is the model id, e.g. `gpt-4`.
The OpenAI chat models support tool calls and some have multi-modal capabilities.

```ts
const model = openai.chat('gpt-5');
```

OpenAI chat models support also some model specific provider options that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them in the `providerOptions` argument:

```ts
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';

const model = openai.chat('gpt-5');

await generateText({
  model,
  providerOptions: {
    openai: {
      logitBias: {
        // optional likelihood for specific tokens
        '50256': -100,
      },
      user: 'test-user', // optional unique user identifier
    } satisfies OpenAILanguageModelChatOptions,
  },
});
```

The following optional provider options are available for OpenAI chat models:

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

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. [Learn more](https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids).

- **reasoningEffort** _'minimal' | 'low' | 'medium' | 'high' | 'xhigh'_

  Reasoning effort for reasoning models. Defaults to `medium`. If you use
  `providerOptions` to set the `reasoningEffort` option, this
  model setting will be ignored.

- **maxCompletionTokens** _number_

  Maximum number of completion tokens to generate. Useful for reasoning models.

- **store** _boolean_

  Whether to enable persistence in Responses API.

- **metadata** _Record&lt;string, string&gt;_

  Metadata to associate with the request.

- **prediction** _Record&lt;string, any&gt;_

  Parameters for prediction mode.

- **serviceTier** _'auto' | 'flex' | 'priority' | 'default'_

  Service tier for the request. Set to 'flex' for 50% cheaper processing
  at the cost of increased latency (available for o3, o4-mini, and gpt-5 models).
  Set to 'priority' for faster processing with Enterprise access (available for gpt-4, gpt-5, gpt-5-mini, o3, o4-mini; gpt-5-nano is not supported).

  Defaults to 'auto'.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation.
  Defaults to `true`.

- **textVerbosity** _'low' | 'medium' | 'high'_

  Controls the verbosity of the model's responses. Lower values will result in more concise responses, while higher values will result in more verbose responses.

- **promptCacheKey** _string_

  A cache key for manual prompt caching control. Used by OpenAI to cache responses for similar requests to optimize your cache hit rates.

- **promptCacheRetention** _'in_memory' | '24h'_

  The retention policy for the prompt cache. Set to `'24h'` to enable extended prompt caching, which keeps cached prefixes active for up to 24 hours. Defaults to `'in_memory'` for standard prompt caching. Note: `'24h'` is currently only available for the 5.1 series of models.

- **safetyIdentifier** _string_

  A stable identifier used to help detect users of your application that may be violating OpenAI's usage policies. The IDs should be a string that uniquely identifies each user.

- **systemMessageMode** _'system' | 'developer' | 'remove'_

  Override the system message mode for this model. If not specified, the mode is automatically determined based on the model. `system` uses the 'system' role for system messages (default for most models); `developer` uses the 'developer' role (used by reasoning models); `remove` removes system messages entirely.

- **forceReasoning** _boolean_

  Force treating this model as a reasoning model. This is useful for "stealth" reasoning models (e.g. via a custom baseURL) where the model ID is not recognized by the SDK's allowlist. When enabled, the SDK applies reasoning-model parameter compatibility rules and defaults `systemMessageMode` to `developer` unless overridden.

#### Reasoning

OpenAI has introduced the `o1`,`o3`, and `o4` series of [reasoning models](https://platform.openai.com/docs/guides/reasoning).
Currently, `o4-mini`, `o3`, `o3-mini`, and `o1` are available via both the chat and responses APIs. The
model `gpt-5.1-codex-mini` is available only via the [responses API](#responses-models).

Reasoning models currently only generate text, have several limitations, and are only supported using `generateText` and `streamText`.

They support additional settings and response metadata:

- You can use `providerOptions` to set

  - the `reasoningEffort` option (or alternatively the `reasoningEffort` model setting), which determines the amount of reasoning the model performs.

- You can use response `providerMetadata` to access the number of reasoning tokens that the model generated.

```ts highlight="4,7-11,17"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5'),
  prompt: 'Invent a new holiday and describe its traditions.',
  providerOptions: {
    openai: {
      reasoningEffort: 'low',
    } satisfies OpenAILanguageModelChatOptions,
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
  reasoning models when supported.
</Note>

- You can control how system messages are handled by providerOptions `systemMessageMode`:

  - `developer`: treat the prompt as a developer message (default for reasoning models).
  - `system`: keep the system message as a system-level instruction.
  - `remove`: remove the system message from the messages.

```ts highlight="12"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.chat('gpt-5'),
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Tell me a joke.' },
  ],
  providerOptions: {
    openai: {
      systemMessageMode: 'system',
    } satisfies OpenAILanguageModelChatOptions,
  },
});
```

<Note>
  Reasoning models require additional runtime inference to complete their
  reasoning phase before generating a response. This introduces longer latency
  compared to other models.
</Note>

<Note>
  `maxOutputTokens` is automatically mapped to `max_completion_tokens` for
  reasoning models.
</Note>

#### Strict Structured Outputs

Strict structured outputs are enabled by default.
You can disable them by setting the `strictJsonSchema` option to `false`.

```ts highlight="7"
import { openai, OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: openai.chat('gpt-4o-2024-08-06'),
  providerOptions: {
    openai: {
      strictJsonSchema: false,
    } satisfies OpenAILanguageModelChatOptions,
  },
  output: Output.object({
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
    schemaName: 'recipe',
    schemaDescription: 'A recipe for lasagna.',
  }),
  prompt: 'Generate a lasagna recipe.',
});

console.log(JSON.stringify(result.output, null, 2));
```

<Note type="warning">
  OpenAI structured outputs have several
  [limitations](https://openai.com/index/introducing-structured-outputs-in-the-api),
  in particular around the [supported schemas](https://platform.openai.com/docs/guides/structured-outputs/supported-schemas),
  and are therefore opt-in.

For example, optional schema properties are not supported.
You need to change Zod `.nullish()` and `.optional()` to `.nullable()`.

</Note>

#### Logprobs

OpenAI provides logprobs information for completion/chat models.
You can access it in the `providerMetadata` object.

```ts highlight="11"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.chat('gpt-5'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  providerOptions: {
    openai: {
      // this can also be a number,
      // refer to logprobs provider options section for more
      logprobs: true,
    } satisfies OpenAILanguageModelChatOptions,
  },
});

const openaiMetadata = (await result.providerMetadata)?.openai;

const logprobs = openaiMetadata?.logprobs;
```

#### Image Support

The OpenAI Chat API supports Image inputs for appropriate models.
You can pass Image files as part of the message content using the 'image' type:

```ts
const result = await generateText({
  model: openai.chat('gpt-5'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Please describe the image.',
        },
        {
          type: 'image',
          image: readFileSync('./data/image.png'),
        },
      ],
    },
  ],
});
```

The model will have access to the image and will respond to questions about it.
The image should be passed using the `image` field.

You can also pass the URL of an image.

```ts
{
  type: 'image',
  image: 'https://sample.edu/image.png',
}
```

#### PDF support

The OpenAI Chat API supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: openai.chat('gpt-5'),
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
          data: readFileSync('./data/ai.pdf'),
          mediaType: 'application/pdf',
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
and the `mediaType` should be set to `'application/pdf'`.

You can also pass a file-id from the OpenAI Files API.

```ts
{
  type: 'file',
  data: 'file-8EFBcWHsQxZV7YGezBC1fq',
  mediaType: 'application/pdf',
}
```

You can also pass the URL of a PDF.

```ts
{
  type: 'file',
  data: 'https://sample.edu/example.pdf',
  mediaType: 'application/pdf',
  filename: 'ai.pdf', // optional
}
```

#### Predicted Outputs

OpenAI supports [predicted outputs](https://platform.openai.com/docs/guides/latency-optimization#use-predicted-outputs) for `gpt-4o` and `gpt-4o-mini`.
Predicted outputs help you reduce latency by allowing you to specify a base text that the model should modify.
You can enable predicted outputs by adding the `prediction` option to the `providerOptions.openai` object:

```ts highlight="15-18"
const result = streamText({
  model: openai.chat('gpt-5'),
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
    } satisfies OpenAILanguageModelChatOptions,
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
  model: openai.chat('gpt-5'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the image in detail.' },
        {
          type: 'image',
          image:
            'https://github.com/vercel/ai/blob/main/examples/ai-functions/data/comic-cat.png?raw=true',

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
  support the `providerOptions` property, you can use `convertToModelMessages`
  first before passing the messages to functions like `generateText` or
  `streamText`. For more details on `providerOptions` usage, see
  [here](/docs/foundations/prompts#provider-options).
</Note>

#### Distillation

OpenAI supports model distillation for some models.
If you want to store a generation for use in the distillation process, you can add the `store` option to the `providerOptions.openai` object.
This will save the generation to the OpenAI platform for later use in distillation.

```typescript highlight="9-16"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';
import 'dotenv/config';

async function main() {
  const { text, usage } = await generateText({
    model: openai.chat('gpt-4o-mini'),
    prompt: 'Who worked on the original macintosh?',
    providerOptions: {
      openai: {
        store: true,
        metadata: {
          custom: 'value',
        },
      } satisfies OpenAILanguageModelChatOptions,
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
including `gpt-4o` and `gpt-4o-mini`.

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
  model: openai.chat('gpt-4o-mini'),
  prompt: `A 1024-token or longer prompt...`,
});

console.log(`usage:`, {
  ...usage,
  cachedPromptTokens: providerMetadata?.openai?.cachedPromptTokens,
});
```

To improve cache hit rates, you can manually control caching using the `promptCacheKey` option:

```ts highlight="7-11"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5'),
  prompt: `A 1024-token or longer prompt...`,
  providerOptions: {
    openai: {
      promptCacheKey: 'my-custom-cache-key-123',
    } satisfies OpenAILanguageModelChatOptions,
  },
});

console.log(`usage:`, {
  ...usage,
  cachedPromptTokens: providerMetadata?.openai?.cachedPromptTokens,
});
```

For GPT-5.1 models, you can enable extended prompt caching that keeps cached prefixes active for up to 24 hours:

```ts highlight="7-12"
import { openai, type OpenAILanguageModelChatOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5.1'),
  prompt: `A 1024-token or longer prompt...`,
  providerOptions: {
    openai: {
      promptCacheKey: 'my-custom-cache-key-123',
      promptCacheRetention: '24h', // Extended caching for GPT-5.1
    } satisfies OpenAILanguageModelChatOptions,
  },
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
  model: openai.chat('gpt-4o-audio-preview'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is the audio saying?' },
        {
          type: 'file',
          mediaType: 'audio/mpeg',
          data: readFileSync('./data/galileo.mp3'),
        },
      ],
    },
  ],
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
const model = openai.completion('gpt-3.5-turbo-instruct');

await model.doGenerate({
  providerOptions: {
    openai: {
      echo: true, // optional, echo the prompt in addition to the completion
      logitBias: {
        // optional likelihood for specific tokens
        '50256': -100,
      },
      suffix: 'some text', // optional suffix that comes after a completion of inserted text
      user: 'test-user', // optional unique user identifier
    } satisfies OpenAILanguageModelCompletionOptions,
  },
});
```

The following optional provider options are available for OpenAI completion models:

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

| Model                 | Image Input         | Audio Input         | Object Generation   | Tool Usage          |
| --------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `gpt-5.4-pro`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.4`             | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.4-mini`        | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.4-nano`        | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.3-chat-latest` | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.2-pro`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.2-chat-latest` | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.2`             | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.1-codex-mini`  | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.1-codex`       | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.1-chat-latest` | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5.1`             | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-pro`           | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5`               | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-mini`          | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-nano`          | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-codex`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-5-chat-latest`   | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `gpt-4.1`             | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4.1-mini`        | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4.1-nano`        | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o`              | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gpt-4o-mini`         | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |

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

OpenAI embedding models support several additional provider options.
You can pass them as an options argument:

```ts
import { openai, type OpenAIEmbeddingModelOptions } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-large'),
  value: 'sunny day at the beach',
  providerOptions: {
    openai: {
      dimensions: 512, // optional, number of dimensions for the embedding
      user: 'test-user', // optional unique user identifier
    } satisfies OpenAIEmbeddingModelOptions,
  },
});
```

The following optional provider options are available for OpenAI embedding models:

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

### Image Editing

OpenAI's `gpt-image-1` model supports powerful image editing capabilities. Pass input images via `prompt.images` to transform, combine, or edit existing images.

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: openai.image('gpt-image-1'),
  prompt: {
    text: 'Turn the cat into a dog but retain the style of the original image',
    images: [imageBuffer],
  },
});
```

#### Inpainting with Mask

Edit specific parts of an image using a mask. Transparent areas in the mask indicate where the image should be edited:

```ts
const image = readFileSync('./input-image.png');
const mask = readFileSync('./mask.png'); // Transparent areas = edit regions

const { images } = await generateImage({
  model: openai.image('gpt-image-1'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask: mask,
  },
});
```

#### Background Removal

Remove the background from an image by setting `background` to `transparent`:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: openai.image('gpt-image-1'),
  prompt: {
    text: 'do not change anything',
    images: [imageBuffer],
  },
  providerOptions: {
    openai: {
      background: 'transparent',
      output_format: 'png',
    },
  },
});
```

#### Multi-Image Combining

Combine multiple reference images into a single output. `gpt-image-1` supports up to 16 input images:

```ts
const cat = readFileSync('./cat.png');
const dog = readFileSync('./dog.png');
const owl = readFileSync('./owl.png');
const bear = readFileSync('./bear.png');

const { images } = await generateImage({
  model: openai.image('gpt-image-1'),
  prompt: {
    text: 'Combine these animals into a group photo, retaining the original style',
    images: [cat, dog, owl, bear],
  },
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings. For `gpt-image-1`, each image should be a `png`,
  `webp`, or `jpg` file less than 50MB.
</Note>

### Model Capabilities

| Model              | Sizes                           |
| ------------------ | ------------------------------- |
| `gpt-image-1.5`    | 1024x1024, 1536x1024, 1024x1536 |
| `gpt-image-1-mini` | 1024x1024, 1536x1024, 1024x1536 |
| `gpt-image-1`      | 1024x1024, 1536x1024, 1024x1536 |
| `dall-e-3`         | 1024x1024, 1792x1024, 1024x1792 |
| `dall-e-2`         | 256x256, 512x512, 1024x1024     |

You can pass optional `providerOptions` to the image model. These are prone to change by OpenAI and are model dependent. For example, the `gpt-image-1` model supports the `quality` option:

```ts
const { image, providerMetadata } = await generateImage({
  model: openai.image('gpt-image-1.5'),
  prompt: 'A salamander at sunrise in a forest pond in the Seychelles.',
  providerOptions: {
    openai: { quality: 'high' },
  },
});
```

For more on `generateImage()` see [Image Generation](/docs/ai-sdk-core/image-generation).

OpenAI's image models return additional metadata in the response that can be
accessed via `providerMetadata.openai`. The following OpenAI-specific metadata
is available:

- **images** _Array&lt;object&gt;_

  Array of image-specific metadata. Each image object may contain:

  - `revisedPrompt` _string_ - The revised prompt that was actually used to generate the image (OpenAI may modify your prompt for safety or clarity)
  - `created` _number_ - The Unix timestamp (in seconds) of when the image was created
  - `size` _string_ - The size of the generated image. One of `1024x1024`, `1024x1536`, or `1536x1024`
  - `quality` _string_ - The quality of the generated image. One of `low`, `medium`, or `high`
  - `background` _string_ - The background parameter used for the image generation. Either `transparent` or `opaque`
  - `outputFormat` _string_ - The output format of the generated image. One of `png`, `webp`, or `jpeg`

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
import { openai, type OpenAITranscriptionModelOptions } from '@ai-sdk/openai';

const result = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: {
    openai: { language: 'en' } satisfies OpenAITranscriptionModelOptions,
  },
});
```

To get word-level timestamps, specify the granularity:

```ts highlight="8-9"
import { experimental_transcribe as transcribe } from 'ai';
import { openai, type OpenAITranscriptionModelOptions } from '@ai-sdk/openai';

const result = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: {
    openai: {
      //timestampGranularities: ['word'],
      timestampGranularities: ['segment'],
    } satisfies OpenAITranscriptionModelOptions,
  },
});

// Access word-level timestamps
console.log(result.segments); // Array of segments with startSecond/endSecond
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

The `voice` argument can be set to one of OpenAI's available voices: `alloy`, `ash`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, or `shimmer`.

```ts highlight="6"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  voice: 'alloy', // OpenAI voice ID
});
```

You can also pass additional provider-specific options using the `providerOptions` argument:

```ts highlight="7-9"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { openai, type OpenAISpeechModelOptions } from '@ai-sdk/openai';

const result = await generateSpeech({
  model: openai.speech('tts-1'),
  text: 'Hello, world!',
  voice: 'alloy',
  providerOptions: {
    openai: {
      speed: 1.2,
    } satisfies OpenAISpeechModelOptions,
  },
});
```

- **instructions** _string_
  Control the voice of your generated audio with additional instructions e.g. "Speak in a slow and steady tone".
  Does not work with `tts-1` or `tts-1-hd`.
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

