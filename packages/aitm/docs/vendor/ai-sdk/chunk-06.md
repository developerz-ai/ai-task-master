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
        messages: convertToModelMessages(messages),
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

The AI SDK shows warnings when something might not work as expected. These warnings help you fix problems before they cause errors.

### When Warnings Appear

Warnings are shown in the browser console when:

- **Unsupported settings**: You use a setting that the AI model doesn't support
- **Unsupported tools**: You use a tool that the AI model can't use
- **Other issues**: The AI model reports other problems

### Warning Messages

All warnings start with "AI SDK Warning:" so you can easily find them. For example:

```
AI SDK Warning: The "temperature" setting is not supported by this model
AI SDK Warning: The tool "calculator" is not supported by this model
```

### Turning Off Warnings

By default, warnings are shown in the console. You can control this behavior:

#### Turn Off All Warnings

Set a global variable to turn off warnings completely:

```ts
globalThis.AI_SDK_LOG_WARNINGS = false;
```

#### Custom Warning Handler

You can also provide your own function to handle warnings:

```ts
globalThis.AI_SDK_LOG_WARNINGS = warnings => {
  // Handle warnings your own way
  warnings.forEach(warning => {
    // Your custom logic here
    console.log('Custom warning:', warning);
  });
};
```

<Note>
  Custom warning functions are experimental and can change in patch releases
  without notice.
</Note>

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
    messages: convertToModelMessages(messages),
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
title: AI_NoSpeechGeneratedError
description: Learn how to fix AI_NoSpeechGeneratedError
---

# AI_NoSpeechGeneratedError

This error occurs when no audio could be generated from the input.

## Properties

- `responses`: Array of responses
- `message`: The error message

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
import { generateText } from "ai";

const { text } = await generateText({
  model: "openai/gpt-5.4",
  prompt: "Hello world",
});
```

```ts
// use provider instance (requires version 5.0.36 or later)
import { generateText, gateway } from "ai";

const { text } = await generateText({
  model: gateway("openai/gpt-5.4"),
  prompt: "Hello world",
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
import { gateway } from "ai";
```

You may want to create a custom provider instance when you need to:

- Set custom configuration options (API key, base URL, headers)
- Use the provider in a [provider registry](/docs/ai-sdk-core/provider-management)
- Wrap the provider with [middleware](/docs/ai-sdk-core/middleware)
- Use different settings for different parts of your application

To create a custom provider instance, import `createGateway` from `ai`:

```ts
import { createGateway } from "ai";

const gateway = createGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
});
```

You can use the following optional settings to customize the AI Gateway provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls. The default prefix is `https://ai-gateway.vercel.sh/v1/ai`.

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
import { createGateway } from "ai";

const gateway = createGateway({
  apiKey: "your_api_key_here",
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

Learn more in the [BYOK documentation](https://vercel.com/docs/ai-gateway/byok).

## Language Models

You can create language models using a provider instance. The first argument is the model ID in the format `creator/model-name`:

```ts
import { generateText } from "ai";

const { text } = await generateText({
  model: "openai/gpt-5.4",
  prompt: "Explain quantum computing in simple terms",
});
```

AI Gateway language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions (see [AI SDK Core](/docs/ai-sdk-core)).

## Available Models

The AI Gateway supports models from OpenAI, Anthropic, Google, Meta, xAI, Mistral, DeepSeek, Amazon Bedrock, Cohere, Perplexity, Alibaba, and other providers.

For the complete list of available models, see the [AI Gateway documentation](https://vercel.com/docs/ai-gateway).

## Dynamic Model Discovery

You can discover available models programmatically:

```ts
import { gateway, generateText } from "ai";

const availableModels = await gateway.getAvailableModels();

// List all available models
availableModels.models.forEach((model) => {
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
  prompt: "Hello world",
});
```

## Credit Usage

You can check your team's current credit balance and usage:

```ts
import { gateway } from "ai";

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
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Write a haiku about programming",
});

console.log(text);
```

### Streaming

```ts
import { streamText } from "ai";

const { textStream } = await streamText({
  model: "openai/gpt-5.4",
  prompt: "Explain the benefits of serverless architecture",
});

for await (const textPart of textStream) {
  process.stdout.write(textPart);
}
```

### Tool Usage

```ts
import { generateText, tool } from "ai";
import { z } from "zod";

const { text } = await generateText({
  model: "xai/grok-4",
  prompt: "What is the weather like in San Francisco?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a location",
      parameters: z.object({
        location: z.string().describe("The location to get weather for"),
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
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";

const result = await generateText({
  model: "openai/gpt-5.4-mini",
  prompt: "What is the Vercel AI Gateway?",
  stopWhen: stepCountIs(10),
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
import { gateway, generateText } from "ai";

const result = await generateText({
  model: "openai/gpt-5.4-nano",
  prompt: "Search for news about AI regulations in January 2025.",
  tools: {
    perplexity_search: gateway.tools.perplexitySearch(),
  },
});

console.log(result.text);
console.log("Tool calls:", JSON.stringify(result.toolCalls, null, 2));
console.log("Tool results:", JSON.stringify(result.toolResults, null, 2));
```

You can also configure the search with optional parameters:

```ts
import { gateway, generateText } from "ai";

const result = await generateText({
  model: "openai/gpt-5.4-nano",
  prompt:
    "Search for news about AI regulations from the first week of January 2025.",
  tools: {
    perplexity_search: gateway.tools.perplexitySearch({
      maxResults: 5,
      searchLanguageFilter: ["en"],
      country: "US",
      searchDomainFilter: ["reuters.com", "bbc.com", "nytimes.com"],
    }),
  },
});

console.log(result.text);
console.log("Tool calls:", JSON.stringify(result.toolCalls, null, 2));
console.log("Tool results:", JSON.stringify(result.toolResults, null, 2));
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
import { gateway, streamText } from "ai";

const result = streamText({
  model: "openai/gpt-5.4-nano",
  prompt: "Search for the latest news about AI regulations.",
  tools: {
    perplexity_search: gateway.tools.perplexitySearch(),
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      process.stdout.write(part.text);
      break;
    case "tool-call":
      console.log("\nTool call:", JSON.stringify(part, null, 2));
      break;
    case "tool-result":
      console.log("\nTool result:", JSON.stringify(part, null, 2));
      break;
  }
}
```

#### Parallel Search

The Parallel Search tool enables models to search the web using [Parallel AI's Search API](https://docs.parallel.ai/api-reference/search-beta/search). This tool is optimized for LLM consumption, returning relevant excerpts from web pages that can replace multiple keyword searches with a single call.

```ts
import { gateway, generateText } from "ai";

const result = await generateText({
  model: "openai/gpt-5.4-nano",
  prompt: "Research the latest developments in quantum computing.",
  tools: {
    parallel_search: gateway.tools.parallelSearch(),
  },
});

console.log(result.text);
console.log("Tool calls:", JSON.stringify(result.toolCalls, null, 2));
console.log("Tool results:", JSON.stringify(result.toolResults, null, 2));
```

You can also configure the search with optional parameters:

```ts
import { gateway, generateText } from "ai";

const result = await generateText({
  model: "openai/gpt-5.4-nano",
  prompt: "Find detailed information about TypeScript 5.0 features.",
  tools: {
    parallel_search: gateway.tools.parallelSearch({
      mode: "agentic",
      maxResults: 5,
      sourcePolicy: {
        includeDomains: ["typescriptlang.org", "github.com"],
      },
      excerpts: {
        maxCharsPerResult: 8000,
      },
    }),
  },
});

console.log(result.text);
console.log("Tool calls:", JSON.stringify(result.toolCalls, null, 2));
console.log("Tool results:", JSON.stringify(result.toolResults, null, 2));
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
import { gateway, streamText } from "ai";

const result = streamText({
  model: "openai/gpt-5.4-nano",
  prompt: "Research the latest AI safety guidelines.",
  tools: {
    parallel_search: gateway.tools.parallelSearch(),
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      process.stdout.write(part.text);
      break;
    case "tool-call":
      console.log("\nTool call:", JSON.stringify(part, null, 2));
      break;
    case "tool-result":
      console.log("\nTool result:", JSON.stringify(part, null, 2));
      break;
  }
}
```

### Usage Tracking with User and Tags

Track usage per end-user and categorize requests with tags:

```ts
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "openai/gpt-5.4",
  prompt: "Summarize this document...",
  providerOptions: {
    gateway: {
      user: "user-abc-123", // Track usage for this specific end-user
      tags: ["document-summary", "premium-feature"], // Categorize for reporting
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
import { gateway } from "ai";

const report = await gateway.getSpendReport({
  startDate: "2026-03-01",
  endDate: "2026-03-25",
  groupBy: "model",
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
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Explain quantum computing",
  providerOptions: {
    gateway: {
      order: ["vertex", "anthropic"], // Try Vertex AI first, then Anthropic
      only: ["vertex", "anthropic"], // Only use these providers
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

  Examples:

  - Single provider: `byok: { 'anthropic': [{ apiKey: 'sk-ant-...' }] }`
  - Multiple credentials: `byok: { 'vertex': [{ projectId: 'proj-1', privateKey: '...' }, { projectId: 'proj-2', privateKey: '...' }] }`
  - Multiple providers: `byok: { 'anthropic': [{ apiKey: '...' }], 'bedrock': [{ accessKeyId: '...', secretAccessKey: '...' }] }`

- **zeroDataRetention** _boolean_

  Restricts routing requests to providers that have zero data retention agreements with Vercel for AI Gateway. If there are no providers available for the model with zero data retention, the request will fail. BYOK credentials are skipped when `zeroDataRetention` is set to `true` to ensure that requests are only routed to providers that support ZDR compliance. Request-level ZDR is only available for Vercel Pro and Enterprise plans.

- **disallowPromptTraining** _boolean_

  Restricts routing requests to providers that have agreements with Vercel for AI Gateway to not use prompts for model training. If there are no providers available for the model that disallow prompt training, the request will fail. BYOK credentials are skipped when `disallowPromptTraining` is set to `true` to ensure that requests are only routed to providers that do not train on prompt data.

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
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Write a haiku about programming",
  providerOptions: {
    gateway: {
      order: ["vertex"], // Prefer Vertex AI
      only: ["anthropic", "vertex"], // Only allow these providers
    } satisfies GatewayProviderOptions,
  },
});
```

#### Model Fallbacks Example

The `models` option enables automatic fallback to alternative models when the primary model fails:

```ts
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "openai/gpt-5.4", // Primary model
  prompt: "Write a TypeScript haiku",
  providerOptions: {
    gateway: {
      models: ["openai/gpt-5.4-nano", "gemini-3-flash-preview"], // Fallback models
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

Set `zeroDataRetention` to true to route requests to providers that have zero data retention agreements with Vercel for AI Gateway. If there are no providers available for the model with zero data retention, the request will fail. When `zeroDataRetention` is `false` or not specified, there is no enforcement of restricting routing. BYOK credentials are skipped when `zeroDataRetention` is set to `true` to ensure that requests are only routed to providers that support ZDR compliance. Request-level ZDR is only available for Vercel Pro and Enterprise plans.

```ts
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Analyze this sensitive document...",
  providerOptions: {
    gateway: {
      zeroDataRetention: true,
    } satisfies GatewayProviderOptions,
  },
});
```

#### Disallow Prompt Training Example

Set `disallowPromptTraining` to true to route requests to providers that have agreements with Vercel for AI Gateway to not use prompts for model training. If there are no providers available for the model that disallow prompt training, the request will fail. When `disallowPromptTraining` is `false` or not specified, there is no enforcement of restricting routing. BYOK credentials are skipped when `disallowPromptTraining` is set to `true` to ensure that requests are only routed to providers that do not train on prompt data.

```ts
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Analyze this proprietary business data...",
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
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Analyze this patient data...",
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
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Summarize this report...",
  providerOptions: {
    gateway: {
      quotaEntityId: "org-123",
    } satisfies GatewayProviderOptions,
  },
});
```

### Provider-Specific Options

When using provider-specific options through AI Gateway, use the actual provider name (e.g. `anthropic`, `openai`, not `gateway`) as the key:

```ts
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';
import { generateText } from 'ai';

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Explain quantum computing",
  providerOptions: {
    gateway: {
      order: ["vertex", "anthropic"],
    } satisfies GatewayProviderOptions,
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    } satisfies AnthropicProviderOptions,
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
description: Learn how to use xAI Grok.
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
first argument is the model id, e.g. `grok-3`.

```ts
const model = xai('grok-3');
```

By default, `xai(modelId)` uses the Chat API. To use the Responses API with server-side agentic tools, explicitly use `xai.responses(modelId)`.

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

### Provider Options

xAI chat models support additional provider options that are not part of
the [standard call settings](/docs/ai-sdk-core/settings). You can pass them in the `providerOptions` argument:

```ts
const model = xai('grok-3-mini');

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

  Reasoning effort for reasoning models.

- **store** _boolean_

  Whether to store the generation. Defaults to `true`.

- **previousResponseId** _string_

  The ID of the previous response. You can use it to continue a conversation. Defaults to `undefined`.

## Responses API (Agentic Tools)

You can use the xAI Responses API with the `xai.responses(modelId)` factory method for server-side agentic tool calling. This enables the model to autonomously orchestrate tool calls and research on xAI's servers.

```ts
const model = xai.responses('grok-4-fast');
```

The Responses API provides server-side tools that the model can autonomously execute during its reasoning process:

- **web_search**: Real-time web search and page browsing
- **x_search**: Search X (Twitter) posts, users, and threads
- **code_execution**: Execute Python code for calculations and data analysis

### Vision

The Responses API supports image input with vision models:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: xai.responses('grok-2-vision-1212'),
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
  model: xai.responses('grok-4-fast'),
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
  model: xai.responses('grok-4-fast'),
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
  model: xai.responses('grok-4-fast'),
  prompt:
    'Calculate the compound interest for $10,000 at 5% annually for 10 years',
  tools: {
    code_execution: xai.tools.codeExecution(),
  },
});
```

### File Search Tool

xAI supports file search through OpenAI compatibility. You can use the OpenAI provider with xAI's base URL to search vector stores:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

const openai = createOpenAI({
  baseURL: 'https://api.x.ai/v1',
  apiKey: process.env.XAI_API_KEY,
});

const result = streamText({
  model: openai('grok-4'),
  prompt: 'What documents do you have access to?',
  tools: {
    file_search: openai.tools.fileSearch({
      vectorStoreIds: ['your-vector-store-id'],
      maxNumResults: 5,
    }),
  },
});
```

<Note>
  File search requires grok-4 family models. See the [OpenAI
  provider](/providers/ai-sdk-providers/openai) documentation for additional
  file search options like filters and ranking.
</Note>

### Multiple Tools

You can combine multiple server-side tools for comprehensive research:

```ts
import { xai } from '@ai-sdk/xai';
import { streamText } from 'ai';

const { fullStream } = streamText({
  model: xai.responses('grok-4-fast'),
  prompt: 'Research AI safety developments and calculate risk metrics',
  tools: {
    web_search: xai.tools.webSearch(),
    x_search: xai.tools.xSearch(),
    code_execution: xai.tools.codeExecution(),
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
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const result = await generateText({
  model: xai.responses('grok-4-fast'),
  providerOptions: {
    xai: {
      reasoningEffort: 'high',
    },
  },
  // ...
});
```

The following provider options are available:

- **reasoningEffort** _'low' | 'high'_

  Control the reasoning effort for the model. Higher effort may produce more thorough results at the cost of increased latency and token usage.

<Note>
  The Responses API only supports server-side tools. You cannot mix server-side
  tools with client-side function tools in the same request.
</Note>

## Live Search

xAI models support Live Search functionality, allowing them to query real-time data from various sources and include it in responses with citations.

### Basic Search

To enable search, specify `searchParameters` with a search mode:

```ts
import { xai } from '@ai-sdk/xai';
import { generateText } from 'ai';

const { text, sources } = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'What are the latest developments in AI?',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'auto', // 'auto', 'on', or 'off'
        returnCitations: true,
        maxSearchResults: 5,
      },
    },
  },
});

