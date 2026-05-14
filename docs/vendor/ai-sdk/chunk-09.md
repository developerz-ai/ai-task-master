# Get started with DeepSeek V3.2

With the [release of DeepSeek V3.2](https://api-docs.deepseek.com/news/news251201), there has never been a better time to start building AI applications that require advanced reasoning and agentic capabilities.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like DeepSeek V3.2 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## DeepSeek V3.2

DeepSeek V3.2 is a frontier model that harmonizes high computational efficiency with superior reasoning and agent performance. It introduces several key technical breakthroughs that enable it to perform comparably to GPT-5 while remaining open-source.

The series includes two primary variants:

- **DeepSeek V3.2**: The official successor to V3.2-Exp. A balanced model optimized for both reasoning and inference efficiency, delivering GPT-5 level performance.
- **DeepSeek V3.2-Speciale**: A high-compute variant with maxed-out reasoning capabilities that rivals Gemini-3.0-Pro. Achieves gold-medal performance in IMO 2025, CMO 2025, ICPC World Finals 2025, and IOI 2025. As of release, it does not support tool-use.

### Benchmarks

DeepSeek V3.2 models excel in both reasoning and agentic tasks, delivering competitive performance across key benchmarks:

**Reasoning Capabilities**

- **AIME 2025 (Pass@1)**: 96.0% (Speciale)
- **HMMT 2025 (Pass@1)**: 99.2% (Speciale)
- **HLE (Pass@1)**: 30.6%
- **Codeforces (Rating)**: 2701 (Speciale)

**Agentic Capabilities**

- **SWE Verified (Resolved)**: 73.1%
- **Terminal Bench 2.0 (Acc)**: 46.4%
- **τ2 Bench (Pass@1)**: 80.3%
- **Tool Decathlon (Pass@1)**: 35.2%

[Source](https://huggingface.co/deepseek-ai/DeepSeek-V3.2/resolve/main/assets/paper.pdf)

### Model Options

When using DeepSeek V3.2 with the AI SDK, you have two model options:

| Model Alias         | Model Version                     | Description                                    |
| ------------------- | --------------------------------- | ---------------------------------------------- |
| `deepseek-chat`     | DeepSeek-V3.2 (Non-thinking Mode) | Standard chat model                            |
| `deepseek-reasoner` | DeepSeek-V3.2 (Thinking Mode)     | Enhanced reasoning for complex problem-solving |

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building agents, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call DeepSeek V3.2 with the AI SDK:

```ts
import { deepseek } from '@ai-sdk/deepseek';
import { generateText } from 'ai';

const { text } = await generateText({
  model: deepseek('deepseek-chat'),
  prompt: 'Explain the concept of sparse attention in transformers.',
});
```

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With three main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building an agent with [Next.js](https://nextjs.org), the AI SDK, and DeepSeek V3.2:

In a new Next.js application, first install the AI SDK and the DeepSeek provider:

<Snippet text="pnpm install ai @ai-sdk/deepseek @ai-sdk/react" />

Then, create a route handler for the chat endpoint:

```tsx filename="app/api/chat/route.ts"
import { deepseek } from '@ai-sdk/deepseek';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: deepseek('deepseek-reasoner'),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
```

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Page() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage({ text: input });
      setInput('');
    }
  };

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part, index) => {
            if (part.type === 'text' || part.type === 'reasoning') {
              return <div key={index}>{part.text}</div>;
            }
            return null;
          })}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input
          name="prompt"
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <button type="submit">Submit</button>
      </form>
    </>
  );
}
```

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Enhance Your Agent with Tools

One of the key strengths of DeepSeek V3.2 is its agentic capabilities. You can extend your agent's functionality by adding tools that allow the model to perform specific actions or retrieve information.

### Update Your Route Handler

Let's add a weather tool to your agent. Update your route handler at `app/api/chat/route.ts`:

```tsx filename="app/api/chat/route.ts"
import { deepseek } from '@ai-sdk/deepseek';
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  UIMessage,
} from 'ai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: deepseek('deepseek-reasoner'),
    messages: await convertToModelMessages(messages),
    tools: {
      weather: tool({
        description: 'Get the weather in a location',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => ({
          location,
          temperature: 72,
          unit: 'fahrenheit',
        }),
      }),
    },
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse({ sendReasoning: true });
}
```

This adds a weather tool that the model can call when needed. The `stopWhen: stepCountIs(5)` parameter allows the agent to continue executing for multiple steps (up to 5), enabling it to use tools and reason iteratively before stopping. Learn more about [loop control](/docs/agents/loop-control) to customize when and how your agent stops execution.

## Get Started

Ready to dive in? Here's how you can begin:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) at [ai-sdk.dev/docs/guides](/cookbook/guides).
4. Use ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Guides
description: Learn how to build AI applications with the AI SDK
---

# Guides

These use-case specific guides are intended to help you build real applications with the AI SDK.

<IndexCards
  cards={[
    {
      title: 'RAG Agent',
      description:
        'Learn how to build a RAG Agent with the AI SDK and Next.js.',
      href: '/cookbook/guides/rag-chatbot',
    },
    {
      title: 'Multi-Modal Agent',
      description:
        'Learn how to build a multi-modal agent that can process images and PDFs with the AI SDK.',
      href: '/cookbook/guides/multi-modal-chatbot',
    },
    {
      title: 'Slackbot Agent',
      description: 'Learn how to use the AI SDK to build an AI Agent in Slack.',
      href: '/cookbook/guides/slackbot',
    },
    {
      title: 'Natural Language Postgres (SQL Agent)',
      description:
        'Learn how to build a Next.js app that lets you talk to a PostgreSQL database in natural language.',
      href: '/cookbook/guides/natural-language-postgres',
    },
    {
      title: 'Get started with Computer Use',
      description:
        "Get started with Claude's Computer Use capabilities with the AI SDK.",
      href: '/cookbook/guides/computer-use',
    },
    {
      title: 'Add Skills to Your Agent',
      description:
        'Extend your agent with specialized capabilities loaded at runtime from markdown files.',
      href: '/cookbook/guides/agent-skills',
    },
    {
      title: 'Get started with Gemini 2.5',
      description: 'Get started with Gemini 2.5 using the AI SDK.',
      href: '/cookbook/guides/gemini-2-5',
    },
    {
      title: 'Get started with Claude 4',
      description: 'Get started with Claude 4 using the AI SDK.',
      href: '/cookbook/guides/claude-4',
    },
    {
      title: 'OpenAI Responses API',
      description:
        'Get started with the OpenAI Responses API using the AI SDK.',
      href: '/cookbook/guides/openai-responses',
    },
    {
      title: 'Get started with Claude 3.7 Sonnet',
      description: 'Get started with Claude 3.7 Sonnet using the AI SDK.',
      href: '/cookbook/guides/sonnet-3-7',
    },
    {
      title: 'Get started with Llama 3.1',
      description: 'Get started with Llama 3.1 using the AI SDK.',
      href: '/cookbook/guides/llama-3_1',
    },
    {
      title: 'Get started with GPT-5',
      description: 'Get started with GPT-5 using the AI SDK.',
      href: '/cookbook/guides/gpt-5',
    },
    {
      title: 'Get started with OpenAI o1',
      description: 'Get started with OpenAI o1 using the AI SDK.',
      href: '/cookbook/guides/o1',
    },
    {
      title: 'Get started with OpenAI o3-mini',
      description: 'Get started with OpenAI o3-mini using the AI SDK.',
      href: '/cookbook/guides/o3',
    },
    {
      title: 'Get started with DeepSeek R1',
      description: 'Get started with DeepSeek R1 using the AI SDK.',
      href: '/cookbook/guides/r1',
    },
  ]}
/>

---
title: Node.js HTTP Server
description: Learn how to use the AI SDK in a Node.js HTTP server
tags: ['api servers', 'streaming']
---

# Node.js HTTP Server

You can use the AI SDK in a Node.js HTTP server to generate text and stream it to the client.

## Examples

The examples start a simple HTTP server that listens on port 8080. You can e.g. test it using `curl`:

```bash
curl -X POST http://localhost:8080
```

<Note>
  The examples use the Vercel AI Gateway. Ensure that your AI Gateway API key is
  set in the `AI_GATEWAY_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/node-http-server](https://github.com/vercel/ai/tree/main/examples/node-http-server)

### UI Message Stream

You can use the `pipeUIMessageStreamToResponse` method to pipe the stream data to the server response.

```ts filename='index.ts'
import { streamText } from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeUIMessageStreamToResponse(res);
}).listen(8080);
```

### Sending Custom Data

`createUIMessageStream` and `pipeUIMessageStreamToResponse` can be used to send custom data to the client.

```ts filename='index.ts'
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  streamText,
} from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  switch (req.url) {
    case '/stream-data': {
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          // write some custom data
          writer.write({ type: 'start' });

          writer.write({
            type: 'data-custom',
            data: {
              custom: 'Hello, world!',
            },
          });

          const result = streamText({
            model: 'openai/gpt-4o',
            prompt: 'Invent a new holiday and describe its traditions.',
          });

          writer.merge(
            result.toUIMessageStream({
              sendStart: false,
              onError: error => {
                // Error messages are masked by default for security reasons.
                // If you want to expose the error message to the client, you can do so here:
                return error instanceof Error ? error.message : String(error);
              },
            }),
          );
        },
      });

      pipeUIMessageStreamToResponse({ stream, response: res });

      break;
    }
  }
}).listen(8080);
```

### Text Stream

You can send a text stream to the client using `pipeTextStreamToResponse`.

```ts filename='index.ts'
import { streamText } from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeTextStreamToResponse(res);
}).listen(8080);
```

## Troubleshooting

- Streaming not working when [proxied](/docs/troubleshooting/streaming-not-working-when-proxied)

---
title: Express
description: Learn how to use the AI SDK in an Express server
tags: ['api servers', 'streaming']
---

# Express

You can use the AI SDK in an [Express](https://expressjs.com/) server to generate and stream text and objects to the client.

## Examples

The examples start a simple HTTP server that listens on port 8080. You can e.g. test it using `curl`:

```bash
curl -X POST http://localhost:8080
```

<Note>
  The examples use the Vercel AI Gateway. Ensure that your AI Gateway API key is
  set in the `AI_GATEWAY_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/express](https://github.com/vercel/ai/tree/main/examples/express)

### UI Message Stream

You can use the `pipeUIMessageStreamToResponse` method to pipe the stream data to the server response.

```ts filename='index.ts'
import { streamText } from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/', async (req: Request, res: Response) => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeUIMessageStreamToResponse(res);
});

app.listen(8080, () => {
  console.log(`Example app listening on port ${8080}`);
});
```

### Sending Custom Data

`pipeUIMessageStreamToResponse` can be used to send custom data to the client.

```ts filename='index.ts'
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  streamText,
} from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/custom-data-parts', async (req: Request, res: Response) => {
  pipeUIMessageStreamToResponse({
    response: res,
    stream: createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });

        writer.write({
          type: 'data-custom',
          data: {
            custom: 'Hello, world!',
          },
        });

        const result = streamText({
          model: 'openai/gpt-4o',
          prompt: 'Invent a new holiday and describe its traditions.',
        });

        writer.merge(result.toUIMessageStream({ sendStart: false }));
      },
    }),
  });
});

app.listen(8080, () => {
  console.log(`Example app listening on port ${8080}`);
});
```

### Text Stream

You can send a text stream to the client using `pipeTextStreamToResponse`.

```ts filename='index.ts'
import { streamText } from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/', async (req: Request, res: Response) => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeTextStreamToResponse(res);
});

app.listen(8080, () => {
  console.log(`Example app listening on port ${8080}`);
});
```

## Troubleshooting

- Streaming not working when [proxied](/docs/troubleshooting/streaming-not-working-when-proxied)

---
title: Hono
description: Example of using the AI SDK in a Hono server.
tags: ['api servers', 'streaming']
---

# Hono

You can use the AI SDK in a [Hono](https://hono.dev/) server to generate and stream text and objects to the client.

## Examples

The examples start a simple HTTP server that listens on port 8080. You can e.g. test it using `curl`:

```bash
curl -X POST http://localhost:8080
```

<Note>
  The examples use the Vercel AI Gateway. Ensure that your AI Gateway API key is
  set in the `AI_GATEWAY_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/hono](https://github.com/vercel/ai/tree/main/examples/hono)

### UI Message Stream

You can use the `toUIMessageStreamResponse` method to create a properly formatted streaming response.

```ts filename='index.ts'
import { serve } from '@hono/node-server';
import { streamText } from 'ai';
import { Hono } from 'hono';

const app = new Hono();

app.post('/', async c => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });
  return result.toUIMessageStreamResponse();
});

serve({ fetch: app.fetch, port: 8080 });
```

### Text Stream

You can use the `toTextStreamResponse` method to return a text stream response.

```ts filename='index.ts'
import { serve } from '@hono/node-server';
import { streamText } from 'ai';
import { Hono } from 'hono';

const app = new Hono();

app.post('/text', async c => {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Write a short poem about coding.',
  });
  return result.toTextStreamResponse();
});

serve({ fetch: app.fetch, port: 8080 });
```

### Sending Custom Data

You can use `createUIMessageStream` and `createUIMessageStreamResponse` to send custom data to the client.

```ts filename='index.ts'
import { serve } from '@hono/node-server';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from 'ai';
import { Hono } from 'hono';

const app = new Hono();

app.post('/stream-data', async c => {
  // immediately start streaming the response
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: 'start' });

      writer.write({
        type: 'data-custom',
        data: {
          custom: 'Hello, world!',
        },
      });

      const result = streamText({
        model: 'openai/gpt-4o',
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      writer.merge(
        result.toUIMessageStream({
          sendStart: false,
          onError: error => {
            // Error messages are masked by default for security reasons.
            // If you want to expose the error message to the client, you can do so here:
            return error instanceof Error ? error.message : String(error);
          },
        }),
      );
    },
  });
  return createUIMessageStreamResponse({ stream });
});

serve({ fetch: app.fetch, port: 8080 });
```

## Troubleshooting

- Streaming not working when [proxied](/docs/troubleshooting/streaming-not-working-when-proxied)

---
title: Fastify
description: Learn how to use the AI SDK in a Fastify server
tags: ['api servers', 'streaming']
---

# Fastify

You can use the AI SDK in a [Fastify](https://fastify.dev/) server to generate and stream text and objects to the client.

## Examples

The examples start a simple HTTP server that listens on port 8080. You can e.g. test it using `curl`:

```bash
curl -X POST http://localhost:8080
```

<Note>
  The examples use the Vercel AI Gateway. Ensure that your AI Gateway API key is
  set in the `AI_GATEWAY_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/fastify](https://github.com/vercel/ai/tree/main/examples/fastify)

### UI Message Stream

You can use the `toUIMessageStream` method to get a UI message stream from the result and then pipe it to the response.

```ts filename='index.ts'
import { streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/', async function (request, reply) {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  reply.header('Content-Type', 'text/plain; charset=utf-8');

  return reply.send(result.toUIMessageStream());
});

fastify.listen({ port: 8080 });
```

### Sending Custom Data

`createUIMessageStream` can be used to send custom data to the client.

```ts filename='index.ts' highlight="8-11,18"
import { createUIMessageStream, streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/stream-data', async function (request, reply) {
  // immediately start streaming the response
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'start' });

      writer.write({
        type: 'data-custom',
        data: {
          custom: 'initialized call',
        },
      });

      const result = streamText({
        model: 'openai/gpt-4o',
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      writer.merge(result.toUIMessageStream({ sendStart: false }));
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });

  reply.header('Content-Type', 'text/plain; charset=utf-8');

  return reply.send(stream);
});