console.log(text);
console.log('Sources:', sources);
```

### Search Parameters

The following search parameters are available:

- **mode** _'auto' | 'on' | 'off'_

  Search mode preference:

  - `'auto'` (default): Model decides whether to search
  - `'on'`: Always enables search
  - `'off'`: Disables search completely

- **returnCitations** _boolean_

  Whether to return citations in the response. Defaults to `true`.

- **fromDate** _string_

  Start date for search data in ISO8601 format (`YYYY-MM-DD`).

- **toDate** _string_

  End date for search data in ISO8601 format (`YYYY-MM-DD`).

- **maxSearchResults** _number_

  Maximum number of search results to consider. Defaults to 20, max 50.

- **sources** _Array&lt;SearchSource&gt;_

  Data sources to search from. Defaults to `["web", "x"]` if not specified.

### Search Sources

You can specify different types of data sources for search:

#### Web Search

```ts
const result = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'Best ski resorts in Switzerland',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'on',
        sources: [
          {
            type: 'web',
            country: 'CH', // ISO alpha-2 country code
            allowedWebsites: ['ski.com', 'snow-forecast.com'],
            safeSearch: true,
          },
        ],
      },
    },
  },
});
```

#### Web source parameters

- **country** _string_: ISO alpha-2 country code
- **allowedWebsites** _string[]_: Max 5 allowed websites
- **excludedWebsites** _string[]_: Max 5 excluded websites
- **safeSearch** _boolean_: Enable safe search (default: true)

#### X (Twitter) Search

```ts
const result = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'Latest updates on Grok AI',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'on',
        sources: [
          {
            type: 'x',
            includedXHandles: ['grok', 'xai'],
            excludedXHandles: ['openai'],
            postFavoriteCount: 10,
            postViewCount: 100,
          },
        ],
      },
    },
  },
});
```

#### X source parameters

- **includedXHandles** _string[]_: Array of X handles to search (without @ symbol)
- **excludedXHandles** _string[]_: Array of X handles to exclude from search (without @ symbol)
- **postFavoriteCount** _number_: Minimum favorite count of the X posts to consider.
- **postViewCount** _number_: Minimum view count of the X posts to consider.

#### News Search

```ts
const result = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'Recent tech industry news',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'on',
        sources: [
          {
            type: 'news',
            country: 'US',
            excludedWebsites: ['tabloid.com'],
            safeSearch: true,
          },
        ],
      },
    },
  },
});
```

#### News source parameters

- **country** _string_: ISO alpha-2 country code
- **excludedWebsites** _string[]_: Max 5 excluded websites
- **safeSearch** _boolean_: Enable safe search (default: true)

#### RSS Feed Search

```ts
const result = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'Latest status updates',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'on',
        sources: [
          {
            type: 'rss',
            links: ['https://status.x.ai/feed.xml'],
          },
        ],
      },
    },
  },
});
```

#### RSS source parameters

- **links** _string[]_: Array of RSS feed URLs (max 1 currently supported)

### Multiple Sources

You can combine multiple data sources in a single search:

```ts
const result = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'Comprehensive overview of recent AI breakthroughs',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'on',
        returnCitations: true,
        maxSearchResults: 15,
        sources: [
          {
            type: 'web',
            allowedWebsites: ['arxiv.org', 'openai.com'],
          },
          {
            type: 'news',
            country: 'US',
          },
          {
            type: 'x',
            includedXHandles: ['openai', 'deepmind'],
          },
        ],
      },
    },
  },
});
```

### Sources and Citations

When search is enabled with `returnCitations: true`, the response includes sources that were used to generate the answer:

```ts
const { text, sources } = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'What are the latest developments in AI?',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'auto',
        returnCitations: true,
      },
    },
  },
});

// Access the sources used
for (const source of sources) {
  if (source.sourceType === 'url') {
    console.log('Source:', source.url);
  }
}
```

### Streaming with Search

Live Search works with streaming responses. Citations are included when the stream completes:

```ts
import { streamText } from 'ai';

const result = streamText({
  model: xai('grok-3-latest'),
  prompt: 'What has happened in tech recently?',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'auto',
        returnCitations: true,
      },
    },
  },
});

for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}

console.log('Sources:', await result.sources);
```

## Model Capabilities

| Model                       | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      | Reasoning           |
| --------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `grok-4-fast-non-reasoning` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-4-fast-reasoning`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-code-fast-1`          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-4`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3-latest`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3-fast`               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3-fast-latest`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-3-mini`               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-mini-latest`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-mini-fast`          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-3-mini-fast-latest`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `grok-2`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-2-latest`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-2-1212`               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-2-vision`             | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-2-vision-latest`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-2-vision-1212`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-beta`                 | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `grok-vision-beta`          | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. Please see the [xAI
  docs](https://docs.x.ai/docs#models) for a full list of available models. The
  table above lists popular models. You can also pass any available provider
  model ID as a string if needed.
</Note>

## Image Models

You can create xAI image models using the `.image()` factory method. For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

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
  model: xai.image('grok-2-image'),
  prompt: 'A futuristic cityscape at sunset',
  maxImagesPerCall: 5, // Default is 10
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

The [Vercel](https://vercel.com) provider gives you access to the [v0 API](https://vercel.com/docs/v0/api), designed for building modern web applications. The v0 models support text and image inputs and provide fast streaming responses.

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
  model: vercel('v0-1.0-md'),
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

OpenAI language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions
(see [AI SDK Core](/docs/ai-sdk-core)).

### Responses Models

You can use the OpenAI responses API with the `openai(modelId)` or `openai.responses(modelId)` factory methods. It is the default API that is used by the OpenAI provider (since AI SDK 5).

```ts
const model = openai('gpt-5');
```

Further configuration can be done using OpenAI provider options.
You can validate the provider options using the `OpenAIResponsesProviderOptions` type.

```ts
import { openai, OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5'), // or openai.responses('gpt-5')
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
  Whether to use strict JSON schema validation. Defaults to `false`.

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

The OpenAI responses provider also returns provider-specific metadata:

```ts
const { providerMetadata } = await generateText({
  model: openai.responses('gpt-5'),
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

#### Reasoning Output

For reasoning models like `gpt-5`, you can enable reasoning summaries to see the model's thought process. Different models support different summarizers—for example, `o4-mini` supports detailed summaries. Set `reasoningSummary: "auto"` to automatically receive the richest level available.

```ts highlight="8-9,16"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

const result = streamText({
  model: openai('gpt-5'),
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
  model: openai('gpt-5'),
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

#### Verbosity Control

You can control the length and detail of model responses using the `textVerbosity` parameter:

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai('gpt-5-mini'),
  prompt: 'Write a poem about a boy and his first pet dog.',
  providerOptions: {
    openai: {
      textVerbosity: 'low', // 'low' for concise, 'medium' (default), or 'high' for verbose
    },
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
    }),
  },
  // Force web search tool (optional):
  toolChoice: { type: 'tool', toolName: 'web_search' },
});

// URL sources
const sources = result.sources;
```

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
    } satisfies OpenAIResponsesProviderOptions,
  },
});
```

<Note>
  The tool must be named `file_search` when using OpenAI's file search
  functionality. This name is required by OpenAI's API specification and cannot
  be customized.
</Note>

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
  The tool must be named `code_interpreter` when using OpenAI's code interpreter
  functionality. This name is required by OpenAI's API specification and cannot
  be customized.
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
  stopWhen: stepCountIs(2),
});
```

<Note>
  The tool must be named `local_shell`. This name is required by OpenAI's API
  specification and cannot be customized. The model can only be
</Note>

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
          image: fs.readFileSync('./data/image.png'),
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
          data: fs.readFileSync('./data/ai.pdf'),
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

The OpenAI Responses API supports structured outputs. You can enforce structured outputs using `generateObject` or `streamObject`, which expose a `schema` option. Additionally, you can pass a Zod or JSON Schema object to the `experimental_output` option when using `generateText` or `streamText`.

```ts
// Using generateObject
const result = await generateObject({
  model: openai('gpt-4.1'),
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
  model: openai('gpt-4.1'),
  prompt: 'How do I make a pizza?',
  experimental_output: Output.object({
    schema: z.object({
      ingredients: z.array(z.string()),
      steps: z.array(z.string()),
    }),
  }),
});
```

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
import { openai, type OpenAIChatLanguageModelOptions } from '@ai-sdk/openai';

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
    } satisfies OpenAIChatLanguageModelOptions,
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

- **structuredOutputs** _boolean_

  Whether to use structured outputs.
  Defaults to `true`.

  When enabled, tool calls and object generation will be strict and follow the provided schema.

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
  Defaults to `false`.

- **textVerbosity** _'low' | 'medium' | 'high'_

  Controls the verbosity of the model's responses. Lower values will result in more concise responses, while higher values will result in more verbose responses.

- **promptCacheKey** _string_

  A cache key for manual prompt caching control. Used by OpenAI to cache responses for similar requests to optimize your cache hit rates.

- **promptCacheRetention** _'in_memory' | '24h'_

  The retention policy for the prompt cache. Set to `'24h'` to enable extended prompt caching, which keeps cached prefixes active for up to 24 hours. Defaults to `'in_memory'` for standard prompt caching. Note: `'24h'` is currently only available for the 5.1 series of models.

- **safetyIdentifier** _string_

  A stable identifier used to help detect users of your application that may be violating OpenAI's usage policies. The IDs should be a string that uniquely identifies each user.

#### Reasoning

OpenAI has introduced the `o1`,`o3`, and `o4` series of [reasoning models](https://platform.openai.com/docs/guides/reasoning).
Currently, `o4-mini`, `o3`, `o3-mini`, and `o1` are available via both the chat and responses APIs. The
models `codex-mini-latest` and `computer-use-preview` are available only via the [responses API](#responses-models).

Reasoning models currently only generate text, have several limitations, and are only supported using `generateText` and `streamText`.

They support additional settings and response metadata:

- You can use `providerOptions` to set

  - the `reasoningEffort` option (or alternatively the `reasoningEffort` model setting), which determines the amount of reasoning the model performs.

- You can use response `providerMetadata` to access the number of reasoning tokens that the model generated.

```ts highlight="4,7-11,17"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5'),
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
  reasoning models when supported.