fastify.listen({ port: 8080 });
```

### Text Stream

You can use the `textStream` property to get a text stream from the result and then pipe it to the response.

```ts filename='index.ts' highlight="15"
import { streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/', async function (request, reply) {
  const result = streamText({
    model: 'openai/gpt-4o',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  reply.header('Content-Type', 'text/plain; charset=utf-8');

  return reply.send(result.textStream);
});

fastify.listen({ port: 8080 });
```

## Troubleshooting

- Streaming not working when [proxied](/docs/troubleshooting/streaming-not-working-when-proxied)

---
title: Nest.js
description: Learn how to use the AI SDK in a Nest.js server
tags: ['api servers', 'streaming']
---

# Nest.js

You can use the AI SDK in a [Nest.js](https://nestjs.com/) server to generate and stream text and objects to the client.

## Examples

The examples show how to implement a Nest.js controller that uses the AI SDK to stream text and objects to the client.

**Full example**: [github.com/vercel/ai/examples/nest](https://github.com/vercel/ai/tree/main/examples/nest)

### UI Message Stream

You can use the `pipeUIMessageStreamToResponse` method to pipe the stream data to the server response.

```ts filename='app.controller.ts'
import { Controller, Post, Res } from '@nestjs/common';
import { streamText } from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post('/')
  async root(@Res() res: Response) {
    const result = streamText({
      model: 'openai/gpt-4o',
      prompt: 'Invent a new holiday and describe its traditions.',
    });

    result.pipeUIMessageStreamToResponse(res);
  }
}
```

### Sending Custom Data

`createUIMessageStream` and `pipeUIMessageStreamToResponse` can be used to send custom data to the client.

```ts filename='app.controller.ts'
import { Controller, Post, Res } from '@nestjs/common';
import {
  createUIMessageStream,
  streamText,
  pipeUIMessageStreamToResponse,
} from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post('/stream-data')
  async streamData(@Res() response: Response) {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        // write some data
        writer.write({ type: 'start' });

        writer.write({
          type: 'data-custom',
          data: {
            custom: 'Hello, world!',
          },
        });

        const result = streamText({
          model: 'openai/gpt-4o',
          prompt: 'Invent a new holiday and describe its traditions.',
        });
        writer.merge(
          result.toUIMessageStream({
            sendStart: false,
            onError: error => {
              // Error messages are masked by default for security reasons.
              // If you want to expose the error message to the client, you can do so here:
              return error instanceof Error ? error.message : String(error);
            },
          }),
        );
      },
    });
    pipeUIMessageStreamToResponse({ stream, response });
  }
}
```

### Text Stream

You can use the `pipeTextStreamToResponse` method to get a text stream from the result and then pipe it to the response.

```ts filename='app.controller.ts'
import { Controller, Post, Res } from '@nestjs/common';
import { streamText } from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post()
  async example(@Res() res: Response) {
    const result = streamText({
      model: 'openai/gpt-4o',
      prompt: 'Invent a new holiday and describe its traditions.',
    });

    result.pipeTextStreamToResponse(res);
  }
}
```

## Troubleshooting

- Streaming not working when [proxied](/docs/troubleshooting/streaming-not-working-when-proxied)

---
title: AI SDK by Vercel
description: The AI SDK is the TypeScript toolkit for building AI applications and agents with React, Next.js, Vue, Svelte, Node.js, and more.
---

# AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications and agents with React, Next.js, Vue, Svelte, Node.js, and more.

## Why use the AI SDK?

Integrating large language models (LLMs) into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK standardizes integrating artificial intelligence (AI) models across [supported providers](/docs/foundations/providers-and-models). This enables developers to focus on building great AI applications, not waste time on technical details.

For example, here’s how you can generate text with various models using the AI SDK:

<PreviewSwitchProviders />

The AI SDK has two main libraries:

- **[AI SDK Core](/docs/ai-sdk-core):** A unified API for generating text, structured objects, tool calls, and building agents with LLMs.
- **[AI SDK UI](/docs/ai-sdk-ui):** A set of framework-agnostic hooks for quickly building chat and generative user interface.

## Model Providers

The AI SDK supports [multiple model providers](/providers).

<OfficialModelCards />

## Templates

We've built some [templates](https://vercel.com/templates?type=ai) that include AI SDK integrations for different use cases, providers, and frameworks. You can use these templates to get started with your AI-powered application.

### Starter Kits

<Templates type="starter-kits" />

### Feature Exploration

<Templates type="feature-exploration" />

### Frameworks

<Templates type="frameworks" />

### Generative UI

<Templates type="generative-ui" />

### Security

<Templates type="security" />

## Join our Community

If you have questions about anything related to the AI SDK, you're always welcome to ask our community on [the Vercel Community](https://community.vercel.com/c/ai-sdk/62).

## `llms.txt` (for Cursor, Windsurf, Copilot, Claude etc.)

You can access the entire AI SDK documentation in Markdown format at [ai-sdk.dev/llms.txt](/llms.txt). This can be used to ask any LLM (assuming it has a big enough context window) questions about the AI SDK based on the most up-to-date documentation.

### Example Usage

For instance, to prompt an LLM with questions about the AI SDK:

1. Copy the documentation contents from [ai-sdk.dev/llms.txt](/llms.txt)
2. Use the following prompt format:

```prompt
Documentation:
{paste documentation here}
---
Based on the above documentation, answer the following:
{your question}
```

---
title: Overview
description: Learn how to build agents with the AI SDK.
---

# Agents

Agents are **large language models (LLMs)** that use **tools** in a **loop** to accomplish tasks.

These components work together:

- **LLMs** process input and decide the next action
- **Tools** extend capabilities beyond text generation (reading files, calling APIs, writing to databases)
- **Loop** orchestrates execution through:
  - **Context management** - Maintaining conversation history and deciding what the model sees (input) at each step
  - **Stopping conditions** - Determining when the loop (task) is complete

## ToolLoopAgent Class

The ToolLoopAgent class handles these three components. Here's an agent that uses multiple tools in a loop to accomplish a task:

```ts
import { ToolLoopAgent, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const weatherAgent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    weather: tool({
      description: 'Get the weather in a location (in Fahrenheit)',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
    convertFahrenheitToCelsius: tool({
      description: 'Convert temperature from Fahrenheit to Celsius',
      inputSchema: z.object({
        temperature: z.number().describe('Temperature in Fahrenheit'),
      }),
      execute: async ({ temperature }) => {
        const celsius = Math.round((temperature - 32) * (5 / 9));
        return { celsius };
      },
    }),
  },
});

const result = await weatherAgent.generate({
  prompt: 'What is the weather in San Francisco in celsius?',
});

console.log(result.text); // agent's final answer
console.log(result.steps); // steps taken by the agent
```

The agent automatically:

1. Calls the `weather` tool to get the temperature in Fahrenheit
2. Calls `convertFahrenheitToCelsius` to convert it
3. Generates a final text response with the result

The ToolLoopAgent handles the loop, context management, and stopping conditions.

## Why Use the ToolLoopAgent?

The ToolLoopAgent is the recommended approach for building agents with the AI SDK because it:

- **Reduces boilerplate** - Manages loops and message arrays
- **Improves reusability** - Define once, use throughout your application
- **Simplifies maintenance** - Single place to update agent configuration

For most use cases, start with the ToolLoopAgent. Use core functions (`generateText`, `streamText`) when you need explicit control over each step for complex structured workflows.

## Structured Workflows

Agents are flexible and powerful, but non-deterministic. When you need reliable, repeatable outcomes with explicit control flow, use core functions with structured workflow patterns combining:

- Conditional statements for explicit branching
- Standard functions for reusable logic
- Error handling for robustness
- Explicit control flow for predictability

[Explore workflow patterns](/docs/agents/workflows) to learn more about building structured, reliable systems.

## Next Steps

- **[Building Agents](/docs/agents/building-agents)** - Guide to creating agents with the ToolLoopAgent
- **[Workflow Patterns](/docs/agents/workflows)** - Structured patterns using core functions for complex workflows
- **[Loop Control](/docs/agents/loop-control)** - Execution control with stopWhen and prepareStep

---
title: Building Agents
description: Complete guide to creating agents with the ToolLoopAgent.
---

# Building Agents

The ToolLoopAgent provides a structured way to encapsulate LLM configuration, tools, and behavior into reusable components. It handles the agent loop for you, allowing the LLM to call tools multiple times in sequence to accomplish complex tasks. Define agents once and use them across your application.

## Why Use the ToolLoopAgent Class?

When building AI applications, you often need to:

- **Reuse configurations** - Same model settings, tools, and prompts across different parts of your application
- **Maintain consistency** - Ensure the same behavior and capabilities throughout your codebase
- **Simplify API routes** - Reduce boilerplate in your endpoints
- **Type safety** - Get full TypeScript support for your agent's tools and outputs

The ToolLoopAgent class provides a single place to define your agent's behavior.

## Creating an Agent

Define an agent by instantiating the ToolLoopAgent class with your desired configuration:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const myAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: 'You are a helpful assistant.',
  tools: {
    // Your tools here
  },
});
```

## Configuration Options

The ToolLoopAgent accepts all the same settings as `generateText` and `streamText`. Configure:

### Model and System Instructions

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: 'You are an expert software engineer.',
});
```

### Tools

Provide tools that the agent can use to accomplish tasks:

```ts
import { ToolLoopAgent, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const codeAgent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    runCode: tool({
      description: 'Execute Python code',
      inputSchema: z.object({
        code: z.string(),
      }),
      execute: async ({ code }) => {
        // Execute code and return result
        return { output: 'Code executed successfully' };
      },
    }),
  },
});
```

### Loop Control

By default, agents run for 20 steps (`stopWhen: stepCountIs(20)`). In each step, the model either generates text or calls a tool. If it generates text, the agent completes. If it calls a tool, the AI SDK executes that tool.

You can configure `stopWhen` differently to allow more steps. After each tool execution, the agent triggers a new generation where the model can call another tool or generate text:

```ts
import { ToolLoopAgent, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  stopWhen: stepCountIs(50), // Increase default from 20 to 50.
});
```

Each step represents one generation (which results in either text or a tool call). The loop continues until:

- A finish reasoning other than tool-calls is returned, or
- A tool that is invoked does not have an execute function, or
- A tool call needs approval, or
- A stop condition is met

You can combine multiple conditions:

```ts
import { ToolLoopAgent, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  stopWhen: [
    stepCountIs(20), // Maximum 20 steps
    yourCustomCondition(), // Custom logic for when to stop
  ],
});
```

Learn more about [loop control and stop conditions](/docs/agents/loop-control).

### Tool Choice

Control how the agent uses tools:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools here
  },
  toolChoice: 'required', // Force tool use
  // or toolChoice: 'none' to disable tools
  // or toolChoice: 'auto' (default) to let the model decide
});
```

You can also force the use of a specific tool:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    weather: weatherTool,
    cityAttractions: attractionsTool,
  },
  toolChoice: {
    type: 'tool',
    toolName: 'weather', // Force the weather tool to be used
  },
});
```

### Structured Output

Define structured output schemas:

```ts
import { ToolLoopAgent, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const analysisAgent = new ToolLoopAgent({
  model: __MODEL__,
  output: Output.object({
    schema: z.object({
      sentiment: z.enum(['positive', 'neutral', 'negative']),
      summary: z.string(),
      keyPoints: z.array(z.string()),
    }),
  }),
});

const { output } = await analysisAgent.generate({
  prompt: 'Analyze customer feedback from the last quarter',
});
```

## Define Agent Behavior with System Instructions

System instructions define your agent's behavior, personality, and constraints. They set the context for all interactions and guide how the agent responds to user queries and uses tools.

### Basic System Instructions

Set the agent's role and expertise:

```ts
const agent = new ToolLoopAgent({
  model: __MODEL__,
  instructions:
    'You are an expert data analyst. You provide clear insights from complex data.',
});
```

### Detailed Behavioral Instructions

Provide specific guidelines for agent behavior:

```ts
const codeReviewAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a senior software engineer conducting code reviews.

  Your approach:
  - Focus on security vulnerabilities first
  - Identify performance bottlenecks
  - Suggest improvements for readability and maintainability
  - Be constructive and educational in your feedback
  - Always explain why something is an issue and how to fix it`,
});
```

### Constrain Agent Behavior

Set boundaries and ensure consistent behavior:

```ts
const customerSupportAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a customer support specialist for an e-commerce platform.

  Rules:
  - Never make promises about refunds without checking the policy
  - Always be empathetic and professional
  - If you don't know something, say so and offer to escalate
  - Keep responses concise and actionable
  - Never share internal company information`,
  tools: {
    checkOrderStatus,
    lookupPolicy,
    createTicket,
  },
});
```

### Tool Usage Instructions

Guide how the agent should use available tools:

```ts
const researchAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a research assistant with access to search and document tools.

  When researching:
  1. Always start with a broad search to understand the topic
  2. Use document analysis for detailed information
  3. Cross-reference multiple sources before drawing conclusions
  4. Cite your sources when presenting information
  5. If information conflicts, present both viewpoints`,
  tools: {
    webSearch,
    analyzeDocument,
    extractQuotes,
  },
});
```

### Format and Style Instructions

Control the output format and communication style:

```ts
const technicalWriterAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a technical documentation writer.

  Writing style:
  - Use clear, simple language
  - Avoid jargon unless necessary
  - Structure information with headers and bullet points
  - Include code examples where relevant
  - Write in second person ("you" instead of "the user")

  Always format responses in Markdown.`,
});
```

## Using an Agent

Once defined, you can use your agent in three ways:

### Generate Text

Use `generate()` for one-time text generation:

```ts
const result = await myAgent.generate({
  prompt: 'What is the weather like?',
});

console.log(result.text);
```

### Stream Text

Use `stream()` for streaming responses:

```ts
const result = await myAgent.stream({
  prompt: 'Tell me a story',
});

for await (const chunk of result.textStream) {
  console.log(chunk);
}
```

### Respond to UI Messages

Use `createAgentUIStreamResponse()` to create API responses for client applications:

```ts
// In your API route (e.g., app/api/chat/route.ts)
import { createAgentUIStreamResponse } from 'ai';

export async function POST(request: Request) {
  const { messages } = await request.json();

  return createAgentUIStreamResponse({
    agent: myAgent,
    uiMessages: messages,
  });
}
```

### Track Step Progress

Use `onStepFinish` to track each step's progress, including token usage.
The callback receives a `stepNumber` (zero-based) to identify which step just completed:

```ts
const result = await myAgent.generate({
  prompt: 'Research and summarize the latest AI trends',
  onStepFinish: async ({ stepNumber, usage, finishReason, toolCalls }) => {
      console.log(`Step ${stepNumber} completed:`, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      finishReason,
      toolsUsed: toolCalls?.map(tc => tc.toolName),
    });
  },
});
```

You can also define `onStepFinish` in the constructor for agent-wide tracking. When both constructor and method callbacks are provided, both are called (constructor first, then the method callback):

```ts
const agent = new ToolLoopAgent({
  model: __MODEL__,
  onStepFinish: async ({ stepNumber, usage }) => {
    // Agent-wide logging
    console.log(`Agent step ${stepNumber}:`, usage.totalTokens);
  },
});

// Method-level callback runs after constructor callback
const result = await agent.generate({
  prompt: 'Hello',
  onStepFinish: async ({ stepNumber, usage }) => {
    // Per-call tracking (e.g., for billing)
    await trackUsage(stepNumber, usage);
  },
});
```

## End-to-end Type Safety

You can infer types for your agent's `UIMessage`s:

```ts
import { ToolLoopAgent, InferAgentUIMessage } from 'ai';

const myAgent = new ToolLoopAgent({
  // ... configuration
});

// Infer the UIMessage type for UI components or persistence
export type MyAgentUIMessage = InferAgentUIMessage<typeof myAgent>;
```

Use this type in your client components with `useChat`:

```tsx filename="components/chat.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import type { MyAgentUIMessage } from '@/agent/my-agent';

export function Chat() {
  const { messages } = useChat<MyAgentUIMessage>();
  // Full type safety for your messages and tools
}
```

## Next Steps

Now that you understand building agents, you can:

- Explore [workflow patterns](/docs/agents/workflows) for structured patterns using core functions
- Learn about [loop control](/docs/agents/loop-control) for advanced execution control
- See [manual loop examples](/cookbook/node/manual-agent-loop) for custom workflow implementations

---
title: Workflow Patterns
description: Learn workflow patterns for building reliable agents with the AI SDK.
---

# Workflow Patterns

Combine the building blocks from the [overview](/docs/agents/overview) with these patterns to add structure and reliability to your agents:

- [Sequential Processing](#sequential-processing-chains) - Steps executed in order
- [Parallel Processing](#parallel-processing) - Independent tasks run simultaneously
- [Evaluation/Feedback Loops](#evaluator-optimizer) - Results checked and improved iteratively
- [Orchestration](#orchestrator-worker) - Coordinating multiple components
- [Routing](#routing) - Directing work based on context

## Choose Your Approach

Consider these key factors:

- **Flexibility vs Control** - How much freedom does the LLM need vs how tightly you must constrain its actions?
- **Error Tolerance** - What are the consequences of mistakes in your use case?
- **Cost Considerations** - More complex systems typically mean more LLM calls and higher costs
- **Maintenance** - Simpler architectures are easier to debug and modify

**Start with the simplest approach that meets your needs**. Add complexity only when required by:

1. Breaking down tasks into clear steps
2. Adding tools for specific capabilities
3. Implementing feedback loops for quality control
4. Introducing multiple agents for complex workflows

Let's look at examples of these patterns in action.

## Patterns with Examples

These patterns, adapted from [Anthropic's guide on building effective agents](https://www.anthropic.com/research/building-effective-agents), serve as building blocks you can combine to create comprehensive workflows. Each pattern addresses specific aspects of task execution. Combine them thoughtfully to build reliable solutions for complex problems.

## Sequential Processing (Chains)

The simplest workflow pattern executes steps in a predefined order. Each step's output becomes input for the next step, creating a clear chain of operations. Use this pattern for tasks with well-defined sequences, like content generation pipelines or data transformation processes.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

async function generateMarketingCopy(input: string) {
  const model = __MODEL__;

  // First step: Generate marketing copy
  const { text: copy } = await generateText({
    model,
    prompt: `Write persuasive marketing copy for: ${input}. Focus on benefits and emotional appeal.`,
  });

  // Perform quality check on copy
  const { output: qualityMetrics } = await generateText({
    model,
    output: Output.object({
      schema: z.object({
        hasCallToAction: z.boolean(),
        emotionalAppeal: z.number().min(1).max(10),
        clarity: z.number().min(1).max(10),
      }),
    }),
    prompt: `Evaluate this marketing copy for:
    1. Presence of call to action (true/false)
    2. Emotional appeal (1-10)
    3. Clarity (1-10)

    Copy to evaluate: ${copy}`,
  });

  // If quality check fails, regenerate with more specific instructions
  if (
    !qualityMetrics.hasCallToAction ||
    qualityMetrics.emotionalAppeal < 7 ||
    qualityMetrics.clarity < 7
  ) {
    const { text: improvedCopy } = await generateText({
      model,
      prompt: `Rewrite this marketing copy with:
      ${!qualityMetrics.hasCallToAction ? '- A clear call to action' : ''}
      ${qualityMetrics.emotionalAppeal < 7 ? '- Stronger emotional appeal' : ''}
      ${qualityMetrics.clarity < 7 ? '- Improved clarity and directness' : ''}

      Original copy: ${copy}`,
    });
    return { copy: improvedCopy, qualityMetrics };
  }

  return { copy, qualityMetrics };
}
```