</Note>

<Note>
  Reasoning models require additional runtime inference to complete their
  reasoning phase before generating a response. This introduces longer latency
  compared to other models.
</Note>

<Note>
  `maxOutputTokens` is automatically mapped to `max_completion_tokens` for
  reasoning models.
</Note>

#### Structured Outputs

Structured outputs are enabled by default.
You can disable them by setting the `structuredOutputs` option to `false`.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

const result = await generateObject({
  model: openai.chat('gpt-4o-2024-08-06'),
  providerOptions: {
    openai: {
      structuredOutputs: false,
    },
  },
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

#### Logprobs

OpenAI provides logprobs information for completion/chat models.
You can access it in the `providerMetadata` object.

```ts highlight="11"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.chat('gpt-5'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  providerOptions: {
    openai: {
      // this can also be a number,
      // refer to logprobs provider options section for more
      logprobs: true,
    },
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
          image: fs.readFileSync('./data/image.png'),
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
          data: fs.readFileSync('./data/ai.pdf'),
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
  model: openai.chat('gpt-5'),
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
import { openai } from '@ai-sdk/openai';
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
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5'),
  prompt: `A 1024-token or longer prompt...`,
  providerOptions: {
    openai: {
      promptCacheKey: 'my-custom-cache-key-123',
    },
  },
});

console.log(`usage:`, {
  ...usage,
  cachedPromptTokens: providerMetadata?.openai?.cachedPromptTokens,
});
```

For GPT-5.1 models, you can enable extended prompt caching that keeps cached prefixes active for up to 24 hours:

```ts highlight="7-12"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: openai.chat('gpt-5.1'),
  prompt: `A 1024-token or longer prompt...`,
  providerOptions: {
    openai: {
      promptCacheKey: 'my-custom-cache-key-123',
      promptCacheRetention: '24h', // Extended caching for GPT-5.1
    },
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
          data: fs.readFileSync('./data/galileo.mp3'),
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
    },
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
using the `.textEmbedding()` factory method.

```ts
const model = openai.textEmbedding('text-embedding-3-large');
```

OpenAI embedding models support several additional provider options.
You can pass them as an options argument:

```ts
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: openai.textEmbedding('text-embedding-3-large'),
  value: 'sunny day at the beach',
  providerOptions: {
    openai: {
      dimensions: 512, // optional, number of dimensions for the embedding
      user: 'test-user', // optional unique user identifier
    },
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
import { openai } from '@ai-sdk/openai';

const result = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: { openai: { language: 'en' } },
});
```

To get word-level timestamps, specify the granularity:

```ts highlight="8-9"
import { experimental_transcribe as transcribe } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: {
    openai: {
      //timestampGranularities: ['word'],
      timestampGranularities: ['segment'],
    },
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

# Azure OpenAI Provider

The [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service) provider contains language model support for the Azure OpenAI chat API.

## Setup

The Azure OpenAI provider is available in the `@ai-sdk/azure` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/azure" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/azure" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/azure" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/azure" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `azure` from `@ai-sdk/azure`:

```ts
import { azure } from '@ai-sdk/azure';
```

If you need a customized setup, you can import `createAzure` from `@ai-sdk/azure` and create a provider instance with your settings:

```ts
import { createAzure } from '@ai-sdk/azure';

const azure = createAzure({
  resourceName: 'your-resource-name', // Azure resource name
  apiKey: 'your-api-key',
});
```

You can use the following optional settings to customize the OpenAI provider instance:

- **resourceName** _string_

  Azure resource name.
  It defaults to the `AZURE_RESOURCE_NAME` environment variable.

  The resource name is used in the assembled URL: `https://{resourceName}.openai.azure.com/openai/v1{path}`.
  You can use `baseURL` instead to specify the URL prefix.

- **apiKey** _string_

  API key that is being sent using the `api-key` header.
  It defaults to the `AZURE_API_KEY` environment variable.

- **apiVersion** _string_

  Sets a custom [api version](https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation).
  Defaults to `v1`.

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.

  Either this or `resourceName` can be used.
  When a baseURL is provided, the resourceName is ignored.

  With a baseURL, the resolved URL is `{baseURL}/v1{path}`.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **useDeploymentBasedUrls** _boolean_

  Use deployment-based URLs for API calls. Set to `true` to use the legacy deployment format:
  `{baseURL}/deployments/{deploymentId}{path}?api-version={apiVersion}` instead of
  `{baseURL}/v1{path}?api-version={apiVersion}`.
  Defaults to `false`.

  This option is useful for compatibility with certain Azure OpenAI models or deployments
  that require the legacy endpoint format.

## Language Models

The Azure OpenAI provider instance is a function that you can invoke to create a language model:

```ts
const model = azure('your-deployment-name');
```

You need to pass your deployment name as the first argument.

### Reasoning Models

Azure exposes the thinking of `DeepSeek-R1` in the generated text using the `<think>` tag.
You can use the `extractReasoningMiddleware` to extract this reasoning and expose it as a `reasoning` property on the result:

```ts
import { azure } from '@ai-sdk/azure';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';

const enhancedModel = wrapLanguageModel({
  model: azure('your-deepseek-r1-deployment-name'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});
```

You can then use that enhanced model in functions like `generateText` and `streamText`.

### Example

You can use OpenAI language models to generate text with the `generateText` function:

```ts
import { azure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const { text } = await generateText({
  model: azure('your-deployment-name'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

OpenAI language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions
(see [AI SDK Core](/docs/ai-sdk-core)).

<Note>
  Azure OpenAI sends larger chunks than OpenAI. This can lead to the perception
  that the response is slower. See [Troubleshooting: Azure OpenAI Slow To
  Stream](/docs/troubleshooting/common-issues/azure-stream-slow)
</Note>

### Provider Options

When using OpenAI language models on Azure, you can configure provider-specific options using `providerOptions.openai`. More information on available configuration options are on [the OpenAI provider page](/providers/ai-sdk-providers/openai#language-models).

```ts highlight="12-14,22-24"
const messages = [
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'What is the capital of the moon?',
      },
      {
        type: 'image',
        image: 'https://example.com/image.png',
        providerOptions: {
          openai: { imageDetail: 'low' },
        },
      },
    ],
  },
];

const { text } = await generateText({
  model: azure('your-deployment-name'),
  providerOptions: {
    openai: {
      reasoningEffort: 'low',
    },
  },
});
```

### Chat Models

<Note>
  The URL for calling Azure chat models will be constructed as follows:
  `https://RESOURCE_NAME.openai.azure.com/openai/v1/chat/completions?api-version=v1`
</Note>