## Routing

This pattern lets the model decide which path to take through a workflow based on context and intermediate results. The model acts as an intelligent router, directing the flow of execution between different branches of your workflow. Use this when handling varied inputs that require different processing approaches. In the example below, the first LLM call's results determine the second call's model size and system prompt.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

async function handleCustomerQuery(query: string) {
  const model = __MODEL__;

  // First step: Classify the query type
  const { output: classification } = await generateText({
    model,
    output: Output.object({
      schema: z.object({
        reasoning: z.string(),
        type: z.enum(['general', 'refund', 'technical']),
        complexity: z.enum(['simple', 'complex']),
      }),
    }),
    prompt: `Classify this customer query:
    ${query}

    Determine:
    1. Query type (general, refund, or technical)
    2. Complexity (simple or complex)
    3. Brief reasoning for classification`,
  });

  // Route based on classification
  // Set model and system prompt based on query type and complexity
  const { text: response } = await generateText({
    model:
      classification.complexity === 'simple'
        ? 'openai/gpt-4o-mini'
        : 'openai/o4-mini',
    system: {
      general:
        'You are an expert customer service agent handling general inquiries.',
      refund:
        'You are a customer service agent specializing in refund requests. Follow company policy and collect necessary information.',
      technical:
        'You are a technical support specialist with deep product knowledge. Focus on clear step-by-step troubleshooting.',
    }[classification.type],
    prompt: query,
  });

  return { response, classification };
}
```

## Parallel Processing

Break down tasks into independent subtasks that execute simultaneously. This pattern uses parallel execution to improve efficiency while maintaining the benefits of structured workflows. For example, analyze multiple documents or process different aspects of a single input concurrently (like code review).

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

// Example: Parallel code review with multiple specialized reviewers
async function parallelCodeReview(code: string) {
  const model = __MODEL__;

  // Run parallel reviews
  const [securityReview, performanceReview, maintainabilityReview] =
    await Promise.all([
      generateText({
        model,
        system:
          'You are an expert in code security. Focus on identifying security vulnerabilities, injection risks, and authentication issues.',
        output: Output.object({
          schema: z.object({
            vulnerabilities: z.array(z.string()),
            riskLevel: z.enum(['low', 'medium', 'high']),
            suggestions: z.array(z.string()),
          }),
        }),
        prompt: `Review this code:
      ${code}`,
      }),

      generateText({
        model,
        system:
          'You are an expert in code performance. Focus on identifying performance bottlenecks, memory leaks, and optimization opportunities.',
        output: Output.object({
          schema: z.object({
            issues: z.array(z.string()),
            impact: z.enum(['low', 'medium', 'high']),
            optimizations: z.array(z.string()),
          }),
        }),
        prompt: `Review this code:
      ${code}`,
      }),

      generateText({
        model,
        system:
          'You are an expert in code quality. Focus on code structure, readability, and adherence to best practices.',
        output: Output.object({
          schema: z.object({
            concerns: z.array(z.string()),
            qualityScore: z.number().min(1).max(10),
            recommendations: z.array(z.string()),
          }),
        }),
        prompt: `Review this code:
      ${code}`,
      }),
    ]);

  const reviews = [
    { ...securityReview.output, type: 'security' },
    { ...performanceReview.output, type: 'performance' },
    { ...maintainabilityReview.output, type: 'maintainability' },
  ];

  // Aggregate results using another model instance
  const { text: summary } = await generateText({
    model,
    system: 'You are a technical lead summarizing multiple code reviews.',
    prompt: `Synthesize these code review results into a concise summary with key actions:
    ${JSON.stringify(reviews, null, 2)}`,
  });

  return { reviews, summary };
}
```

## Orchestrator-Worker

A primary model (orchestrator) coordinates the execution of specialized workers. Each worker optimizes for a specific subtask, while the orchestrator maintains overall context and ensures coherent results. This pattern excels at complex tasks requiring different types of expertise or processing.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

async function implementFeature(featureRequest: string) {
  // Orchestrator: Plan the implementation
  const { output: implementationPlan } = await generateText({
    model: __MODEL__,
    output: Output.object({
      schema: z.object({
        files: z.array(
          z.object({
            purpose: z.string(),
            filePath: z.string(),
            changeType: z.enum(['create', 'modify', 'delete']),
          }),
        ),
        estimatedComplexity: z.enum(['low', 'medium', 'high']),
      }),
    }),
    system:
      'You are a senior software architect planning feature implementations.',
    prompt: `Analyze this feature request and create an implementation plan:
    ${featureRequest}`,
  });

  // Workers: Execute the planned changes
  const fileChanges = await Promise.all(
    implementationPlan.files.map(async file => {
      // Each worker is specialized for the type of change
      const workerSystemPrompt = {
        create:
          'You are an expert at implementing new files following best practices and project patterns.',
        modify:
          'You are an expert at modifying existing code while maintaining consistency and avoiding regressions.',
        delete:
          'You are an expert at safely removing code while ensuring no breaking changes.',
      }[file.changeType];

      const { output: change } = await generateText({
        model: __MODEL__,
        output: Output.object({
          schema: z.object({
            explanation: z.string(),
            code: z.string(),
          }),
        }),
        system: workerSystemPrompt,
        prompt: `Implement the changes for ${file.filePath} to support:
        ${file.purpose}

        Consider the overall feature context:
        ${featureRequest}`,
      });

      return {
        file,
        implementation: change,
      };
    }),
  );

  return {
    plan: implementationPlan,
    changes: fileChanges,
  };
}
```

## Evaluator-Optimizer

Add quality control to workflows with dedicated evaluation steps that assess intermediate results. Based on the evaluation, the workflow proceeds, retries with adjusted parameters, or takes corrective action. This creates robust workflows capable of self-improvement and error recovery.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

async function translateWithFeedback(text: string, targetLanguage: string) {
  let currentTranslation = '';
  let iterations = 0;
  const MAX_ITERATIONS = 3;

  // Initial translation
  const { text: translation } = await generateText({
    model: __MODEL__,
    system: 'You are an expert literary translator.',
    prompt: `Translate this text to ${targetLanguage}, preserving tone and cultural nuances:
    ${text}`,
  });

  currentTranslation = translation;

  // Evaluation-optimization loop
  while (iterations < MAX_ITERATIONS) {
    // Evaluate current translation
    const { output: evaluation } = await generateText({
      model: __MODEL__,
      output: Output.object({
        schema: z.object({
          qualityScore: z.number().min(1).max(10),
          preservesTone: z.boolean(),
          preservesNuance: z.boolean(),
          culturallyAccurate: z.boolean(),
          specificIssues: z.array(z.string()),
          improvementSuggestions: z.array(z.string()),
        }),
      }),
      system: 'You are an expert in evaluating literary translations.',
      prompt: `Evaluate this translation:

      Original: ${text}
      Translation: ${currentTranslation}

      Consider:
      1. Overall quality
      2. Preservation of tone
      3. Preservation of nuance
      4. Cultural accuracy`,
    });

    // Check if quality meets threshold
    if (
      evaluation.qualityScore >= 8 &&
      evaluation.preservesTone &&
      evaluation.preservesNuance &&
      evaluation.culturallyAccurate
    ) {
      break;
    }

    // Generate improved translation based on feedback
    const { text: improvedTranslation } = await generateText({
      model: __MODEL__,
      system: 'You are an expert literary translator.',
      prompt: `Improve this translation based on the following feedback:
      ${evaluation.specificIssues.join('\n')}
      ${evaluation.improvementSuggestions.join('\n')}

      Original: ${text}
      Current Translation: ${currentTranslation}`,
    });

    currentTranslation = improvedTranslation;
    iterations++;
  }

  return {
    finalTranslation: currentTranslation,
    iterationsRequired: iterations,
  };
}
```

---
title: Loop Control
description: Control agent execution with built-in loop management using stopWhen and prepareStep
---

# Loop Control

You can control both the execution flow and the settings at each step of the agent loop. The loop continues until:

- A finish reasoning other than tool-calls is returned, or
- A tool that is invoked does not have an execute function, or
- A tool call needs approval, or
- A stop condition is met

The AI SDK provides built-in loop control through two parameters: `stopWhen` for defining stopping conditions and `prepareStep` for modifying settings (model, tools, messages, and more) between steps.

## Stop Conditions

The `stopWhen` parameter controls when to stop execution when there are tool results in the last step. By default, agents stop after 20 steps using `stepCountIs(20)`. This default is a safety measure to prevent runaway loops that could result in excessive API calls and costs.

When you provide `stopWhen`, the agent continues executing after tool calls until a stopping condition is met. When the condition is an array, execution stops when any of the conditions are met.

### Use Built-in Conditions

The AI SDK provides several built-in stopping conditions:

- `stepCountIs(count)` — stops after a specified number of steps
- `hasToolCall(toolName)` — stops when a specific tool is called
- `isLoopFinished()` — never triggers, letting the loop run until the agent is naturally finished

### Run Up to a Maximum Number of Steps

```ts
import { ToolLoopAgent, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools
  },
  stopWhen: stepCountIs(50), // Increasing the default of 20 to 50.
});

const result = await agent.generate({
  prompt: 'Analyze this dataset and create a summary report',
});
```

### Run Until Finished

If you want the agent to run until the model naturally stops making tool calls, use `isLoopFinished()`. This removes the default step limit:

```ts
import { ToolLoopAgent, isLoopFinished } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools
  },
  stopWhen: isLoopFinished(), // No maximum step limit.
});

const result = await agent.generate({
  prompt: 'Analyze this dataset and create a summary report',
});
```

<Note>
  Use `isLoopFinished()` with caution. Without a step limit, the agent could
  potentially run indefinitely or incur significant costs if the model keeps
  making tool calls.
</Note>

### Combine Multiple Conditions

Combine multiple stopping conditions. The loop stops when it meets any condition:

```ts
import { ToolLoopAgent, stepCountIs, hasToolCall } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools
  },
  stopWhen: [
    stepCountIs(20), // Maximum 20 steps
    hasToolCall('someTool'), // Stop after calling 'someTool'
  ],
});

const result = await agent.generate({
  prompt: 'Research and analyze the topic',
});
```

### Create Custom Conditions

Build custom stopping conditions for specific requirements:

```ts
import { ToolLoopAgent, StopCondition, ToolSet } from 'ai';
__PROVIDER_IMPORT__;

const tools = {
  // your tools
} satisfies ToolSet;

const hasAnswer: StopCondition<typeof tools> = ({ steps }) => {
  // Stop when the model generates text containing "ANSWER:"
  return steps.some(step => step.text?.includes('ANSWER:')) ?? false;
};

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools,
  stopWhen: hasAnswer,
});

const result = await agent.generate({
  prompt: 'Find the answer and respond with "ANSWER: [your answer]"',
});
```

Custom conditions receive step information across all steps:

```ts
const budgetExceeded: StopCondition<typeof tools> = ({ steps }) => {
  const totalUsage = steps.reduce(
    (acc, step) => ({
      inputTokens: acc.inputTokens + (step.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (step.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  const costEstimate =
    (totalUsage.inputTokens * 0.01 + totalUsage.outputTokens * 0.03) / 1000;
  return costEstimate > 0.5; // Stop if cost exceeds $0.50
};
```

## Prepare Step

The `prepareStep` callback runs before each step in the loop and defaults to the initial settings if you don't return any changes. Use it to modify settings, manage context, or implement dynamic behavior based on execution history.

### Dynamic Model Selection

Switch models based on step requirements:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: 'openai/gpt-4o-mini', // Default model
  tools: {
    // your tools
  },
  prepareStep: async ({ stepNumber, messages }) => {
    // Use a stronger model for complex reasoning after initial steps
    if (stepNumber > 2 && messages.length > 10) {
      return {
        model: __MODEL__,
      };
    }
    // Continue with default settings
    return {};
  },
});

const result = await agent.generate({
  prompt: '...',
});
```

### Context Management

Manage growing conversation history in long-running loops:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools
  },
  prepareStep: async ({ messages }) => {
    // Keep only recent messages to stay within context limits
    if (messages.length > 20) {
      return {
        messages: [
          messages[0], // Keep system instructions
          ...messages.slice(-10), // Keep last 10 messages
        ],
      };
    }
    return {};
  },
});

const result = await agent.generate({
  prompt: '...',
});
```

### Tool Selection

Control which tools are available at each step:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    search: searchTool,
    analyze: analyzeTool,
    summarize: summarizeTool,
  },
  prepareStep: async ({ stepNumber, steps }) => {
    // Search phase (steps 0-2)
    if (stepNumber <= 2) {
      return {
        activeTools: ['search'],
        toolChoice: 'required',
      };
    }

    // Analysis phase (steps 3-5)
    if (stepNumber <= 5) {
      return {
        activeTools: ['analyze'],
      };
    }

    // Summary phase (step 6+)
    return {
      activeTools: ['summarize'],
      toolChoice: 'required',
    };
  },
});

const result = await agent.generate({
  prompt: '...',
});
```

You can also force a specific tool to be used:

```ts
prepareStep: async ({ stepNumber }) => {
  if (stepNumber === 0) {
    // Force the search tool to be used first
    return {
      toolChoice: { type: 'tool', toolName: 'search' },
    };
  }

  if (stepNumber === 5) {
    // Force the summarize tool after analysis
    return {
      toolChoice: { type: 'tool', toolName: 'summarize' },
    };
  }

  return {};
};
```

### Message Modification

Transform messages before sending them to the model:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    // your tools
  },
  prepareStep: async ({ messages, stepNumber }) => {
    // Summarize tool results to reduce token usage
    const processedMessages = messages.map(msg => {
      if (msg.role === 'tool' && msg.content.length > 1000) {
        return {
          ...msg,
          content: summarizeToolResult(msg.content),
        };
      }
      return msg;
    });

    return { messages: processedMessages };
  },
});

const result = await agent.generate({
  prompt: '...',
});
```

## Access Step Information

Both `stopWhen` and `prepareStep` receive detailed information about the current execution:

```ts
prepareStep: async ({
  model, // Current model configuration
  stepNumber, // Current step number (0-indexed)
  steps, // All previous steps with their results
  messages, // Messages to be sent to the model
}) => {
  // Access previous tool calls and results
  const previousToolCalls = steps.flatMap(step => step.toolCalls);
  const previousResults = steps.flatMap(step => step.toolResults);

  // Make decisions based on execution history
  if (previousToolCalls.some(call => call.toolName === 'dataAnalysis')) {
    return {
      toolChoice: { type: 'tool', toolName: 'reportGenerator' },
    };
  }

  return {};
},
```

## Forced Tool Calling

You can force the agent to always use tools by combining `toolChoice: 'required'` with a `done` tool that has no `execute` function. This pattern ensures the agent uses tools for every step and stops only when it explicitly signals completion.

```ts
import { ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';
__PROVIDER_IMPORT__;

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: {
    search: searchTool,
    analyze: analyzeTool,
    done: tool({
      description: 'Signal that you have finished your work',
      inputSchema: z.object({
        answer: z.string().describe('The final answer'),
      }),
      // No execute function - stops the agent when called
    }),
  },
  toolChoice: 'required', // Force tool calls at every step
});

const result = await agent.generate({
  prompt: 'Research and analyze this topic, then provide your answer.',
});

// extract answer from done tool call
const toolCall = result.staticToolCalls[0]; // tool call from final step
if (toolCall?.toolName === 'done') {
  console.log(toolCall.input.answer);
}
```