Azure OpenAI chat models support also some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
import { azure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('your-deployment-name'),
  prompt: 'Write a short story about a robot.',
  providerOptions: {
    openai: {
      logitBias: {
        // optional likelihood for specific tokens
        '50256': -100,
      },
      user: 'test-user', // optional unique user identifier
    },
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

  Whether to enable parallel function calling during tool use. Default to true.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. Learn more.

### Responses Models

You can use the Azure OpenAI responses API with the `azure.responses(deploymentName)` factory method.

```ts
const model = azure.responses('your-deployment-name');
```

Further configuration can be done using OpenAI provider options.
You can validate the provider options using the `OpenAIResponsesProviderOptions` type.

```ts
import { azure, OpenAIResponsesProviderOptions } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure.responses('your-deployment-name'),
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

- **strictJsonSchema** _boolean_
  Whether to use strict JSON schema validation. Defaults to `false`.

The Azure OpenAI responses provider also returns provider-specific metadata:

```ts
const { providerMetadata } = await generateText({
  model: azure.responses('your-deployment-name'),
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

<Note>
  The providerMetadata is only returned with the default responses API, and is
  not supported when using 'azure.chat' or 'azure.completion'
</Note>

#### Web Search Tool

The Azure OpenAI responses API supports web search(preview) through the `azure.tools.webSearchPreview` tool.

```ts
const result = await generateText({
  model: azure('gpt-4.1-mini'),
  prompt: 'What happened in San Francisco last week?',
  tools: {
    web_search_preview: azure.tools.webSearchPreview({
      // optional configuration:
      searchContextSize: 'low',
      userLocation: {
        type: 'approximate',
        city: 'San Francisco',
        region: 'California',
      },
    }),
  },
  // Force web search tool (optional):
  toolChoice: { type: 'tool', toolName: 'web_search_preview' },
});

console.log(result.text);

// URL sources directly from `results`
const sources = result.sources;
for (const source of sources) {
  console.log('source:', source);
}
```

<Note>
  The tool must be named `web_search_preview` when using Azure OpenAI's web
  search(preview) functionality. This name is required by Azure OpenAI's API
  specification and cannot be customized.
</Note>

<Note>
  The 'web_search_preview' tool is only supported with the default responses
  API, and is not supported when using 'azure.chat' or 'azure.completion'
</Note>

#### File Search Tool

The Azure OpenAI responses API supports file search through the `azure.tools.fileSearch` tool.

You can force the use of the file search tool by setting the `toolChoice` parameter to `{ type: 'tool', toolName: 'file_search' }`.

```ts
const result = await generateText({
  model: azure.responses('gpt-5'),
  prompt: 'What does the document say about user authentication?',
  tools: {
    file_search: azure.tools.fileSearch({
      // optional configuration:
      vectorStoreIds: ['vs_123', 'vs_456'],
      maxNumResults: 10,
      ranking: {
        ranker: 'auto',
      },
    }),
  },
  // Force file search tool:
  toolChoice: { type: 'tool', toolName: 'file_search' },
});
```

<Note>
  The tool must be named `file_search` when using Azure OpenAI's file search
  functionality. This name is required by Azure OpenAI's API specification and
  cannot be customized.
</Note>

#### Image Generation Tool

<Note type="warning">
  Azure OpenAI Responses API
  [image_generation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses?tabs=python-secure#image-generation-preview)
  is now Preview release(Not GA release).Image tool does not currently support
  streaming mode. You can not use the image tool with `streamText` currently.
</Note>

Azure OpenAI's Responses API supports multi-modal image generation as a provider-defined tool.
Availability is restricted to specific models (for example, `gpt-5` variants).

You can use the image tool with `generateText`.

```ts
import { createAzure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const azure = createAzure({
  headers: {
    'x-ms-oai-image-generation-deployment': 'gpt-image-1', // use your own image model deployment
  },
});

const result = await generateText({
  model: azure.responses('gpt-5'),
  prompt:
    'Generate an image of an echidna swimming across the Mozambique channel.',
  tools: {
    image_generation: azure.tools.imageGeneration({ outputFormat: 'png' }),
  },
});

for (const toolResult of result.staticToolResults) {
  if (toolResult.toolName === 'image_generation') {
    const base64Image = toolResult.output.result;
  }
}
```

<Note>
  To use image_generation, you must first create an image generation model. You
  must add a deployment specification to the header
  `x-ms-oai-image-generation-deployment`. Please note that the Responses API
  model and the image generation model must be in the same resource.
</Note>

<Note>
  When you set `store: false`, then previously generated images will not be
  accessible by the model. We recommend using the image generation tool without
  setting `store: false`.
</Note>

#### Code Interpreter Tool

The Azure OpenAI responses API supports the code interpreter tool through the `azure.tools.codeInterpreter` tool. This allows models to write and execute Python code.

```ts
import { azure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure.responses('gpt-5'),
  prompt: 'Write and run Python code to calculate the factorial of 10',
  tools: {
    code_interpreter: azure.tools.codeInterpreter({
      // optional configuration:
      container: {
        fileIds: ['assistant-123', 'assistant-456'], // optional file IDs to make available
      },
    }),
  },
});
```

The code interpreter tool can be configured with:

- **container**: Either a container ID string or an object with `fileIds` to specify uploaded files that should be available to the code interpreter

<Note>
  The tool must be named `code_interpreter` when using Azure OpenAI's code
  interpreter functionality. This name is required by Azure OpenAI's API
  specification and cannot be customized.
</Note>

#### PDF support

The Azure OpenAI Responses API supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: azure.responses('your-deployment-name'),
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

### Completion Models

You can create models that call the completions API using the `.completion()` factory method.
The first argument is the model id.
Currently only `gpt-35-turbo-instruct` is supported.

```ts
const model = azure.completion('your-gpt-35-turbo-instruct-deployment');
```

OpenAI completion models support also some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
import { azure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure.completion('your-gpt-35-turbo-instruct-deployment'),
  prompt: 'Write a haiku about coding.',
  providerOptions: {
    openai: {
      echo: true, // optional, echo the prompt in addition to the completion
      logitBias: {
        // optional likelihood for specific tokens
        '50256': -100,
      },
      suffix: 'some text', // optional suffix that comes after a completion of inserted text
      user: 'test-user', // optional unique user identifier
    },
  },
});
```

The following optional provider options are available for Azure OpenAI completion models:

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
  monitor and detect abuse. Learn more.

## Embedding Models

You can create models that call the Azure OpenAI embeddings API
using the `.textEmbedding()` factory method.

```ts
const model = azure.textEmbedding('your-embedding-deployment');
```

Azure OpenAI embedding models support several additional settings.
You can pass them as an options argument:

```ts
import { azure } from '@ai-sdk/azure';
import { embed } from 'ai';

const { embedding } = await embed({
  model: azure.textEmbedding('your-embedding-deployment'),
  value: 'sunny day at the beach',
  providerOptions: {
    openai: {
      dimensions: 512, // optional, number of dimensions for the embedding
      user: 'test-user', // optional unique user identifier
    },
  },
});
```

The following optional provider options are available for Azure OpenAI embedding models:

- **dimensions**: _number_

  The number of dimensions the resulting output embeddings should have.
  Only supported in text-embedding-3 and later models.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. Learn more.

## Image Models

You can create models that call the Azure OpenAI image generation API (DALL-E) using the `.image()` factory method. The first argument is your deployment name for the DALL-E model.

```ts
const model = azure.image('your-dalle-deployment-name');
```

Azure OpenAI image models support several additional settings. You can pass them as `providerOptions.openai` when generating the image:

```ts
await generateImage({
  model: azure.image('your-dalle-deployment-name'),
  prompt: 'A photorealistic image of a cat astronaut floating in space',
  size: '1024x1024', // '1024x1024', '1792x1024', or '1024x1792' for DALL-E 3
  providerOptions: {
    openai: {
      user: 'test-user', // optional unique user identifier
      responseFormat: 'url', // 'url' or 'b64_json', defaults to 'url'
    },
  },
});
```

### Example

You can use Azure OpenAI image models to generate images with the `generateImage` function:

```ts
import { azure } from '@ai-sdk/azure';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: azure.image('your-dalle-deployment-name'),
  prompt: 'A photorealistic image of a cat astronaut floating in space',
  size: '1024x1024', // '1024x1024', '1792x1024', or '1024x1792' for DALL-E 3
});

// image contains the URL or base64 data of the generated image
console.log(image);
```

### Model Capabilities

Azure OpenAI supports DALL-E 2 and DALL-E 3 models through deployments. The capabilities depend on which model version your deployment is using:

| Model Version | Sizes                           |
| ------------- | ------------------------------- |
| DALL-E 3      | 1024x1024, 1792x1024, 1024x1792 |
| DALL-E 2      | 256x256, 512x512, 1024x1024     |

<Note>
  DALL-E models do not support the `aspectRatio` parameter. Use the `size`
  parameter instead.
</Note>

<Note>
  When creating your Azure OpenAI deployment, make sure to set the DALL-E model
  version you want to use.
</Note>

## Transcription Models

You can create models that call the Azure OpenAI transcription API using the `.transcription()` factory method.

The first argument is the model id e.g. `whisper-1`.

```ts
const model = azure.transcription('whisper-1');
```

<Note>
  If you encounter a "DeploymentNotFound" error with transcription models,
  try enabling deployment-based URLs:
  
  ```ts
  const azure = createAzure({
    useDeploymentBasedUrls: true,
    apiVersion: '2025-04-01-preview',
  });
  ```
  
  This uses the legacy endpoint format which may be required for certain Azure OpenAI deployments.
  When using useDeploymentBasedUrls, the default api-version is not valid. You must set it to `2025-04-01-preview` or an earlier value.
</Note>

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the input language in ISO-639-1 (e.g. `en`) format will improve accuracy and latency.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import { azure } from '@ai-sdk/azure';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: azure.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
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

---
title: Anthropic
description: Learn how to use the Anthropic provider for the AI SDK.
---

# Anthropic Provider

The [Anthropic](https://www.anthropic.com/) provider contains language model support for the [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages_post).

## Setup

The Anthropic provider is available in the `@ai-sdk/anthropic` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/anthropic" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/anthropic" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/anthropic" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/anthropic" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `anthropic` from `@ai-sdk/anthropic`:

```ts
import { anthropic } from '@ai-sdk/anthropic';
```

If you need a customized setup, you can import `createAnthropic` from `@ai-sdk/anthropic` and create a provider instance with your settings:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic({
  // custom settings
});
```

You can use the following optional settings to customize the Anthropic provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.anthropic.com/v1`.

- **apiKey** _string_

  API key that is being sent using the `x-api-key` header.
  It defaults to the `ANTHROPIC_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create models that call the [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages_post) using the provider instance.
The first argument is the model id, e.g. `claude-3-haiku-20240307`.
Some models have multi-modal capabilities.

```ts
const model = anthropic('claude-3-haiku-20240307');
```

You can use Anthropic language models to generate text with the `generateText` function:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-3-haiku-20240307'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Anthropic language models can also be used in the `streamText`, `generateObject`, and `streamObject` functions
(see [AI SDK Core](/docs/ai-sdk-core)).

The following optional provider options are available for Anthropic models:

- `disableParallelToolUse` _boolean_

  Optional. Disables the use of parallel tool calls. Defaults to `false`.

  When set to `true`, the model will only call one tool at a time instead of potentially calling multiple tools in parallel.

- `sendReasoning` _boolean_

  Optional. Include reasoning content in requests sent to the model. Defaults to `true`.

  If you are experiencing issues with the model handling requests involving
  reasoning content, you can set this to `false` to omit them from the request.

- `effort` _"low" | "medium" | "high" | "xhigh" | "max"_

  Optional. See [Effort section](#effort) for more details.

- `taskBudget` _object_

  Optional. See [Task Budgets section](#task-budgets) for more details.

- `speed` _"fast" | "standard"_

  Optional. See [Fast Mode section](#fast-mode) for more details.

- `inferenceGeo` _"us" | "global"_

  Optional. See [Data Residency section](#data-residency) for more details.

- `thinking` _object_

  Optional. See [Reasoning section](#reasoning) for more details.

- `effort` _"high" | "medium" | "low"_

  Optional. See [Effort section](#effort) for more details.

- `toolStreaming` _boolean_

  Whether to enable tool streaming (and structured output streaming). Default to `true`.

- `structuredOutputMode` _"outputFormat" | "jsonTool" | "auto"_

  Determines how structured outputs are generated. Optional.

  - `"outputFormat"`: Use the `output_format` parameter to specify the structured output format.
  - `"jsonTool"`: Use a special `"json"` tool to specify the structured output format (default).
  - `"auto"`: Use `"outputFormat"` when supported, otherwise fall back to `"jsonTool"`.

- `metadata` _object_

  Optional. Metadata to include with the request. See the [Anthropic API documentation](https://platform.claude.com/docs/en/api/messages/create) for details.

  - `userId` _string_ - An external identifier for the end-user. Should be a UUID, hash, or other opaque identifier. Must not contain PII.

### Structured Outputs and Tool Input Streaming

By default, the Anthropic API returns streaming tool calls and structured outputs all at once after a delay. To enable incremental streaming of tool inputs (when using `streamText` with tools) and structured outputs (when using `streamObject`), you need to set the `anthropic-beta` header to `fine-grained-tool-streaming-2025-05-14`.

#### For structured outputs with `streamObject`

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { streamObject } from 'ai';
import { z } from 'zod';

const result = streamObject({
  model: anthropic('claude-sonnet-4-20250514'),
  schema: z.object({
    characters: z.array(
      z.object({
        name: z.string(),
        class: z.string(),
        description: z.string(),
      }),
    ),
  }),
  prompt: 'Generate 3 character descriptions for a fantasy role playing game.',
  headers: {
    'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
  },
});

for await (const partialObject of result.partialObjectStream) {
  console.log(partialObject);
}
```

#### For tool input streaming with `streamText`

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { streamText, tool } from 'ai';
import { z } from 'zod';

const result = streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: {
    writeFile: tool({
      description: 'Write content to a file',
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        // Implementation
        return { success: true };
      },
    }),
  },
  prompt: 'Write a short story to story.txt',
  headers: {
    'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
  },
});
```

Without this header, tool inputs and structured outputs may arrive all at once after a delay instead of streaming incrementally.

### Effort

Anthropic introduced an `effort` option with `claude-opus-4-5` that affects thinking, text responses, and function calls. Effort defaults to `high` and you can set it to `medium` or `low` to save tokens and to lower time-to-last-token latency (TTLT). `claude-opus-4-7` additionally supports `xhigh` for maximum reasoning effort.

```ts highlight="8-10"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, usage } = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      effort: 'low',
    } satisfies AnthropicProviderOptions,
  },
});

console.log(text); // resulting text
console.log(usage); // token usage
```

### Fast Mode

Anthropic supports a [`speed` option](https://code.claude.com/docs/en/fast-mode) for `claude-opus-4-6` that enables faster inference with approximately 2.5x faster output token speeds.

```ts highlight="8-10"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'Write a short poem about the sea.',
  providerOptions: {
    anthropic: {
      speed: 'fast',
    } satisfies AnthropicProviderOptions,
  },
});
```

The `speed` option accepts `'fast'` or `'standard'` (default behavior).

### Data Residency

Anthropic supports an [`inferenceGeo` option](https://platform.claude.com/docs/en/build-with-claude/data-residency) that controls where model inference runs for a request.

```ts highlight="8-10"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'Summarize the key points of this document.',
  providerOptions: {
    anthropic: {
      inferenceGeo: 'us',
    } satisfies AnthropicProviderOptions,
  },
});
```

The `inferenceGeo` option accepts `'us'` (US-only infrastructure) or `'global'` (default, any available geography).

### Task Budgets

`claude-opus-4-7` supports a `taskBudget` option that informs the model of the total token budget available for an agentic turn. The model uses this information to prioritize work, plan ahead, and wind down gracefully as the budget is consumed.

Task budgets are advisory — they do not enforce a hard token limit. The model will attempt to stay within budget, but actual usage may vary.

```ts highlight="8-13"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-opus-4-7'),
  prompt: 'Research the pros and cons of Rust vs Go for building CLI tools.',
  providerOptions: {
    anthropic: {
      taskBudget: {
        type: 'tokens',
        total: 400000,
      },
    } satisfies AnthropicProviderOptions,
  },
});
```

For long-running agents that compact and restart context, you can carry the remaining budget forward using the `remaining` field:

```ts
taskBudget: {
  type: 'tokens',
  total: 400000,
  remaining: 215000, // budget left after prior compacted-away contexts
}
```

The `taskBudget` object accepts:

- `type` _"tokens"_ - Budget type. Currently only `"tokens"` is supported.
- `total` _number_ - Total task budget for the agentic turn. Minimum 20,000.
- `remaining` _number_ - Budget left after prior compacted-away contexts. Must be between 0 and `total`. Defaults to `total` if omitted.

### Reasoning

Anthropic has reasoning support for `claude-opus-4-20250514`, `claude-sonnet-4-20250514`, and `claude-3-7-sonnet-20250219` models.

You can enable it using the `thinking` provider option
and specifying a thinking budget in tokens.

```ts highlight="4,8-10"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive' },
    } satisfies AnthropicProviderOptions,
  },
});

console.log(reasoningText); // reasoning text
console.log(reasoning); // reasoning details including redacted reasoning
console.log(text); // text response
```

You can combine adaptive thinking with the `effort` option to control how much reasoning Claude uses:

```ts highlight="6-8"
const { text } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'Invent a new holiday and describe its traditions.',
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive' },
      effort: 'max', // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    } satisfies AnthropicProviderOptions,
  },
});
```

##### Thinking Display (Opus 4.7+)

Starting with `claude-opus-4-7`, thinking content is omitted from the response by default — thinking blocks are present in the stream but their text is empty. To receive reasoning output, set `display: 'summarized'`:

```ts highlight="5"
const { text, reasoningText } = await generateText({
  model: anthropic('claude-opus-4-7'),
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive', display: 'summarized' },
    } satisfies AnthropicProviderOptions,
  },
  prompt: 'How many people will live in the world in 2040?',
});

console.log(reasoningText); // reasoning text (empty without display: 'summarized')
console.log(text);
```

<Note>
  If you stream reasoning to users with `claude-opus-4-7`, the default `"omitted"` display will
  cause a long pause before output begins. Set `display: "summarized"` to restore visible
  progress during thinking.
</Note>

#### Budget-Based Thinking

For earlier models (`claude-opus-4-20250514`, `claude-sonnet-4-20250514`, `claude-sonnet-4-5-20250929`),
use `type: 'enabled'` with an explicit token budget:

```ts highlight="4,8-10"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: anthropic('claude-sonnet-4-5-20250929'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    } satisfies AnthropicProviderOptions,
  },
});

console.log(reasoningText); // reasoning text
console.log(reasoning); // reasoning details including redacted reasoning
console.log(text); // text response
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

### Cache Control

In the messages and message parts, you can use the `providerOptions` property to set cache control breakpoints.
You need to set the `anthropic` property in the `providerOptions` object to `{ cacheControl: { type: 'ephemeral' } }` to set a cache control breakpoint.

The cache creation input tokens are then returned in the `providerMetadata` object
for `generateText` and `generateObject`, again under the `anthropic` property.
When you use `streamText` or `streamObject`, the response contains a promise
that resolves to the metadata. Alternatively you can receive it in the
`onFinish` callback.

```ts highlight="8,18-20,29-30"
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const errorMessage = '... long error message ...';

const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20240620'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'You are a JavaScript expert.' },
        {
          type: 'text',
          text: `Error message: ${errorMessage}`,
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        },
        { type: 'text', text: 'Explain the error message.' },
      ],
    },
  ],
});

console.log(result.text);
console.log(result.providerMetadata?.anthropic);
// e.g. { cacheCreationInputTokens: 2118 }
```

You can also use cache control on system messages by providing multiple system messages at the head of your messages array:

```ts highlight="3,7-9"
const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20240620'),
  messages: [
    {
      role: 'system',
      content: 'Cached system message part',
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    },
    {
      role: 'system',
      content: 'Uncached system message part',
    },
    {
      role: 'user',
      content: 'User prompt',
    },
  ],
});
```

Cache control for tools:

```ts
const result = await generateText({
  model: anthropic('claude-3-5-haiku-latest'),
  tools: {
    cityAttractions: tool({
      inputSchema: z.object({ city: z.string() }),
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    }),
  },
  messages: [
    {
      role: 'user',
      content: 'User prompt',
    },
  ],
});
```

#### Longer cache TTL

Anthropic also supports a longer 1-hour cache duration.

Here's an example:

```ts
const result = await generateText({
  model: anthropic('claude-3-5-haiku-latest'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Long cached message',
          providerOptions: {
            anthropic: {
              cacheControl: { type: 'ephemeral', ttl: '1h' },
            },
          },
        },
      ],
    },
  ],
});
```

#### Limitations

The minimum cacheable prompt length is:

- 1024 tokens for Claude 3.7 Sonnet, Claude 3.5 Sonnet and Claude 3 Opus
- 2048 tokens for Claude 3.5 Haiku and Claude 3 Haiku

Shorter prompts cannot be cached, even if marked with `cacheControl`. Any requests to cache fewer than this number of tokens will be processed without caching.

For more on prompt caching with Anthropic, see [Anthropic's Cache Control documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).

<Note type="warning">
  Because the `UIMessage` type (used by AI SDK UI hooks like `useChat`) does not
  support the `providerOptions` property, you can use `convertToModelMessages`
  first before passing the messages to functions like `generateText` or
  `streamText`. For more details on `providerOptions` usage, see
  [here](/docs/foundations/prompts#provider-options).
</Note>

### Bash Tool

The Bash Tool allows running bash commands. Here's how to create and use it:

```ts
const bashTool = anthropic.tools.bash_20241022({
  execute: async ({ command, restart }) => {
    // Implement your bash command execution logic here
    // Return the result of the command execution
  },
});
```

Parameters:

- `command` (string): The bash command to run. Required unless the tool is being restarted.
- `restart` (boolean, optional): Specifying true will restart this tool.

<Note>
  The bash tool must have the name `bash`. Only certain Claude versions are
  supported.
</Note>

### Memory Tool

The [Memory Tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool) allows Claude to use a local memory, e.g. in the filesystem.
Here's how to create it:

```ts
const memory = anthropic.tools.memory_20250818({
  execute: async action => {
    // Implement your memory command execution logic here
    // Return the result of the command execution
  },
});
```

<Note>
  The memory tool must have the name `memory`. Only certain Claude versions are
  supported.
</Note>

### Text Editor Tool

The Text Editor Tool provides functionality for viewing and editing text files.

```ts
const tools = {
  // tool name must be str_replace_based_edit_tool
  str_replace_based_edit_tool: anthropic.tools.textEditor_20250728({
    maxCharacters: 10000, // optional
    async execute({ command, path, old_str, new_str }) {
      // ...
    },
  }),
} satisfies ToolSet;
```

<Note>
  Different models support different versions of the tool. For Claude Sonnet 3.5
  and 3.7 you need to use older tool versions and tool names.
</Note>

Parameters:

- `command` ('view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'): The command to run. Note: `undo_edit` is only available in Claude 3.5 Sonnet and earlier models.
- `path` (string): Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.
- `file_text` (string, optional): Required for `create` command, with the content of the file to be created.
- `insert_line` (number, optional): Required for `insert` command. The line number after which to insert the new string.
- `new_str` (string, optional): New string for `str_replace` or `insert` commands.
- `old_str` (string, optional): Required for `str_replace` command, containing the string to replace.
- `view_range` (number[], optional): Optional for `view` command to specify line range to show.

### Computer Tool

The Computer Tool enables control of keyboard and mouse actions on a computer:

```ts
const computerTool = anthropic.tools.computer_20241022({
  displayWidthPx: 1920,
  displayHeightPx: 1080,
  displayNumber: 0, // Optional, for X11 environments

  execute: async ({ action, coordinate, text }) => {
    // Implement your computer control logic here
    // Return the result of the action

    // Example code:
    switch (action) {
      case 'screenshot': {
        // multipart result:
        return {
          type: 'image',
          data: fs
            .readFileSync('./data/screenshot-editor.png')
            .toString('base64'),
        };
      }
      default: {
        console.log('Action:', action);
        console.log('Coordinate:', coordinate);
        console.log('Text:', text);
        return `executed ${action}`;
      }
    }
  },

  // map to tool result content for LLM consumption:
  toModelOutput(result) {
    return typeof result === 'string'
      ? [{ type: 'text', text: result }]
      : [{ type: 'image', data: result.data, mediaType: 'image/png' }];
  },
});
```

Parameters:

- `action` ('key' | 'type' | 'mouse_move' | 'left_click' | 'left_click_drag' | 'right_click' | 'middle_click' | 'double_click' | 'screenshot' | 'cursor_position'): The action to perform.
- `coordinate` (number[], optional): Required for `mouse_move` and `left_click_drag` actions. Specifies the (x, y) coordinates.
- `text` (string, optional): Required for `type` and `key` actions.

These tools can be used in conjunction with the `sonnet-3-5-sonnet-20240620` model to enable more complex interactions and tasks.

### Web Search Tool

Anthropic provides a provider-defined web search tool that gives Claude direct access to real-time web content, allowing it to answer questions with up-to-date information beyond its knowledge cutoff.

You can enable web search using the provider-defined web search tool:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const webSearchTool = anthropic.tools.webSearch_20250305({
  maxUses: 5,
});

const result = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'What are the latest developments in AI?',
  tools: {
    web_search: webSearchTool,
  },
});
```

<Note>
  Web search must be enabled in your organization's [Console
  settings](https://console.anthropic.com/settings/privacy).
</Note>

#### Configuration Options

The web search tool supports several configuration options:

- **maxUses** _number_

  Maximum number of web searches Claude can perform during the conversation.

- **allowedDomains** _string[]_

  Optional list of domains that Claude is allowed to search. If provided, searches will be restricted to these domains.

- **blockedDomains** _string[]_

  Optional list of domains that Claude should avoid when searching.

- **userLocation** _object_

  Optional user location information to provide geographically relevant search results.

```ts
const webSearchTool = anthropic.tools.webSearch_20250305({
  maxUses: 3,
  allowedDomains: ['techcrunch.com', 'wired.com'],
  blockedDomains: ['example-spam-site.com'],
  userLocation: {
    type: 'approximate',
    country: 'US',
    region: 'California',
    city: 'San Francisco',
    timezone: 'America/Los_Angeles',
  },
});

const result = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'Find local news about technology',
  tools: {
    web_search: webSearchTool,
  },
});
```

### Web Fetch Tool

Anthropic provides a provider-defined web fetch tool that allows Claude to retrieve content from specific URLs. This is useful when you want Claude to analyze or reference content from a particular webpage or document.

You can enable web fetch using the provider-defined web fetch tool:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-sonnet-4-0'),
  prompt:
    'What is this page about? https://en.wikipedia.org/wiki/Maglemosian_culture',
  tools: {
    web_fetch: anthropic.tools.webFetch_20250910({ maxUses: 1 }),
  },
});
```

#### Configuration Options

The web fetch tool supports several configuration options:

- **maxUses** _number_

  The maxUses parameter limits the number of web fetches performed.

- **allowedDomains** _string[]_

  Only fetch from these domains.

- **blockedDomains** _string[]_

  Never fetch from these domains.

- **citations** _object_

  Unlike web search where citations are always enabled, citations are optional for web fetch. Set `"citations": {"enabled": true}` to enable Claude to cite specific passages from fetched documents.

- **maxContentTokens** _number_

  The maxContentTokens parameter limits the amount of content that will be included in the context.

#### Error Handling

Web search errors are handled differently depending on whether you're using streaming or non-streaming:

**Non-streaming (`generateText`, `generateObject`):**
Web search errors throw exceptions that you can catch:

```ts
try {
  const result = await generateText({
    model: anthropic('claude-opus-4-20250514'),
    prompt: 'Search for something',
    tools: {
      web_search: webSearchTool,
    },
  });
} catch (error) {
  if (error.message.includes('Web search failed')) {
    console.log('Search error:', error.message);
    // Handle search error appropriately
  }
}
```

**Streaming (`streamText`, `streamObject`):**
Web search errors are delivered as error parts in the stream:

```ts
const result = await streamText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'Search for something',
  tools: {
    web_search: webSearchTool,
  },
});