Key aspects of this pattern:

- **`toolChoice: 'required'`**: Forces the model to call a tool at every step instead of generating text directly. This ensures the agent follows a structured workflow.
- **`done` tool without `execute`**: A tool that has no `execute` function acts as a termination signal. When the agent calls this tool, the loop stops because there's no function to execute.
- **Accessing results**: The final answer is available in `result.staticToolCalls`, which contains tool calls that weren't executed.

This pattern is useful when you want the agent to always use specific tools for operations (like code execution or data retrieval) rather than attempting to answer directly.

## Manual Loop Control

For scenarios requiring complete control over the agent loop, you can use AI SDK Core functions (`generateText` and `streamText`) to implement your own loop management instead of using `stopWhen` and `prepareStep`. This approach provides maximum flexibility for complex workflows.

### Implementing a Manual Loop

Build your own agent loop when you need full control over execution:

```ts
import { generateText, ModelMessage } from 'ai';
__PROVIDER_IMPORT__;

const messages: ModelMessage[] = [{ role: 'user', content: '...' }];

let step = 0;
const maxSteps = 10;

while (step < maxSteps) {
  const result = await generateText({
    model: __MODEL__,
    messages,
    tools: {
      // your tools here
    },
  });

  messages.push(...result.response.messages);

  if (result.text) {
    break; // Stop when model generates text
  }

  step++;
}
```

This manual approach gives you complete control over:

- Message history management
- Step-by-step decision making
- Custom stopping conditions
- Dynamic tool and model selection
- Error handling and recovery

[Learn more about manual agent loops in the cookbook](/cookbook/node/manual-agent-loop).

---
title: Configuring Call Options
description: Pass type-safe runtime inputs to dynamically configure agent behavior.
---

# Configuring Call Options

Call options allow you to pass type-safe structured inputs to your agent. Use them to dynamically modify any agent setting based on the specific request.

## Why Use Call Options?

When you need agent behavior to change based on runtime context:

- **Add dynamic context** - Inject retrieved documents, user preferences, or session data into prompts
- **Select models dynamically** - Choose faster or more capable models based on request complexity
- **Configure tools per request** - Pass user location to search tools or adjust tool behavior
- **Customize provider options** - Set reasoning effort, temperature, or other provider-specific settings

Without call options, you'd need to create multiple agents or handle configuration logic outside the agent.

## How It Works

Define call options in three steps:

1. **Define the schema** - Specify what inputs you accept using `callOptionsSchema`
2. **Configure with `prepareCall`** - Use those inputs to modify agent settings
3. **Pass options at runtime** - Provide the options when calling `generate()` or `stream()`

## Basic Example

Add user context to your agent's prompt at runtime:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const supportAgent = new ToolLoopAgent({
  model: __MODEL__,
  callOptionsSchema: z.object({
    userId: z.string(),
    accountType: z.enum(['free', 'pro', 'enterprise']),
  }),
  instructions: 'You are a helpful customer support agent.',
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    instructions:
      settings.instructions +
      `\nUser context:
- Account type: ${options.accountType}
- User ID: ${options.userId}

Adjust your response based on the user's account level.`,
  }),
});

// Call the agent with specific user context
const result = await supportAgent.generate({
  prompt: 'How do I upgrade my account?',
  options: {
    userId: 'user_123',
    accountType: 'free',
  },
});
```

The `options` parameter is now required and type-checked. If you don't provide it or pass incorrect types, TypeScript will error.

## Modifying Agent Settings

Use `prepareCall` to modify any agent setting. Return only the settings you want to change.

### Dynamic Model Selection

Choose models based on request characteristics:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const agent = new ToolLoopAgent({
  model: __MODEL__, // Default model
  callOptionsSchema: z.object({
    complexity: z.enum(['simple', 'complex']),
  }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    model:
      options.complexity === 'simple' ? 'openai/gpt-4o-mini' : 'openai/o1-mini',
  }),
});

// Use faster model for simple queries
await agent.generate({
  prompt: 'What is 2+2?',
  options: { complexity: 'simple' },
});

// Use more capable model for complex reasoning
await agent.generate({
  prompt: 'Explain quantum entanglement',
  options: { complexity: 'complex' },
});
```

### Dynamic Tool Configuration

Configure tools based on runtime context:

```ts
import { openai } from '@ai-sdk/openai';
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const newsAgent = new ToolLoopAgent({
  model: __MODEL__,
  callOptionsSchema: z.object({
    userCity: z.string().optional(),
    userRegion: z.string().optional(),
  }),
  tools: {
    web_search: openai.tools.webSearch(),
  },
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    tools: {
      web_search: openai.tools.webSearch({
        searchContextSize: 'low',
        userLocation: {
          type: 'approximate',
          city: options.userCity,
          region: options.userRegion,
          country: 'US',
        },
      }),
    },
  }),
});

await newsAgent.generate({
  prompt: 'What are the top local news stories?',
  options: {
    userCity: 'San Francisco',
    userRegion: 'California',
  },
});
```

### Provider-Specific Options

Configure provider settings dynamically:

```ts
import { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { ToolLoopAgent } from 'ai';
import { z } from 'zod';

const agent = new ToolLoopAgent({
  model: 'openai/o3',
  callOptionsSchema: z.object({
    taskDifficulty: z.enum(['low', 'medium', 'high']),
  }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    providerOptions: {
      openai: {
        reasoningEffort: options.taskDifficulty,
      } satisfies OpenAILanguageModelResponsesOptions,
    },
  }),
});

await agent.generate({
  prompt: 'Analyze this complex scenario...',
  options: { taskDifficulty: 'high' },
});
```

## Advanced Patterns

### Retrieval Augmented Generation (RAG)

Fetch relevant context and inject it into your prompt:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const ragAgent = new ToolLoopAgent({
  model: __MODEL__,
  callOptionsSchema: z.object({
    query: z.string(),
  }),
  prepareCall: async ({ options, ...settings }) => {
    // Fetch relevant documents (this can be async)
    const documents = await vectorSearch(options.query);

    return {
      ...settings,
      instructions: `Answer questions using the following context:

${documents.map(doc => doc.content).join('\n\n')}`,
    };
  },
});

await ragAgent.generate({
  prompt: 'What is our refund policy?',
  options: { query: 'refund policy' },
});
```

The `prepareCall` function can be async, enabling you to fetch data before configuring the agent.

### Combining Multiple Modifications

Modify multiple settings together:

```ts
import { ToolLoopAgent } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const agent = new ToolLoopAgent({
  model: __MODEL__,
  callOptionsSchema: z.object({
    userRole: z.enum(['admin', 'user']),
    urgency: z.enum(['low', 'high']),
  }),
  tools: {
    readDatabase: readDatabaseTool,
    writeDatabase: writeDatabaseTool,
  },
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    // Upgrade model for urgent requests
    model: options.urgency === 'high' ? __MODEL__ : settings.model,
    // Limit tools based on user role
    activeTools:
      options.userRole === 'admin'
        ? ['readDatabase', 'writeDatabase']
        : ['readDatabase'],
    // Adjust instructions
    instructions: `You are a ${options.userRole} assistant.
${options.userRole === 'admin' ? 'You have full database access.' : 'You have read-only access.'}`,
  }),
});

await agent.generate({
  prompt: 'Update the user record',
  options: {
    userRole: 'admin',
    urgency: 'high',
  },
});
```

## Using with createAgentUIStreamResponse

Pass call options through API routes to your agent:

```ts filename="app/api/chat/route.ts"
import { createAgentUIStreamResponse } from 'ai';
import { myAgent } from '@/ai/agents/my-agent';

export async function POST(request: Request) {
  const { messages, userId, accountType } = await request.json();

  return createAgentUIStreamResponse({
    agent: myAgent,
    messages,
    options: {
      userId,
      accountType,
    },
  });
}
```

## Next Steps

- Learn about [loop control](/docs/agents/loop-control) for execution management
- Explore [workflow patterns](/docs/agents/workflows) for complex multi-step processes

---
title: Memory
description: Add persistent memory to your agent using provider-defined tools, memory providers, or a custom tool.
---

# Memory

Memory lets your agent save information and recall it later. Without memory, every conversation starts fresh. With memory, your agent builds context over time, recalls previous interactions, and adapts to the user.

## Three Approaches

You can add memory to your agent with the AI SDK in three ways, each with different tradeoffs:

| Approach                                          | Effort | Flexibility | Provider Lock-in           |
| ------------------------------------------------- | ------ | ----------- | -------------------------- |
| [Provider-Defined Tools](#provider-defined-tools) | Low    | Medium      | Yes                        |
| [Memory Providers](#memory-providers)             | Low    | Low         | Depends on memory provider |
| [Custom Tool](#custom-tool)                       | High   | High        | No                         |

## Provider-Defined Tools

[Provider-defined tools](/docs/foundations/tools#types-of-tools) are tools where the provider specifies the tool's `inputSchema` and `description`, but you provide the `execute` function. The model has been trained to use these tools, which can result in better performance compared to custom tools.

### Anthropic Memory Tool

The [Anthropic Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) gives Claude a structured interface for managing a `/memories` directory. Claude reads its memory before starting tasks, creates and updates files as it works, and references them in future conversations.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent } from 'ai';

const memory = anthropic.tools.memory_20250818({
  execute: async action => {
    // `action` contains `command`, `path`, and other fields
    // depending on the command (view, create, str_replace,
    // insert, delete, rename).
    // Implement your storage backend here.
    // Return the result as a string.
  },
});

const agent = new ToolLoopAgent({
  model: 'anthropic/claude-haiku-4.5',
  tools: { memory },
});

const result = await agent.generate({
  prompt: 'Remember that my favorite editor is Neovim',
});
```

The tool receives structured commands (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`), each with a `path` scoped to `/memories`. Your `execute` function maps these to your storage backend (the filesystem, a database, or any other persistence layer).

**When to use this**: you want memory with minimal implementation effort and are already using Anthropic models. The tradeoff is provider lock-in, since this tool only works with Claude.

## Memory Providers

Another approach is to use a provider that has memory built in. These providers wrap an external memory service and expose it through the AI SDK's standard interface. Memory storage, retrieval, and injection happen transparently, and you do not define any tools yourself.

### Letta

[Letta](https://letta.com) provides agents with persistent long-term memory. You create an agent on Letta's platform (cloud or self-hosted), configure its memory there, and use the AI SDK provider to interact with it. Letta's agent runtime handles memory management (core memory, archival memory, recall).

```bash
pnpm add @letta-ai/vercel-ai-sdk-provider
```

```ts
import { lettaCloud } from '@letta-ai/vercel-ai-sdk-provider';
import { ToolLoopAgent } from 'ai';

const agent = new ToolLoopAgent({
  model: lettaCloud(),
  providerOptions: {
    letta: {
      agent: { id: 'your-agent-id' },
    },
  },
});

const result = await agent.generate({
  prompt: 'Remember that my favorite editor is Neovim',
});
```

You can also use Letta's built-in memory tools alongside custom tools:

```ts
import { lettaCloud } from '@letta-ai/vercel-ai-sdk-provider';
import { ToolLoopAgent } from 'ai';

const agent = new ToolLoopAgent({
  model: lettaCloud(),
  tools: {
    core_memory_append: lettaCloud.tool('core_memory_append'),
    memory_insert: lettaCloud.tool('memory_insert'),
    memory_replace: lettaCloud.tool('memory_replace'),
  },
  providerOptions: {
    letta: {
      agent: { id: 'your-agent-id' },
    },
  },
});

const stream = agent.stream({
  prompt: 'What do you remember about me?',
});
```

See the [Letta provider documentation](/providers/community-providers/letta) for full setup and configuration.

### Mem0

[Mem0](https://mem0.ai) adds a memory layer on top of any supported LLM provider. It automatically extracts memories from conversations, stores them, and retrieves relevant ones for future prompts.

```bash
pnpm add @mem0/vercel-ai-provider
```

```ts
import { createMem0 } from '@mem0/vercel-ai-provider';
import { ToolLoopAgent } from 'ai';

const mem0 = createMem0({
  provider: 'openai',
  mem0ApiKey: process.env.MEM0_API_KEY,
  apiKey: process.env.OPENAI_API_KEY,
});

const agent = new ToolLoopAgent({
  model: mem0('gpt-4.1', { user_id: 'user-123' }),
});

const { text } = await agent.generate({
  prompt: 'Remember that my favorite editor is Neovim',
});
```

Mem0 works across multiple LLM providers (OpenAI, Anthropic, Google, Groq, Cohere). You can also manage memories explicitly:

```ts
import { addMemories, retrieveMemories } from '@mem0/vercel-ai-provider';

await addMemories(messages, { user_id: 'user-123' });
const context = await retrieveMemories(prompt, { user_id: 'user-123' });
```

See the [Mem0 provider documentation](/providers/community-providers/mem0) for full setup and configuration.

### Supermemory

[Supermemory](https://supermemory.ai) is a long-term memory platform that adds persistent, self-growing memory to your AI applications. It provides tools that handle saving and retrieving memories automatically through semantic search.

```bash
pnpm add @supermemory/tools
```

```ts
__PROVIDER_IMPORT__;
import { supermemoryTools } from '@supermemory/tools/ai-sdk';
import { ToolLoopAgent } from 'ai';

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: supermemoryTools(process.env.SUPERMEMORY_API_KEY!),
});

const result = await agent.generate({
  prompt: 'Remember that my favorite editor is Neovim',
});
```

Supermemory works with any AI SDK provider. The tools give the model `addMemory` and `searchMemories` operations that handle storage and retrieval.

See the [Supermemory provider documentation](/providers/community-providers/supermemory) for full setup and configuration.

### Hindsight

[Hindsight](/providers/community-providers/hindsight) provides agents with persistent memory through five tools: `retain`, `recall`, `reflect`, `getMentalModel`, and `getDocument`. It can be self-hosted with Docker or used as a cloud service.

```bash
pnpm add @vectorize-io/hindsight-ai-sdk @vectorize-io/hindsight-client
```

```ts
__PROVIDER_IMPORT__;
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { createHindsightTools } from '@vectorize-io/hindsight-ai-sdk';
import { ToolLoopAgent } from 'ai';
import { openai } from '@ai-sdk/openai';

const client = new HindsightClient({ baseUrl: process.env.HINDSIGHT_API_URL });

const agent = new ToolLoopAgent({
  model: __MODEL__,
  tools: createHindsightTools({ client, bankId: 'user-123' }),
  instructions: 'You are a helpful assistant with long-term memory.',
});