for await (const part of result.textStream) {
  if (part.type === 'error') {
    console.log('Search error:', part.error);
    // Handle search error appropriately
  }
}
```

## Code Execution

Anthropic provides a provider-defined code execution tool that gives Claude direct access to a real Python environment allowing it to execute code to inform its responses.

You can enable code execution using the provider-defined code execution tool:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const codeExecutionTool = anthropic.tools.codeExecution_20260120();

const result = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt:
    'Calculate the mean and standard deviation of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
  tools: {
    code_execution: codeExecutionTool,
  },
});
```

<Note>
  Three versions are available: `codeExecution_20260120` (recommended, does not
  require a beta header, supports Claude Opus 4.6, Sonnet 4.6, Sonnet 4.5, and
  Opus 4.5), `codeExecution_20250825` (supports Python and Bash with enhanced
  file operations), and `codeExecution_20250522` (supports Bash only).
</Note>

#### Error Handling

Code execution errors are handled differently depending on whether you're using streaming or non-streaming:

**Non-streaming (`generateText`, `generateObject`):**
Code execution errors are delivered as tool result parts in the response:

```ts
const result = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'Execute some Python script',
  tools: {
    code_execution: codeExecutionTool,
  },
});

const toolErrors = result.content?.filter(
  content => content.type === 'tool-error',
);

toolErrors?.forEach(error => {
  console.error('Tool execution error:', {
    toolName: error.toolName,
    toolCallId: error.toolCallId,
    error: error.error,
  });
});
```

**Streaming (`streamText`, `streamObject`):**
Code execution errors are delivered as error parts in the stream:

```ts
const result = await streamText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'Execute some Python script',
  tools: {
    code_execution: codeExecutionTool,
  },
});
for await (const part of result.textStream) {
  if (part.type === 'error') {
    console.log('Code execution error:', part.error);
    // Handle code execution error appropriately
  }
}
```

## Agent Skills

[Anthropic Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) enable Claude to perform specialized tasks like document processing (PPTX, DOCX, PDF, XLSX) and data analysis. Skills run in a sandboxed container and require the code execution tool to be enabled.

### Using Built-in Skills

Anthropic provides several built-in skills:

- **pptx** - Create and edit PowerPoint presentations
- **docx** - Create and edit Word documents
- **pdf** - Process and analyze PDF files
- **xlsx** - Work with Excel spreadsheets

To use skills, you need to:

1. Enable the code execution tool
2. Specify the container with skills in `providerOptions`

```ts highlight="4,9-17,19-23"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    code_execution: anthropic.tools.codeExecution_20260120(),
  },
  prompt: 'Create a presentation about renewable energy with 5 slides',
  providerOptions: {
    anthropic: {
      container: {
        skills: [
          {
            type: 'anthropic',
            skillId: 'pptx',
            version: 'latest', // optional
          },
        ],
      },
    } satisfies AnthropicProviderOptions,
  },
});
```

### Custom Skills

You can also use custom skills by specifying `type: 'custom'`:

```ts highlight="9-11"
const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    code_execution: anthropic.tools.codeExecution_20260120(),
  },
  prompt: 'Use my custom skill to process this data',
  providerOptions: {
    anthropic: {
      container: {
        skills: [
          {
            type: 'custom',
            skillId: 'my-custom-skill-id',
            version: '1.0', // optional
          },
        ],
      },
    } satisfies AnthropicProviderOptions,
  },
});
```

<Note>
  Skills use progressive context loading and execute within a sandboxed
  container with code execution capabilities.
</Note>

### Compaction

The `compact_20260112` edit type automatically summarizes earlier conversation context when token limits are reached. This is useful for long-running conversations where you want to preserve the essence of earlier exchanges while staying within token limits.

```ts highlight="7-19"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { streamText } from 'ai';

const result = streamText({
  model: anthropic('claude-opus-4-6'),
  messages: conversationHistory,
  providerOptions: {
    anthropic: {
      contextManagement: {
        edits: [
          {
            type: 'compact_20260112',
            trigger: {
              type: 'input_tokens',
              value: 50000, // trigger compaction when input exceeds 50k tokens
            },
            instructions:
              'Summarize the conversation concisely, preserving key decisions and context.',
            pauseAfterCompaction: false,
          },
        ],
      },
    } satisfies AnthropicProviderOptions,
  },
});
```

**Configuration:**

- **trigger** - Condition that triggers compaction (e.g., `{ type: 'input_tokens', value: 50000 }`)
- **instructions** - Custom instructions for how the model should summarize the conversation. Use this to guide the compaction summary towards specific aspects of the conversation you want to preserve.
- **pauseAfterCompaction** - When `true`, the model will pause after generating the compaction summary, allowing you to inspect or process it before continuing. Defaults to `false`.

When compaction occurs, the model generates a summary of the earlier context. This summary appears as a text block with special provider metadata.

#### Detecting Compaction in Streams

When using `streamText`, you can detect compaction summaries by checking the `providerMetadata` on `text-start` events:

```ts
for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-start': {
      const isCompaction =
        part.providerMetadata?.anthropic?.type === 'compaction';
      if (isCompaction) {
        console.log('[COMPACTION SUMMARY START]');
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

#### Compaction in UI Applications

When using `useChat` or other UI hooks, compaction summaries appear as regular text parts with `providerMetadata`. You can style them differently in your UI:

```tsx
{
  message.parts.map((part, index) => {
    if (part.type === 'text') {
      const isCompaction =
        (part.providerMetadata?.anthropic as { type?: string } | undefined)
          ?.type === 'compaction';

      if (isCompaction) {
        return (
          <div
            key={index}
            className="bg-yellow-100 border-l-4 border-yellow-500 p-2"
          >
            <span className="font-bold">[Compaction Summary]</span>
            <div>{part.text}</div>
          </div>
        );
      }
      return <div key={index}>{part.text}</div>;
    }
  });
}
```

### PDF support

Anthropic Sonnet `claude-3-5-sonnet-20241022` supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

Option 1: URL-based PDF document

```ts
const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is an embedding model according to this document?',
        },
        {
          type: 'file',
          data: new URL(
            'https://github.com/vercel/ai/blob/main/examples/ai-core/data/ai.pdf?raw=true',
          ),
          mimeType: 'application/pdf',
        },
      ],
    },
  ],
});
```

Option 2: Base64-encoded PDF document

```ts
const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is an embedding model according to this document?',
        },
        {
          type: 'file',
          data: fs.readFileSync('./data/ai.pdf'),
          mediaType: 'application/pdf',
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

### Model Capabilities

| Model                      | Image Input         | Object Generation   | Tool Usage          | Computer Use        | Web Search          | Tool Search         | Compaction          |
| -------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `claude-opus-4-7`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-opus-4-6`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-sonnet-4-6`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-opus-4-5`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-haiku-4-5`         | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-sonnet-4-5`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-opus-4-1`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-opus-4-0`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-sonnet-4-0`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-3-7-sonnet-latest` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-3-5-haiku-latest`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |

<Note>
  The table above lists popular models. Please see the [Anthropic
  docs](https://docs.anthropic.com/en/docs/about-claude/models) for a full list
  of available models. The table above lists popular models. You can also pass
  any available provider model ID as a string if needed.
</Note>

---
title: Amazon Bedrock
description: Learn how to use the Amazon Bedrock provider.
---

# Amazon Bedrock Provider

The Amazon Bedrock provider for the [AI SDK](/docs) contains language model support for the [Amazon Bedrock](https://aws.amazon.com/bedrock) APIs.

## Setup

The Bedrock provider is available in the `@ai-sdk/amazon-bedrock` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/amazon-bedrock" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/amazon-bedrock" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/amazon-bedrock" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/amazon-bedrock" dark />
  </Tab>
</Tabs>

### Prerequisites

Access to Amazon Bedrock foundation models isn't granted by default. In order to gain access to a foundation model, an IAM user with sufficient permissions needs to request access to it through the console. Once access is provided to a model, it is available for all users in the account.

See the [Model Access Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) for more information.

### Authentication

#### Using IAM Access Key and Secret Key

**Step 1: Creating AWS Access Key and Secret Key**

To get started, you'll need to create an AWS access key and secret key. Here's how:

**Login to AWS Management Console**

- Go to the [AWS Management Console](https://console.aws.amazon.com/) and log in with your AWS account credentials.

**Create an IAM User**

- Navigate to the [IAM dashboard](https://console.aws.amazon.com/iam/home) and click on "Users" in the left-hand navigation menu.
- Click on "Create user" and fill in the required details to create a new IAM user.
- Make sure to select "Programmatic access" as the access type.
- The user account needs the `AmazonBedrockFullAccess` policy attached to it.

**Create Access Key**

- Click on the "Security credentials" tab and then click on "Create access key".
- Click "Create access key" to generate a new access key pair.
- Download the `.csv` file containing the access key ID and secret access key.

**Step 2: Configuring the Access Key and Secret Key**

Within your project add a `.env` file if you don't already have one. This file will be used to set the access key and secret key as environment variables. Add the following lines to the `.env` file:

```makefile
AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
AWS_REGION=YOUR_REGION
```

<Note>
  Many frameworks such as [Next.js](https://nextjs.org/) load the `.env` file
  automatically. If you're using a different framework, you may need to load the
  `.env` file manually using a package like
  [`dotenv`](https://github.com/motdotla/dotenv).
</Note>

Remember to replace `YOUR_ACCESS_KEY_ID`, `YOUR_SECRET_ACCESS_KEY`, and `YOUR_REGION` with the actual values from your AWS account.

#### Using AWS SDK Credentials Chain (instance profiles, instance roles, ECS roles, EKS Service Accounts, etc.)

When using AWS SDK, the SDK will automatically use the credentials chain to determine the credentials to use. This includes instance profiles, instance roles, ECS roles, EKS Service Accounts, etc. A similar behavior is possible using the AI SDK by not specifying the `accessKeyId` and `secretAccessKey`, `sessionToken` properties in the provider settings and instead passing a `credentialProvider` property.

_Usage:_

`@aws-sdk/credential-providers` package provides a set of credential providers that can be used to create a credential provider chain.

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @aws-sdk/credential-providers" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @aws-sdk/credential-providers" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @aws-sdk/credential-providers" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @aws-sdk/credential-providers" dark />
  </Tab>
</Tabs>

```ts
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const bedrock = createAmazonBedrock({
  region: 'us-east-1',
  credentialProvider: fromNodeProviderChain(),
});
```

## Provider Instance

You can import the default provider instance `bedrock` from `@ai-sdk/amazon-bedrock`:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
```

If you need a customized setup, you can import `createAmazonBedrock` from `@ai-sdk/amazon-bedrock` and create a provider instance with your settings:

```ts
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

const bedrock = createAmazonBedrock({
  region: 'us-east-1',
  accessKeyId: 'xxxxxxxxx',
  secretAccessKey: 'xxxxxxxxx',
  sessionToken: 'xxxxxxxxx',
});
```

<Note>
  The credentials settings fall back to environment variable defaults described
  below. These may be set by your serverless environment without your awareness,
  which can lead to merged/conflicting credential values and provider errors
  around failed authentication. If you're experiencing issues be sure you are
  explicitly specifying all settings (even if `undefined`) to avoid any
  defaults.
</Note>

You can use the following optional settings to customize the Amazon Bedrock provider instance:

- **region** _string_

  The AWS region that you want to use for the API calls.
  It uses the `AWS_REGION` environment variable by default.

- **accessKeyId** _string_

  The AWS access key ID that you want to use for the API calls.
  It uses the `AWS_ACCESS_KEY_ID` environment variable by default.

- **secretAccessKey** _string_

  The AWS secret access key that you want to use for the API calls.
  It uses the `AWS_SECRET_ACCESS_KEY` environment variable by default.

- **sessionToken** _string_

  Optional. The AWS session token that you want to use for the API calls.
  It uses the `AWS_SESSION_TOKEN` environment variable by default.

- **credentialProvider** _() =&gt; Promise&lt;&#123; accessKeyId: string; secretAccessKey: string; sessionToken?: string; &#125;&gt;_

  Optional. The AWS credential provider chain that you want to use for the API calls.
  It uses the specified credentials by default.

## Language Models

You can create models that call the Bedrock API using the provider instance.
The first argument is the model id, e.g. `meta.llama3-70b-instruct-v1:0`.

```ts
const model = bedrock('meta.llama3-70b-instruct-v1:0');
```

Amazon Bedrock models also support some model specific provider options that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them in the `providerOptions` argument:

```ts
const model = bedrock('anthropic.claude-3-sonnet-20240229-v1:0');

await generateText({
  model,
  providerOptions: {
    anthropic: {
      additionalModelRequestFields: { top_k: 350 },
    },
  },
});
```

Documentation for additional settings based on the selected model can be found within the [Amazon Bedrock Inference Parameter Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters.html).

You can use Amazon Bedrock language models to generate text with the `generateText` function:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const { text } = await generateText({
  model: bedrock('meta.llama3-70b-instruct-v1:0'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Amazon Bedrock language models can also be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

### File Inputs

<Note type="warning">
  Amazon Bedrock supports file inputs on in combination with specific models,
  e.g. `anthropic.claude-3-haiku-20240307-v1:0`.
</Note>

The Amazon Bedrock provider supports file inputs, e.g. PDF files.

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const result = await generateText({
  model: bedrock('anthropic.claude-3-haiku-20240307-v1:0'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the pdf in detail.' },
        {
          type: 'file',
          data: fs.readFileSync('./data/ai.pdf'),
          mediaType: 'application/pdf',
        },
      ],
    },
  ],
});
```

### Guardrails

You can use the `bedrock` provider options to utilize [Amazon Bedrock Guardrails](https://aws.amazon.com/bedrock/guardrails/):

```ts
const result = await generateText({
  model: bedrock('anthropic.claude-3-sonnet-20240229-v1:0'),
  prompt: 'Write a story about space exploration.',
  providerOptions: {
    bedrock: {
      guardrailConfig: {
        guardrailIdentifier: '1abcd2ef34gh',
        guardrailVersion: '1',
        trace: 'enabled' as const,
        streamProcessingMode: 'async',
      },
    },
  },
});
```

Tracing information will be returned in the provider metadata if you have tracing enabled.

```ts
if (result.providerMetadata?.bedrock.trace) {
  // ...
}
```

See the [Amazon Bedrock Guardrails documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) for more information.

### Citations

Amazon Bedrock supports citations for document-based inputs across compatible models. When enabled:

- Some models can read documents with visual understanding, not just extracting text
- Models can cite specific parts of documents you provide, making it easier to trace information back to its source (Not Supported Yet)

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateObject } from 'ai';
import { z } from 'zod';
import fs from 'fs';

const result = await generateObject({
  model: bedrock('apac.anthropic.claude-sonnet-4-20250514-v1:0'),
  schema: z.object({
    summary: z.string().describe('Summary of the PDF document'),
    keyPoints: z.array(z.string()).describe('Key points from the PDF'),
  }),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Summarize this PDF and provide key points.',
        },
        {
          type: 'file',
          data: fs.readFileSync('./document.pdf'),
          mediaType: 'application/pdf',
          providerOptions: {
            bedrock: {
              citations: { enabled: true },
            },
          },
        },
      ],
    },
  ],
});

console.log('Response:', result.object);
```

### Cache Points

<Note>
  Amazon Bedrock prompt caching is currently in preview release. To request
  access, visit the [Amazon Bedrock prompt caching
  page](https://aws.amazon.com/bedrock/prompt-caching/).
</Note>

In messages, you can use the `providerOptions` property to set cache points. Set the `bedrock` property in the `providerOptions` object to `{ cachePoint: { type: 'default' } }` to create a cache point.

Cache usage information is returned in the `providerMetadata` object`. See examples below.

<Note>
  Cache points have model-specific token minimums and limits. For example,
  Claude 3.5 Sonnet v2 requires at least 1,024 tokens for a cache point and
  allows up to 4 cache points. See the [Amazon Bedrock prompt caching
  documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
  for details on supported models, regions, and limits.
</Note>

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const cyberpunkAnalysis =
  '... literary analysis of cyberpunk themes and concepts ...';

const result = await generateText({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  messages: [
    {
      role: 'system',
      content: `You are an expert on William Gibson's cyberpunk literature and themes. You have access to the following academic analysis: ${cyberpunkAnalysis}`,
      providerOptions: {
        bedrock: { cachePoint: { type: 'default' } },
      },
    },
    {
      role: 'user',
      content:
        'What are the key cyberpunk themes that Gibson explores in Neuromancer?',
    },
  ],
});

console.log(result.text);
console.log(result.providerMetadata?.bedrock?.usage);
// Shows cache read/write token usage, e.g.:
// {
//   cacheReadInputTokens: 1337,
//   cacheWriteInputTokens: 42,
// }
```

Cache points also work with streaming responses:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { streamText } from 'ai';

const cyberpunkAnalysis =
  '... literary analysis of cyberpunk themes and concepts ...';

const result = streamText({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  messages: [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'You are an expert on cyberpunk literature.' },
        { type: 'text', text: `Academic analysis: ${cyberpunkAnalysis}` },
      ],
      providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
    },
    {
      role: 'user',
      content:
        'How does Gibson explore the relationship between humanity and technology?',
    },
  ],
});

for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}

console.log(
  'Cache token usage:',
  (await result.providerMetadata)?.bedrock?.usage,
);
// Shows cache read/write token usage, e.g.:
// {
//   cacheReadInputTokens: 1337,
//   cacheWriteInputTokens: 42,
// }
```

## Reasoning

Amazon Bedrock supports model creator-specific reasoning features:

- Anthropic (e.g. `claude-3-7-sonnet-20250219`): enable via the `reasoningConfig` provider option and specifying a thinking budget in tokens (minimum: `1024`, maximum: `64000`).
- Amazon (e.g. `us.amazon.nova-2-lite-v1:0`): enable via the `reasoningConfig` provider option and specifying a maximum reasoning effort level (`'low' | 'medium' | 'high'`).

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

// Anthropic example
const anthropicResult = await generateText({
  model: bedrock('us.anthropclaude-3-7-sonnet-20250219-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    bedrock: {
      reasoningConfig: { type: 'enabled', budgetTokens: 1024 },
    },
  },
});

console.log(anthropicResult.reasoning); // reasoning text
console.log(anthropicResult.text); // text response

// Nova 2 example
const amazonResult = await generateText({
  model: bedrock('us.amazon.nova-2-lite-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    bedrock: {
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'medium' },
    },
  },
});

console.log(amazonResult.reasoning); // reasoning text
console.log(amazonResult.text); // text response
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

## Extended Context Window

Claude Sonnet 4 models on Amazon Bedrock support an extended context window of up to 1 million tokens when using the `context-1m-2025-08-07` beta feature.

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const result = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  prompt: 'analyze this large document...',
  providerOptions: {
    bedrock: {
      anthropicBeta: ['context-1m-2025-08-07'],
    },
  },
});
```

## Computer Use

Via Anthropic, Amazon Bedrock provides three provider-defined tools that can be used to interact with external systems:

1. **Bash Tool**: Allows running bash commands.
2. **Text Editor Tool**: Provides functionality for viewing and editing text files.
3. **Computer Tool**: Enables control of keyboard and mouse actions on a computer.

They are available via the `tools` property of the provider instance.

### Bash Tool

The Bash Tool allows running bash commands. Here's how to create and use it:

```ts
const bashTool = anthropic.tools.bash_20241022({
  execute: async ({ command, restart }) => {
    // Implement your bash command execution logic here
    // Return the result of the command execution
  },
});
```

Parameters:

- `command` (string): The bash command to run. Required unless the tool is being restarted.
- `restart` (boolean, optional): Specifying true will restart this tool.

### Text Editor Tool

The Text Editor Tool provides functionality for viewing and editing text files.

**For Claude 4 models (Opus & Sonnet):**

```ts
const textEditorTool = anthropic.tools.textEditor_20250429({
  execute: async ({
    command,
    path,
    file_text,
    insert_line,
    new_str,
    old_str,
    view_range,
  }) => {
    // Implement your text editing logic here
    // Return the result of the text editing operation
  },
});
```

**For Claude 3.5 Sonnet and earlier models:**

```ts
const textEditorTool = anthropic.tools.textEditor_20241022({
  execute: async ({
    command,
    path,
    file_text,
    insert_line,
    new_str,
    old_str,
    view_range,
  }) => {
    // Implement your text editing logic here
    // Return the result of the text editing operation
  },
});
```

Parameters:

- `command` ('view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'): The command to run. Note: `undo_edit` is only available in Claude 3.5 Sonnet and earlier models.
- `path` (string): Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.
- `file_text` (string, optional): Required for `create` command, with the content of the file to be created.
- `insert_line` (number, optional): Required for `insert` command. The line number after which to insert the new string.
- `new_str` (string, optional): New string for `str_replace` or `insert` commands.
- `old_str` (string, optional): Required for `str_replace` command, containing the string to replace.
- `view_range` (number[], optional): Optional for `view` command to specify line range to show.

When using the Text Editor Tool, make sure to name the key in the tools object correctly:

- **Claude 4 models**: Use `str_replace_based_edit_tool`
- **Claude 3.5 Sonnet and earlier**: Use `str_replace_editor`

```ts
// For Claude 4 models
const response = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  prompt:
    "Create a new file called example.txt, write 'Hello World' to it, and run 'cat example.txt' in the terminal",
  tools: {
    str_replace_based_edit_tool: textEditorTool, // Claude 4 tool name
  },
});