const result = await agent.generate({
  prompt: 'Remember that my favorite editor is Neovim',
});
```

The `bankId` identifies the memory store and is typically a user ID. In multi-user apps, call `createHindsightTools` inside your request handler so each request gets the right bank. Hindsight works with any AI SDK provider.

See the [Hindsight provider documentation](/providers/community-providers/hindsight) for full setup and configuration.

**When to use memory providers**: these providers are a good fit when you want memory without building any storage infrastructure. The tradeoff is that the provider controls memory behavior, so you have less visibility into what gets stored and how it is retrieved. You also take on a dependency on an external service.

## Custom Tool

Building your own memory tool from scratch is the most flexible approach. You control the storage format, the interface, and the retrieval logic. This requires the most upfront work but gives you full ownership of how memory works, with no provider lock-in and no external dependencies.

There are two common patterns:

- **Structured actions**: you define explicit operations (`view`, `create`, `update`, `search`) and handle structured input yourself. Safe by design since you control every operation.
- **Bash-backed**: you give the model a sandboxed bash environment to compose shell commands (`cat`, `grep`, `sed`, `echo`) for flexible memory access. More powerful but requires command validation for safety.

For a full walkthrough of implementing a custom memory tool with a bash-backed interface, AST-based command validation, and filesystem persistence, see the **[Build a Custom Memory Tool](/cookbook/guides/custom-memory-tool)** recipe.

---
title: Subagents
description: Delegate context-heavy tasks to specialized subagents while keeping the main agent focused.
---

# Subagents

A subagent is an agent that a parent agent can invoke. The parent delegates work via a tool, and the subagent executes autonomously before returning a result.

## How It Works

1. **Define a subagent** with its own model, instructions, and tools
2. **Create a tool that calls it** for the main agent to use
3. **Subagent runs independently with its own context window**
4. **Return a result** (optionally streaming progress to the UI)
5. **Control what the model sees** using `toModelOutput` to summarize

## When to Use Subagents

Subagents add latency and complexity. Use them when the benefits outweigh the costs:

| Use Subagents When                              | Avoid Subagents When           |
| ----------------------------------------------- | ------------------------------ |
| Tasks require exploring large amounts of tokens | Tasks are simple and focused   |
| You need to parallelize independent research    | Sequential processing suffices |
| Context would grow beyond model limits          | Context stays manageable       |
| You want to isolate tool access by capability   | All tools can safely coexist   |

## Why Use Subagents?

### Offloading Context-Heavy Tasks

Some tasks require exploring large amounts of information—reading files, searching codebases, or researching topics. Running these in the main agent consumes context quickly, making the agent less coherent over time.

With subagents, you can:

- Spin up a dedicated agent that uses hundreds of thousands of tokens
- Have it return only a focused summary (perhaps 1,000 tokens)
- Keep your main agent's context clean and coherent

The subagent does the heavy lifting while the main agent stays focused on orchestration.

### Parallelizing Independent Work

For tasks like exploring a codebase, you can spawn multiple subagents to research different areas simultaneously. Each returns a summary, and the main agent synthesizes the findings—without paying the context cost of all that exploration.

### Specialized Orchestration

A less common but valid pattern is using a main agent purely for orchestration, delegating to specialized subagents for different types of work. For example:

- An exploration subagent with read-only tools for researching codebases
- A coding subagent with file editing tools
- An integration subagent with tools for a specific platform or API

This creates a clear separation of concerns, though context offloading and parallelization are the more common motivations for subagents.

## Basic Subagent Without Streaming

The simplest subagent pattern requires no special machinery. Your main agent has a tool that calls another agent in its `execute` function:

```ts
import { ToolLoopAgent, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

// Define a subagent for research tasks
const researchSubagent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a research agent.
Summarize your findings in your final response.`,
  tools: {
    read: readFileTool, // defined elsewhere
    search: searchTool, // defined elsewhere
  },
});

// Create a tool that delegates to the subagent
const researchTool = tool({
  description: 'Research a topic or question in depth.',
  inputSchema: z.object({
    task: z.string().describe('The research task to complete'),
  }),
  execute: async ({ task }, { abortSignal }) => {
    const result = await researchSubagent.generate({
      prompt: task,
      abortSignal,
    });
    return result.text;
  },
});

// Main agent uses the research tool
const mainAgent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: 'You are a helpful assistant that can delegate research tasks.',
  tools: {
    research: researchTool,
  },
});
```

This works well when you don't need to show the subagent's progress in the UI. The tool call blocks until the subagent completes, then returns the final text response.

### Handling Cancellation

When the user cancels a request, the `abortSignal` propagates to the subagent. Always pass it through to ensure cleanup:

```ts
execute: async ({ task }, { abortSignal }) => {
  const result = await researchSubagent.generate({
    prompt: task,
    abortSignal, // Cancels subagent if main request is aborted
  });
  return result.text;
},
```

If you abort the signal, the subagent stops executing and throws an `AbortError`. The main agent's tool execution fails, which stops the main loop.

To avoid errors about incomplete tool calls in subsequent messages, use `convertToModelMessages` with `ignoreIncompleteToolCalls`:

```ts
import { convertToModelMessages } from 'ai';

const modelMessages = await convertToModelMessages(messages, {
  ignoreIncompleteToolCalls: true,
});
```

This filters out tool calls that don't have corresponding results. Learn more in the [convertToModelMessages](/docs/reference/ai-sdk-ui/convert-to-model-messages) reference.

## Streaming Subagent Progress

When you want to show incremental progress as the subagent works, use [**preliminary tool results**](/docs/ai-sdk-core/tools-and-tool-calling#preliminary-tool-results). This pattern uses a generator function that yields partial updates to the UI.

### How Preliminary Tool Results Work

Change your `execute` function from a regular function to an async generator (`async function*`). Each `yield` sends a preliminary result to the frontend:

```ts
execute: async function* ({ /* input */ }) {
  // ... do work ...
  yield partialResult;
  // ... do more work ...
  yield updatedResult;
}
```

### Building the Complete Message

Each `yield` **replaces** the previous output entirely (it does not append). This means you need a way to accumulate the subagent's response into a complete message that grows over time.

The `readUIMessageStream` utility handles this. It reads each chunk from the stream and builds an ever-growing `UIMessage` containing all parts received so far:

```ts
import { readUIMessageStream, tool } from 'ai';
import { z } from 'zod';

const researchTool = tool({
  description: 'Research a topic or question in depth.',
  inputSchema: z.object({
    task: z.string().describe('The research task to complete'),
  }),
  execute: async function* ({ task }, { abortSignal }) {
    // Start the subagent with streaming
    const result = await researchSubagent.stream({
      prompt: task,
      abortSignal,
    });

    // Each iteration yields a complete, accumulated UIMessage
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream(),
    })) {
      yield message;
    }
  },
});
```

Each yielded `message` is a complete `UIMessage` containing all the subagent's parts up to that point (text, tool calls, and tool results). The frontend simply replaces its display with each new message.

## Controlling What the Model Sees

Here's where subagents become powerful for context management. The full `UIMessage` with all the subagent's work is stored in the message history and displayed in the UI. But you can control what the main agent's model actually sees using `toModelOutput`.

### How It Works

The `toModelOutput` function maps the tool's output to the tokens sent to the model:

```ts
const researchTool = tool({
  description: 'Research a topic or question in depth.',
  inputSchema: z.object({
    task: z.string().describe('The research task to complete'),
  }),
  execute: async function* ({ task }, { abortSignal }) {
    const result = await researchSubagent.stream({
      prompt: task,
      abortSignal,
    });

    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream(),
    })) {
      yield message;
    }
  },
  toModelOutput: ({ output: message }) => {
    // Extract just the final text as a summary
    const lastTextPart = message?.parts.findLast(p => p.type === 'text');
    return {
      type: 'text',
      value: lastTextPart?.text ?? 'Task completed.',
    };
  },
});
```

With this setup:

- **Users see**: The full subagent execution—every tool call, every intermediate step
- **The model sees**: Just the final summary text

The subagent might use 100,000 tokens exploring and reasoning, but the main agent only consumes the summary. This keeps the main agent coherent and focused.

### Write Subagent Instructions for Summarization

For `toModelOutput` to extract a useful summary, your subagent must produce one. Add explicit instructions like this:

```ts
const researchSubagent = new ToolLoopAgent({
  model: __MODEL__,
  instructions: `You are a research agent. Complete the task autonomously.

IMPORTANT: When you have finished, write a clear summary of your findings as your final response.
This summary will be returned to the main agent, so include all relevant information.`,
  tools: {
    read: readFileTool,
    search: searchTool,
  },
});
```

Without this instruction, the subagent might not produce a comprehensive summary. It could simply say "Done", leaving `toModelOutput` with nothing useful to extract.

## Rendering Subagents in the UI (with useChat)

To display streaming progress, check the tool part's `state` and `preliminary` flag.

### Tool Part States

| State              | Description                                |
| ------------------ | ------------------------------------------ |
| `input-streaming`  | Tool input being generated                 |
| `input-available`  | Tool ready to execute                      |
| `output-available` | Tool produced output (check `preliminary`) |
| `output-error`     | Tool execution failed                      |

### Detecting Streaming vs Complete

```tsx
const hasOutput = part.state === 'output-available';
const isStreaming = hasOutput && part.preliminary === true;
const isComplete = hasOutput && !part.preliminary;
```

### Type Safety for Subagent Output

Export types alongside your agents for use in UI components:

```ts filename="lib/agents.ts"
import { ToolLoopAgent, InferAgentUIMessage } from 'ai';

export const mainAgent = new ToolLoopAgent({
  // ... configuration with researchTool
});

// Export the main agent message type for the chat UI
export type MainAgentMessage = InferAgentUIMessage<typeof mainAgent>;
```

### Render Messages and Subagent Output

This example uses the types defined above to render both the main agent's messages and the subagent's streamed output:

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import type { MainAgentMessage } from '@/lib/agents';

export function Chat() {
  const { messages } = useChat<MainAgentMessage>();

  return (
    <div>
      {messages.map(message =>
        message.parts.map((part, i) => {
          switch (part.type) {
            case 'text':
              return <p key={i}>{part.text}</p>;
            case 'tool-research':
              return (
                <div>
                  {part.state !== 'input-streaming' && (
                    <div>Research: {part.input.task}</div>
                  )}
                  {part.state === 'output-available' && (
                    <div>
                      {part.output.parts.map((nestedPart, i) => {
                        switch (nestedPart.type) {
                          case 'text':
                            return <p key={i}>{nestedPart.text}</p>;
                          default:
                            return null;
                        }
                      })}
                    </div>
                  )}
                </div>
              );
            default:
              return null;
          }
        }),
      )}
    </div>
  );
}
```

## Caveats

### No Tool Approvals in Subagents

Subagent tools cannot use `needsApproval`. All tools must execute automatically without user confirmation.

### Subagent Context is Isolated

Each subagent invocation starts with a fresh context window. This is one of the key benefits of subagents: they don't inherit the accumulated context from the main agent, which is exactly what allows them to do heavy exploration without bloating the main conversation.

If you need to give a subagent access to the conversation history, the `messages` are available in the tool's execute function alongside `abortSignal`:

```ts
execute: async ({ task }, { abortSignal, messages }) => {
  const result = await researchSubagent.generate({
    messages: [
      ...messages, // The main agent's conversation history
      { role: 'user', content: task }, // The specific task for this invocation
    ],
    abortSignal,
  });
  return result.text;
},
```

Use this sparingly since passing full history defeats some of the context isolation benefits.

### Streaming Adds Complexity

The basic pattern (no streaming) is simpler to implement and debug. Only add streaming when you need to show real-time progress in the UI.

---
title: Agents
description: An overview of building agents with the AI SDK.
---

# Agents

The following section shows you how to build agents with the AI SDK - systems where large language models (LLMs) use tools in a loop to accomplish tasks.

<IndexCards
  cards={[
    {
      title: 'Overview',
      description: 'Learn what agents are and why to use the ToolLoopAgent.',
      href: '/docs/agents/overview',
    },
    {
      title: 'Building Agents',
      description: 'Complete guide to creating agents with the ToolLoopAgent.',
      href: '/docs/agents/building-agents',
    },
    {
      title: 'Workflow Patterns',
      description:
        'Structured patterns using core functions for complex workflows.',
      href: '/docs/agents/workflows',
    },
    {
      title: 'Loop Control',
      description: 'Advanced execution control with stopWhen and prepareStep.',
      href: '/docs/agents/loop-control',
    },
    {
      title: 'Configuring Call Options',
      description:
        'Pass type-safe runtime inputs to dynamically configure agent behavior.',
      href: '/docs/agents/configuring-call-options',
    },
    {
      title: 'Subagents',
      description:
        'Delegate context-heavy tasks to specialized subagents while keeping the main agent focused.',
      href: '/docs/agents/subagents',
    },
  ]}
/>

---
title: Overview
description: An overview of AI SDK Core.
---

# AI SDK Core

Large Language Models (LLMs) are advanced programs that can understand, create, and engage with human language on a large scale.
They are trained on vast amounts of written material to recognize patterns in language and predict what might come next in a given piece of text.

AI SDK Core **simplifies working with LLMs by offering a standardized way of integrating them into your app** - so you can focus on building great AI applications for your users, not waste time on technical details.

For example, here’s how you can generate text with various models using the AI SDK:

<PreviewSwitchProviders />

## AI SDK Core Functions

AI SDK Core has various functions designed for [text generation](./generating-text), [structured data generation](./generating-structured-data), and [tool usage](./tools-and-tool-calling).
These functions take a standardized approach to setting up [prompts](./prompts) and [settings](./settings), making it easier to work with different models.

- [`generateText`](/docs/ai-sdk-core/generating-text): Generates text and [tool calls](./tools-and-tool-calling).
  This function is ideal for non-interactive use cases such as automation tasks where you need to write text (e.g. drafting email or summarizing web pages) and for agents that use tools.
- [`streamText`](/docs/ai-sdk-core/generating-text): Stream text and tool calls.
  You can use the `streamText` function for interactive use cases such as [chat bots](/docs/ai-sdk-ui/chatbot) and [content streaming](/docs/ai-sdk-ui/completion).

Both `generateText` and `streamText` support [structured output](/docs/ai-sdk-core/generating-structured-data) via the `output` property (e.g. `Output.object()`, `Output.array()`), allowing you to generate typed, schema-validated data for information extraction, synthetic data generation, classification tasks, and [streaming generated UIs](/docs/ai-sdk-ui/object-generation).

## API Reference

Please check out the [AI SDK Core API Reference](/docs/reference/ai-sdk-core) for more details on each function.

---
title: Generating Text
description: Learn how to generate text with the AI SDK.
---

# Generating and Streaming Text

Large language models (LLMs) can generate text in response to a prompt, which can contain instructions and information to process.
For example, you can ask a model to come up with a recipe, draft an email, or summarize a document.

The AI SDK Core provides two functions to generate text and stream it from LLMs:

- [`generateText`](#generatetext): Generates text for a given prompt and model.
- [`streamText`](#streamtext): Streams text from a given prompt and model.

Advanced LLM features such as [tool calling](./tools-and-tool-calling) and [structured data generation](./generating-structured-data) are built on top of text generation.

## `generateText`

You can generate text using the [`generateText`](/docs/reference/ai-sdk-core/generate-text) function. This function is ideal for non-interactive use cases where you need to write text (e.g. drafting email or summarizing web pages) and for agents that use tools.

```tsx
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const { text } = await generateText({
  model: __MODEL__,
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can use more [advanced prompts](./prompts) to generate text with more complex instructions and content:

```tsx
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const { text } = await generateText({
  model: __MODEL__,
  system:
    'You are a professional writer. ' +
    'You write simple, clear, and concise content.',
  prompt: `Summarize the following article in 3-5 sentences: ${article}`,
});
```

The result object of `generateText` contains several promises that resolve when all required data is available:

- `result.content`: The content that was generated in the last step.
- `result.text`: The generated text.
- `result.reasoning`: The full reasoning that the model has generated in the last step.
- `result.reasoningText`: The reasoning text of the model (only available for some models).
- `result.files`: The files that were generated in the last step.
- `result.sources`: Sources that have been used as references in the last step (only available for some models).
- `result.toolCalls`: The tool calls that were made in the last step.
- `result.toolResults`: The results of the tool calls from the last step.
- `result.finishReason`: The reason the model finished generating text.
- `result.rawFinishReason`: The raw reason why the generation finished (from the provider).
- `result.usage`: The usage of the model during the final step of text generation.
- `result.totalUsage`: The total usage across all steps (for multi-step generations).
- `result.warnings`: Warnings from the model provider (e.g. unsupported settings).
- `result.request`: Additional request information.
- `result.response`: Additional response information, including response messages and body.
- `result.providerMetadata`: Additional provider-specific metadata.
- `result.steps`: Details for all steps, useful for getting information about intermediate steps.
- `result.output`: The generated structured output using the `output` specification.

### Accessing response headers & body

Sometimes you need access to the full response from the model provider,
e.g. to access some provider-specific headers or body content.

You can access the raw response headers and body using the `response` property:

```ts
import { generateText } from 'ai';

const result = await generateText({
  // ...
});

console.log(JSON.stringify(result.response.headers, null, 2));
console.log(JSON.stringify(result.response.body, null, 2));
```

### `onFinish` callback

When using `generateText`, you can provide an `onFinish` callback that is triggered after the last step is finished (
[API Reference](/docs/reference/ai-sdk-core/generate-text#on-finish)
).
It contains the text, usage information, finish reason, messages, steps, total usage, and more:

```tsx highlight="6-8"
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  onFinish({ text, finishReason, usage, response, steps, totalUsage }) {
    // your own logic, e.g. for saving the chat history or recording usage

    const messages = response.messages; // messages that were generated
  },
});
```

### Lifecycle callbacks (experimental)

<Note type="warning">
  Experimental callbacks are subject to breaking changes in incremental package
  releases.
</Note>

`generateText` provides several experimental lifecycle callbacks that let you hook into different phases of the generation process.
These are useful for logging, observability, debugging, and custom telemetry.
Errors thrown inside these callbacks are silently caught and do not break the generation flow.

```tsx
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  prompt: 'What is the weather in San Francisco?',
  tools: {
    // ... your tools
  },

  experimental_onStart({ model, settings, functionId }) {
    console.log('Generation started', { model, functionId });
  },

  experimental_onStepStart({ stepNumber, model, promptMessages }) {
    console.log(`Step ${stepNumber} starting`, { model: model.modelId });
  },

  experimental_onToolCallStart({ toolName, toolCallId, input }) {
    console.log(`Tool call starting: ${toolName}`, { toolCallId });
  },

  experimental_onToolCallFinish({ toolName, durationMs, error }) {
    console.log(`Tool call finished: ${toolName} (${durationMs}ms)`, {
      success: !error,
    });
  },

  onStepFinish({ stepNumber, finishReason, usage }) {
    console.log(`Step ${stepNumber} finished`, { finishReason, usage });
  },
});
```

The available lifecycle callbacks are:

- **`experimental_onStart`**: Called once when the `generateText` operation begins, before any LLM calls. Receives model info, prompt, settings, and telemetry metadata.
- **`experimental_onStepStart`**: Called before each step (LLM call). Receives the step number, model, prompt messages being sent, tools, and prior steps.
- **`experimental_onToolCallStart`**: Called right before a tool's `execute` function runs. Receives the tool name, call ID, and input.
- **`experimental_onToolCallFinish`**: Called right after a tool's `execute` function completes or errors. Receives the tool name, call ID, input, output (or undefined on error), error (or undefined on success), and `durationMs`.
- **`onStepFinish`**: Called after each step finishes. Now also includes `stepNumber` (zero-based index of the completed step).

## `streamText`

Depending on your model and prompt, it can take a large language model (LLM) up to a minute to finish generating its response. This delay can be unacceptable for interactive use cases such as chatbots or real-time applications, where users expect immediate responses.

AI SDK Core provides the [`streamText`](/docs/reference/ai-sdk-core/stream-text) function which simplifies streaming text from LLMs:

```ts
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = streamText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
});

// example: use textStream as an async iterable
for await (const textPart of result.textStream) {
  console.log(textPart);
}
```

<Note>
  `result.textStream` is both a `ReadableStream` and an `AsyncIterable`.
</Note>

<Note type="warning">
  `streamText` immediately starts streaming and suppresses errors to prevent
  server crashes. Use the `onError` callback to log errors.
</Note>

You can use `streamText` on its own or in combination with [AI SDK
UI](/examples/next-pages/basics/streaming-text-generation) and [AI SDK
RSC](/examples/next-app/basics/streaming-text-generation).
The result object contains several helper functions to make the integration into [AI SDK UI](/docs/ai-sdk-ui) easier:

- `result.toUIMessageStreamResponse()`: Creates a UI Message stream HTTP response (with tool calls etc.) that can be used in a Next.js App Router API route.
- `result.pipeUIMessageStreamToResponse()`: Writes UI Message stream delta output to a Node.js response-like object.
- `result.toTextStreamResponse()`: Creates a simple text stream HTTP response.
- `result.pipeTextStreamToResponse()`: Writes text delta output to a Node.js response-like object.

<Note>
  `streamText` is using backpressure and only generates tokens as they are
  requested. You need to consume the stream in order for it to finish.
</Note>

It also provides several promises that resolve when the stream is finished:

- `result.content`: The content that was generated in the last step.
- `result.text`: The generated text.
- `result.reasoning`: The full reasoning that the model has generated.
- `result.reasoningText`: The reasoning text of the model (only available for some models).
- `result.files`: Files that have been generated by the model in the last step.
- `result.sources`: Sources that have been used as references in the last step (only available for some models).
- `result.toolCalls`: The tool calls that have been executed in the last step.
- `result.toolResults`: The tool results that have been generated in the last step.
- `result.finishReason`: The reason the model finished generating text.
- `result.rawFinishReason`: The raw reason why the generation finished (from the provider).
- `result.usage`: The usage of the model during the final step of text generation.
- `result.totalUsage`: The total usage across all steps (for multi-step generations).
- `result.warnings`: Warnings from the model provider (e.g. unsupported settings).
- `result.steps`: Details for all steps, useful for getting information about intermediate steps.
- `result.request`: Additional request information from the last step.
- `result.response`: Additional response information from the last step.
- `result.providerMetadata`: Additional provider-specific metadata from the last step.

### `onError` callback

`streamText` immediately starts streaming to enable sending data without waiting for the model.
Errors become part of the stream and are not thrown to prevent e.g. servers from crashing.

To log errors, you can provide an `onError` callback that is triggered when an error occurs.

```tsx highlight="6-8"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = streamText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  onError({ error }) {
    console.error(error); // your error logging logic here
  },
});
```

### `onChunk` callback

When using `streamText`, you can provide an `onChunk` callback that is triggered for each chunk of the stream.

It receives the following chunk types:

- `text`
- `reasoning`
- `source`
- `tool-call`
- `tool-input-start`
- `tool-input-delta`
- `tool-result`
- `raw`

```tsx highlight="6-11"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = streamText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  onChunk({ chunk }) {
    // implement your own logic here, e.g.:
    if (chunk.type === 'text') {
      console.log(chunk.text);
    }
  },
});
```

### `onFinish` callback

When using `streamText`, you can provide an `onFinish` callback that is triggered when the stream is finished (
[API Reference](/docs/reference/ai-sdk-core/stream-text#on-finish)
).
It contains the text, usage information, finish reason, messages, steps, total usage, and more:

```tsx highlight="6-8"
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = streamText({
  model: __MODEL__,
  prompt: 'Invent a new holiday and describe its traditions.',
  onFinish({ text, finishReason, usage, response, steps, totalUsage }) {
    // your own logic, e.g. for saving the chat history or recording usage

    const messages = response.messages; // messages that were generated
  },
});
```

### Lifecycle callbacks (experimental)

<Note type="warning">
  Experimental callbacks are subject to breaking changes in incremental package
  releases.
</Note>

`streamText` provides several experimental lifecycle callbacks that let you hook into different phases of the streaming process.
These are useful for logging, observability, debugging, and custom telemetry.
Errors thrown inside these callbacks are silently caught and do not break the streaming flow.

```tsx
import { streamText } from 'ai';
__PROVIDER_IMPORT__;

const result = streamText({
  model: __MODEL__,
  prompt: 'What is the weather in San Francisco?',
  tools: {
    // ... your tools
  },

  experimental_onStart({ model, system, prompt, messages }) {
    console.log('Streaming started', { model, prompt });
  },

  experimental_onStepStart({ stepNumber, model, messages }) {
    console.log(`Step ${stepNumber} starting`, { model: model.modelId });
  },

  experimental_onToolCallStart({ toolCall }) {
    console.log(`Tool call starting: ${toolCall.toolName}`, {
      toolCallId: toolCall.toolCallId,
    });
  },

  experimental_onToolCallFinish({ toolCall, durationMs, success, error }) {
    console.log(`Tool call finished: ${toolCall.toolName} (${durationMs}ms)`, {
      success,
    });
  },

  onStepFinish({ finishReason, usage }) {
    console.log('Step finished', { finishReason, usage });
  },
});
```

The available lifecycle callbacks are:

- **`experimental_onStart`**: Called once when the `streamText` operation begins, before any LLM calls. Receives model info, prompt, settings, and telemetry metadata.
- **`experimental_onStepStart`**: Called before each step (LLM call). Receives the step number, model, messages being sent, tools, and prior steps.
- **`experimental_onToolCallStart`**: Called right before a tool's `execute` function runs. Receives the tool call object, messages, and context.
- **`experimental_onToolCallFinish`**: Called right after a tool's `execute` function completes or errors. Receives the tool call object, `durationMs`, and a discriminated union with `success`/`output` or `success`/`error`.
- **`onStepFinish`**: Called after each step finishes. Receives the finish reason, usage, and other step details.

### `fullStream` property

You can read a stream with all events using the `fullStream` property.
This can be useful if you want to implement your own UI or handle the stream in a different way.
Here is an example of how to use the `fullStream` property:

```tsx
import { streamText } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const result = streamText({
  model: __MODEL__,
  tools: {
    cityAttractions: {
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({
        attractions: ['attraction1', 'attraction2', 'attraction3'],
      }),
    },
  },
  prompt: 'What are some San Francisco tourist attractions?',
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'start': {
      // handle start of stream
      break;
    }
    case 'start-step': {
      // handle start of step
      break;
    }
    case 'text-start': {
      // handle text start
      break;
    }
    case 'text-delta': {
      // handle text delta here
      break;
    }
    case 'text-end': {
      // handle text end
      break;
    }
    case 'reasoning-start': {
      // handle reasoning start
      break;
    }
    case 'reasoning-delta': {
      // handle reasoning delta here
      break;
    }
    case 'reasoning-end': {
      // handle reasoning end
      break;
    }
    case 'source': {
      // handle source here
      break;
    }
    case 'file': {
      // handle file here
      break;
    }
    case 'tool-call': {
      switch (part.toolName) {
        case 'cityAttractions': {
          // handle tool call here
          break;
        }
      }
      break;
    }
    case 'tool-input-start': {
      // handle tool input start
      break;
    }
    case 'tool-input-delta': {
      // handle tool input delta
      break;
    }
    case 'tool-input-end': {
      // handle tool input end
      break;
    }
    case 'tool-result': {
      switch (part.toolName) {
        case 'cityAttractions': {
          // handle tool result here
          break;
        }
      }
      break;
    }
    case 'tool-error': {
      // handle tool error
      break;
    }
    case 'finish-step': {
      // handle finish step
      break;
    }
    case 'finish': {
      // handle finish here
      break;
    }
    case 'error': {
      // handle error here
      break;
    }
    case 'raw': {
      // handle raw value
      break;
    }
  }
}
```

### Stream transformation

You can use the `experimental_transform` option to transform the stream.
This is useful for e.g. filtering, changing, or smoothing the text stream.

The transformations are applied before the callbacks are invoked and the promises are resolved.
If you e.g. have a transformation that changes all text to uppercase, the `onFinish` callback will receive the transformed text.

#### Smoothing streams

The AI SDK Core provides a [`smoothStream` function](/docs/reference/ai-sdk-core/smooth-stream) that
can be used to smooth out text and reasoning streaming.

```tsx highlight="6"
import { smoothStream, streamText } from 'ai';

const result = streamText({
  model,
  prompt,
  experimental_transform: smoothStream(),
});
```

#### Custom transformations

You can also implement your own custom transformations.
The transformation function receives the tools that are available to the model,
and returns a function that is used to transform the stream.
Tools can either be generic or limited to the tools that you are using.

Here is an example of how to implement a custom transformation that converts
all text to uppercase:

```ts
import { streamText, type TextStreamPart, type ToolSet } from 'ai';

const upperCaseTransform =
  <TOOLS extends ToolSet>() =>
  (options: { tools: TOOLS; stopStream: () => void }) =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        controller.enqueue(
          // for text-delta chunks, convert the text to uppercase:
          chunk.type === 'text-delta'
            ? { ...chunk, text: chunk.text.toUpperCase() }
            : chunk,
        );
      },
    });
```

You can also stop the stream using the `stopStream` function.
This is e.g. useful if you want to stop the stream when model guardrails are violated, e.g. by generating inappropriate content.

When you invoke `stopStream`, it is important to simulate the `finish-step` and `finish` events to guarantee that a well-formed stream is returned
and all callbacks are invoked.

```ts
import { streamText, type TextStreamPart, type ToolSet } from 'ai';

const stopWordTransform =
  <TOOLS extends ToolSet>() =>
  ({ stopStream }: { stopStream: () => void }) =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      // note: this is a simplified transformation for testing;
      // in a real-world version more there would need to be
      // stream buffering and scanning to correctly emit prior text
      // and to detect all STOP occurrences.
      transform(chunk, controller) {
        if (chunk.type !== 'text-delta') {
          controller.enqueue(chunk);
          return;
        }

        if (chunk.text.includes('STOP')) {
          // stop the stream
          stopStream();

          // simulate the finish-step event
          controller.enqueue({
            type: 'finish-step',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            usage: {
              completionTokens: NaN,
              promptTokens: NaN,
              totalTokens: NaN,
            },
            response: {
              id: 'response-id',
              modelId: 'mock-model-id',
              timestamp: new Date(0),
            },
            providerMetadata: undefined,
          });

          // simulate the finish event
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: {
              completionTokens: NaN,
              promptTokens: NaN,
              totalTokens: NaN,
            },
          });

          return;
        }

        controller.enqueue(chunk);
      },
    });
```

#### Multiple transformations

You can also provide multiple transformations. They are applied in the order they are provided.

```tsx highlight="4"
const result = streamText({
  model,
  prompt,
  experimental_transform: [firstTransform, secondTransform],
});
```

## Sources

Some providers such as [Perplexity](/providers/ai-sdk-providers/perplexity#sources) and
[Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#sources) include sources in the response.

Currently sources are limited to web pages that ground the response.
You can access them using the `sources` property of the result.

Each `url` source contains the following properties:

- `id`: The ID of the source.
- `url`: The URL of the source.
- `title`: The optional title of the source.
- `providerMetadata`: Provider metadata for the source.

When you use `generateText`, you can access the sources using the `sources` property:

```ts
const result = await generateText({
  model: 'google/gemini-2.5-flash',
  tools: {
    google_search: google.tools.googleSearch({}),
  },
  prompt: 'List the top 5 San Francisco news from the past week.',
});

for (const source of result.sources) {
  if (source.sourceType === 'url') {
    console.log('ID:', source.id);
    console.log('Title:', source.title);
    console.log('URL:', source.url);
    console.log('Provider metadata:', source.providerMetadata);
    console.log();
  }
}
```

When you use `streamText`, you can access the sources using the `fullStream` property:

```tsx
const result = streamText({
  model: 'google/gemini-2.5-flash',
  tools: {
    google_search: google.tools.googleSearch({}),
  },
  prompt: 'List the top 5 San Francisco news from the past week.',
});

for await (const part of result.fullStream) {
  if (part.type === 'source' && part.sourceType === 'url') {
    console.log('ID:', part.id);
    console.log('Title:', part.title);
    console.log('URL:', part.url);
    console.log('Provider metadata:', part.providerMetadata);
    console.log();
  }
}
```

The sources are also available in the `result.sources` promise.

## Examples

You can see `generateText` and `streamText` in action using various frameworks in the following examples:

### `generateText`

<ExampleLinks
  examples={[
    {
      title: 'Learn to generate text in Node.js',
      link: '/examples/node/generating-text/generate-text',
    },
    {
      title:
        'Learn to generate text in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/generating-text',
    },
    {
      title:
        'Learn to generate text in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/generating-text',
    },
  ]}
/>

### `streamText`

<ExampleLinks
  examples={[
    {
      title: 'Learn to stream text in Node.js',
      link: '/examples/node/generating-text/stream-text',
    },
    {
      title: 'Learn to stream text in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/streaming-text-generation',
    },
    {
      title: 'Learn to stream text in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/streaming-text-generation',
    },
  ]}
/>

---
title: Generating Structured Data
description: Learn how to generate structured data with the AI SDK.
---

# Generating Structured Data

While text generation can be useful, your use case will likely call for generating structured data.
For example, you might want to extract information from text, classify data, or generate synthetic data.

Many language models are capable of generating structured data, often defined as using "JSON modes" or "tools".
However, you need to manually provide schemas and then validate the generated data as LLMs can produce incorrect or incomplete structured data.

The AI SDK standardises structured object generation across model providers
using the `output` property on [`generateText`](/docs/reference/ai-sdk-core/generate-text)
and [`streamText`](/docs/reference/ai-sdk-core/stream-text).
You can use [Zod schemas](/docs/reference/ai-sdk-core/zod-schema), [Valibot](/docs/reference/ai-sdk-core/valibot-schema), or [JSON schemas](/docs/reference/ai-sdk-core/json-schema) to specify the shape of the data that you want,
and the AI model will generate data that conforms to that structure.

<Note>
  Structured output generation is part of the `generateText` and `streamText`
  flow. This means you can combine it with tool calling in the same request.
</Note>

## Generating Structured Outputs

Use `generateText` with `Output.object()` to generate structured data from a prompt.
The schema is also used to validate the generated data, ensuring type safety and correctness.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const { output } = await generateText({
  model: __MODEL__,
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(
          z.object({ name: z.string(), amount: z.string() }),
        ),
        steps: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

<Note>
  Structured output generation counts as a step in the AI SDK's multi-turn
  execution model (where each model call or tool execution is one step). When
  combining with tools, account for this in your `stopWhen` configuration.
</Note>

### Accessing response headers & body

Sometimes you need access to the full response from the model provider,
e.g. to access some provider-specific headers or body content.

You can access the raw response headers and body using the `response` property:

```ts
import { generateText, Output } from 'ai';

const result = await generateText({
  // ...
  output: Output.object({ schema }),
});

console.log(JSON.stringify(result.response.headers, null, 2));
console.log(JSON.stringify(result.response.body, null, 2));
```

## Stream Structured Outputs

Given the added complexity of returning structured data, model response time can be unacceptable for your interactive use case.
With `streamText` and `output`, you can stream the model's structured response as it is generated.

```ts
import { streamText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const { partialOutputStream } = streamText({
  model: __MODEL__,
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(
          z.object({ name: z.string(), amount: z.string() }),
        ),
        steps: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});

// use partialOutputStream as an async iterable
for await (const partialObject of partialOutputStream) {
  console.log(partialObject);
}
```

You can consume the structured output on the client with the [`useObject`](/docs/reference/ai-sdk-ui/use-object) hook.

### Error Handling in Streams

`streamText` starts streaming immediately. When errors occur during streaming, they become part of the stream rather than thrown exceptions (to prevent stream crashes).

To handle errors, provide an `onError` callback:

```tsx highlight="5-7"
import { streamText, Output } from 'ai';

const result = streamText({
  // ...
  output: Output.object({ schema }),
  onError({ error }) {
    console.error(error); // log to your error tracking service
  },
});
```

For non-streaming error handling with `generateText`, see the [Error Handling](#error-handling) section below.

## Output Types

The AI SDK supports multiple ways of specifying the expected structure of generated data via the `Output` object. You can select from various strategies for structured/text generation and validation.

### `Output.text()`

Use `Output.text()` to generate plain text from a model. This option doesn't enforce any schema on the result: you simply receive the model's text as a string. This is the default behavior when no `output` is specified.

```ts
import { generateText, Output } from 'ai';

const { output } = await generateText({
  // ...
  output: Output.text(),
  prompt: 'Tell me a joke.',
});
// output will be a string (the joke)
```

### `Output.object()`

Use `Output.object({ schema })` to generate a structured object based on a schema (for example, a Zod schema). The output is type-validated to ensure the returned result matches the schema.

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  // ...
  output: Output.object({
    schema: z.object({
      name: z.string(),
      age: z.number().nullable(),
      labels: z.array(z.string()),
    }),
  }),
  prompt: 'Generate information for a test user.',
});
// output will be an object matching the schema above
```

<Note>
  Partial outputs streamed via `streamText` cannot be validated against your
  provided schema, as incomplete data may not yet conform to the expected
  structure.
</Note>

### `Output.array()`

Use `Output.array({ element })` to specify that you expect an array of typed objects from the model, where each element should conform to a schema (defined in the `element` property).

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  // ...
  output: Output.array({
    element: z.object({
      location: z.string(),
      temperature: z.number(),
      condition: z.string(),
    }),
  }),
  prompt: 'List the weather for San Francisco and Paris.',
});
// output will be an array of objects like:
// [
//   { location: 'San Francisco', temperature: 70, condition: 'Sunny' },
//   { location: 'Paris', temperature: 65, condition: 'Cloudy' },
// ]
```

When streaming arrays with `streamText`, you can use `elementStream` to receive each completed element as it is generated:

```ts
import { streamText, Output } from 'ai';
import { z } from 'zod';

const { elementStream } = streamText({
  // ...
  output: Output.array({
    element: z.object({
      name: z.string(),
      class: z.string(),
      description: z.string(),
    }),
  }),
  prompt: 'Generate 3 hero descriptions for a fantasy role playing game.',
});

for await (const hero of elementStream) {
  console.log(hero); // Each hero is complete and validated
}
```

<Note>
  Each element emitted by `elementStream` is complete and validated against your
  element schema. This differs from `partialOutputStream`, which streams the
  entire partial array including incomplete elements.
</Note>

### `Output.choice()`

Use `Output.choice({ options })` when you expect the model to choose from a specific set of string options, such as for classification or fixed-enum answers.

```ts
import { generateText, Output } from 'ai';

const { output } = await generateText({
  // ...
  output: Output.choice({
    options: ['sunny', 'rainy', 'snowy'],
  }),
  prompt: 'Is the weather sunny, rainy, or snowy today?',
});
// output will be one of: 'sunny', 'rainy', or 'snowy'
```

You can provide any set of string options, and the output will always be a single string value that matches one of the specified options. The AI SDK validates that the result matches one of your options, and will throw if the model returns something invalid.

This is especially useful for making classification-style generations or forcing valid values for API compatibility.

### `Output.json()`

Use `Output.json()` when you want to generate and parse unstructured JSON values from the model, without enforcing a specific schema. This is useful if you want to capture arbitrary objects, flexible structures, or when you want to rely on the model's natural output rather than rigid validation.

```ts
import { generateText, Output } from 'ai';

const { output } = await generateText({
  // ...
  output: Output.json(),
  prompt:
    'For each city, return the current temperature and weather condition as a JSON object.',
});

// output could be any valid JSON, for example:
// {
//   "San Francisco": { "temperature": 70, "condition": "Sunny" },
//   "Paris": { "temperature": 65, "condition": "Cloudy" }
// }
```

With `Output.json`, the AI SDK only checks that the response is valid JSON; it doesn't validate the structure or types of the values. If you need schema validation, use the `.object` or `.array` outputs instead.

For more advanced validation or different structures, see [the Output API reference](/docs/reference/ai-sdk-core/output).

## Generating Structured Outputs with Tools

One of the key advantages of using structured output with `generateText` and `streamText` is the ability to combine it with tool calling.

```ts
import { generateText, Output, tool, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const { output } = await generateText({
  model: __MODEL__,
  tools: {
    weather: tool({
      description: 'Get the weather for a location',
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        // fetch weather data
        return { temperature: 72, condition: 'sunny' };
      },
    }),
  },
  output: Output.object({
    schema: z.object({
      summary: z.string(),
      recommendation: z.string(),
    }),
  }),
  stopWhen: stepCountIs(5),
  prompt: 'What should I wear in San Francisco today?',
});
```

<Note>
  When using tools with structured output, remember that generating the
  structured output counts as a step. Configure `stopWhen` to allow enough steps
  for both tool execution and output generation.
</Note>

## Property Descriptions

You can add `.describe("...")` to individual schema properties to give the model hints about what each property is for. This helps improve the quality and accuracy of generated structured data:

```ts highlight="5,9"
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const { output } = await generateText({
  model: __MODEL__,
  output: Output.object({
    schema: z.object({
      name: z.string().describe('The name of the recipe'),
      ingredients: z
        .array(
          z.object({
            name: z.string(),
            amount: z
              .string()
              .describe('The amount of the ingredient (grams or ml)'),
          }),
        )
        .describe('List of ingredients with amounts'),
      steps: z.array(z.string()).describe('Step-by-step cooking instructions'),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

Property descriptions are particularly useful for:

- Clarifying ambiguous property names
- Specifying expected formats or conventions
- Providing context for complex nested structures

## Output Name and Description

You can optionally specify a `name` and `description` for the output. These are used by some providers for additional LLM guidance, e.g. via tool or schema name.

```ts highlight="6-7"
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const { output } = await generateText({
  model: __MODEL__,
  output: Output.object({
    name: 'Recipe',
    description: 'A recipe for a dish.',
    schema: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This works with all output types that support structured generation:

- `Output.object({ name, description, schema })`
- `Output.array({ name, description, element })`
- `Output.choice({ name, description, options })`
- `Output.json({ name, description })`

## Accessing Reasoning

You can access the reasoning used by the language model to generate the object via the `reasoning` property on the result. This property contains a string with the model's thought process, if available.

```ts
import { generateText, Output } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const result = await generateText({
  model: __MODEL__, // must be a reasoning model
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

console.log(result.reasoningText);
```

## Error Handling

When `generateText` with structured output cannot generate a valid object, it throws a [`AI_NoObjectGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-object-generated-error).

This error occurs when the AI provider fails to generate a parsable object that conforms to the schema.
It can arise due to the following reasons:

- The model failed to generate a response.
- The model generated a response that could not be parsed.
- The model generated a response that could not be validated against the schema.

The error preserves the following information to help you log the issue:

- `text`: The text that was generated by the model. This can be the raw text or the tool call text, depending on the object generation mode.
- `response`: Metadata about the language model response, including response id, timestamp, and model.
- `usage`: Request token usage.
- `cause`: The cause of the error (e.g. a JSON parsing error). You can use this for more detailed error handling.

```ts
import { generateText, Output, NoObjectGeneratedError } from 'ai';

try {
  await generateText({
    model,
    output: Output.object({ schema }),
    prompt,
  });
} catch (error) {
  if (NoObjectGeneratedError.isInstance(error)) {
    console.log('NoObjectGeneratedError');
    console.log('Cause:', error.cause);
    console.log('Text:', error.text);
    console.log('Response:', error.response);
    console.log('Usage:', error.usage);
  }
}
```

## More Examples

You can see structured output generation in action using various frameworks in the following examples:

### `generateText` with Output

<ExampleLinks
  examples={[
    {
      title: 'Learn to generate structured data in Node.js',
      link: '/examples/node/generating-structured-data/generate-object',
    },
    {
      title:
        'Learn to generate structured data in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/generating-object',
    },
    {
      title:
        'Learn to generate structured data in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/generating-object',
    },
  ]}
/>

### `streamText` with Output

<ExampleLinks
  examples={[
    {
      title: 'Learn to stream structured data in Node.js',
      link: '/examples/node/streaming-structured-data/stream-object',
    },
    {
      title:
        'Learn to stream structured data in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/streaming-object-generation',
    },
    {
      title:
        'Learn to stream structured data in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/streaming-object-generation',
    },
  ]}
/>

---
title: Tool Calling
description: Learn about tool calling and multi-step calls (using stopWhen) with AI SDK Core.
---

# Tool Calling

As covered under Foundations, [tools](/docs/foundations/tools) are objects that can be called by the model to perform a specific task.
AI SDK Core tools contain several core elements:

- **`description`**: An optional description of the tool that can influence when the tool is picked.
- **`inputSchema`**: A [Zod schema](/docs/foundations/tools#schemas) or a [JSON schema](/docs/reference/ai-sdk-core/json-schema) that defines the input parameters. The schema is consumed by the LLM, and also used to validate the LLM tool calls.
- **`execute`**: An optional async function that is called with the inputs from the tool call. It produces a value of type `RESULT` (generic type). It is optional because you might want to forward tool calls to the client or to a queue instead of executing them in the same process.
- **`strict`**: _(optional, boolean)_ Enables strict tool calling when supported by the provider

<Note className="mb-2">
  You can use the [`tool`](/docs/reference/ai-sdk-core/tool) helper function to
  infer the types of the `execute` parameters.
</Note>

The `tools` parameter of `generateText` and `streamText` is an object that has the tool names as keys and the tools as values:

```ts highlight="6-17"
import { z } from 'zod';
import { generateText, tool, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  },
  stopWhen: stepCountIs(5),
  prompt: 'What is the weather in San Francisco?',
});
```

<Note>
  When a model uses a tool, it is called a "tool call" and the output of the
  tool is called a "tool result".
</Note>

Tool calling is not restricted to only text generation.
You can also use it to render user interfaces (Generative UI).

## Strict Mode

When enabled, language model providers that support strict tool calling will only generate tool calls that are valid according to your defined `inputSchema`.
This increases the reliability of tool calling.
However, not all schemas may be supported in strict mode, and what is supported depends on the specific provider.

By default, strict mode is disabled. You can enable it per-tool by setting `strict: true`:

```ts
tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string(),
  }),
  strict: true, // Enable strict validation for this tool
  execute: async ({ location }) => ({
    // ...
  }),
});
```

<Note>
  Not all providers or models support strict mode. For those that do not, this
  option is ignored.
</Note>

## Input Examples

You can specify example inputs for your tools to help guide the model on how input data should be structured.
When supported by providers, input examples can help when JSON schema itself does not fully specify the intended
usage or when there are optional values.

```ts
tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  inputExamples: [
    { input: { location: 'San Francisco' } },
    { input: { location: 'London' } },
  ],
  execute: async ({ location }) => {
    // ...
  },
});
```

<Note>
  Only the Anthropic providers supports tool input examples natively. Other
  providers ignore the setting.
</Note>

## Tool Execution Approval

By default, tools with an `execute` function run automatically as the model calls them. You can require approval before execution by setting `needsApproval`:

```ts highlight="13"
import { tool } from 'ai';
import { z } from 'zod';

const runCommand = tool({
  description: 'Run a shell command',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
  }),
  needsApproval: true,
  execute: async ({ command }) => {
    // your command execution logic here
  },
});
```

This is useful for tools that perform sensitive operations like executing commands, processing payments, modifying data, and more potentially dangerous actions.

### How It Works

When a tool requires approval, `generateText` and `streamText` don't pause execution. Instead, they complete and return `tool-approval-request` parts in the result content. This means the approval flow requires two calls to the model: the first returns the approval request, and the second (after receiving the approval response) either executes the tool or informs the model that approval was denied.

Here's the complete flow:

1. Call `generateText` with a tool that has `needsApproval: true`
2. Model generates a tool call
3. `generateText` returns with `tool-approval-request` parts in `result.content`
4. Your app requests an approval and collects the user's decision
5. Add a `tool-approval-response` to the messages array
6. Call `generateText` again with the updated messages
7. If approved, the tool runs and returns a result. If denied, the model sees the denial and responds accordingly.

### Handling Approval Requests

After calling `generateText` or `streamText`, check `result.content` for `tool-approval-request` parts:

```ts
import { type ModelMessage, generateText } from 'ai';

const messages: ModelMessage[] = [
  { role: 'user', content: 'Remove the most recent file' },
];
const result = await generateText({
  model: __MODEL__,
  tools: { runCommand },
  messages,
});

messages.push(...result.response.messages);

for (const part of result.content) {
  if (part.type === 'tool-approval-request') {
    console.log(part.approvalId); // Unique ID for this approval request
    console.log(part.toolCall); // Contains toolName, input, etc.
  }
}
```

To respond, create a `tool-approval-response` and add it to your messages:

```ts
import { type ToolApprovalResponse } from 'ai';

const approvals: ToolApprovalResponse[] = [];

for (const part of result.content) {
  if (part.type === 'tool-approval-request') {
    const response: ToolApprovalResponse = {
      type: 'tool-approval-response',
      approvalId: part.approvalId,
      approved: true, // or false to deny
      reason: 'User confirmed the command', // Optional context for the model
    };
    approvals.push(response);
  }
}

// add approvals to messages
messages.push({ role: 'tool', content: approvals });
```

Then call `generateText` again with the updated messages. If approved, the tool executes. If denied, the model receives the denial and can respond accordingly.

<Note>
  When a tool execution is denied, consider adding a system instruction like
  "When a tool execution is not approved, do not retry it" to prevent the model
  from attempting the same call again.
</Note>

### Dynamic Approval

You can make approval decisions based on tool input by providing an async function:

```ts
const paymentTool = tool({
  description: 'Process a payment',
  inputSchema: z.object({
    amount: z.number(),
    recipient: z.string(),
  }),
  needsApproval: async ({ amount }) => amount > 1000,
  execute: async ({ amount, recipient }) => {
    return await processPayment(amount, recipient);
  },
});
```

In this example, only transactions over $1000 require approval. Smaller transactions execute automatically.

### Tool Execution Approval with useChat

When using `useChat`, the approval flow is handled through UI state. See [Chatbot Tool Usage](/docs/ai-sdk-ui/chatbot-tool-usage#tool-execution-approval) for details on handling approvals in your UI with `addToolApprovalResponse`.

## Multi-Step Calls (using stopWhen)

With the `stopWhen` setting, you can enable multi-step calls in `generateText` and `streamText`. When `stopWhen` is set and the model generates a tool call, the AI SDK will trigger a new generation passing in the tool result until there are no further tool calls or the stopping condition is met.

The AI SDK provides several built-in stopping conditions:

- `stepCountIs(count)` — stops after a specified number of steps (default: `stepCountIs(20)`)
- `hasToolCall(toolName)` — stops when a specific tool is called
- `isLoopFinished()` — never triggers, letting the loop run until naturally finished

You can also combine multiple conditions in an array or create custom conditions. See [Loop Control](/docs/agents/loop-control) for more details.

<Note>
  The `stopWhen` conditions are only evaluated when the last step contains tool
  results.
</Note>

By default, when you use `generateText` or `streamText`, it triggers a single generation. This works well for many use cases where you can rely on the model's training data to generate a response. However, when you provide tools, the model now has the choice to either generate a normal text response, or generate a tool call. If the model generates a tool call, its generation is complete and that step is finished.

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

```ts highlight="18-19"
import { z } from 'zod';
import { generateText, tool, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

const { text, steps } = await generateText({
  model: __MODEL__,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
  },
  stopWhen: stepCountIs(5), // stop after a maximum of 5 steps if tools were called
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
__PROVIDER_IMPORT__;

const { steps } = await generateText({
  model: __MODEL__,
  stopWhen: stepCountIs(10),
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

The callback receives a `stepNumber` (zero-based) to identify which step just completed:

```tsx highlight="5-8"
import { generateText } from 'ai';

const result = await generateText({
  // ...
  onStepFinish({
    stepNumber,
    text,
    toolCalls,
    toolResults,
    finishReason,
    usage,
  }) {
    console.log(`Step ${stepNumber} finished (${finishReason})`);
    // your own logic, e.g. for saving the chat history or recording usage
  },
});
```

### Tool execution lifecycle callbacks

You can use `experimental_onToolCallStart` and `experimental_onToolCallFinish` to observe tool execution.
These callbacks are called right before and after each tool's `execute` function, giving you
visibility into tool execution timing, inputs, outputs, and errors:

```tsx highlight="5-14"
import { generateText } from 'ai';

const result = await generateText({
  // ... model, tools, prompt
  experimental_onToolCallStart({ toolName, toolCallId, input }) {
    console.log(`Calling tool: ${toolName}`, { toolCallId, input });
  },
  experimental_onToolCallFinish({
    toolName,
    toolCallId,
    output,
    error,
    durationMs,
  }) {
    if (error) {
      console.error(`Tool ${toolName} failed after ${durationMs}ms:`, error);
    } else {
      console.log(`Tool ${toolName} completed in ${durationMs}ms`, { output });
    }
  },
});
```

Errors thrown inside these callbacks are silently caught and do not break the generation flow.

### `prepareStep` callback

The `prepareStep` callback is called before a step is started.

It is called with the following parameters:

- `model`: The model that was passed into `generateText`.
- `stopWhen`: The stopping condition that was passed into `generateText`.
- `stepNumber`: The number of the step that is being executed.
- `steps`: The steps that have been executed so far.
- `messages`: The messages that will be sent to the model for the current step.
- `experimental_context`: The context passed via the `experimental_context` setting (experimental).

You can use it to provide different settings for a step, including modifying the input messages.

```tsx highlight="5-7"
import { generateText } from 'ai';

const result = await generateText({
  // ...
  prepareStep: async ({ model, stepNumber, steps, messages }) => {
    if (stepNumber === 0) {
      return {
        // use a different model for this step:
        model: modelForThisParticularStep,
        // force a tool choice for this step:
        toolChoice: { type: 'tool', toolName: 'tool1' },
        // limit the tools that are available for this step:
        activeTools: ['tool1'],
      };
    }

    // when nothing is returned, the default settings are used
  },
});
```

#### Message Modification for Longer Agentic Loops

In longer agentic loops, you can use the `messages` parameter to modify the input messages for each step. This is particularly useful for prompt compression:

```tsx
prepareStep: async ({ stepNumber, steps, messages }) => {
  // Compress conversation history for longer loops
  if (messages.length > 20) {
    return {
      messages: messages.slice(-10),
    };
  }

  return {};
},
```

#### Provider Options for Step Configuration

You can use `providerOptions` in `prepareStep` to pass provider-specific configuration for each step. This is useful for features like Anthropic's code execution container persistence:

```tsx
import { forwardAnthropicContainerIdFromLastStep } from '@ai-sdk/anthropic';

// Propagate container ID from previous step for code execution continuity
prepareStep: forwardAnthropicContainerIdFromLastStep,
```

## Response Messages

Adding the generated assistant and tool messages to your conversation history is a common task,
especially if you are using multi-step tool calls.

Both `generateText` and `streamText` have a `response.messages` property that you can use to
add the assistant and tool messages to your conversation history.
It is also available in the `onFinish` callback of `streamText`.

The `response.messages` property contains an array of `ModelMessage` objects that you can add to your conversation history:

```ts
import { generateText, ModelMessage } from 'ai';

const messages: ModelMessage[] = [
  // ...
];

const { response } = await generateText({
  // ...
  messages,
});

// add the response messages to your conversation history:
messages.push(...response.messages); // streamText: ...((await response).messages)
```

## Dynamic Tools

AI SDK Core supports dynamic tools for scenarios where tool schemas are not known at compile time. This is useful for:

- MCP (Model Context Protocol) tools without schemas
- User-defined functions at runtime
- Tools loaded from external sources

### Using dynamicTool

The `dynamicTool` helper creates tools with unknown input/output types:

```ts
import { dynamicTool } from 'ai';
import { z } from 'zod';

const customTool = dynamicTool({
  description: 'Execute a custom function',
  inputSchema: z.object({}),
  execute: async input => {
    // input is typed as 'unknown'
    // You need to validate/cast it at runtime
    const { action, parameters } = input as any;

    // Execute your dynamic logic
    return { result: `Executed ${action}` };
  },
});
```

### Type-Safe Handling

When using both static and dynamic tools, use the `dynamic` flag for type narrowing:

```ts
const result = await generateText({
  model: __MODEL__,
  tools: {
    // Static tool with known types
    weather: weatherTool,
    // Dynamic tool
    custom: dynamicTool({
      /* ... */
    }),
  },
  onStepFinish: ({ toolCalls, toolResults }) => {
    // Type-safe iteration
    for (const toolCall of toolCalls) {
      if (toolCall.dynamic) {
        // Dynamic tool: input is 'unknown'
        console.log('Dynamic:', toolCall.toolName, toolCall.input);
        continue;
      }

      // Static tool: full type inference
      switch (toolCall.toolName) {
        case 'weather':
          console.log(toolCall.input.location); // typed as string
          break;
      }
    }
  },
});
```

## Preliminary Tool Results

You can return an `AsyncIterable` over multiple results.
In this case, the last value from the iterable is the final tool result.

This can be used in combination with generator functions to e.g. stream status information
during the tool execution:

```ts
tool({
  description: 'Get the current weather.',
  inputSchema: z.object({
    location: z.string(),
  }),
  async *execute({ location }) {
    yield {
      status: 'loading' as const,
      text: `Getting weather for ${location}`,
      weather: undefined,
    };

    await new Promise(resolve => setTimeout(resolve, 3000));

    const temperature = 72 + Math.floor(Math.random() * 21) - 10;

    yield {
      status: 'success' as const,
      text: `The weather in ${location} is ${temperature}°F`,
      temperature,
    };
  },
});
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
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
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
import {
  streamText,
  tool,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const result = streamText({
        // ...
        messages,
        tools: {
          myTool: tool({
            // ...
            execute: async (args, { toolCallId }) => {
              // return e.g. custom status for tool call
              writer.write({
                type: 'data-tool-status',
                id: toolCallId,
                data: {
                  name: 'myTool',
                  status: 'in-progress',
                },
              });
              // ...
            },
          }),
        },
      });

      writer.merge(result.toUIMessageStream());
    },
  });

  return createUIMessageStreamResponse({ stream });
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
        return { ... };
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
__PROVIDER_IMPORT__;

const result = await generateText({
  model: __MODEL__,
  abortSignal: myAbortSignal, // signal that will be forwarded to tools
  tools: {
    weather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({ location: z.string() }),
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

### Context (experimental)

You can pass in arbitrary context from `generateText` or `streamText` via the `experimental_context` setting.
This context is available in the `experimental_context` tool execution option.

```ts
const result = await generateText({
  // ...
  tools: {
    someTool: tool({
      // ...
      execute: async (input, { experimental_context: context }) => {
        const typedContext = context as { example: string }; // or use type validation library
        // ...
      },
    }),
  },
  experimental_context: { example: '123' },
});
```

## Tool Input Lifecycle Hooks

The following tool input lifecycle hooks are available:

- **`onInputStart`**: Called when the model starts generating the input (arguments) for the tool call
- **`onInputDelta`**: Called for each chunk of text as the input is streamed
- **`onInputAvailable`**: Called when the complete input is available and validated

`onInputStart` and `onInputDelta` are only called in streaming contexts (when using `streamText`). They are not called when using `generateText`.

### Example

```ts highlight="15-23"
import { streamText, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const result = streamText({
  model: __MODEL__,
  tools: {
    getWeather: tool({
      description: 'Get the weather in a location',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
      onInputStart: () => {
        console.log('Tool call starting');
      },
      onInputDelta: ({ inputTextDelta }) => {
        console.log('Received input chunk:', inputTextDelta);
      },
      onInputAvailable: ({ input }) => {
        console.log('Complete input:', input);
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
The type inference helpers `TypedToolCall<TOOLS extends ToolSet>`
and `TypedToolResult<TOOLS extends ToolSet>` can be used to
extract the tool call and tool result types from the tools.

```ts highlight="18-19,23-24"
import { TypedToolCall, TypedToolResult, generateText, tool } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';

const myToolSet = {
  firstTool: tool({
    description: 'Greets the user',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  }),
  secondTool: tool({
    description: 'Tells the user their age',
    inputSchema: z.object({ age: z.number() }),
    execute: async ({ age }) => `You are ${age} years old!`,
  }),
};

type MyToolCall = TypedToolCall<typeof myToolSet>;
type MyToolResult = TypedToolResult<typeof myToolSet>;

async function generateSomething(prompt: string): Promise<{
  text: string;
  toolCalls: Array<MyToolCall>; // typed tool calls
  toolResults: Array<MyToolResult>; // typed tool results
}> {
  return generateText({
    model: __MODEL__,
    tools: myToolSet,
    prompt,
  });
}
```

## Handling Errors

The AI SDK has three tool-call related errors:

- [`NoSuchToolError`](/docs/reference/ai-sdk-errors/ai-no-such-tool-error): the model tries to call a tool that is not defined in the tools object
- [`InvalidToolInputError`](/docs/reference/ai-sdk-errors/ai-invalid-tool-input-error): the model calls a tool with inputs that do not match the tool's input schema
- [`ToolCallRepairError`](/docs/reference/ai-sdk-errors/ai-tool-call-repair-error): an error that occurred during tool call repair

When tool execution fails (errors thrown by your tool's `execute` function), the AI SDK adds them as `tool-error` content parts to enable automated LLM roundtrips in multi-step scenarios.

### `generateText`

`generateText` throws errors for tool schema validation issues and other errors, and can be handled using a `try`/`catch` block. Tool execution errors appear as `tool-error` parts in the result steps:

```ts
try {
  const result = await generateText({
    //...
  });
} catch (error) {
  if (NoSuchToolError.isInstance(error)) {
    // handle the no such tool error
  } else if (InvalidToolInputError.isInstance(error)) {
    // handle the invalid tool inputs error
  } else {
    // handle other errors
  }
}
```

Tool execution errors are available in the result steps:

```ts
const { steps } = await generateText({
  // ...
});

// check for tool errors in the steps
const toolErrors = steps.flatMap(step =>
  step.content.filter(part => part.type === 'tool-error'),
);

toolErrors.forEach(toolError => {
  console.log('Tool error:', toolError.error);
  console.log('Tool name:', toolError.toolName);
  console.log('Tool input:', toolError.input);
});
```

### `streamText`

`streamText` sends errors as part of the full stream. Tool execution errors appear as `tool-error` parts, while other errors appear as `error` parts.

When using `toUIMessageStreamResponse`, you can pass an `onError` function to extract the error message from the error part and forward it as part of the stream response:

```ts
const result = streamText({
  // ...
});

return result.toUIMessageStreamResponse({
  onError: error => {
    if (NoSuchToolError.isInstance(error)) {
      return 'The model tried to call a unknown tool.';
    } else if (InvalidToolInputError.isInstance(error)) {
      return 'The model called a tool with invalid inputs.';
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
especially when the input schema is complex or the model is smaller.

If you use multiple steps, those failed tool calls will be sent back to the LLM
in the next step to give it an opportunity to fix it.
However, you may want to control how invalid tool calls are repaired without requiring
additional steps that pollute the message history.

You can use the `experimental_repairToolCall` function to attempt to repair the tool call
with a custom function.

You can use different strategies to repair the tool call:

- Use a model with structured outputs to generate the inputs.
- Send the messages, system prompt, and tool schema to a stronger model to generate the inputs.
- Provide more specific repair instructions based on which tool was called.

### Example: Use a model with structured outputs for repair

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, NoSuchToolError, Output, tool } from 'ai';

const result = await generateText({
  model,
  tools,
  prompt,

  experimental_repairToolCall: async ({
    toolCall,
    tools,
    inputSchema,
    error,
  }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null; // do not attempt to fix invalid tool names
    }

    const tool = tools[toolCall.toolName as keyof typeof tools];

    const { output: repairedArgs } = await generateText({
      model: __MODEL__,
      output: Output.object({ schema: tool.inputSchema }),
      prompt: [
        `The model tried to call the tool "${toolCall.toolName}"` +
          ` with the following inputs:`,
        JSON.stringify(toolCall.input),
        `The tool accepts the following schema:`,
        JSON.stringify(inputSchema(toolCall)),
        'Please fix the inputs.',
      ].join('\n'),
    });

    return { ...toolCall, input: JSON.stringify(repairedArgs) };
  },
});
```

### Example: Use the re-ask strategy for repair

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, NoSuchToolError, tool } from 'ai';

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
              input: toolCall.input,
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
              output: error.message,
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
          type: 'tool-call' as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: JSON.stringify(newToolCall.input),
        }
      : null;
  },
});
```

## Active Tools

Language models can only handle a limited number of tools at a time, depending on the model.
To allow for static typing using a large number of tools and limiting the available tools to the model at the same time,
the AI SDK provides the `activeTools` property.

It is an array of tool names that are currently active.
By default, the value is `undefined` and all tools are active.

```ts highlight="7"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
__PROVIDER_IMPORT__;

const { text } = await generateText({
  model: __MODEL__,
  tools: myToolSet,
  activeTools: ['firstTool'],
});
```

## Multi-modal Tool Results

<Note type="warning">
  Multi-modal tool results are experimental and supported by Anthropic, OpenAI,
  and Google (Gemini 3 models).
</Note>

For Google, use base64 media parts (`image-data` / `file-data`) or base64
`data:` URLs in URL-style parts. Remote HTTP(S) URLs in tool-result URL parts
are not supported.

In order to send multi-modal tool results, e.g. screenshots, back to the model,
they need to be converted into a specific format.

AI SDK Core tools have an optional `toModelOutput` function
that converts the tool result into a content part.

Here is an example for converting a screenshot into a content part:

```ts highlight="22-27"
const result = await generateText({
  model: __MODEL__,
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
      toModelOutput({ output }) {
        return {
          type: 'content',
          value:
            typeof output === 'string'
              ? [{ type: 'text', text: output }]
              : [{ type: 'media', data: output.data, mediaType: 'image/png' }],
        };
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
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => ({
    location,
    temperature: 72 + Math.floor(Math.random() * 21) - 10,
  }),
});
```

## MCP Tools

The AI SDK supports connecting to Model Context Protocol (MCP) servers to access their tools.
MCP enables your AI applications to discover and use tools across various services through a standardized interface.

For detailed information about MCP tools, including initialization, transport options, and usage patterns, see the [MCP Tools documentation](/docs/ai-sdk-core/mcp-tools).

### AI SDK Tools vs MCP Tools

In most cases, you should define your own AI SDK tools for production applications. They provide full control, type safety, and optimal performance. MCP tools are best suited for rapid development iteration and scenarios where users bring their own tools.

| Aspect                 | AI SDK Tools                                              | MCP Tools                                             |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| **Type Safety**        | Full static typing end-to-end                             | Dynamic discovery at runtime                          |
| **Execution**          | Same process as your request (low latency)                | Separate server (network overhead)                    |
| **Prompt Control**     | Full control over descriptions and schemas                | Controlled by MCP server owner                        |
| **Schema Control**     | You define and optimize for your model                    | Controlled by MCP server owner                        |
| **Version Management** | Full visibility over updates                              | Can update independently (version skew risk)          |
| **Authentication**     | Same process, no additional auth required                 | Separate server introduces additional auth complexity |
| **Best For**           | Production applications requiring control and performance | Development iteration, user-provided tools            |

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
title: Model Context Protocol (MCP)
description: Learn how to connect to Model Context Protocol (MCP) servers and use their tools with AI SDK Core.
---

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

    // optional: reject redirect responses to prevent SSRF
    redirect: 'error',
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

    // optional: reject redirect responses to prevent SSRF
    redirect: 'error',
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

```ts highlight="3-5"
const result = await generateText({
  model: __MODEL__,
  maxOutputTokens: 512,
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

You can specify the timeout either as a number (milliseconds) or as an object with `totalMs`, `stepMs`, and/or `chunkMs` properties:

- `totalMs`: The total timeout for the entire call including all steps.
- `stepMs`: The timeout for each individual step (LLM call). This is useful for multi-step generations where you want to limit the time spent on each step independently.
- `chunkMs`: The timeout between stream chunks (streaming only). The call will abort if no new chunk is received within this duration. This is useful for detecting stalled streams.

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
| [Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#embedding-models) | `gemini-embedding-001`          | 3072                 | <Cross size={18} /> |
| [Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#embedding-models) | `gemini-embedding-2-preview`    | 3072                 | <Check size={18} /> |
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
`wrapImageModel` and `ImageModelV3Middleware`.

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
| [Google](/providers/ai-sdk-providers/google-generative-ai#image-models)         | `imagen-4.0-generate-001`                                    | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google](/providers/ai-sdk-providers/google-generative-ai#image-models)         | `imagen-4.0-fast-generate-001`                               | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
| [Google](/providers/ai-sdk-providers/google-generative-ai#image-models)         | `imagen-4.0-ultra-generate-001`                              | 1:1, 3:4, 4:3, 9:16, 16:9                                                                                                                                           |
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
| [Google](/providers/ai-sdk-providers/google-generative-ai#video-models) | `veo-2.0-generate-001`      | Text-to-video, up to 4 videos per call |
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
title: Language Model Middleware
description: Learn how to use middleware to enhance the behavior of language models
---