// For Claude 3.5 Sonnet and earlier
const response = await generateText({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  prompt:
    "Create a new file called example.txt, write 'Hello World' to it, and run 'cat example.txt' in the terminal",
  tools: {
    str_replace_editor: textEditorTool, // Earlier models tool name
  },
});
```

### Computer Tool

The Computer Tool enables control of keyboard and mouse actions on a computer:

```ts
const computerTool = anthropic.tools.computer_20241022({
  displayWidthPx: 1920,
  displayHeightPx: 1080,
  displayNumber: 0, // Optional, for X11 environments

  execute: async ({ action, coordinate, text }) => {
    // Implement your computer control logic here
    // Return the result of the action

    // Example code:
    switch (action) {
      case 'screenshot': {
        // multipart result:
        return {
          type: 'image',
          data: fs
            .readFileSync('./data/screenshot-editor.png')
            .toString('base64'),
        };
      }
      default: {
        console.log('Action:', action);
        console.log('Coordinate:', coordinate);
        console.log('Text:', text);
        return `executed ${action}`;
      }
    }
  },

  // map to tool result content for LLM consumption:
  toModelOutput(result) {
    return typeof result === 'string'
      ? [{ type: 'text', text: result }]
      : [{ type: 'image', data: result.data, mediaType: 'image/png' }];
  },
});
```

Parameters:

- `action` ('key' | 'type' | 'mouse_move' | 'left_click' | 'left_click_drag' | 'right_click' | 'middle_click' | 'double_click' | 'screenshot' | 'cursor_position'): The action to perform.
- `coordinate` (number[], optional): Required for `mouse_move` and `left_click_drag` actions. Specifies the (x, y) coordinates.
- `text` (string, optional): Required for `type` and `key` actions.

These tools can be used in conjunction with the `anthropic.claude-3-5-sonnet-20240620-v1:0` model to enable more complex interactions and tasks.

### Model Capabilities

| Model                                          | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ---------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `amazon.titan-tg1-large`                       | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `amazon.titan-text-express-v1`                 | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `amazon.titan-text-lite-v1`                    | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `us.amazon.nova-premier-v1:0`                  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.amazon.nova-pro-v1:0`                      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.amazon.nova-lite-v1:0`                     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.amazon.nova-micro-v1:0`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-haiku-4-5-20251001-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-sonnet-4-20250514-v1:0`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-sonnet-4-5-20250929-v1:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-opus-4-20250514-v1:0`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-opus-4-1-20250805-v1:0`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-7-sonnet-20250219-v1:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-5-sonnet-20241022-v2:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-5-sonnet-20240620-v1:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-5-haiku-20241022-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `anthropic.claude-3-opus-20240229-v1:0`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-sonnet-20240229-v1:0`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-haiku-20240307-v1:0`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-20250514-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-20250514-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-1-20250805-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-7-sonnet-20250219-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-sonnet-20240620-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-haiku-20241022-v1:0`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `us.anthropic.claude-3-sonnet-20240229-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-opus-20240229-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-haiku-20240307-v1:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-v2`                          | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `anthropic.claude-v2:1`                        | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `anthropic.claude-instant-v1`                  | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `cohere.command-text-v14`                      | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `cohere.command-light-text-v14`                | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `cohere.command-r-v1:0`                        | <Cross size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `cohere.command-r-plus-v1:0`                   | <Cross size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `us.deepseek.r1-v1:0`                          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta.llama3-8b-instruct-v1:0`                 | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-70b-instruct-v1:0`                | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-1-8b-instruct-v1:0`               | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-1-70b-instruct-v1:0`              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-1-405b-instruct-v1:0`             | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-2-1b-instruct-v1:0`               | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-2-3b-instruct-v1:0`               | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-2-11b-instruct-v1:0`              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta.llama3-2-90b-instruct-v1:0`              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `us.meta.llama3-2-1b-instruct-v1:0`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-2-3b-instruct-v1:0`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-2-11b-instruct-v1:0`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-2-90b-instruct-v1:0`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-1-8b-instruct-v1:0`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-1-70b-instruct-v1:0`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama3-3-70b-instruct-v1:0`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama4-scout-17b-instruct-v1:0`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.meta.llama4-maverick-17b-instruct-v1:0`    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral.mistral-7b-instruct-v0:2`             | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `mistral.mixtral-8x7b-instruct-v0:1`           | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `mistral.mistral-large-2402-v1:0`              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `mistral.mistral-small-2402-v1:0`              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `us.mistral.pixtral-large-2502-v1:0`           | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai.gpt-oss-120b-1:0`                      | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai.gpt-oss-20b-1:0`                       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [Amazon Bedrock
  docs](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html)
  for a full list of available models. The table above lists popular models. You
  can also pass any available provider model ID as a string if needed.
</Note>

## Embedding Models

You can create models that call the Bedrock API [Bedrock API](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)
using the `.textEmbedding()` factory method.

```ts
const model = bedrock.textEmbedding('amazon.titan-embed-text-v1');
```

Bedrock Titan embedding model amazon.titan-embed-text-v2:0 supports several additional settings.
You can pass them as an options argument:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { embed } from 'ai';

const model = bedrock.textEmbedding('amazon.titan-embed-text-v2:0');

const { embedding } = await embed({
  model,
  value: 'sunny day at the beach',
  providerOptions: {
    bedrock: {
      dimensions: 512, // optional, number of dimensions for the embedding
      normalize: true, // optional, normalize the output embeddings
    },
  },
});
```

The following optional provider options are available for Bedrock Titan embedding models:

- **dimensions**: _number_

  The number of dimensions the output embeddings should have. The following values are accepted: 1024 (default), 512, 256.

- **normalize** _boolean_

  Flag indicating whether or not to normalize the output embeddings. Defaults to true.

### Model Capabilities

| Model                          | Default Dimensions | Custom Dimensions   |
| ------------------------------ | ------------------ | ------------------- |
| `amazon.titan-embed-text-v1`   | 1536               | <Cross size={18} /> |
| `amazon.titan-embed-text-v2:0` | 1024               | <Check size={18} /> |
| `cohere.embed-english-v3`      | 1024               | <Cross size={18} /> |
| `cohere.embed-multilingual-v3` | 1024               | <Cross size={18} /> |

## Image Models

You can create models that call the Bedrock API [Bedrock API](https://docs.aws.amazon.com/nova/latest/userguide/image-generation.html)
using the `.image()` factory method.

For more on the Amazon Nova Canvas image model, see the [Nova Canvas
Overview](https://docs.aws.amazon.com/ai/responsible-ai/nova-canvas/overview.html).

<Note>
  The `amazon.nova-canvas-v1:0` model is available in the `us-east-1`,
  `eu-west-1`, and `ap-northeast-1` regions.
</Note>

```ts
const model = bedrock.image('amazon.nova-canvas-v1:0');
```

You can then generate images with the `experimental_generateImage` function:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: 'A beautiful sunset over a calm ocean',
  size: '512x512',
  seed: 42,
});
```

You can also pass the `providerOptions` object to the `generateImage` function to customize the generation behavior:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: 'A beautiful sunset over a calm ocean',
  size: '512x512',
  seed: 42,
  providerOptions: {
    bedrock: {
      quality: 'premium',
      negativeText: 'blurry, low quality',
      cfgScale: 7.5,
      style: 'PHOTOREALISM',
    },
  },
});
```

The following optional provider options are available for Amazon Nova Canvas:

- **quality** _string_

  The quality level for image generation. Accepts `'standard'` or `'premium'`.

- **negativeText** _string_

  Text describing what you don't want in the generated image.

- **cfgScale** _number_

  Controls how closely the generated image adheres to the prompt. Higher values result in images that are more closely aligned to the prompt.

- **style** _string_

  Predefined visual style for image generation.  
  Accepts one of:
  `3D_ANIMATED_FAMILY_FILM` · `DESIGN_SKETCH` · `FLAT_VECTOR_ILLUSTRATION` ·  
  `GRAPHIC_NOVEL_ILLUSTRATION` · `MAXIMALISM` · `MIDCENTURY_RETRO` ·  
  `PHOTOREALISM` · `SOFT_DIGITAL_PAINTING`.

Documentation for additional settings can be found within the [Amazon Bedrock
User Guide for Amazon Nova
Documentation](https://docs.aws.amazon.com/nova/latest/userguide/image-gen-req-resp-structure.html).

### Image Model Settings

You can customize the generation behavior with optional options:

```ts
await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: 'A beautiful sunset over a calm ocean',
  size: '512x512',
  seed: 42,
  maxImagesPerCall: 1, // Maximum number of images to generate per API call
});
```

- **maxImagesPerCall** _number_

  Override the maximum number of images generated per API call. Default can vary
  by model, with 5 as a common default.

### Model Capabilities

The Amazon Nova Canvas model supports custom sizes with constraints as follows:

- Each side must be between 320-4096 pixels, inclusive.
- Each side must be evenly divisible by 16.
- The aspect ratio must be between 1:4 and 4:1. That is, one side can't be more than 4 times longer than the other side.
- The total pixel count must be less than 4,194,304.

For more, see [Image generation access and
usage](https://docs.aws.amazon.com/nova/latest/userguide/image-gen-access.html).

| Model                     | Sizes                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `amazon.nova-canvas-v1:0` | Custom sizes: 320-4096px per side (must be divisible by 16), aspect ratio 1:4 to 4:1, max 4.2M pixels |

## Response Headers

The Amazon Bedrock provider will return the response headers associated with
network requests made of the Bedrock servers.

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const { text } = await generateText({
  model: bedrock('meta.llama3-70b-instruct-v1:0'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});

console.log(result.response.headers);
```

Below is sample output where you can see the `x-amzn-requestid` header. This can
be useful for correlating Bedrock API calls with requests made by the AI SDK:

```js highlight="6"
{
  connection: 'keep-alive',
  'content-length': '2399',
  'content-type': 'application/json',
  date: 'Fri, 07 Feb 2025 04:28:30 GMT',
  'x-amzn-requestid': 'c9f3ace4-dd5d-49e5-9807-39aedfa47c8e'
}
```

This information is also available with `streamText`:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { streamText } from 'ai';

const result = streamText({
  model: bedrock('meta.llama3-70b-instruct-v1:0'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}
console.log('Response headers:', (await result.response).headers);
```

With sample output as:

```js highlight="6"
{
  connection: 'keep-alive',
  'content-type': 'application/vnd.amazon.eventstream',
  date: 'Fri, 07 Feb 2025 04:33:37 GMT',
  'transfer-encoding': 'chunked',
  'x-amzn-requestid': 'a976e3fc-0e45-4241-9954-b9bdd80ab407'
}
```

## Bedrock Anthropic Provider Usage

The Bedrock Anthropic provider offers support for Anthropic's Claude models through Amazon Bedrock's native InvokeModel API. This provides full feature parity with the [Anthropic API](https://platform.claude.com/docs/en/build-with-claude/overview), including features that may not be available through the Converse API (such as `stop_sequence` in streaming responses).

For more information on Claude models available on Amazon Bedrock, see [Claude on Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock).

### Provider Instance

You can import the default provider instance `bedrockAnthropic` from `@ai-sdk/amazon-bedrock/anthropic`:

```typescript
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
```

If you need a customized setup, you can import `createBedrockAnthropic` from `@ai-sdk/amazon-bedrock/anthropic` and create a provider instance with your settings:

```typescript
import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';

const bedrockAnthropic = createBedrockAnthropic({
  region: 'us-east-1', // optional
  accessKeyId: 'xxxxxxxxx', // optional
  secretAccessKey: 'xxxxxxxxx', // optional
  sessionToken: 'xxxxxxxxx', // optional
});
```

#### Provider Settings

You can use the following optional settings to customize the Bedrock Anthropic provider instance:

- **region** _string_

  The AWS region that you want to use for the API calls.
  It uses the `AWS_REGION` environment variable by default.

- **accessKeyId** _string_

  The AWS access key ID that you want to use for the API calls.
  It uses the `AWS_ACCESS_KEY_ID` environment variable by default.

- **secretAccessKey** _string_

  The AWS secret access key that you want to use for the API calls.
  It uses the `AWS_SECRET_ACCESS_KEY` environment variable by default.

- **sessionToken** _string_

  Optional. The AWS session token that you want to use for the API calls.
  It uses the `AWS_SESSION_TOKEN` environment variable by default.

- **apiKey** _string_

  API key for authenticating requests using Bearer token authentication.
  When provided, this will be used instead of AWS SigV4 authentication.
  It uses the `AWS_BEARER_TOKEN_BEDROCK` environment variable by default.

- **baseURL** _string_

  Base URL for the Bedrock API calls.
  Useful for custom endpoints or proxy configurations.

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **credentialProvider** _() => PromiseLike&lt;BedrockCredentials&gt;_

  The AWS credential provider to use for the Bedrock provider to get dynamic
  credentials similar to the AWS SDK. Setting a provider here will cause its
  credential values to be used instead of the `accessKeyId`, `secretAccessKey`,
  and `sessionToken` settings.

### Language Models

You can create models that call the [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages_post) using the provider instance.
The first argument is the model id, e.g. `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.

```ts
const model = bedrockAnthropic('us.anthropic.claude-3-5-sonnet-20241022-v2:0');
```

You can use Bedrock Anthropic language models to generate text with the `generateText` function:

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-3-5-sonnet-20241022-v2:0'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

### Provider Options

The following optional provider options are available for Bedrock Anthropic models:

- `metadata` _object_

  Optional. Metadata to include with the request. See the [Anthropic API documentation](https://platform.claude.com/docs/en/api/messages/create) for details.

  - `userId` _string_ - An external identifier for the end-user.

### Cache Control

In the messages and message parts, you can use the `providerOptions` property to set cache control breakpoints.
You need to set the `anthropic` property in the `providerOptions` object to `{ cacheControl: { type: 'ephemeral' } }` to set a cache control breakpoint.

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-3-7-sonnet-20250219-v1:0'),
  messages: [
    {
      role: 'system',
      content: 'You are an expert assistant.',
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    },
    {
      role: 'user',
      content: 'Explain quantum computing.',
    },
  ],
});
```

<Note>
  Cache control requires a minimum of 1024 tokens before the cache checkpoint.
  See the [Amazon Bedrock prompt caching
  documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
  for details on supported models and limits.
</Note>

### Computer Use

The Bedrock Anthropic provider supports Anthropic's computer use tools:

1. **Bash Tool**: Allows running bash commands.
2. **Text Editor Tool**: Provides functionality for viewing and editing text files.
3. **Computer Tool**: Enables control of keyboard and mouse actions on a computer.

They are available via the `tools` property of the provider instance.

<Note>
  Computer use tools require Claude 3.7 Sonnet or newer models. Claude 3.5
  Sonnet v2 does not support these tools.
</Note>

#### Bash Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, stepCountIs } from 'ai';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-3-7-sonnet-20250219-v1:0'),
  tools: {
    bash: bedrockAnthropic.tools.bash_20241022({
      execute: async ({ command }) => {
        // Implement your bash command execution logic here
        return [{ type: 'text', text: `Executed: ${command}` }];
      },
    }),
  },
  prompt: 'List the files in my directory.',
  stopWhen: stepCountIs(2),
});
```

#### Text Editor Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, stepCountIs } from 'ai';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-3-7-sonnet-20250219-v1:0'),
  tools: {
    str_replace_editor: bedrockAnthropic.tools.textEditor_20241022({
      execute: async ({ command, path, old_str, new_str }) => {
        // Implement your text editing logic here
        return 'File updated successfully';
      },
    }),
  },
  prompt: 'Update my README file.',
  stopWhen: stepCountIs(5),
});
```

#### Computer Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, stepCountIs } from 'ai';
import fs from 'fs';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-3-7-sonnet-20250219-v1:0'),
  tools: {
    computer: bedrockAnthropic.tools.computer_20241022({
      displayWidthPx: 1024,
      displayHeightPx: 768,
      execute: async ({ action, coordinate, text }) => {
        if (action === 'screenshot') {
          return {
            type: 'image',
            data: fs.readFileSync('./screenshot.png').toString('base64'),
          };
        }
        return `executed ${action}`;
      },
      toModelOutput({ output }) {
        return {
          type: 'content',
          value: [
            typeof output === 'string'
              ? { type: 'text', text: output }
              : {
                  type: 'image-data',
                  data: output.data,
                  mediaType: 'image/png',
                },
          ],
        };
      },
    }),
  },
  prompt: 'Take a screenshot.',
  stopWhen: stepCountIs(3),
});
```

### Reasoning

Anthropic has reasoning support for Claude 3.7 and Claude 4 models on Bedrock, including:

- `us.anthropic.claude-opus-4-7`
- `us.anthropic.claude-opus-4-6-v1`
- `us.anthropic.claude-opus-4-5-20251101-v1:0`
- `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- `us.anthropic.claude-opus-4-20250514-v1:0`
- `us.anthropic.claude-sonnet-4-20250514-v1:0`
- `us.anthropic.claude-opus-4-1-20250805-v1:0`
- `us.anthropic.claude-haiku-4-5-20251001-v1:0`
- `us.anthropic.claude-3-7-sonnet-20250219-v1:0`

You can enable it using the `thinking` provider option and specifying a thinking budget in tokens.

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    },
  },
});

console.log(reasoningText); // reasoning text
console.log(reasoning); // reasoning details including redacted reasoning
console.log(text); // text response
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

### Model Capabilities

| Model                                          | Image Input         | Object Generation   | Tool Usage          | Computer Use        | Reasoning           |
| ---------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `us.anthropic.claude-opus-4-7`                 | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-6-v1`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-5-20251101-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-20250514-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-20250514-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-1-20250805-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-7-sonnet-20250219-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `us.anthropic.claude-3-5-haiku-20241022-v1:0`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  The Bedrock Anthropic provider uses the native InvokeModel API and supports
  all features available in the Anthropic API, except for the Files API and MCP
  Connector which are not supported on Bedrock.
</Note>

## Migrating to `@ai-sdk/amazon-bedrock` 2.x

The Amazon Bedrock provider was rewritten in version 2.x to remove the
dependency on the `@aws-sdk/client-bedrock-runtime` package.

The `bedrockOptions` provider setting previously available has been removed. If
you were using the `bedrockOptions` object, you should now use the `region`,
`accessKeyId`, `secretAccessKey`, and `sessionToken` settings directly instead.

Note that you may need to set all of these explicitly, e.g. even if you're not
using `sessionToken`, set it to `undefined`. If you're running in a serverless
environment, there may be default environment variables set by your containing
environment that the Amazon Bedrock provider will then pick up and could
conflict with the ones you're intending to use.

---
title: Groq
description: Learn how to use Groq.
---

