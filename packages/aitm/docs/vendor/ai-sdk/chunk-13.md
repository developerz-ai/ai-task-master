# DeepSeek Provider

The [DeepSeek](https://www.deepseek.com) provider offers access to powerful language models through the DeepSeek API.

API keys can be obtained from the [DeepSeek Platform](https://platform.deepseek.com/api_keys).

## Setup

The DeepSeek provider is available via the `@ai-sdk/deepseek` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/deepseek" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/deepseek" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/deepseek" dark />
  </Tab>
  <Tab>
    <Snippet text="bun add @ai-sdk/deepseek" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `deepseek` from `@ai-sdk/deepseek`:

```ts
import { deepseek } from '@ai-sdk/deepseek';
```

For custom configuration, you can import `createDeepSeek` and create a provider instance with your settings:

```ts
import { createDeepSeek } from '@ai-sdk/deepseek';

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});
```

You can use the following optional settings to customize the DeepSeek provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls.
  The default prefix is `https://api.deepseek.com`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `DEEPSEEK_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Language Models

You can create language models using a provider instance:

```ts
import { deepseek } from '@ai-sdk/deepseek';
import { generateText } from 'ai';

const { text } = await generateText({
  model: deepseek('deepseek-chat'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can also use the `.chat()` or `.languageModel()` factory methods:

```ts
const model = deepseek.chat('deepseek-chat');
// or
const model = deepseek.languageModel('deepseek-chat');
```

DeepSeek language models can be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

The following optional provider options are available for DeepSeek models:

- `thinking` _object_

  Optional. Controls thinking mode (chain-of-thought reasoning). You can enable thinking mode either by using the `deepseek-reasoner` model or by setting this option.

  - `type`: `'enabled' | 'disabled'` - Enable or disable thinking mode.

```ts highlight="7-11"
import { deepseek, type DeepSeekLanguageModelOptions } from '@ai-sdk/deepseek';
import { generateText } from 'ai';

const { text, reasoning } = await generateText({
  model: deepseek('deepseek-chat'),
  prompt: 'How many "r"s are in the word "strawberry"?',
  providerOptions: {
    deepseek: {
      thinking: { type: 'enabled' },
    } satisfies DeepSeekLanguageModelOptions,
  },
});
```

### Reasoning

DeepSeek has reasoning support for the `deepseek-reasoner` model. The reasoning is exposed through streaming:

```ts
import { deepseek } from '@ai-sdk/deepseek';
import { streamText } from 'ai';

const result = streamText({
  model: deepseek('deepseek-reasoner'),
  prompt: 'How many "r"s are in the word "strawberry"?',
});

for await (const part of result.fullStream) {
  if (part.type === 'reasoning') {
    // This is the reasoning text
    console.log('Reasoning:', part.text);
  } else if (part.type === 'text') {
    // This is the final answer
    console.log('Answer:', part.text);
  }
}
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

### Cache Token Usage

DeepSeek provides context caching on disk technology that can significantly reduce token costs for repeated content. You can access the cache hit/miss metrics through the `providerMetadata` property in the response:

```ts
import { deepseek } from '@ai-sdk/deepseek';
import { generateText } from 'ai';

const result = await generateText({
  model: deepseek('deepseek-chat'),
  prompt: 'Your prompt here',
});

console.log(result.providerMetadata);
// Example output: { deepseek: { promptCacheHitTokens: 1856, promptCacheMissTokens: 5 } }
```

The metrics include:

- `promptCacheHitTokens`: Number of input tokens that were cached
- `promptCacheMissTokens`: Number of input tokens that were not cached

<Note>
  For more details about DeepSeek's caching system, see the [DeepSeek caching
  documentation](https://api-docs.deepseek.com/guides/kv_cache#checking-cache-hit-status).
</Note>

## Model Capabilities

| Model               | Text Generation     | Object Generation   | Image Input         | Tool Usage          | Tool Streaming      |
| ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `deepseek-chat`     | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-reasoner` | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  Please see the [DeepSeek
  docs](https://api-docs.deepseek.com/quick_start/pricing) for a full list of
  available models. You can also pass any available provider model ID as a
  string if needed.
</Note>

---
title: Moonshot AI
description: Learn how to use Moonshot AI models with the AI SDK.
---

# Moonshot AI Provider

The [Moonshot AI](https://www.moonshot.ai) provider offers access to powerful language models through the Moonshot API, including the Kimi series of models with reasoning capabilities.

API keys can be obtained from the [Moonshot Platform](https://platform.moonshot.ai).

## Setup

The Moonshot AI provider is available via the `@ai-sdk/moonshotai` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/moonshotai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/moonshotai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/moonshotai" dark />
  </Tab>
  <Tab>
    <Snippet text="bun add @ai-sdk/moonshotai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `moonshotai` from `@ai-sdk/moonshotai`:

```ts
import { moonshotai } from '@ai-sdk/moonshotai';
```

For custom configuration, you can import `createMoonshotAI` and create a provider instance with your settings:

```ts
import { createMoonshotAI } from '@ai-sdk/moonshotai';

const moonshotai = createMoonshotAI({
  apiKey: process.env.MOONSHOT_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Moonshot AI provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls.
  The default prefix is `https://api.moonshot.ai/v1`

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `MOONSHOT_API_KEY` environment variable

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation

## Language Models

You can create language models using a provider instance:

```ts
import { moonshotai } from '@ai-sdk/moonshotai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: moonshotai('kimi-k2.5'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can also use the `.chatModel()` or `.languageModel()` factory methods:

```ts
const model = moonshotai.chatModel('kimi-k2.5');
// or
const model = moonshotai.languageModel('kimi-k2.5');
```

Moonshot AI language models can be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

### Reasoning Models

Moonshot AI offers thinking models like `kimi-k2-thinking` that generate intermediate reasoning tokens before their final response. The reasoning output is streamed through the standard AI SDK reasoning parts.

```ts
import {
  moonshotai,
  type MoonshotAILanguageModelOptions,
} from '@ai-sdk/moonshotai';
import { generateText } from 'ai';

const { text, reasoningText } = await generateText({
  model: moonshotai('kimi-k2-thinking'),
  providerOptions: {
    moonshotai: {
      thinking: { type: 'enabled', budgetTokens: 2048 },
      reasoningHistory: 'interleaved',
    } satisfies MoonshotAILanguageModelOptions,
  },
  prompt: 'How many "r"s are in the word "strawberry"?',
});

console.log(reasoningText);
console.log(text);
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details on how to integrate reasoning into your chatbot.

### Provider Options

The following optional provider options are available for Moonshot AI language models:

- **thinking** _object_

  Configuration for thinking/reasoning models like Kimi K2 Thinking.

  - **type** _'enabled' | 'disabled'_

    Whether to enable thinking mode

  - **budgetTokens** _number_

    Maximum number of tokens for thinking (minimum 1024)

- **reasoningHistory** _'disabled' | 'interleaved' | 'preserved'_

  Controls how reasoning history is handled in multi-turn conversations:

  - `'disabled'`: Remove reasoning from history
  - `'interleaved'`: Include reasoning between tool calls within a single turn
  - `'preserved'`: Keep all reasoning in history

## Model Capabilities

| Model                    | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ------------------------ | ------------------- | ------------------- | ------------------- | ------------------- |
| `moonshot-v1-8k`         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `moonshot-v1-32k`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `moonshot-v1-128k`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `kimi-k2`                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `kimi-k2.5`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `kimi-k2-thinking`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `kimi-k2-thinking-turbo` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `kimi-k2-turbo`          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  Please see the [Moonshot AI docs](https://platform.moonshot.ai/docs/intro) for
  a full list of available models. You can also pass any available provider
  model ID as a string if needed.
</Note>

---
title: Alibaba
description: Learn how to use Alibaba Cloud Model Studio (Qwen) models with the AI SDK.
---

# Alibaba Provider

[Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com/) provides access to the Qwen model series, including advanced reasoning capabilities.

API keys can be obtained from the [Console](https://modelstudio.console.alibabacloud.com/).

## Setup

The Alibaba provider is available via the `@ai-sdk/alibaba` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/alibaba" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/alibaba" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/alibaba" dark />
  </Tab>
  <Tab>
    <Snippet text="bun add @ai-sdk/alibaba" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `alibaba` from `@ai-sdk/alibaba`:

```ts
import { alibaba } from '@ai-sdk/alibaba';
```

For custom configuration, you can import `createAlibaba` and create a provider instance with your settings:

```ts
import { createAlibaba } from '@ai-sdk/alibaba';

const alibaba = createAlibaba({
  apiKey: process.env.ALIBABA_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Alibaba provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers or regional endpoints.
  The default prefix is `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.

- **videoBaseURL** _string_

  Use a different URL prefix for video generation API calls. The video API uses the DashScope
  native endpoint (not the OpenAI-compatible endpoint).
  The default prefix is `https://dashscope-intl.aliyuncs.com`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `ALIBABA_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

- **includeUsage** _boolean_

  Include usage information in streaming responses. When enabled, token usage will be included in the final chunk.
  Defaults to `true`.

## Language Models

You can create language models using a provider instance:

```ts
import { alibaba } from '@ai-sdk/alibaba';
import { generateText } from 'ai';

const { text } = await generateText({
  model: alibaba('qwen-plus'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can also use the `.chatModel()` or `.languageModel()` factory methods:

```ts
const model = alibaba.chatModel('qwen-plus');
// or
const model = alibaba.languageModel('qwen-plus');
```

Alibaba language models can be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

The following optional provider options are available for Alibaba models:

- **enableThinking** _boolean_

  Enable thinking/reasoning mode for supported models. When enabled, the model generates reasoning content before the response.
  Defaults to `false`.

- **thinkingBudget** _number_

  Maximum number of reasoning tokens to generate. Limits the length of thinking content.

- **parallelToolCalls** _boolean_

  Whether to enable parallel function calling during tool use.
  Defaults to `true`.

### Thinking Mode

Alibaba's Qwen models support thinking/reasoning mode for complex problem-solving:

```ts
import { alibaba, type AlibabaLanguageModelOptions } from '@ai-sdk/alibaba';
import { generateText } from 'ai';

const { text, reasoning } = await generateText({
  model: alibaba('qwen3-max'),
  providerOptions: {
    alibaba: {
      enableThinking: true,
      thinkingBudget: 2048,
    } satisfies AlibabaLanguageModelOptions,
  },
  prompt: 'How many "r"s are in the word "strawberry"?',
});

console.log('Reasoning:', reasoning);
console.log('Answer:', text);
```

For models that are thinking-only (like `qwen3-235b-a22b-thinking-2507`), thinking mode is enabled by default.

### Tool Calling

Alibaba models support tool calling with parallel execution:

```ts
import { alibaba } from '@ai-sdk/alibaba';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const { text } = await generateText({
  model: alibaba('qwen-plus'),
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

### Prompt Caching

Alibaba supports both implicit and explicit prompt caching to reduce costs for repeated prompts.

**Implicit caching** works automatically - the provider caches appropriate content without any configuration. For more control, you can use **explicit caching** by marking specific messages with `cacheControl`:

### Single message cache control

```ts
import { alibaba } from '@ai-sdk/alibaba';
import { generateText } from 'ai';

const { text, usage } = await generateText({
  model: alibaba('qwen-plus'),
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant. [... long system prompt ...]',
      providerOptions: {
        alibaba: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    },
  ],
});
```

### Multi-part message cache control

```ts
import { alibaba } from '@ai-sdk/alibaba';
import { generateText } from 'ai';

const longDocument = '... large document content ...';

const { text, usage } = await generateText({
  model: alibaba('qwen-plus'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Context: Please analyze this document.',
        },
        {
          type: 'text',
          text: longDocument,
          providerOptions: {
            alibaba: {
              cacheControl: { type: 'ephemeral' },
            },
          },
        },
      ],
    },
  ],
});
```

**Note:** The minimum content length for a cache block is 1,024 tokens.

## Video Models

You can create [Wan](https://www.alibabacloud.com/help/en/model-studio/use-video-generation) video models that call the Alibaba Cloud DashScope API
using the `.video()` factory method. For more on video generation with the AI SDK see [generateVideo()](/docs/reference/ai-sdk-core/generate-video).

Alibaba supports three video generation modes: text-to-video, image-to-video (first frame), and reference-to-video.

### Text-to-Video

Generate videos from text prompts:

```ts
import { alibaba, type AlibabaVideoModelOptions } from '@ai-sdk/alibaba';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: alibaba.video('wan2.6-t2v'),
  prompt: 'A serene mountain lake at sunset with gentle ripples on the water.',
  resolution: '1280x720',
  duration: 5,
  providerOptions: {
    alibaba: {
      promptExtend: true,
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies AlibabaVideoModelOptions,
  },
});
```

### Image-to-Video

Generate videos from a first-frame image and optional text prompt:

```ts
import { alibaba, type AlibabaVideoModelOptions } from '@ai-sdk/alibaba';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: alibaba.video('wan2.6-i2v'),
  prompt: {
    image: 'https://example.com/landscape.jpg',
    text: 'Camera slowly pans across the landscape',
  },
  duration: 5,
  providerOptions: {
    alibaba: {
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies AlibabaVideoModelOptions,
  },
});
```

### Reference-to-Video

Generate videos using reference images and/or videos for character consistency. Use character identifiers
(`character1`, `character2`, etc.) in your prompt to reference them:

```ts
import { alibaba, type AlibabaVideoModelOptions } from '@ai-sdk/alibaba';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: alibaba.video('wan2.6-r2v-flash'),
  prompt: 'character1 walks through a beautiful garden and waves at the camera',
  resolution: '1280x720',
  duration: 5,
  providerOptions: {
    alibaba: {
      referenceUrls: ['https://example.com/character-reference.jpg'],
      pollTimeoutMs: 600000, // 10 minutes
    } satisfies AlibabaVideoModelOptions,
  },
});
```

### Video Provider Options

The following provider options are available via `providerOptions.alibaba`:

- **negativePrompt** _string_

  A description of what to avoid in the generated video (max 500 characters).

- **audioUrl** _string_

  URL to an audio file for audio-video sync (WAV/MP3, 3-30 seconds, max 15MB).

- **promptExtend** _boolean_

  Enable prompt extension/rewriting for better generation quality. Defaults to `true`.

- **shotType** `'single'` | `'multi'`

  Shot type for video generation. `'multi'` enables multi-shot cinematic narrative (wan2.6 models only).

- **watermark** _boolean_

  Whether to add a watermark to the generated video. Defaults to `false`.

- **audio** _boolean_

  Whether to generate audio (for I2V and R2V models that support it).

- **referenceUrls** _string[]_

  Array of reference image/video URLs for reference-to-video mode. Supports 0-5 images and 0-3 videos, max 5 total.

- **pollIntervalMs** _number_

  Polling interval in milliseconds for checking task status. Defaults to 5000.

- **pollTimeoutMs** _number_

  Maximum wait time in milliseconds for video generation. Defaults to 600000 (10 minutes).

<Note>
  Video generation is an asynchronous process that can take several minutes.
  Consider setting `pollTimeoutMs` to at least 10 minutes (600000ms) for
  reliable operation.
</Note>

### Video Model Capabilities

#### Text-to-Video

| Model                | Audio | Resolution        | Duration |
| -------------------- | ----- | ----------------- | -------- |
| `wan2.6-t2v`         | Yes   | 720P, 1080P       | 2-15s    |
| `wan2.5-t2v-preview` | Yes   | 480P, 720P, 1080P | 5s, 10s  |

#### Image-to-Video (First Frame)

| Model              | Audio    | Resolution  | Duration |
| ------------------ | -------- | ----------- | -------- |
| `wan2.6-i2v-flash` | Optional | 720P, 1080P | 2-15s    |
| `wan2.6-i2v`       | Yes      | 720P, 1080P | 2-15s    |

#### Reference-to-Video

| Model              | Audio    | Resolution  | Duration |
| ------------------ | -------- | ----------- | -------- |
| `wan2.6-r2v-flash` | Optional | 720P, 1080P | 2-10s    |
| `wan2.6-r2v`       | Yes      | 720P, 1080P | 2-10s    |

<Note>
  The tables above list models available in the Singapore International region.
  You can also pass any available provider model ID as a string if needed.
</Note>

## Model Capabilities

Please see the [Alibaba Cloud Model Studio docs](https://www.alibabacloud.com/help/en/model-studio/models) for a full
list of available models. You can also pass any available provider model ID as
a string if needed.

---
title: Cerebras
description: Learn how to use Cerebras's models with the AI SDK.
---

# Cerebras Provider

The [Cerebras](https://cerebras.ai) provider offers access to powerful language models through the Cerebras API, including their high-speed inference capabilities powered by Wafer-Scale Engines and CS-3 systems.

API keys can be obtained from the [Cerebras Platform](https://cloud.cerebras.ai).

## Setup

The Cerebras provider is available via the `@ai-sdk/cerebras` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/cerebras" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/cerebras" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/cerebras" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/cerebras" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `cerebras` from `@ai-sdk/cerebras`:

```ts
import { cerebras } from '@ai-sdk/cerebras';
```

For custom configuration, you can import `createCerebras` and create a provider instance with your settings:

```ts
import { createCerebras } from '@ai-sdk/cerebras';

const cerebras = createCerebras({
  apiKey: process.env.CEREBRAS_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Cerebras provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls.
  The default prefix is `https://api.cerebras.ai/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `CEREBRAS_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Language Models

You can create language models using a provider instance:

```ts
import { cerebras } from '@ai-sdk/cerebras';
import { generateText } from 'ai';

const { text } = await generateText({
  model: cerebras('llama3.1-8b'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Cerebras language models can be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

You can create Cerebras language models using a provider instance. The first argument is the model ID, e.g. `llama-3.3-70b`:

```ts
const model = cerebras('llama-3.3-70b');
```

You can also use the `.languageModel()` and `.chat()` methods:

```ts
const model = cerebras.languageModel('llama-3.3-70b');
const model = cerebras.chat('llama-3.3-70b');
```

### Reasoning Models

Cerebras offers several reasoning models including `gpt-oss-120b`, `qwen-3-32b`, and `zai-glm-4.7` that generate intermediate thinking tokens before their final response. The reasoning output is streamed through the standard AI SDK reasoning parts.

For `gpt-oss-120b`, you can control the reasoning depth using the `reasoningEffort` provider option:

```ts
import { cerebras } from '@ai-sdk/cerebras';
import { streamText } from 'ai';

const result = streamText({
  model: cerebras('gpt-oss-120b'),
  providerOptions: {
    cerebras: {
      reasoningEffort: 'medium',
    },
  },
  prompt: 'How many "r"s are in the word "strawberry"?',
});

for await (const part of result.fullStream) {
  if (part.type === 'reasoning') {
    console.log('Reasoning:', part.text);
  } else if (part.type === 'text-delta') {
    process.stdout.write(part.textDelta);
  }
}
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details on how to integrate reasoning into your chatbot.

### Provider Options

The following optional provider options are available for Cerebras language models:

- **reasoningEffort** _'low' | 'medium' | 'high'_

  Controls the depth of reasoning for GPT-OSS models. Defaults to `'medium'`.

- **user** _string_

  A unique identifier representing your end-user, which can help with monitoring and abuse detection.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation. When `true`, the model uses constrained decoding to guarantee schema compliance. Defaults to `true`.

## Model Capabilities

| Model                            | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      | Reasoning           |
| -------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `llama3.1-8b`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `llama-3.3-70b`                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `gpt-oss-120b`                   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `qwen-3-32b`                     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `qwen-3-235b-a22b-instruct-2507` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `qwen-3-235b-a22b-thinking-2507` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `zai-glm-4.6`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `zai-glm-4.7`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The models `qwen-3-32b` and `llama-3.3-70b` are scheduled for deprecation on
  February 16, 2026. Please see the [Cerebras
  docs](https://inference-docs.cerebras.ai/introduction) for more details about
  the available models and migration guidance. You can also pass any available
  provider model ID as a string if needed.
</Note>

---
title: Replicate
description: Learn how to use Replicate models with the AI SDK.
---

# Replicate Provider

[Replicate](https://replicate.com/) is a platform for running open-source AI models.
It is a popular choice for running image generation models.

## Setup

The Replicate provider is available via the `@ai-sdk/replicate` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/replicate" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/replicate" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/replicate" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/replicate" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `replicate` from `@ai-sdk/replicate`:

```ts
import { replicate } from '@ai-sdk/replicate';
```

If you need a customized setup, you can import `createReplicate` from `@ai-sdk/replicate`
and create a provider instance with your settings:

```ts
import { createReplicate } from '@ai-sdk/replicate';

const replicate = createReplicate({
  apiToken: process.env.REPLICATE_API_TOKEN ?? '',
});
```

You can use the following optional settings to customize the Replicate provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.replicate.com/v1`.

- **apiToken** _string_

  API token that is being sent using the `Authorization` header. It defaults to
  the `REPLICATE_API_TOKEN` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Image Models

You can create Replicate image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

<Note>
  Model support for `size` and other parameters varies by model. Check the
  model's documentation on [Replicate](https://replicate.com/explore) for
  supported options and additional parameters that can be passed via
  `providerOptions.replicate`.
</Note>

### Supported Image Models

The following image models are currently supported by the Replicate provider:

**Text-to-Image Models:**

- [black-forest-labs/flux-1.1-pro-ultra](https://replicate.com/black-forest-labs/flux-1.1-pro-ultra)
- [black-forest-labs/flux-1.1-pro](https://replicate.com/black-forest-labs/flux-1.1-pro)
- [black-forest-labs/flux-dev](https://replicate.com/black-forest-labs/flux-dev)
- [black-forest-labs/flux-pro](https://replicate.com/black-forest-labs/flux-pro)
- [black-forest-labs/flux-schnell](https://replicate.com/black-forest-labs/flux-schnell)
- [bytedance/sdxl-lightning-4step](https://replicate.com/bytedance/sdxl-lightning-4step)
- [fofr/aura-flow](https://replicate.com/fofr/aura-flow)
- [fofr/latent-consistency-model](https://replicate.com/fofr/latent-consistency-model)
- [fofr/realvisxl-v3-multi-controlnet-lora](https://replicate.com/fofr/realvisxl-v3-multi-controlnet-lora)
- [fofr/sdxl-emoji](https://replicate.com/fofr/sdxl-emoji)
- [fofr/sdxl-multi-controlnet-lora](https://replicate.com/fofr/sdxl-multi-controlnet-lora)
- [ideogram-ai/ideogram-v2-turbo](https://replicate.com/ideogram-ai/ideogram-v2-turbo)
- [ideogram-ai/ideogram-v2](https://replicate.com/ideogram-ai/ideogram-v2)
- [lucataco/dreamshaper-xl-turbo](https://replicate.com/lucataco/dreamshaper-xl-turbo)
- [lucataco/open-dalle-v1.1](https://replicate.com/lucataco/open-dalle-v1.1)
- [lucataco/realvisxl-v2.0](https://replicate.com/lucataco/realvisxl-v2.0)
- [lucataco/realvisxl2-lcm](https://replicate.com/lucataco/realvisxl2-lcm)
- [luma/photon-flash](https://replicate.com/luma/photon-flash)
- [luma/photon](https://replicate.com/luma/photon)
- [nvidia/sana](https://replicate.com/nvidia/sana)
- [playgroundai/playground-v2.5-1024px-aesthetic](https://replicate.com/playgroundai/playground-v2.5-1024px-aesthetic)
- [recraft-ai/recraft-v3-svg](https://replicate.com/recraft-ai/recraft-v3-svg)
- [recraft-ai/recraft-v3](https://replicate.com/recraft-ai/recraft-v3)
- [stability-ai/stable-diffusion-3.5-large-turbo](https://replicate.com/stability-ai/stable-diffusion-3.5-large-turbo)
- [stability-ai/stable-diffusion-3.5-large](https://replicate.com/stability-ai/stable-diffusion-3.5-large)
- [stability-ai/stable-diffusion-3.5-medium](https://replicate.com/stability-ai/stable-diffusion-3.5-medium)
- [tstramer/material-diffusion](https://replicate.com/tstramer/material-diffusion)

**Inpainting and Image Editing Models:**

- [black-forest-labs/flux-fill-pro](https://replicate.com/black-forest-labs/flux-fill-pro)
- [black-forest-labs/flux-fill-dev](https://replicate.com/black-forest-labs/flux-fill-dev)

**Flux-2 Models (Multi-Reference Image Generation):**

These models support up to 8 input reference images for style transfer and composition:

- [black-forest-labs/flux-2-pro](https://replicate.com/black-forest-labs/flux-2-pro)
- [black-forest-labs/flux-2-dev](https://replicate.com/black-forest-labs/flux-2-dev)

You can also use [versioned models](https://replicate.com/docs/topics/models/versions).
The id for versioned models is the Replicate model id followed by a colon and the version ID (`$modelId:$versionId`), e.g.
`bytedance/sdxl-lightning-4step:5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637`.

<Note>
  You can also pass any available Replicate model ID as a string if needed.
</Note>

### Basic Usage

```ts
import { replicate } from '@ai-sdk/replicate';
import { generateImage } from 'ai';
import { writeFile } from 'node:fs/promises';

const { image } = await generateImage({
  model: replicate.image('black-forest-labs/flux-schnell'),
  prompt: 'The Loch Ness Monster getting a manicure',
  aspectRatio: '16:9',
});

await writeFile('image.webp', image.uint8Array);

console.log('Image saved as image.webp');
```

### Model-specific options

```ts highlight="9-11"
import { replicate, type ReplicateImageModelOptions } from '@ai-sdk/replicate';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: replicate.image('recraft-ai/recraft-v3'),
  prompt: 'The Loch Ness Monster getting a manicure',
  size: '1365x1024',
  providerOptions: {
    replicate: {
      style: 'realistic_image',
    } satisfies ReplicateImageModelOptions,
  },
});
```

### Versioned Models

```ts
import { replicate } from '@ai-sdk/replicate';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: replicate.image(
    'bytedance/sdxl-lightning-4step:5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637',
  ),
  prompt: 'The Loch Ness Monster getting a manicure',
});
```

### Image Editing

Replicate supports image editing through various models. Pass input images via `prompt.images` to transform or edit existing images.

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: replicate.image('black-forest-labs/flux-fill-dev'),
  prompt: {
    text: 'Turn the cat into a golden retriever dog',
    images: [imageBuffer],
  },
  providerOptions: {
    replicate: {
      guidance_scale: 7.5,
      num_inference_steps: 30,
    } satisfies ReplicateImageModelOptions,
  },
});
```

#### Inpainting with Mask

Edit specific parts of an image using a mask. For FLUX Fill models, white areas in the mask indicate where the image should be edited:

```ts
const image = readFileSync('./input-image.png');
const mask = readFileSync('./mask.png'); // White = inpaint, black = keep

const { images } = await generateImage({
  model: replicate.image('black-forest-labs/flux-fill-pro'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask: mask,
  },
  providerOptions: {
    replicate: {
      guidance_scale: 7.5,
      num_inference_steps: 30,
    } satisfies ReplicateImageModelOptions,
  },
});
```

#### Multi-Reference Image Generation (Flux-2)

Flux-2 models support up to 8 input reference images for style transfer, composition, and multi-subject generation:

```ts
import { replicate } from '@ai-sdk/replicate';
import { generateImage } from 'ai';

const reference1 = readFileSync('./style-reference.png');
const reference2 = readFileSync('./subject-reference.png');

const { images } = await generateImage({
  model: replicate.image('black-forest-labs/flux-2-pro'),
  prompt: {
    text: 'Combine the style and subjects from the reference images',
    images: [reference1, reference2],
  },
});
```

<Note>
  Flux-2 models use a different input format internally (`input_image`,
  `input_image_2`, etc.) which is handled automatically. Note that Flux-2 models
  do not support mask-based inpainting.
</Note>

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings. Different Replicate models have different parameter
  names and capabilities — check the model's documentation on
  [Replicate](https://replicate.com/explore) for details.
</Note>

### Provider Options

Common provider options for image generation:

- **maxWaitTimeInSeconds** _number_ - Maximum time in seconds to wait for the prediction to complete in sync mode. By default, Replicate uses [sync mode](https://replicate.com/docs/topics/predictions/create-a-prediction#timeout-duration) with a 60-second timeout. Set to a positive number to use a custom duration (e.g., `120` for 2 minutes). When not specified, uses the default 60-second wait.
- **guidance_scale** _number_ - Guidance scale for classifier-free guidance. Higher values make the output more closely match the prompt.
- **num_inference_steps** _number_ - Number of denoising steps. More steps = higher quality but slower.
- **negative_prompt** _string_ - Negative prompt to guide what to avoid in the generation.
- **output_format** _'png' | 'jpg' | 'webp'_ - Output image format.
- **output_quality** _number (1-100)_ - Output image quality. Only applies to jpg and webp.
- **strength** _number (0-1)_ - Strength of the transformation for img2img. Lower values keep more of the original image.

For more details, see the [Replicate models page](https://replicate.com/explore).

---
title: Prodia
description: Learn how to use Prodia models with the AI SDK.
---

# Prodia Provider

[Prodia](https://prodia.com/) is a fast inference platform for generative AI, offering high-speed image generation with FLUX and Stable Diffusion models.

## Setup

The Prodia provider is available via the `@ai-sdk/prodia` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/prodia" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/prodia" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/prodia" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/prodia" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `prodia` from `@ai-sdk/prodia`:

```ts
import { prodia } from '@ai-sdk/prodia';
```

If you need a customized setup, you can import `createProdia` and create a provider instance with your settings:

```ts
import { createProdia } from '@ai-sdk/prodia';

const prodia = createProdia({
  apiKey: 'your-api-key', // optional, defaults to PRODIA_TOKEN environment variable
  baseURL: 'custom-url', // optional
  headers: {
    /* custom headers */
  }, // optional
});
```

You can use the following optional settings to customize the Prodia provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls.
  The default prefix is `https://inference.prodia.com/v2`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header as a Bearer token.
  It defaults to the `PRODIA_TOKEN` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Image Models

You can create Prodia image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

### Basic Usage

```ts
import { writeFileSync } from 'node:fs';
import { prodia } from '@ai-sdk/prodia';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: prodia.image('inference.flux-fast.schnell.txt2img.v2'),
  prompt: 'A cat wearing an intricate robe',
});

const filename = `image-${Date.now()}.png`;
writeFileSync(filename, image.uint8Array);
console.log(`Image saved to ${filename}`);
```

### Model Capabilities

Prodia offers fast inference for various image generation models. Here are the supported model types:

| Model                                    | Description                                          |
| ---------------------------------------- | ---------------------------------------------------- |
| `inference.flux-fast.schnell.txt2img.v2` | Fast FLUX Schnell model for text-to-image generation |
| `inference.flux.schnell.txt2img.v2`      | FLUX Schnell model for text-to-image generation      |

<Note>
  Prodia supports additional model IDs. Check the [Prodia
  documentation](https://docs.prodia.com/) for the full list of available
  models.
</Note>

### Image Size

You can specify the image size using the `size` parameter in `WIDTHxHEIGHT` format:

```ts
import { prodia } from '@ai-sdk/prodia';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: prodia.image('inference.flux-fast.schnell.txt2img.v2'),
  prompt: 'A serene mountain landscape at sunset',
  size: '1024x768',
});
```

### Provider Options

Prodia image models support additional options through the `providerOptions.prodia` object:

```ts
import { prodia, type ProdiaImageModelOptions } from '@ai-sdk/prodia';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: prodia.image('inference.flux-fast.schnell.txt2img.v2'),
  prompt: 'A cat wearing an intricate robe',
  providerOptions: {
    prodia: {
      width: 1024,
      height: 768,
      steps: 4,
      stylePreset: 'cinematic',
    } satisfies ProdiaImageModelOptions,
  },
});
```

The following provider options are supported:

- **width** _number_ - Output width in pixels (256–1920). When set, this overrides any width derived from `size`.
- **height** _number_ - Output height in pixels (256–1920). When set, this overrides any height derived from `size`.
- **steps** _number_ - Number of computational iterations (1–4). More steps typically produce higher quality results.
- **stylePreset** _string_ - Apply a visual theme to the output image. Supported presets: `3d-model`, `analog-film`, `anime`, `cinematic`, `comic-book`, `digital-art`, `enhance`, `fantasy-art`, `isometric`, `line-art`, `low-poly`, `neon-punk`, `origami`, `photographic`, `pixel-art`, `texture`, `craft-clay`.
- **loras** _string[]_ - Augment the output with up to 3 LoRA models.
- **progressive** _boolean_ - When using JPEG output, return a progressive JPEG.

### Seed

You can use the `seed` parameter to get reproducible results:

```ts
import { prodia } from '@ai-sdk/prodia';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: prodia.image('inference.flux-fast.schnell.txt2img.v2'),
  prompt: 'A serene mountain landscape at sunset',
  seed: 12345,
});
```

### Provider Metadata

The `generateImage` response includes provider-specific metadata in `providerMetadata.prodia.images[]`. Each image object may contain the following properties:

- **jobId** _string_ - The unique identifier for the generation job.
- **seed** _number_ - The seed used for generation. Useful for reproducing results.
- **elapsed** _number_ - Generation time in seconds.
- **iterationsPerSecond** _number_ - Processing speed metric.
- **createdAt** _string_ - Timestamp when the job was created.
- **updatedAt** _string_ - Timestamp when the job was last updated.

```ts
import { prodia } from '@ai-sdk/prodia';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: prodia.image('inference.flux-fast.schnell.txt2img.v2'),
  prompt: 'A serene mountain landscape at sunset',
});

// Access provider metadata
const metadata = providerMetadata?.prodia?.images?.[0];
console.log('Job ID:', metadata?.jobId);
console.log('Seed:', metadata?.seed);
console.log('Elapsed:', metadata?.elapsed);
```

---
title: Perplexity
description: Learn how to use Perplexity's Sonar API with the AI SDK.
---

# Perplexity Provider

The [Perplexity](https://sonar.perplexity.ai) provider offers access to Sonar API - a language model that uniquely combines real-time web search with natural language processing. Each response is grounded in current web data and includes detailed citations, making it ideal for research, fact-checking, and obtaining up-to-date information.

API keys can be obtained from the [Perplexity Platform](https://docs.perplexity.ai).

## Setup

The Perplexity provider is available via the `@ai-sdk/perplexity` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/perplexity" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/perplexity" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/perplexity" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/perplexity" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `perplexity` from `@ai-sdk/perplexity`:

```ts
import { perplexity } from '@ai-sdk/perplexity';
```

For custom configuration, you can import `createPerplexity` and create a provider instance with your settings:

```ts
import { createPerplexity } from '@ai-sdk/perplexity';

const perplexity = createPerplexity({
  apiKey: process.env.PERPLEXITY_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Perplexity provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls.
  The default prefix is `https://api.perplexity.ai`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `PERPLEXITY_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Language Models

You can create Perplexity models using a provider instance:

```ts
import { perplexity } from '@ai-sdk/perplexity';
import { generateText } from 'ai';

const { text } = await generateText({
  model: perplexity('sonar-pro'),
  prompt: 'What are the latest developments in quantum computing?',
});
```

### Sources

Websites that have been used to generate the response are included in the `sources` property of the result:

```ts
import { perplexity } from '@ai-sdk/perplexity';
import { generateText } from 'ai';

const { text, sources } = await generateText({
  model: perplexity('sonar-pro'),
  prompt: 'What are the latest developments in quantum computing?',
});

console.log(sources);
```

### Provider Options & Metadata

The Perplexity provider includes additional metadata in the response through `providerMetadata`.
Additional configuration options are available through `providerOptions`.

```ts
const result = await generateText({
  model: perplexity('sonar-pro'),
  prompt: 'What are the latest developments in quantum computing?',
  providerOptions: {
    perplexity: {
      return_images: true, // Enable image responses (Tier-2 Perplexity users only)
      search_recency_filter: 'week', // Filter search results by recency
    },
  },
});

console.log(result.providerMetadata);
// Example output:
// {
//   perplexity: {
//     usage: { citationTokens: 5286, numSearchQueries: 1 },
//     images: [
//       { imageUrl: "https://example.com/image1.jpg", originUrl: "https://elsewhere.com/page1", height: 1280, width: 720 },
//       { imageUrl: "https://example.com/image2.jpg", originUrl: "https://elsewhere.com/page2", height: 1280, width: 720 }
//     ]
//   },
// }
```

#### Provider Options

The following provider-specific options are available:

- **return_images** _boolean_

  Enable image responses. When set to `true`, the response may include relevant images. This feature is only available to Perplexity Tier-2 users and above.

- **search_recency_filter** _string_

  Filter search results by recency. Possible values: `'hour'`, `'day'`, `'week'`, `'month'`. If not specified, defaults to all time.

<Note>
  Any other [Perplexity API
  parameters](https://docs.perplexity.ai/api-reference/chat-completions) can
  also be passed through `providerOptions.perplexity`.
</Note>

#### Provider Metadata

The response metadata includes:

- `usage`: Object containing `citationTokens` and `numSearchQueries` metrics
- `images`: Array of image objects when `return_images` is enabled (Tier-2 users only). Each image contains `imageUrl`, `originUrl`, `height`, and `width`.

### PDF Support

The Perplexity provider supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: perplexity('sonar-pro'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is this document about?',
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

You can also pass the URL of a PDF:

```ts
{
  type: 'file',
  data: new URL('https://example.com/document.pdf'),
  mediaType: 'application/pdf',
  filename: 'document.pdf', // optional
}
```

The model will have access to the contents of the PDF file and
respond to questions about it.

<Note>
  For more details about Perplexity's capabilities, see the [Perplexity chat
  completion docs](https://docs.perplexity.ai/api-reference/chat-completions).
</Note>

## Model Capabilities

| Model                 | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| --------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `sonar-deep-research` | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `sonar-reasoning-pro` | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `sonar-reasoning`     | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `sonar-pro`           | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `sonar`               | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  Please see the [Perplexity docs](https://docs.perplexity.ai) for detailed API
  documentation and the latest updates.
</Note>

---
title: Luma
description: Learn how to use Luma AI models with the AI SDK.
---

# Luma Provider

[Luma AI](https://lumalabs.ai/) provides state-of-the-art image generation models through their Dream Machine platform. Their models offer ultra-high quality image generation with superior prompt understanding and unique capabilities like character consistency and multi-image reference support.

## Setup

The Luma provider is available via the `@ai-sdk/luma` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/luma" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/luma" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/luma" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/luma" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `luma` from `@ai-sdk/luma`:

```ts
import { luma } from '@ai-sdk/luma';
```

If you need a customized setup, you can import `createLuma` and create a provider instance with your settings:

```ts
import { createLuma } from '@ai-sdk/luma';

const luma = createLuma({
  apiKey: 'your-api-key', // optional, defaults to LUMA_API_KEY environment variable
  baseURL: 'custom-url', // optional
  headers: {
    /* custom headers */
  }, // optional
});
```

You can use the following optional settings to customize the Luma provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.lumalabs.ai`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `LUMA_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Image Models

You can create Luma image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

### Basic Usage

```ts
import { luma, type LumaImageModelOptions } from '@ai-sdk/luma';
import { generateImage } from 'ai';
import fs from 'fs';

const { image } = await generateImage({
  model: luma.image('photon-1'),
  prompt: 'A serene mountain landscape at sunset',
  aspectRatio: '16:9',
});

const filename = `image-${Date.now()}.png`;
fs.writeFileSync(filename, image.uint8Array);
console.log(`Image saved to ${filename}`);
```

### Image Model Settings

You can customize the generation behavior with optional settings:

```ts
const { image } = await generateImage({
  model: luma.image('photon-1'),
  prompt: 'A serene mountain landscape at sunset',
  aspectRatio: '16:9',
  maxImagesPerCall: 1, // Maximum number of images to generate per API call
  providerOptions: {
    luma: {
      pollIntervalMillis: 5000, // How often to check for completed images (in ms)
      maxPollAttempts: 10, // Maximum number of polling attempts before timeout
    },
  } satisfies LumaImageModelOptions,
});
```

Since Luma processes images through an asynchronous queue system, these settings allow you to tune the polling behavior:

- **maxImagesPerCall** _number_

  Override the maximum number of images generated per API call. Defaults to 1.

- **pollIntervalMillis** _number_

  Control how frequently the API is checked for completed images while they are
  being processed. Defaults to 500ms.

- **maxPollAttempts** _number_

  Limit how long to wait for results before timing out, since image generation
  is queued asynchronously. Defaults to 120 attempts.

### Model Capabilities

Luma offers two main models:

| Model            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `photon-1`       | High-quality image generation with superior prompt understanding |
| `photon-flash-1` | Faster generation optimized for speed while maintaining quality  |

Both models support the following aspect ratios:

- 1:1
- 3:4
- 4:3
- 9:16
- 16:9 (default)
- 9:21
- 21:9

For more details about supported aspect ratios, see the [Luma Image Generation documentation](https://docs.lumalabs.ai/docs/image-generation).

Key features of Luma models include:

- Ultra-high quality image generation
- 10x higher cost efficiency compared to similar models
- Superior prompt understanding and adherence
- Unique character consistency capabilities from single reference images
- Multi-image reference support for precise style matching

### Image editing

Luma supports different modes of generating images that reference other images.

#### Modify an image

Images have to be passed as URLs. `weight` can be configured for each image in the `providerOptions.luma.images` array.

```ts
await generateImage({
  model: luma.image('photon-flash-1'),
  prompt: {
    text: 'transform the bike to a boat',
    images: [
      'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/future-me-8hcBWcZOkbE53q3gshhEm16S87qDpF.jpeg',
    ],
  },
  providerOptions: {
    luma: {
      referenceType: 'modify_image',
      images: [{ weight: 1.0 }],
    } satisfies LumaImageModelOptions,
  },
});
```

Learn more at https://docs.lumalabs.ai/docs/image-generation#modify-image.

#### Reference an image

Use up to 4 reference images to guide your generation. Useful for creating variations or visualizing complex concepts. Adjust the `weight` for each image (0-1) to control the influence of reference images.

```ts
await generateImage({
  model: luma.image('photon-flash-1'),
  prompt: {
    text: 'A salamander at dusk in a forest pond, in the style of ukiyo-e',
    images: [
      'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/future-me-8hcBWcZOkbE53q3gshhEm16S87qDpF.jpeg',
    ],
  },
  aspectRatio: '1:1',
  providerOptions: {
    luma: {
      referenceType: 'image',
      images: [{ weight: 0.8 }],
    } satisfies LumaImageModelOptions,
  },
});
```

Learn more at https://docs.lumalabs.ai/docs/image-generation#image-reference

#### Style Reference

Apply specific visual styles to your generations using reference images. Control the style influence using the `weight` parameter.

```ts
await generateImage({
  model: luma.image('photon-flash-1'),
  prompt: {
    text: 'A blue cream Persian cat launching its website on Vercel',
    images: [
      'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/future-me-8hcBWcZOkbE53q3gshhEm16S87qDpF.jpeg',
    ],
  },
  aspectRatio: '1:1',
  providerOptions: {
    luma: {
      referenceType: 'style',
      images: [{ weight: 0.8 }],
    } satisfies LumaImageModelOptions,
  },
});
```

Learn more at https://docs.lumalabs.ai/docs/image-generation#style-reference

#### Character Reference

Create consistent and personalized characters using up to 4 reference images of the same subject. More reference images improve character representation.

```ts
await generateImage({
  model: luma.image('photon-flash-1'),
  prompt: {
    text: 'A woman with a cat riding a broomstick in a forest',
    images: [
      'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/future-me-8hcBWcZOkbE53q3gshhEm16S87qDpF.jpeg',
    ],
  },
  aspectRatio: '1:1',
  providerOptions: {
    luma: {
      referenceType: 'character',
      images: [
        {
          id: 'identity0',
        },
      ],
    } satisfies LumaImageModelOptions,
  },
});
```

Learn more at https://docs.lumalabs.ai/docs/image-generation#character-reference

---
title: ByteDance
description: Learn how to use ByteDance Seedance video models with the AI SDK.
---

# ByteDance Provider

The [ByteDance](https://www.bytedance.com/) provider contains support for the Seedance family of video generation models through the [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/Video_Generation_API) platform. Seedance provides high-quality text-to-video and image-to-video generation capabilities, including audio-video synchronization, first-and-last frame control, and multi-reference image generation.

## Setup

The ByteDance provider is available via the `@ai-sdk/bytedance` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/bytedance" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/bytedance" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/bytedance" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/bytedance" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `byteDance` from `@ai-sdk/bytedance`:

```ts
import { byteDance } from '@ai-sdk/bytedance';
```

If you need a customized setup, you can import `createByteDance` and create a provider instance with your settings:

```ts
import { createByteDance } from '@ai-sdk/bytedance';

const byteDance = createByteDance({
  apiKey: 'your-api-key', // optional, defaults to ARK_API_KEY environment variable
  baseURL: 'custom-url', // optional
  headers: {
    /* custom headers */
  }, // optional
});
```

You can use the following optional settings to customize the ByteDance provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://ark.ap-southeast.bytepluses.com/api/v3`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `ARK_API_KEY` environment variable.
  You can [obtain an API key](https://console.byteplus.com/ark/apiKey) from the BytePlus console.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Video Models

You can create ByteDance video models using the `.video()` factory method.
For more on video generation with the AI SDK see [generateVideo()](/docs/reference/ai-sdk-core/generate-video).

### Text-to-Video

Generate videos from text prompts:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('seedance-1-0-pro-250528'),
  prompt:
    'Photorealistic style: Under a clear blue sky, a vast expanse of white daisy fields stretches out. The camera gradually zooms in and fixates on a close-up of a single daisy.',
  aspectRatio: '16:9',
  duration: 5,
  providerOptions: {
    bytedance: {
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});

console.log(video.url);
```

### Image-to-Video

Generate videos from a first-frame image with an optional text prompt:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('seedance-1-5-pro-251215'),
  prompt: {
    image: 'https://example.com/first-frame.png',
    text: 'The cat slowly turns its head and blinks',
  },
  duration: 5,
  providerOptions: {
    bytedance: {
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### Image-to-Video with Audio

Seedance 1.5 Pro supports generating synchronized audio alongside the video:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('seedance-1-5-pro-251215'),
  prompt: {
    image: 'https://example.com/pianist.png',
    text: 'A young man sits at a piano, playing calmly. Gentle piano music plays in sync with his movements.',
  },
  duration: 5,
  providerOptions: {
    bytedance: {
      generateAudio: true,
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### First-and-Last Frame Video

Generate smooth transitions between a starting and ending keyframe image:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('seedance-1-5-pro-251215'),
  prompt: {
    image: 'https://example.com/first-frame.jpg',
    text: 'Create a 360-degree orbiting camera shot based on this photo',
  },
  duration: 5,
  providerOptions: {
    bytedance: {
      lastFrameImage: 'https://example.com/last-frame.jpg',
      generateAudio: true,
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### Multi-Reference Image-to-Video

Using the Seedance 1.0 Lite I2V model, you can provide multiple reference images (1-4) that the model uses to faithfully reproduce object shapes, colors, and textures:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('seedance-1-0-lite-i2v-250428'),
  prompt:
    'A boy wearing glasses and a blue T-shirt from [Image 1] and a corgi dog from [Image 2], sitting on the lawn from [Image 3], in 3D cartoon style',
  aspectRatio: '16:9',
  duration: 5,
  providerOptions: {
    bytedance: {
      referenceImages: [
        'https://example.com/boy.png',
        'https://example.com/corgi.png',
        'https://example.com/lawn.png',
      ],
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### Reference Video

Seedance 2.0 supports reference videos that guide the style, motion, or composition of the generated video:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('dreamina-seedance-2-0-260128'),
  prompt:
    'First-person perspective promotional ad, using the composition and camera movement from the reference video',
  aspectRatio: '16:9',
  duration: 4,
  providerOptions: {
    bytedance: {
      referenceVideos: ['https://example.com/reference-video.mp4'],
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### Reference Audio

Seedance 2.0 supports reference audio that is used as background music or sound for the generated video:

```ts
import {
  byteDance,
  type ByteDanceVideoProviderOptions,
} from '@ai-sdk/bytedance';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: byteDance.video('dreamina-seedance-2-0-260128'),
  prompt:
    'A serene mountain landscape at sunrise with gentle camera movement',
  aspectRatio: '16:9',
  duration: 4,
  providerOptions: {
    bytedance: {
      referenceAudio: ['https://example.com/background-music.mp3'],
      generateAudio: true,
      watermark: false,
    } satisfies ByteDanceVideoProviderOptions,
  },
});
```

### Video Provider Options

The following provider options are available via `providerOptions.bytedance`:

#### Generation Options

- **watermark** _boolean_

  Whether to add a watermark to the generated video.

- **generateAudio** _boolean_

  Whether to generate synchronized audio for the video. Only supported by Seedance 1.5 Pro.

- **cameraFixed** _boolean_

  Whether to fix the camera during generation.

- **returnLastFrame** _boolean_

  Whether to return the last frame of the generated video. Useful for chaining consecutive videos.

- **serviceTier** _'default' | 'flex'_

  Inference tier. `'default'` for online inference. `'flex'` for offline inference at 50% of the price, with higher latency (response times on the order of hours).

- **draft** _boolean_

  Enable draft sample mode for low-cost preview generation. Only supported by Seedance 1.5 Pro. Generates a 480p preview video for rapid iteration before committing to a full-quality generation.

#### Image Input Options

- **lastFrameImage** _string_

  URL of the last frame image for first-and-last frame video generation. The model generates smooth transitions between the first frame (provided via the `image` prompt) and this last frame. Supported by Seedance 1.5 Pro, 1.0 Pro, and 1.0 Lite I2V.

- **referenceImages** _string[]_

  Array of reference image URLs (1-4 images) for multi-reference image-to-video generation. The model extracts key features from each image and reproduces them in the video. Use `[Image 1]`, `[Image 2]`, etc. in your prompt to reference specific images. Supported by Seedance 1.0 Lite I2V.

#### Media Reference Options

- **referenceVideos** _string[]_

  Array of reference video URLs (up to 3 videos, max 15 seconds each) for reference-guided video generation. The model uses the referenced videos to guide style, motion, or composition. Supported by Seedance 2.0.

- **referenceAudio** _string[]_

  Array of reference audio URLs (up to 3, max 15 seconds each) for audio-guided video generation. The model uses the referenced audio as background music or synchronized sound. Supports data URIs (e.g., `data:audio/wav;base64,...`). Supported by Seedance 2.0.

#### Polling Options

- **pollIntervalMs** _number_

  Control how frequently the API is checked for completed videos while they are
  being processed. Defaults to 3000ms.

- **pollTimeoutMs** _number_

  Maximum time to wait for video generation to complete before timing out.
  Defaults to 300000ms (5 minutes).

<Note>
  Video generation is an asynchronous process that can take several minutes.
  Consider setting `pollTimeoutMs` to at least 10 minutes (600000ms) for
  reliable operation.
</Note>

### Video Model Capabilities

| Model                   | Model ID                            | Capabilities                                                                                                                   |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Seedance 2.0            | `dreamina-seedance-2-0-260128`      | T2V, I2V, reference videos (up to 3), reference audio (up to 3), audio-video sync. Duration: 4-15s. Resolution: 480p, 720p.                 |
| Seedance 2.0 Fast       | `dreamina-seedance-2-0-fast-260128` | T2V, I2V, reference videos (up to 3), reference audio (up to 3), audio-video sync. Optimized for speed. Duration: 4-15s. Resolution: 480p, 720p. |
| Seedance 1.5 Pro        | `seedance-1-5-pro-251215`           | T2V, I2V (first frame), I2V (first+last frame), audio-video sync, draft mode. Duration: 4-12s. Resolution: 480p, 720p, 1080p. |
| Seedance 1.0 Pro        | `seedance-1-0-pro-250528`      | T2V, I2V (first frame), I2V (first+last frame). Duration: 2-12s. Resolution: 480p, 720p, 1080p.                               |
| Seedance 1.0 Pro Fast   | `seedance-1-0-pro-fast-251015` | T2V, I2V (first frame). Optimized for speed and cost. Duration: 2-12s.                                                        |
| Seedance 1.0 Lite (T2V) | `seedance-1-0-lite-t2v-250428` | Text-to-video only. Duration: 2-12s. Resolution: 480p, 720p, 1080p.                                                           |
| Seedance 1.0 Lite (I2V) | `seedance-1-0-lite-i2v-250428` | I2V (first frame), I2V (first+last frame), multi-reference images (1-4). Duration: 2-12s. Resolution: 480p, 720p.             |

Supported aspect ratios: `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` (image-to-video only).

All models output MP4 video at 24 fps.

<Note>
  You can also pass any model ID string if needed, e.g. for future models not
  yet listed here.
</Note>

---
title: Kling AI
description: Learn how to use the Kling AI provider for the AI SDK.
---

# Kling AI Provider

The [Kling AI](https://klingai.com/) provider contains support for Kling AI's video generation models, including text-to-video, image-to-video, motion control, and multi-shot video generation.

## Setup

The Kling AI provider is available in the `@ai-sdk/klingai` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/klingai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/klingai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/klingai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/klingai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `klingai` from `@ai-sdk/klingai`:

```ts
import { klingai } from '@ai-sdk/klingai';
```

If you need a customized setup, you can import `createKlingAI` from `@ai-sdk/klingai` and create a provider instance with your settings:

```ts
import { createKlingAI } from '@ai-sdk/klingai';

const klingai = createKlingAI({
  accessKey: 'your-access-key',
  secretKey: 'your-secret-key',
});
```

You can use the following optional settings to customize the Kling AI provider instance:

- **accessKey** _string_

  Kling AI access key. Defaults to the `KLINGAI_ACCESS_KEY` environment variable.

- **secretKey** _string_

  Kling AI secret key. Defaults to the `KLINGAI_SECRET_KEY` environment variable.

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api-singapore.klingai.com`.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Video Models

You can create Kling AI video models using the `.video()` factory method.
For more on video generation with the AI SDK see [generateVideo()](/docs/reference/ai-sdk-core/generate-video).

This provider currently supports three video generation modes: text-to-video, image-to-video, and motion control.

<Note>
  Not all options are supported by every model version and mode combination. See
  the [KlingAI Capability
  Map](https://app.klingai.com/global/dev/document-api/apiReference/model/skillsMap)
  for detailed compatibility across models.
</Note>

### Text-to-Video

Generate videos from text prompts:

```ts
import { klingai, type KlingAIVideoModelOptions } from '@ai-sdk/klingai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { videos } = await generateVideo({
  model: klingai.video('kling-v2.6-t2v'),
  prompt: 'A chicken flying into the sunset in the style of 90s anime.',
  aspectRatio: '16:9',
  duration: 5,
  providerOptions: {
    klingai: {
      mode: 'std',
    } satisfies KlingAIVideoModelOptions,
  },
});
```

### Image-to-Video

Generate videos from a start frame image with an optional text prompt. The popular start+end frame feature is available via the `imageTail` option:

```ts
import { klingai, type KlingAIVideoModelOptions } from '@ai-sdk/klingai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { videos } = await generateVideo({
  model: klingai.video('kling-v2.6-i2v'),
  prompt: {
    image: 'https://example.com/start-frame.png',
    text: 'The cat slowly turns its head and blinks',
  },
  duration: 5,
  providerOptions: {
    klingai: {
      // Pro mode required for start+end frame control
      mode: 'pro',
      // Optional: end frame image
      imageTail: 'https://example.com/end-frame.png',
    } satisfies KlingAIVideoModelOptions,
  },
});
```

### Multi-Shot Video Generation

Generate videos with multiple storyboard shots, each with its own prompt and duration (Kling v3.0+):

```ts
import { klingai, type KlingAIVideoModelOptions } from '@ai-sdk/klingai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { videos } = await generateVideo({
  model: klingai.video('kling-v3.0-t2v'),
  prompt: '',
  aspectRatio: '16:9',
  duration: 10,
  providerOptions: {
    klingai: {
      mode: 'pro',
      multiShot: true,
      shotType: 'customize',
      multiPrompt: [
        {
          index: 1,
          prompt: 'A sunrise over a calm ocean, warm golden light.',
          duration: '4',
        },
        {
          index: 2,
          prompt: 'A flock of seagulls take flight from the beach.',
          duration: '3',
        },
        {
          index: 3,
          prompt: 'Waves crash against rocky cliffs at sunset.',
          duration: '3',
        },
      ],
      sound: 'on',
    } satisfies KlingAIVideoModelOptions,
  },
});
```

Multi-shot also works with image-to-video by combining a start frame image with per-shot prompts.

### Motion Control

Generate video by transferring motion from a reference video to a character image:

```ts
import { klingai, type KlingAIVideoModelOptions } from '@ai-sdk/klingai';
import { experimental_generateVideo as generateVideo } from 'ai';

const { videos } = await generateVideo({
  model: klingai.video('kling-v3.0-motion-control'),
  prompt: {
    image: 'https://example.com/character.png',
    text: 'The character performs a smooth dance move',
  },
  providerOptions: {
    klingai: {
      videoUrl: 'https://example.com/reference-motion.mp4',
      characterOrientation: 'image',
      mode: 'std',
      // Optional: reference element from element library (v3.0+, max 1)
      elementList: [{ element_id: 829836802793406551 }],
    } satisfies KlingAIVideoModelOptions,
  },
});
```

### Video Provider Options

The following provider options are available via `providerOptions.klingai`. Options vary by mode — see the
[KlingAI Capability Map](https://app.klingai.com/global/dev/document-api/apiReference/model/skillsMap) for per-model support.

#### Common Options

- **mode** _'std' | 'pro'_

  Video generation mode. `'std'` is cost-effective. `'pro'` produces higher quality
  but takes longer.

- **pollIntervalMs** _number_

  Polling interval in milliseconds for checking task status. Defaults to 5000.

- **pollTimeoutMs** _number_

  Maximum wait time in milliseconds for video generation. Defaults to 600000 (10 minutes).

- **watermarkEnabled** _boolean_

  Whether to generate watermarked results simultaneously.

#### Text-to-Video and Image-to-Video Options

- **negativePrompt** _string_

  A description of what to avoid in the generated video (max 2500 characters).

- **sound** _'on' | 'off'_

  Whether to generate audio simultaneously. Only V2.6 and subsequent models support this, and requires `mode: 'pro'`.

- **cfgScale** _number_

  Flexibility in video generation. Higher values mean stronger prompt adherence. Range: [0, 1]. Not supported by V2.x models.

- **cameraControl** _object_

  Camera movement control with a `type` preset (`'simple'`, `'down_back'`, `'forward_up'`, `'right_turn_forward'`, `'left_turn_forward'`) and optional `config` with `horizontal`, `vertical`, `pan`, `tilt`, `roll`, `zoom` values (range: [-10, 10]).

- **multiShot** _boolean_

  Enable multi-shot video generation (Kling v3.0+). When true, the video is split into up to 6 storyboard shots with individual prompts and durations.

- **shotType** _'customize' | 'intelligence'_

  Storyboard method for multi-shot generation. `'customize'` uses `multiPrompt` for user-defined shots. `'intelligence'` lets the model auto-segment based on the main prompt. Required when `multiShot` is true.

- **multiPrompt** _Array&lt;\{index, prompt, duration\}&gt;_

  Per-shot details for multi-shot generation. Each shot has an `index` (number), `prompt` (string, max 512 characters), and `duration` (string, in seconds). Shot durations must sum to the total duration. Required when `multiShot` is true and `shotType` is `'customize'`.

- **voiceList** _Array&lt;\{voice_id: string\}&gt;_

  Voice references for voice control (Kling v3.0+). Up to 2 voices. Reference via `<<<voice_1>>>` template syntax in the prompt. Requires `sound: 'on'`. Cannot coexist with `elementList` on the I2V endpoint.

#### Image-to-Video Only Options

- **imageTail** _string_

  End frame image for start+end frame control. Accepts an image URL or raw base64-encoded data. Requires `mode: 'pro'` for most models.

- **staticMask** _string_

  Static brush mask image for motion brush. Accepts an image URL or raw base64-encoded data.

- **dynamicMasks** _Array_

  Dynamic brush configurations for motion brush. Up to 6 groups, each with a `mask` (image URL or base64) and `trajectories` (array of `{x, y}` coordinates).

#### Image-to-Video and Motion Control Options

- **elementList** _Array&lt;\{element_id: number\}&gt;_

  Reference elements for element control (Kling v3.0+). Supports video character elements and multi-image elements. Up to 3 elements for I2V (cannot coexist with `voiceList`). Up to 1 element for motion control.

#### Motion Control Only Options

- **videoUrl** _string_ (required)

  URL of the reference motion video. Supports .mp4/.mov, max 100MB, duration 3–30 seconds.

- **characterOrientation** _'image' | 'video'_ (required)

  Orientation of the characters in the generated video.
  `'image'` matches the reference image orientation (max 10s video).
  `'video'` matches the reference video orientation (max 30s video).

- **keepOriginalSound** _'yes' | 'no'_

  Whether to keep the original sound from the reference video. Defaults to `'yes'`.

<Note>
  Video generation is an asynchronous process that can take several minutes.
  Consider setting `pollTimeoutMs` to at least 10 minutes (600000ms) for
  reliable operation.
</Note>

### Video Model Capabilities

#### Text-to-Video

| Model                   | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `kling-v3.0-t2v`        | Latest v3.0, multi-shot, voice control, sound (3-15s) |
| `kling-v2.6-t2v`        | V2.6, sound in pro mode                               |
| `kling-v2.5-turbo-t2v`  | Optimized for speed, std and pro                      |
| `kling-v2.1-master-t2v` | High-quality generation, pro only                     |
| `kling-v2-master-t2v`   | Master-quality generation                             |
| `kling-v1.6-t2v`        | V1.6 generation, std and pro                          |
| `kling-v1-t2v`          | Original V1 model, supports camera control (std)      |

#### Image-to-Video

| Model                   | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `kling-v3.0-i2v`        | Latest v3.0, multi-shot, element/voice control, sound (3-15s) |
| `kling-v2.6-i2v`        | V2.6, sound and end-frame in pro mode                         |
| `kling-v2.5-turbo-i2v`  | Optimized for speed, end-frame in pro                         |
| `kling-v2.1-master-i2v` | High-quality generation, pro only                             |
| `kling-v2.1-i2v`        | V2.1 generation, end-frame in pro                             |
| `kling-v2-master-i2v`   | Master-quality generation                                     |
| `kling-v1.6-i2v`        | V1.6 generation, end-frame in pro                             |
| `kling-v1.5-i2v`        | V1.5 generation, end-frame and motion brush in pro            |
| `kling-v1-i2v`          | Original V1 model, end-frame and motion brush in std/pro      |

#### Motion Control

| Model                       | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `kling-v3.0-motion-control` | Latest v3.0, enhanced facial consistency via element binding |
| `kling-v2.6-motion-control` | Transfers motion from a reference video to a character image |

<Note>
  You can also pass any available provider model ID as a string if needed.
</Note>

---
title: ElevenLabs
description: Learn how to use the ElevenLabs provider for the AI SDK.
---

# ElevenLabs Provider

The [ElevenLabs](https://elevenlabs.io/) provider contains language model support for the ElevenLabs transcription and speech generation APIs.

## Setup

The ElevenLabs provider is available in the `@ai-sdk/elevenlabs` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/elevenlabs" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/elevenlabs" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/elevenlabs" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/elevenlabs" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `elevenlabs` from `@ai-sdk/elevenlabs`:

```ts
import { elevenlabs } from '@ai-sdk/elevenlabs';
```

If you need a customized setup, you can import `createElevenLabs` from `@ai-sdk/elevenlabs` and create a provider instance with your settings:

```ts
import { createElevenLabs } from '@ai-sdk/elevenlabs';

const elevenlabs = createElevenLabs({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the ElevenLabs provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `ELEVENLABS_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Speech Models

You can create models that call the [ElevenLabs speech API](https://elevenlabs.io/text-to-speech)
using the `.speech()` factory method.

The first argument is the model id e.g. `eleven_multilingual_v2`.

```ts
const model = elevenlabs.speech('eleven_multilingual_v2');
```

The `voice` argument can be set to a voice ID from the [ElevenLabs Voice Library](https://elevenlabs.io/app/voice-library).
You can find voice IDs by selecting a voice in the library and copying its ID.

```ts highlight="6"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { elevenlabs } from '@ai-sdk/elevenlabs';

const result = await generateSpeech({
  model: elevenlabs.speech('eleven_multilingual_v2'),
  text: 'Hello, world!',
  voice: '21m00Tcm4TlvDq8ikWAM', // Rachel voice
});
```

You can also pass additional provider-specific options using the `providerOptions` argument:

```ts highlight="7-9"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import {
  elevenlabs,
  type ElevenLabsSpeechModelOptions,
} from '@ai-sdk/elevenlabs';

const result = await generateSpeech({
  model: elevenlabs.speech('eleven_multilingual_v2'),
  text: 'Hello, world!',
  voice: '21m00Tcm4TlvDq8ikWAM',
  providerOptions: {
    elevenlabs: {
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
      },
    } satisfies ElevenLabsSpeechModelOptions,
  },
});
```

- **languageCode** _string or null_  
  Optional. Language code (ISO 639-1) used to enforce a language for the model. Currently, only Turbo v2.5 and Flash v2.5 support language enforcement. For other models, providing a language code will result in an error.

- **voiceSettings** _object or null_  
  Optional. Voice settings that override stored settings for the given voice. These are applied only to the current request.

  - **stability** _double or null_  
    Optional. Determines how stable the voice is and the randomness between each generation. Lower values introduce broader emotional range; higher values result in a more monotonous voice.
  - **useSpeakerBoost** _boolean or null_  
    Optional. Boosts similarity to the original speaker. Increases computational load and latency.
  - **similarityBoost** _double or null_  
    Optional. Controls how closely the AI should adhere to the original voice.
  - **style** _double or null_  
    Optional. Amplifies the style of the original speaker. May increase latency if set above 0.

- **pronunciationDictionaryLocators** _array of objects or null_  
  Optional. A list of pronunciation dictionary locators to apply to the text, in order. Up to 3 locators per request.  
  Each locator object:

  - **pronunciationDictionaryId** _string_ (required)  
    The ID of the pronunciation dictionary.
  - **versionId** _string or null_ (optional)  
    The version ID of the dictionary. If not provided, the latest version is used.

- **seed** _integer or null_  
  Optional. If specified, the system will attempt to sample deterministically. Must be between 0 and 4294967295. Determinism is not guaranteed.

- **previousText** _string or null_  
  Optional. The text that came before the current request's text. Can improve continuity when concatenating generations or influence current generation continuity.

- **nextText** _string or null_  
  Optional. The text that comes after the current request's text. Can improve continuity when concatenating generations or influence current generation continuity.

- **previousRequestIds** _array of strings or null_  
  Optional. List of request IDs for samples generated before this one. Improves continuity when splitting large tasks. Max 3 IDs. If both `previousText` and `previousRequestIds` are sent, `previousText` is ignored.

- **nextRequestIds** _array of strings or null_  
  Optional. List of request IDs for samples generated after this one. Useful for maintaining continuity when regenerating a sample. Max 3 IDs. If both `nextText` and `nextRequestIds` are sent, `nextText` is ignored.

- **applyTextNormalization** _enum_  
  Optional. Controls text normalization.  
  Allowed values: `'auto'` (default), `'on'`, `'off'`.

  - `'auto'`: System decides whether to apply normalization (e.g., spelling out numbers).
  - `'on'`: Always apply normalization.
  - `'off'`: Never apply normalization.  
    For `eleven_turbo_v2_5` and `eleven_flash_v2_5`, can only be enabled with Enterprise plans.

- **applyLanguageTextNormalization** _boolean_  
  Optional. Defaults to `false`. Controls language text normalization, which helps with proper pronunciation in some supported languages (currently only Japanese). May significantly increase latency.

- **enableLogging** _boolean_  
  Optional. Whether to enable request logging for this API call. Defaults to the account-level setting.

### Model Capabilities

| Model                    | Instructions        |
| ------------------------ | ------------------- |
| `eleven_v3`              | <Check size={18} /> |
| `eleven_multilingual_v2` | <Check size={18} /> |
| `eleven_flash_v2_5`      | <Check size={18} /> |
| `eleven_flash_v2`        | <Check size={18} /> |
| `eleven_turbo_v2_5`      | <Check size={18} /> |
| `eleven_turbo_v2`        | <Check size={18} /> |
| `eleven_monolingual_v1`  | <Check size={18} /> |
| `eleven_multilingual_v1` | <Check size={18} /> |

## Transcription Models

You can create models that call the [ElevenLabs transcription API](https://elevenlabs.io/speech-to-text)
using the `.transcription()` factory method.

The first argument is the model id e.g. `scribe_v1`.

```ts
const model = elevenlabs.transcription('scribe_v1');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the input language in ISO-639-1 (e.g. `en`) format can sometimes improve transcription performance if known beforehand.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import {
  elevenlabs,
  type ElevenLabsTranscriptionModelOptions,
} from '@ai-sdk/elevenlabs';

const result = await transcribe({
  model: elevenlabs.transcription('scribe_v1'),
  audio: new Uint8Array([1, 2, 3, 4]),
  providerOptions: {
    elevenlabs: {
      languageCode: 'en',
    } satisfies ElevenLabsTranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **languageCode** _string_

  An ISO-639-1 or ISO-639-3 language code corresponding to the language of the audio file.
  Can sometimes improve transcription performance if known beforehand.
  Defaults to `null`, in which case the language is predicted automatically.

- **tagAudioEvents** _boolean_

  Whether to tag audio events like (laughter), (footsteps), etc. in the transcription.
  Defaults to `true`.

- **numSpeakers** _integer_

  The maximum amount of speakers talking in the uploaded file.
  Can help with predicting who speaks when.
  The maximum amount of speakers that can be predicted is 32.
  Defaults to `null`, in which case the amount of speakers is set to the maximum value the model supports.

- **timestampsGranularity** _enum_

  The granularity of the timestamps in the transcription.
  Defaults to `'word'`.
  Allowed values: `'none'`, `'word'`, `'character'`.

- **diarize** _boolean_

  Whether to annotate which speaker is currently talking in the uploaded file.
  Defaults to `true`.

- **fileFormat** _enum_

  The format of input audio.
  Defaults to `'other'`.
  Allowed values: `'pcm_s16le_16'`, `'other'`.
  For `'pcm_s16le_16'`, the input audio must be 16-bit PCM at a 16kHz sample rate, single channel (mono), and little-endian byte order.
  Latency will be lower than with passing an encoded waveform.

### Model Capabilities

| Model                    | Transcription       | Duration            | Segments            | Language            |
| ------------------------ | ------------------- | ------------------- | ------------------- | ------------------- |
| `scribe_v1`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `scribe_v1_experimental` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: LM Studio
description: Use the LM Studio OpenAI compatible API with the AI SDK.
---

# LM Studio Provider

[LM Studio](https://lmstudio.ai/) is a user interface for running local models.

It contains an OpenAI compatible API server that you can use with the AI SDK.
You can start the local server under the [Local Server tab](https://lmstudio.ai/docs/basics/server) in the LM Studio UI ("Start Server" button).

## Setup

The LM Studio provider is available via the `@ai-sdk/openai-compatible` module as it is compatible with the OpenAI API.
You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai-compatible" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/openai-compatible" dark />
  </Tab>
</Tabs>

## Provider Instance

To use LM Studio, you can create a custom provider instance with the `createOpenAICompatible` function from `@ai-sdk/openai-compatible`:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
});
```

<Note>
  LM Studio uses port `1234` by default, but you can change in the [app's Local
  Server tab](https://lmstudio.ai/docs/basics/server).
</Note>

## Language Models

You can interact with local LLMs in [LM Studio](https://lmstudio.ai/docs/basics/server#endpoints-overview) using a provider instance.
The first argument is the model id, e.g. `llama-3.2-1b`.

```ts
const model = lmstudio('llama-3.2-1b');
```

###### To be able to use a model, you need to [download it first](https://lmstudio.ai/docs/basics/download-model).

### Example

You can use LM Studio language models to generate text with the `generateText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'https://localhost:1234/v1',
});

const { text } = await generateText({
  model: lmstudio('llama-3.2-1b'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  maxRetries: 1, // immediately error if the server is not running
});
```

LM Studio language models can also be used with `streamText`.

## Embedding Models

You can create models that call the [LM Studio embeddings API](https://lmstudio.ai/docs/basics/server#endpoints-overview)
using the `.embeddingModel()` factory method.

```ts
const model = lmstudio.embeddingModel('text-embedding-nomic-embed-text-v1.5');
```

### Example - Embedding a Single Value

```tsx
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'https://localhost:1234/v1',
});

// 'embedding' is a single embedding object (number[])
const { embedding } = await embed({
  model: lmstudio.embeddingModel('text-embedding-nomic-embed-text-v1.5'),
  value: 'sunny day at the beach',
});
```

### Example - Embedding Many Values

When loading data, e.g. when preparing a data store for retrieval-augmented generation (RAG),
it is often useful to embed many values at once (batch embedding).

The AI SDK provides the [`embedMany`](/docs/reference/ai-sdk-core/embed-many) function for this purpose.
Similar to `embed`, you can use it with embeddings models,
e.g. `lmstudio.embeddingModel('text-embedding-nomic-embed-text-v1.5')` or `lmstudio.embeddingModel('text-embedding-bge-small-en-v1.5')`.

```tsx
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany } from 'ai';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'https://localhost:1234/v1',
});

// 'embeddings' is an array of embedding objects (number[][]).
// It is sorted in the same order as the input values.
const { embeddings } = await embedMany({
  model: lmstudio.embeddingModel('text-embedding-nomic-embed-text-v1.5'),
  values: [
    'sunny day at the beach',
    'rainy afternoon in the city',
    'snowy night in the mountains',
  ],
});
```

---
title: NVIDIA NIM
description: Use NVIDIA NIM OpenAI compatible API with the AI SDK.
---

# NVIDIA NIM Provider

[NVIDIA NIM](https://www.nvidia.com/en-us/ai/) provides optimized inference microservices for deploying foundation models. It offers an OpenAI-compatible API that you can use with the AI SDK.

## Setup

The NVIDIA NIM provider is available via the `@ai-sdk/openai-compatible` module as it is compatible with the OpenAI API.
You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai-compatible" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/openai-compatible" dark />
  </Tab>
</Tabs>

## Provider Instance

To use NVIDIA NIM, you can create a custom provider instance with the `createOpenAICompatible` function from `@ai-sdk/openai-compatible`:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
  },
});
```

<Note>
  You can obtain an API key and free credits by registering at [NVIDIA
  Build](https://build.nvidia.com/explore/discover). New users receive 1,000
  inference credits to get started.
</Note>

## Language Models

You can interact with NIM models using a provider instance. For example, to use [DeepSeek-R1](https://build.nvidia.com/deepseek-ai/deepseek-r1), a powerful open-source language model:

```ts
const model = nim.chatModel('deepseek-ai/deepseek-r1');
```

### Example - Generate Text

You can use NIM language models to generate text with the `generateText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
  },
});

const { text, usage, finishReason } = await generateText({
  model: nim.chatModel('deepseek-ai/deepseek-r1'),
  prompt: 'Tell me the history of the San Francisco Mission-style burrito.',
});

console.log(text);
console.log('Token usage:', usage);
console.log('Finish reason:', finishReason);
```

### Example - Stream Text

NIM language models can also generate text in a streaming fashion with the `streamText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
  },
});

const result = streamText({
  model: nim.chatModel('deepseek-ai/deepseek-r1'),
  prompt: 'Tell me the history of the Northern White Rhino.',
});

for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}

console.log();
console.log('Token usage:', await result.usage);
console.log('Finish reason:', await result.finishReason);
```

NIM language models also support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output).

<Note>
  Model support for tool calls and structured output varies. For example, the
  [`meta/llama-3.3-70b-instruct`](https://build.nvidia.com/meta/llama-3_3-70b-instruct)
  model supports structured output capabilities. Check each model's
  documentation on NVIDIA Build for specific supported features.
</Note>

---
title: Clarifai
description: Use Clarifai OpenAI compatible API with the AI SDK.
---

# Clarifai Provider

[Clarifai](https://docs.clarifai.com/getting-started/quickstart) is a platform for building, deploying, and scaling AI-powered applications. It provides a suite of tools and APIs for computer vision, natural language processing, and generative AI. Clarifai offers an OpenAI-compatible API through its full-stack AI development platform, making it easy to integrate powerful AI capabilities using the AI SDK.

## Setup

The Clarifai provider is available via the `@ai-sdk/openai-compatible` module as it is compatible with the OpenAI API. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai-compatible" dark />
  </Tab>
</Tabs>

## Provider Instance

To use Clarifai, you can create a custom provider instance with the `createOpenAICompatible` function from `@ai-sdk/openai-compatible`:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const clarifai = createOpenAICompatible({
  name: 'clarifai',
  baseURL: 'https://api.clarifai.com/v2/ext/openai/v1',
  apiKey: process.env.CLARIFAI_PAT,
});
```

<Note>
  You can obtain an API key by creating a Personal Access Token (PAT) in your Clarifai [account settings](https://clarifai.com/settings/security). Make sure to set the `CLARIFAI_PAT` environment variable with your PAT.

New users can sign up for a free account on [Clarifai](https://clarifai.com/signup) to get started.

</Note>

## Language Models

You can interact with various large language models (LLMs) available on Clarifai using the provider instance. For example, to use [DeepSeek-R1](https://clarifai.com/deepseek-ai/deepseek-chat/models/DeepSeek-R1-0528-Qwen3-8B), a powerful open-source language model:

```ts
const model = clarifai.chatModel(
  'https://clarifai.com/deepseek-ai/deepseek-chat/models/DeepSeek-R1-0528-Qwen3-8B',
);
```

### Example - Generate Text

You can use Clarifai language models to generate text with the `generateText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const clarifai = createOpenAICompatible({
  name: 'clarifai',
  baseURL: 'https://api.clarifai.com/v2/ext/openai/v1',
  apiKey: process.env.CLARIFAI_PAT,
});

const model = clarifai.chatModel(
  'https://clarifai.com/deepseek-ai/deepseek-chat/models/DeepSeek-R1-0528-Qwen3-8B',
);

const { text, usage, finishReason } = await generateText({
  model,
  prompt: 'What is photosynthesis?',
});

console.log(text);
console.log('Token usage:', usage);
console.log('Finish reason:', finishReason);
```

### Example - Streaming Text

You can also stream text responses from Clarifai models using the `streamText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

const clarifai = createOpenAICompatible({
  name: 'clarifai',
  baseURL: 'https://api.clarifai.com/v2/ext/openai/v1',
  apiKey: process.env.CLARIFAI_PAT,
});

const model = clarifai.chatModel(
  'https://clarifai.com/deepseek-ai/deepseek-chat/models/DeepSeek-R1-0528-Qwen3-8B',
);

const result = streamText({
  model,
  prompt: 'What is photosynthesis?',
});

for await (const message of result.textStream) {
  console.log(message);
}
```

For full list of available models, you can refer to the [Clarifai Model Gallery](https://clarifai.com/explore).

---
title: Heroku
description: Use a Heroku OpenAI compatible API with the AI SDK.
---

# Heroku Provider

[Heroku](https://heroku.com/) is a cloud platform that allows you to deploy and run applications, including AI models with OpenAI API compatibility.
You can deploy models that are OpenAI API compatible and use them with the AI SDK.

## Setup

The Heroku provider is available via the `@ai-sdk/openai-compatible` module as it is compatible with the OpenAI API.
You can install it with

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai-compatible" dark />
  </Tab>
</Tabs>

### Heroku Setup

1. Create a test app in Heroku:

```bash
heroku create
```

2. Inference using claude-3-5-haiku:

```bash
heroku ai:models:create -a $APP_NAME claude-3-5-haiku
```

3. Export Variables:

```bash
export INFERENCE_KEY=$(heroku config:get INFERENCE_KEY -a $APP_NAME)
export INFERENCE_MODEL_ID=$(heroku config:get INFERENCE_MODEL_ID -a $APP_NAME)
export INFERENCE_URL=$(heroku config:get INFERENCE_URL -a $APP_NAME)
```

## Provider Instance

To use Heroku, you can create a custom provider instance with the `createOpenAICompatible` function from `@ai-sdk/openai-compatible`:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const heroku = createOpenAICompatible({
  name: 'heroku',
  baseURL: process.env.INFERENCE_URL + '/v1',
  apiKey: process.env.INFERENCE_KEY,
});
```

Be sure to have your `INFERENCE_KEY`, `INFERENCE_MODEL_ID`, and `INFERENCE_URL` set in your environment variables.

## Language Models

You can create Heroku models using a provider instance.
The first argument is the served model name, e.g. `claude-3-5-haiku`.

```ts
const model = heroku('claude-3-5-haiku');
```

### Example

You can use Heroku language models to generate text with the `generateText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const heroku = createOpenAICompatible({
  name: 'heroku',
  baseURL: process.env.INFERENCE_URL + '/v1',
  apiKey: process.env.INFERENCE_KEY,
});

const { text } = await generateText({
  model: heroku('claude-3-5-haiku'),
  prompt: 'Tell me about yourself in one sentence',
});

console.log(text);
```

Heroku language models are also able to generate text in a streaming fashion with the `streamText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

const heroku = createOpenAICompatible({
  name: 'heroku',
  baseURL: process.env.INFERENCE_URL + '/v1',
  apiKey: process.env.INFERENCE_KEY,
});

const result = streamText({
  model: heroku('claude-3-5-haiku'),
  prompt: 'Tell me about yourself in one sentence',
});

for await (const message of result.textStream) {
  console.log(message);
}
```

Heroku language models also support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output).

---
title: OpenAI Compatible Providers
description: Use OpenAI compatible providers with the AI SDK.
---

# OpenAI Compatible Providers

You can use the [OpenAI Compatible Provider](https://www.npmjs.com/package/@ai-sdk/openai-compatible) package to use language model providers that implement the OpenAI API.

Below we focus on the general setup and provider instance creation. You can also [write a custom provider package leveraging the OpenAI Compatible package](/providers/openai-compatible-providers/custom-providers).

We provide detailed documentation for the following OpenAI compatible providers:

- [LM Studio](/providers/openai-compatible-providers/lmstudio)
- [NIM](/providers/openai-compatible-providers/nim)
- [Heroku](/providers/openai-compatible-providers/heroku)
- [Clarifai](/providers/openai-compatible-providers/clarifai)

The general setup and provider instance creation is the same for all of these providers.

## Setup

The OpenAI Compatible provider is available via the `@ai-sdk/openai-compatible` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/openai-compatible" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/openai-compatible" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/openai-compatible" dark />
  </Tab>
</Tabs>

## Provider Instance

To use an OpenAI compatible provider, you can create a custom provider instance with the `createOpenAICompatible` function from `@ai-sdk/openai-compatible`:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
  includeUsage: true, // Include usage information in streaming responses
});
```

You can use the following optional settings to customize the provider instance:

- **baseURL** _string_

  Set the URL prefix for API calls.

- **apiKey** _string_

  API key for authenticating requests. If specified, adds an `Authorization`
  header to request headers with the value `Bearer <apiKey>`. This will be added
  before any headers potentially specified in the `headers` option.

- **headers** _Record&lt;string,string&gt;_

  Optional custom headers to include in requests. These will be added to request headers
  after any headers potentially added by use of the `apiKey` option.

- **queryParams** _Record&lt;string,string&gt;_

  Optional custom url query parameters to include in request urls.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **includeUsage** _boolean_

  Include usage information in streaming responses. When enabled, usage data will be included in the response metadata for streaming requests. Defaults to `undefined` (`false`).

- **supportsStructuredOutputs** _boolean_

  Set to true if the provider supports structured outputs. Only relevant for `provider()`, `provider.chatModel()`, and `provider.languageModel()`.

- **transformRequestBody** _(args: Record&lt;string, any&gt;) =&gt; Record&lt;string, any&gt;_

  Optional function to transform the request body before sending it to the API.
  This is useful for proxy providers that may require a different request format
  than the official OpenAI API.

- **metadataExtractor** _MetadataExtractor_

  Optional metadata extractor to capture provider-specific metadata from API responses.
  See [Custom Metadata Extraction](#custom-metadata-extraction) for details.

## Language Models

You can create provider models using a provider instance.
The first argument is the model id, e.g. `model-id`.

```ts
const model = provider('model-id');
```

You can also use the following factory methods:

- `provider.languageModel('model-id')` - creates a chat language model (same as `provider('model-id')`)
- `provider.chatModel('model-id')` - creates a chat language model

### Supported Capabilities

Chat models created with this provider support the following capabilities:

- **Text generation** - Generate text completions
- **Streaming** - Stream text responses in real-time
- **Tool calling** - Call tools/functions with streaming support
- **Structured outputs** - Generate JSON with schema validation (when `supportsStructuredOutputs` is enabled)
- **Reasoning content** - Support for models that return reasoning/thinking tokens (e.g., DeepSeek R1)
- **System messages** - Support for system prompts
- **Multi-modal inputs** - Support for images and other content types (provider-dependent)

### Example

You can use provider language models to generate text with the `generateText` function:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const { text } = await generateText({
  model: provider('model-id'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

### Including model ids for auto-completion

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

type ExampleChatModelIds =
  | 'meta-llama/Llama-3-70b-chat-hf'
  | 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
  | (string & {});

type ExampleCompletionModelIds =
  | 'codellama/CodeLlama-34b-Instruct-hf'
  | 'Qwen/Qwen2.5-Coder-32B-Instruct'
  | (string & {});

type ExampleEmbeddingModelIds =
  | 'BAAI/bge-large-en-v1.5'
  | 'bert-base-uncased'
  | (string & {});

type ExampleImageModelIds = 'dall-e-3' | 'stable-diffusion-xl' | (string & {});

const model = createOpenAICompatible<
  ExampleChatModelIds,
  ExampleCompletionModelIds,
  ExampleEmbeddingModelIds,
  ExampleImageModelIds
>({
  name: 'example',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.example.com/v1',
});

// Subsequent calls to e.g. `model.chatModel` will auto-complete the model id
// from the list of `ExampleChatModelIds` while still allowing free-form
// strings as well.

const { text } = await generateText({
  model: model.chatModel('meta-llama/Llama-3-70b-chat-hf'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

### Custom query parameters

Some providers may require custom query parameters. An example is the [Azure AI
Model Inference
API](https://learn.microsoft.com/en-us/azure/machine-learning/reference-model-inference-chat-completions?view=azureml-api-2)
which requires an `api-version` query parameter.

You can set these via the optional `queryParams` provider setting. These will be
added to all requests made by the provider.

```ts highlight="7-9"
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
  queryParams: {
    'api-version': '1.0.0',
  },
});
```

For example, with the above configuration, API requests would include the query parameter in the URL like:
`https://api.provider.com/v1/chat/completions?api-version=1.0.0`.

## Image Models

You can create image models using the `.imageModel()` factory method:

```ts
const model = provider.imageModel('model-id');
```

### Basic Image Generation

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateImage } from 'ai';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const { images } = await generateImage({
  model: provider.imageModel('model-id'),
  prompt: 'A futuristic cityscape at sunset',
  size: '1024x1024',
});
```

### Image Editing

The OpenAI Compatible provider supports image editing through the `/images/edits` endpoint. Pass input images via `prompt.images` to transform or edit existing images.

#### Basic Image Editing

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateImage } from 'ai';
import fs from 'fs';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const imageBuffer = fs.readFileSync('./input-image.png');

const { images } = await generateImage({
  model: provider.imageModel('model-id'),
  prompt: {
    text: 'Turn the cat into a dog but retain the style of the original image',
    images: [imageBuffer],
  },
});
```

#### Inpainting with Mask

Edit specific parts of an image using a mask:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateImage } from 'ai';
import fs from 'fs';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const image = fs.readFileSync('./input-image.png');
const mask = fs.readFileSync('./mask.png');

const { images } = await generateImage({
  model: provider.imageModel('model-id'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask,
  },
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`,
  base64-encoded strings, or URLs. The provider will automatically download
  URL-based images and convert them to the appropriate format.
</Note>

## Embedding Models

You can create embedding models using the `.embeddingModel()` factory method:

```ts
const model = provider.embeddingModel('model-id');
```

### Example

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const { embedding } = await embed({
  model: provider.embeddingModel('text-embedding-model'),
  value: 'The quick brown fox jumps over the lazy dog',
});
```

### Embedding Model Options

The following provider options are available for embedding models via `providerOptions`:

- **dimensions** _number_

  The number of dimensions the resulting output embeddings should have.
  Only supported in models that allow dimension configuration.

- **user** _string_

  A unique identifier representing your end-user, which can help providers to
  monitor and detect abuse.

```ts
const { embedding } = await embed({
  model: provider.embeddingModel('text-embedding-model'),
  value: 'The quick brown fox jumps over the lazy dog',
  providerOptions: {
    providerName: {
      dimensions: 512,
      user: 'user-123',
    },
  },
});
```

## Completion Models

You can create completion models (for text completion, not chat) using the `.completionModel()` factory method:

```ts
const model = provider.completionModel('model-id');
```

### Example

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const { text } = await generateText({
  model: provider.completionModel('completion-model-id'),
  prompt: 'The quick brown fox',
});
```

### Completion Model Options

The following provider options are available for completion models via `providerOptions`:

- **echo** _boolean_

  Echo back the prompt in addition to the completion.

- **logitBias** _Record&lt;string, number&gt;_

  Modify the likelihood of specified tokens appearing in the completion.
  Accepts a JSON object that maps tokens (specified by their token ID) to an
  associated bias value from -100 to 100.

- **suffix** _string_

  The suffix that comes after a completion of inserted text.

- **user** _string_

  A unique identifier representing your end-user, which can help providers to
  monitor and detect abuse.

```ts
const { text } = await generateText({
  model: provider.completionModel('completion-model-id'),
  prompt: 'The quick brown fox',
  providerOptions: {
    providerName: {
      echo: true,
      suffix: ' The end.',
      user: 'user-123',
    },
  },
});
```

## Chat Model Options

The following provider options are available for chat models via `providerOptions`:

- **user** _string_

  A unique identifier representing your end-user, which can help the provider to
  monitor and detect abuse.

- **reasoningEffort** _string_

  Reasoning effort for reasoning models. The exact values depend on the provider.

- **textVerbosity** _string_

  Controls the verbosity of the generated text. The exact values depend on the provider.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation. When true, the model uses constrained
  decoding to guarantee schema compliance. Only used when the provider supports
  structured outputs and a schema is provided. Defaults to `true`.

```ts
const { text } = await generateText({
  model: provider('model-id'),
  prompt: 'Solve this step by step: What is 15 * 23?',
  providerOptions: {
    providerName: {
      user: 'user-123',
      reasoningEffort: 'high',
    },
  },
});
```

## Provider-specific options

The OpenAI Compatible provider supports adding provider-specific options to the request body. These are specified with the `providerOptions` field in the request body.

For example, if you create a provider instance with the name `providerName`, you can add a `customOption` field to the request body like this:

```ts
const provider = createOpenAICompatible({
  name: 'providerName',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
});

const { text } = await generateText({
  model: provider('model-id'),
  prompt: 'Hello',
  providerOptions: {
    providerName: { customOption: 'magic-value' },
  },
});
```

Note that the `providerOptions` key will be in camelCase. If you set the provider name to `provider-name`, the options still need to be set on `providerOptions.providerName`.

The request body sent to the provider will include the `customOption` field with the value `magic-value`. This gives you an easy way to add provider-specific options to requests without having to modify the provider or AI SDK code.

## Custom Metadata Extraction

The OpenAI Compatible provider supports extracting provider-specific metadata from API responses through metadata extractors.
These extractors allow you to capture additional information returned by the provider beyond the standard response format.

Metadata extractors receive the raw, unprocessed response data from the provider, giving you complete flexibility
to extract any custom fields or experimental features that the provider may include.
This is particularly useful when:

- Working with providers that include non-standard response fields
- Experimenting with beta or preview features
- Capturing provider-specific metrics or debugging information
- Supporting rapid provider API evolution without SDK changes

Metadata extractors work with both streaming and non-streaming chat completions and consist of two main components:

1. A function to extract metadata from complete responses
2. A streaming extractor that can accumulate metadata across chunks in a streaming response

Here's an example metadata extractor that captures both standard and custom provider data:

```typescript
import { MetadataExtractor } from '@ai-sdk/openai-compatible';

const myMetadataExtractor: MetadataExtractor = {
  // Process complete, non-streaming responses
  extractMetadata: ({ parsedBody }) => {
    // You have access to the complete raw response
    // Extract any fields the provider includes
    return {
      myProvider: {
        standardUsage: parsedBody.usage,
        experimentalFeatures: parsedBody.beta_features,
        customMetrics: {
          processingTime: parsedBody.server_timing?.total_ms,
          modelVersion: parsedBody.model_version,
          // ... any other provider-specific data
        },
      },
    };
  },

  // Process streaming responses
  createStreamExtractor: () => {
    let accumulatedData = {
      timing: [],
      customFields: {},
    };

    return {
      // Process each chunk's raw data
      processChunk: parsedChunk => {
        if (parsedChunk.server_timing) {
          accumulatedData.timing.push(parsedChunk.server_timing);
        }
        if (parsedChunk.custom_data) {
          Object.assign(accumulatedData.customFields, parsedChunk.custom_data);
        }
      },
      // Build final metadata from accumulated data
      buildMetadata: () => ({
        myProvider: {
          streamTiming: accumulatedData.timing,
          customData: accumulatedData.customFields,
        },
      }),
    };
  },
};
```

You can provide a metadata extractor when creating your provider instance:

```typescript
const provider = createOpenAICompatible({
  name: 'my-provider',
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: 'https://api.provider.com/v1',
  metadataExtractor: myMetadataExtractor,
});
```

The extracted metadata will be included in the response under the `providerMetadata` field:

```typescript
const { text, providerMetadata } = await generateText({
  model: provider('model-id'),
  prompt: 'Hello',
});

console.log(providerMetadata.myProvider.customMetric);
```

This allows you to access provider-specific information while maintaining a consistent interface across different providers.

---
title: RAG Agent
description: Learn how to build a RAG Agent with the AI SDK and Next.js
tags:
  [
    'rag',
    'chatbot',
    'next',
    'embeddings',
    'database',
    'retrieval',
    'memory',
    'agent',
  ]
---

# RAG Agent Guide

In this guide, you will learn how to build a retrieval-augmented generation (RAG) agent.

<video
  src="/images/rag-guide-demo.mp4"
  autoplay
  height={540}
  width={910}
  controls
  playsinline
/>

Before we dive in, let's look at what RAG is, and why we would want to use it.

### What is RAG?

RAG stands for retrieval augmented generation. In simple terms, RAG is the process of providing a Large Language Model (LLM) with specific information relevant to the prompt.

### Why is RAG important?

While LLMs are powerful, the information they can reason on is restricted to the data they were trained on. This problem becomes apparent when asking an LLM for information outside of their training data, like proprietary data or common knowledge that has occurred after the model’s training cutoff. RAG solves this problem by fetching information relevant to the prompt and then passing that to the model as context.

To illustrate with a basic example, imagine asking the model for your favorite food:

```txt
**input**
What is my favorite food?

**generation**
I don't have access to personal information about individuals, including their
favorite foods.
```

Not surprisingly, the model doesn’t know. But imagine, alongside your prompt, the model received some extra context:

```txt
**input**
Respond to the user's prompt using only the provided context.
user prompt: 'What is my favorite food?'
context: user loves chicken nuggets

**generation**
Your favorite food is chicken nuggets!
```

Just like that, you have augmented the model’s generation by providing relevant information to the query. Assuming the model has the appropriate information, it is now highly likely to return an accurate response to the users query. But how does it retrieve the relevant information? The answer relies on a concept called embedding.

<Note>
  You could fetch any context for your RAG application (eg. Google search).
  Embeddings and Vector Databases are just a specific retrieval approach to
  achieve semantic search.
</Note>

### Embedding

[Embeddings](/docs/ai-sdk-core/embeddings) are a way to represent words, phrases, or images as vectors in a high-dimensional space. In this space, similar words are close to each other, and the distance between words can be used to measure their similarity.

In practice, this means that if you embedded the words `cat` and `dog`, you would expect them to be plotted close to each other in vector space. The process of calculating the similarity between two vectors is called ‘cosine similarity’ where a value of 1 would indicate high similarity and a value of -1 would indicate high opposition.

<Note>
  Don’t worry if this seems complicated. a high level understanding is all you
  need to get started! For a more in-depth introduction to embeddings, check out
  [this guide](https://jalammar.github.io/illustrated-word2vec/).
</Note>

As mentioned above, embeddings are a way to represent the semantic meaning of **words and phrases**. The implication here is that the larger the input to your embedding, the lower quality the embedding will be. So how would you approach embedding content longer than a simple phrase?

### Chunking

Chunking refers to the process of breaking down a particular source material into smaller pieces. There are many different approaches to chunking and it’s worth experimenting as the most effective approach can differ by use case. A simple and common approach to chunking (and what you will be using in this guide) is separating written content by sentences.

Once your source material is appropriately chunked, you can embed each one and then store the embedding and the chunk together in a database. Embeddings can be stored in any database that supports vectors. For this tutorial, you will be using [Postgres](https://www.postgresql.org/) alongside the [pgvector](https://github.com/pgvector/pgvector) plugin.

<MDXImage
  srcLight="/images/rag-guide-1.png"
  srcDark="/images/rag-guide-1-dark.png"
  width={800}
  height={800}
/>

### All Together Now

Combining all of this together, RAG is the process of enabling the model to respond with information outside of it’s training data by embedding a users query, retrieving the relevant source material (chunks) with the highest semantic similarity, and then passing them alongside the initial query as context. Going back to the example where you ask the model for your favorite food, the prompt preparation process would look like this.

<MDXImage
  srcLight="/images/rag-guide-2.png"
  srcDark="/images/rag-guide-2-dark.png"
  width={800}
  height={800}
/>

By passing the appropriate context and refining the model’s objective, you are able to fully leverage its strengths as a reasoning machine.

Onto the project!

## Project Setup

In this project, you will build a agent that will only respond with information that it has within its knowledge base. The agent will be able to both store and retrieve information. This project has many interesting use cases from customer support through to building your own second brain!

This project will use the following stack:

- [Next.js](https://nextjs.org) 14 (App Router)
- [ AI SDK ](/docs)
- [ Vercel AI Gateway ](/providers/ai-sdk-providers/ai-gateway)
- [ Drizzle ORM ](https://orm.drizzle.team)
- [ Postgres ](https://www.postgresql.org/) with [ pgvector ](https://github.com/pgvector/pgvector)
- [ shadcn-ui ](https://ui.shadcn.com) and [ TailwindCSS ](https://tailwindcss.com) for styling

### Clone Repo

To reduce the scope of this guide, you will be starting with a [repository](https://github.com/vercel/ai-sdk-rag-starter) that already has a few things set up for you:

- Drizzle ORM (`lib/db`) including an initial migration and a script to migrate (`db:migrate`)
- a basic schema for the `resources` table (this will be for source material)
- a Server Action for creating a `resource`

To get started, clone the starter repository with the following command:

<Snippet
  text={[
    'git clone https://github.com/vercel/ai-sdk-rag-starter',
    'cd ai-sdk-rag-starter',
  ]}
/>

First things first, run the following command to install the project’s dependencies:

<Snippet text="pnpm install" />

### Create Database

You will need a Postgres database to complete this tutorial. If you don't have Postgres setup on your local machine you can:

- Create a free Postgres database with Vercel (recommended - see instructions below); or
- Follow [this guide](https://www.prisma.io/dataguide/postgresql/setting-up-a-local-postgresql-database) to set it up locally

#### Setting up Postgres with Vercel

To set up a Postgres instance on your Vercel account:

1. Go to [Vercel.com](https://vercel.com) and make sure you're logged in
1. Navigate to your team homepage
1. Click on the **Integrations** tab
1. Click **Browse Marketplace**
1. Look for the **Storage** option in the sidebar
1. Select the **Neon** option (recommended, but any other PostgreSQL database provider should work)
1. Click **Install**, then click **Install** again in the top right corner
1. On the "Get Started with Neon" page, click **Create Database** on the right
1. Select your region (e.g., Washington, D.C., U.S. East)
1. Turn off **Auth**
1. Click **Continue**
1. Name your database (you can use the default name or rename it to something like "RagTutorial")
1. Click **Create** in the bottom right corner
1. After seeing "Database created successfully", click **Done**
1. You'll be redirected to your database instance
1. In the Quick Start section, click **Show secrets**
1. Copy the full `DATABASE_URL` environment variable

### Migrate Database

Once you have a Postgres database, you need to add the connection string as an environment secret.

Make a copy of the `.env.example` file and rename it to `.env`.

<Snippet text="cp .env.example .env" />

Open the new `.env` file. You should see an item called `DATABASE_URL`. Copy in your database connection string after the equals sign.

With that set up, you can now run your first database migration. Run the following command:

<Snippet text="pnpm db:migrate" />

This will first add the `pgvector` extension to your database. Then it will create a new table for your `resources` schema that is defined in `lib/db/schema/resources.ts`. This schema has four columns: `id`, `content`, `createdAt`, and `updatedAt`.

<Note>
  If you experience an error with the migration, see the [troubleshooting
  section](#troubleshooting-migration-error) below.
</Note>

### Vercel AI Gateway Key

For this guide, you will need a Vercel AI Gateway API key, which gives you access to hundreds of models from different providers with one API key. If you haven't obtained your Vercel AI Gateway API key, you can do so by [signing up](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai&title=Go+to+AI+Gateway) on the Vercel website.

<Note>
  The AI SDK's Vercel AI Gateway Provider is the default global provider, so you
  can access models using a simple string in the model configuration. If you
  prefer to use a specific provider like OpenAI directly, see the [provider
  management](/docs/ai-sdk-core/provider-management) documentation.
</Note>

Now, open your `.env` file and add your API Gateway key:

```env filename=".env"
AI_GATEWAY_API_KEY=your-api-key
```

Replace `your-api-key` with your actual Vercel AI Gateway API key.

## Build

Let’s build a quick task list of what needs to be done:

1. Create a table in your database to store embeddings
2. Add logic to chunk and create embeddings when creating resources
3. Create an agent
4. Give the agent tools to query / create resources for it’s knowledge base

### Create Embeddings Table

Currently, your application has one table (`resources`) which has a column (`content`) for storing content. Remember, each `resource` (source material) will have to be chunked, embedded, and then stored. Let’s create a table called `embeddings` to store these chunks.

Create a new file (`lib/db/schema/embeddings.ts`) and add the following code:

```tsx filename="lib/db/schema/embeddings.ts"
import { nanoid } from '@/lib/utils';
import { index, pgTable, text, varchar, vector } from 'drizzle-orm/pg-core';
import { resources } from './resources';

export const embeddings = pgTable(
  'embeddings',
  {
    id: varchar('id', { length: 191 })
      .primaryKey()
      .$defaultFn(() => nanoid()),
    resourceId: varchar('resource_id', { length: 191 }).references(
      () => resources.id,
      { onDelete: 'cascade' },
    ),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  },
  table => ({
    embeddingIndex: index('embeddingIndex').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);
```

This table has four columns:

- `id` - unique identifier
- `resourceId` - a foreign key relation to the full source material
- `content` - the plain text chunk
- `embedding` - the vector representation of the plain text chunk

To perform similarity search, you also need to include an index ([HNSW](https://github.com/pgvector/pgvector?tab=readme-ov-file#hnsw) or [IVFFlat](https://github.com/pgvector/pgvector?tab=readme-ov-file#ivfflat)) on this column for better performance.

To push this change to the database, run the following command:

<Snippet text="pnpm db:push" />

### Add Embedding Logic

Now that you have a table to store embeddings, it’s time to write the logic to create the embeddings.

Create a file with the following command:

<Snippet text="mkdir lib/ai && touch lib/ai/embedding.ts" />

### Generate Chunks

Remember, to create an embedding, you will start with a piece of source material (unknown length), break it down into smaller chunks, embed each chunk, and then save the chunk to the database. Let’s start by creating a function to break the source material into small chunks.

```tsx filename="lib/ai/embedding.ts"
const generateChunks = (input: string): string[] => {
  return input
    .trim()
    .split('.')
    .filter(i => i !== '');
};
```

This function will take an input string and split it by periods, filtering out any empty items. This will return an array of strings. It is worth experimenting with different chunking techniques in your projects as the best technique will vary.

### Install AI SDK

You will use the AI SDK to create embeddings. This will require two more dependencies, which you can install by running the following command:

<Snippet text="pnpm add ai @ai-sdk/react" />

This will install the [AI SDK](/docs) and the AI SDK's React hooks.

<Note>
  The AI SDK is designed to be a unified interface to interact with any large
  language model. This means that you can change model and providers with just
  one line of code! Learn more about [available providers](/providers) and
  [building custom providers](/providers/community-providers/custom-providers)
  in the [providers](/providers) section.
</Note>

### Generate Embeddings

Let’s add a function to generate embeddings. Copy the following code into your `lib/ai/embedding.ts` file.

```tsx filename="lib/ai/embedding.ts" highlight="1-2,4,13-22"
import { embedMany } from 'ai';

const embeddingModel = 'openai/text-embedding-ada-002';

const generateChunks = (input: string): string[] => {
  return input
    .trim()
    .split('.')
    .filter(i => i !== '');
};

export const generateEmbeddings = async (
  value: string,
): Promise<Array<{ embedding: number[]; content: string }>> => {
  const chunks = generateChunks(value);
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks,
  });
  return embeddings.map((e, i) => ({ content: chunks[i], embedding: e }));
};
```

In this code, you first define the model you want to use for the embeddings. In this example, you are using OpenAI’s `text-embedding-ada-002` embedding model.

Next, you create an asynchronous function called `generateEmbeddings`. This function will take in the source material (`value`) as an input and return a promise of an array of objects, each containing an embedding and content. Within the function, you first generate chunks for the input. Then, you pass those chunks to the [`embedMany`](/docs/reference/ai-sdk-core/embed-many) function imported from the AI SDK which will return embeddings of the chunks you passed in. Finally, you map over and return the embeddings in a format that is ready to save in the database.

### Update Server Action

Open the file at `lib/actions/resources.ts`. This file has one function, `createResource`, which, as the name implies, allows you to create a resource.

```tsx filename="lib/actions/resources.ts"
'use server';

import {
  NewResourceParams,
  insertResourceSchema,
  resources,
} from '@/lib/db/schema/resources';
import { db } from '../db';

export const createResource = async (input: NewResourceParams) => {
  try {
    const { content } = insertResourceSchema.parse(input);

    const [resource] = await db
      .insert(resources)
      .values({ content })
      .returning();

    return 'Resource successfully created.';
  } catch (e) {
    if (e instanceof Error)
      return e.message.length > 0 ? e.message : 'Error, please try again.';
  }
};
```

This function is a [Server Action](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations#with-client-components), as denoted by the `“use server”;` directive at the top of the file. This means that it can be called anywhere in your Next.js application. This function will take an input, run it through a [Zod](https://zod.dev) schema to ensure it adheres to the correct schema, and then creates a new resource in the database. This is the ideal location to generate and store embeddings of the newly created resources.

Update the file with the following code:

```tsx filename="lib/actions/resources.ts" highlight="9-10,21-27,29"
'use server';

import {
  NewResourceParams,
  insertResourceSchema,
  resources,
} from '@/lib/db/schema/resources';
import { db } from '../db';
import { generateEmbeddings } from '../ai/embedding';
import { embeddings as embeddingsTable } from '../db/schema/embeddings';

export const createResource = async (input: NewResourceParams) => {
  try {
    const { content } = insertResourceSchema.parse(input);

    const [resource] = await db
      .insert(resources)
      .values({ content })
      .returning();

    const embeddings = await generateEmbeddings(content);
    await db.insert(embeddingsTable).values(
      embeddings.map(embedding => ({
        resourceId: resource.id,
        ...embedding,
      })),
    );

    return 'Resource successfully created and embedded.';
  } catch (error) {
    return error instanceof Error && error.message.length > 0
      ? error.message
      : 'Error, please try again.';
  }
};
```

First, you call the `generateEmbeddings` function created in the previous step, passing in the source material (`content`). Once you have your embeddings (`e`) of the source material, you can save them to the database, passing the `resourceId` alongside each embedding.

### Create Root Page

Great! Let's build the frontend. The AI SDK’s [`useChat`](/docs/reference/ai-sdk-ui/use-chat) hook allows you to easily create a conversational user interface for your agent.

Replace your root page (`app/page.tsx`) with the following code.

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      <div className="space-y-4">
        {messages.map(m => (
          <div key={m.id} className="whitespace-pre-wrap">
            <div>
              <div className="font-bold">{m.role}</div>
              {m.parts.map(part => {
                switch (part.type) {
                  case 'text':
                    return <p>{part.text}</p>;
                }
              })}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={e => {
          e.preventDefault();
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={e => setInput(e.currentTarget.value)}
        />
      </form>
    </div>
  );
}
```

The `useChat` hook enables the streaming of chat messages from your AI provider (you will be using OpenAI via the Vercel AI Gateway), manages the state for chat input, and updates the UI automatically as new messages are received.

Run the following command to start the Next.js dev server:

<Snippet text="pnpm run dev" />

Head to [http://localhost:3000](http://localhost:3000/). You should see an empty screen with an input bar floating at the bottom. Try to send a message. The message shows up in the UI for a fraction of a second and then disappears. This is because you haven’t set up the corresponding API route to call the model! By default, `useChat` will send a POST request to the `/api/chat` endpoint with the `messages` as the request body.

<Note>You can customize the endpoint in the useChat configuration object</Note>

### Create API Route

In Next.js, you can create custom request handlers for a given route using [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers). Route Handlers are defined in a `route.ts` file and can export HTTP methods like `GET`, `POST`, `PUT`, `PATCH` etc.

Create a file at `app/api/chat/route.ts` by running the following command:

<Snippet text="mkdir -p app/api/chat && touch app/api/chat/route.ts" />

Open the file and add the following code:

```tsx filename="app/api/chat/route.ts"
import { convertToModelMessages, streamText, UIMessage } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

In this code, you declare and export an asynchronous function called POST. You retrieve the `messages` from the request body and then pass them to the [`streamText`](/docs/reference/ai-sdk-core/stream-text) function imported from the AI SDK, alongside the model you would like to use. Finally, you return the model’s response in `UIMessageStreamResponse` format.

Head back to the browser and try to send a message again. You should see a response from the model streamed directly in!

### Refining your prompt

While you now have a working agent, it isn't doing anything special.

Let’s add system instructions to refine and restrict the model’s behavior. In this case, you want the model to only use information it has retrieved to generate responses. Update your route handler with the following code:

```tsx filename="app/api/chat/route.ts" highlight="12-14"
import { convertToModelMessages, streamText, UIMessage } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Head back to the browser and try to ask the model what your favorite food is. The model should now respond exactly as you instructed above (“Sorry, I don’t know”) given it doesn’t have any relevant information.

In its current form, your agent is now, well, useless. How do you give the model the ability to add and query information?

### Using Tools

A [tool](/docs/foundations/tools) is a function that can be called by the model to perform a specific task. You can think of a tool like a program you give to the model that it can run as and when it deems necessary.

Let’s see how you can create a tool to give the model the ability to create, embed and save a resource to your agents’ knowledge base.

### Add Resource Tool

Update your route handler with the following code:

```tsx filename="app/api/chat/route.ts" highlight="18-29"
import { createResource } from '@/lib/actions/resources';
import { convertToModelMessages, streamText, tool, UIMessage } from 'ai';
import { z } from 'zod';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    messages: await convertToModelMessages(messages),
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        inputSchema: z.object({
          content: z
            .string()
            .describe('the content or resource to add to the knowledge base'),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

In this code, you define a tool called `addResource`. This tool has three elements:

- **description**: description of the tool that will influence when the tool is picked.
- **inputSchema**: [Zod schema](/docs/foundations/tools#schema-specification-and-validation-with-zod) that defines the input necessary for the tool to run.
- **execute**: An asynchronous function that is called with the arguments from the tool call.

In simple terms, on each generation, the model will decide whether it should call the tool. If it deems it should call the tool, it will extract the input and then append a new `message` to the `messages` array of type `tool-call`. The AI SDK will then run the `execute` function with the parameters provided by the `tool-call` message.

Head back to the browser and tell the model your favorite food. You should see an empty response in the UI. Did anything happen? Let’s see. Run the following command in a new terminal window.

<Snippet text="pnpm db:studio" />

This will start Drizzle Studio where we can view the rows in our database. You should see a new row in both the `embeddings` and `resources` table with your favorite food!

Let’s make a few changes in the UI to communicate to the user when a tool has been called. Head back to your root page (`app/page.tsx`) and add the following code:

```tsx filename="app/page.tsx" highlight="14-32"
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      <div className="space-y-4">
        {messages.map(m => (
          <div key={m.id} className="whitespace-pre-wrap">
            <div>
              <div className="font-bold">{m.role}</div>
              {m.parts.map(part => {
                switch (part.type) {
                  case 'text':
                    return <p>{part.text}</p>;
                  case 'tool-addResource':
                  case 'tool-getInformation':
                    return (
                      <p>
                        call{part.state === 'output-available' ? 'ed' : 'ing'}{' '}
                        tool: {part.type}
                        <pre className="my-4 bg-zinc-100 p-2 rounded-sm">
                          {JSON.stringify(part.input, null, 2)}
                        </pre>
                      </p>
                    );
                }
              })}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={e => {
          e.preventDefault();
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={e => setInput(e.currentTarget.value)}
        />
      </form>
    </div>
  );
}
```

With this change, you now conditionally render the tool that has been called directly in the UI. Save the file and head back to browser. Tell the model your favorite movie. You should see which tool is called in place of the model’s typical text response.

<Note>
  Don't worry about the `tool-getInformation` tool case in the switch statement
  - we'll add that tool in a later section.
</Note>

### Improving UX with Multi-Step Calls

It would be nice if the model could summarize the action too. However, technically, once the model calls a tool, it has completed its generation as it ‘generated’ a tool call. How could you achieve this desired behavior?

The AI SDK has a feature called [`stopWhen`](/docs/ai-sdk-core/tools-and-tool-calling#multi-step-calls) which allows stopping conditions when the model generates a tool call. If those stopping conditions haven't been hit, the AI SDK will automatically send tool call results back to the model!

Open your root page (`api/chat/route.ts`) and add the following key to the `streamText` configuration object:

```tsx filename="api/chat/route.ts" highlight="8,24"
import { createResource } from '@/lib/actions/resources';
import {
  convertToModelMessages,
  streamText,
  tool,
  UIMessage,
  isStepCount,
} from 'ai';
import { z } from 'zod';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        inputSchema: z.object({
          content: z
            .string()
            .describe('the content or resource to add to the knowledge base'),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

Head back to the browser and tell the model your favorite pizza topping (note: pineapple is not an option). You should see a follow-up response from the model confirming the action.

### Retrieve Resource Tool

The model can now add and embed arbitrary information to your knowledge base. However, it still isn’t able to query it. Let’s create a new tool to allow the model to answer questions by finding relevant information in your knowledge base.

To find similar content, you will need to embed the users query, search the database for semantic similarities, then pass those items to the model as context alongside the query. To achieve this, let’s update your embedding logic file (`lib/ai/embedding.ts`):

```tsx filename="lib/ai/embedding.ts" highlight="1,3-5,27-34,36-49"
import { embed, embedMany } from 'ai';
import { db } from '../db';
import { cosineDistance, desc, gt, sql } from 'drizzle-orm';
import { embeddings } from '../db/schema/embeddings';

const embeddingModel = 'openai/text-embedding-ada-002';

const generateChunks = (input: string): string[] => {
  return input
    .trim()
    .split('.')
    .filter(i => i !== '');
};

export const generateEmbeddings = async (
  value: string,
): Promise<Array<{ embedding: number[]; content: string }>> => {
  const chunks = generateChunks(value);
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks,
  });
  return embeddings.map((e, i) => ({ content: chunks[i], embedding: e }));
};

export const generateEmbedding = async (value: string): Promise<number[]> => {
  const input = value.replaceAll('\\n', ' ');
  const { embedding } = await embed({
    model: embeddingModel,
    value: input,
  });
  return embedding;
};

export const findRelevantContent = async (userQuery: string) => {
  const userQueryEmbedded = await generateEmbedding(userQuery);
  const similarity = sql<number>`1 - (${cosineDistance(
    embeddings.embedding,
    userQueryEmbedded,
  )})`;
  const similarGuides = await db
    .select({ name: embeddings.content, similarity })
    .from(embeddings)
    .where(gt(similarity, 0.5))
    .orderBy(t => desc(t.similarity))
    .limit(4);
  return similarGuides;
};
```

In this code, you add two functions:

- `generateEmbedding`: generate a single embedding from an input string
- `findRelevantContent`: embeds the user’s query, searches the database for similar items, then returns relevant items

With that done, it’s onto the final step: creating the tool.

Go back to your route handler (`api/chat/route.ts`) and add a new tool called `getInformation`:

```ts filename="api/chat/route.ts" highlight="11,37-43"
import { createResource } from '@/lib/actions/resources';
import {
  convertToModelMessages,
  streamText,
  tool,
  UIMessage,
  isStepCount,
} from 'ai';
import { z } from 'zod';
import { findRelevantContent } from '@/lib/ai/embedding';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        inputSchema: z.object({
          content: z
            .string()
            .describe('the content or resource to add to the knowledge base'),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
      getInformation: tool({
        description: `get information from your knowledge base to answer questions.`,
        inputSchema: z.object({
          question: z.string().describe('the users question'),
        }),
        execute: async ({ question }) => findRelevantContent(question),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

Head back to the browser, refresh the page, and ask for your favorite food. You should see the model call the `getInformation` tool, and then use the relevant information to formulate a response!

## Conclusion

Congratulations, you have successfully built an AI agent that can dynamically add and retrieve information to and from a knowledge base. Throughout this guide, you learned how to create and store embeddings, set up server actions to manage resources, and use tools to extend the capabilities of your agent.

## Troubleshooting Migration Error

If you experience an error with the migration, open your migration file (`lib/db/migrations/0000_yielding_bloodaxe.sql`), cut (copy and remove) the first line, and run it directly on your postgres instance. You should now be able to run the updated migration.

If you're using the Vercel setup above, you can run the command directly by either:

- Going to the Neon console and entering the command there, or
- Going back to the Vercel platform, navigating to the Quick Start section of your database, and finding the PSQL connection command (second tab). This will connect to your instance in the terminal where you can run the command directly.

[More info](https://github.com/vercel/ai-sdk-rag-starter/issues/1).

---
title: Multi-Modal Agent
description: Learn how to build a multi-modal agent that can process images and PDFs with the AI SDK.
tags: ['multi-modal', 'agent', 'images', 'pdf', 'vision', 'next']
---

# Multi-Modal Agent

In this guide, you will build a multi-modal agent capable of understanding both images and PDFs.

Multi-modal refers to the ability of the agent to understand and generate responses in multiple formats. In this guide, we'll focus on images and PDFs - two common document types that modern language models can process natively.

<Note>
  For a complete list of providers and their multi-modal capabilities, visit the
  [providers documentation](/providers/ai-sdk-providers).
</Note>

We'll build this agent using OpenAI's GPT-4o, but the same code works seamlessly with other providers - you can switch between them by changing just one line of code.

## Prerequisites

To follow this quickstart, you'll need:

- Node.js 18+ and pnpm installed on your local development machine.
- A Vercel AI Gateway API key.

If you haven't obtained your Vercel AI Gateway API key, you can do so by [signing up](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai&title=Go+to+AI+Gateway) on the Vercel website.

## Create Your Application

Start by creating a new Next.js application. This command will create a new directory named `multi-modal-agent` and set up a basic Next.js application inside it.

<div className="mb-4">
  <Note>
    Be sure to select yes when prompted to use the App Router. If you are
    looking for the Next.js Pages Router quickstart guide, you can find it
    [here](/docs/getting-started/nextjs-pages-router).
  </Note>
</div>

<Snippet text="pnpm create next-app@latest multi-modal-agent" />

Navigate to the newly created directory:

<Snippet text="cd multi-modal-agent" />

### Install dependencies

Install `ai` and `@ai-sdk/react`, the AI SDK package and the AI SDK's React package respectively.

<Note>
  The AI SDK is designed to be a unified interface to interact with any large
  language model. This means that you can change model and providers with just
  one line of code! Learn more about [available providers](/providers) and
  [building custom providers](/providers/community-providers/custom-providers)
  in the [providers](/providers) section.
</Note>
<div className="my-4">
  <Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
    <Tab>
      <Snippet text="pnpm add ai @ai-sdk/react" dark />
    </Tab>
    <Tab>
      <Snippet text="npm install ai @ai-sdk/react" dark />
    </Tab>
    <Tab>
      <Snippet text="yarn add ai @ai-sdk/react" dark />
    </Tab>

    <Tab>
      <Snippet text="bun add ai @ai-sdk/react" dark />
    </Tab>

  </Tabs>
</div>

### Configure your Vercel AI Gateway API key

Create a `.env.local` file in your project root and add your Vercel AI Gateway API key. This key authenticates your application with Vercel AI Gateway.

<Snippet text="touch .env.local" />

Edit the `.env.local` file:

```env filename=".env.local"
AI_GATEWAY_API_KEY=your_api_key_here
```

Replace `your_api_key_here` with your actual Vercel AI Gateway API key.

<Note className="mb-4">
  The AI SDK's Vercel AI Gateway Provider is the default global provider, so you
  can access models using a simple string in the model configuration. If you
  prefer to use a specific provider like OpenAI directly, see the [provider
  management](/docs/ai-sdk-core/provider-management) documentation.
</Note>

## Implementation Plan

To build a multi-modal agent, you will need to:

- Create a Route Handler to handle incoming chat messages and generate responses.
- Wire up the UI to display chat messages, provide a user input, and handle submitting new messages.
- Add the ability to upload images and PDFs and attach them alongside the chat messages.

## Create a Route Handler

Create a route handler, `app/api/chat/route.ts` and add the following code:

```tsx filename="app/api/chat/route.ts"
import { streamText, convertToModelMessages, type UIMessage } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'openai/gpt-4o',
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Let's take a look at what is happening in this code:

1. Define an asynchronous `POST` request handler and extract `messages` from the body of the request. The `messages` variable contains a history of the conversation between you and the agent and provides the agent with the necessary context to make the next generation.
2. Convert the UI messages to model messages using `convertToModelMessages`, which transforms the UI-focused message format to the format expected by the language model.
3. Call [`streamText`](/docs/reference/ai-sdk-core/stream-text), which is imported from the `ai` package. This function accepts a configuration object that contains a `model` provider and `messages` (converted in step 2). You can pass additional [settings](/docs/ai-sdk-core/settings) to further customize the model's behavior.
4. The `streamText` function returns a [`StreamTextResult`](/docs/reference/ai-sdk-core/stream-text#result-object). This result object contains the [ `toUIMessageStreamResponse` ](/docs/reference/ai-sdk-core/stream-text#to-ui-message-stream-response) function which converts the result to a streamed response object.
5. Finally, return the result to the client to stream the response.

This Route Handler creates a POST request endpoint at `/api/chat`.

## Wire up the UI

Now that you have a Route Handler that can query a large language model (LLM), it's time to setup your frontend. [ AI SDK UI ](/docs/ai-sdk-ui) abstracts the complexity of a chat interface into one hook, [`useChat`](/docs/reference/ai-sdk-ui/use-chat).

Update your root page (`app/page.tsx`) with the following code to show a list of chat messages and provide a user message input:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');

  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.parts.map((part, index) => {
            if (part.type === 'text') {
              return <span key={`${m.id}-text-${index}`}>{part.text}</span>;
            }
            return null;
          })}
        </div>
      ))}

      <form
        onSubmit={async event => {
          event.preventDefault();
          sendMessage({
            role: 'user',
            parts: [{ type: 'text', text: input }],
          });
          setInput('');
        }}
        className="fixed bottom-0 w-full max-w-md mb-8 border border-gray-300 rounded shadow-xl"
      >
        <input
          className="w-full p-2"
          value={input}
          placeholder="Say something..."
          onChange={e => setInput(e.target.value)}
        />
      </form>
    </div>
  );
}
```

<Note>
  Make sure you add the `"use client"` directive to the top of your file. This
  allows you to add interactivity with JavaScript.
</Note>

This page utilizes the `useChat` hook, configured with `DefaultChatTransport` to specify the API endpoint. The `useChat` hook provides multiple utility functions and state variables:

- `messages` - the current chat messages (an array of objects with `id`, `role`, and `parts` properties).
- `sendMessage` - function to send a new message to the AI.
- Each message contains a `parts` array that can include text, images, PDFs, and other content types.
- Files are converted to data URLs before being sent to maintain compatibility across different environments.

## Add File Upload

To make your agent multi-modal, let's add the ability to upload and send both images and PDFs to the model. In v5, files are sent as part of the message's `parts` array. Files are converted to data URLs using the FileReader API before being sent to the server.

Update your root page (`app/page.tsx`) with the following code:

```tsx filename="app/page.tsx" highlight="4-5,10-12,15-39,46-81,87-97"
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRef, useState } from 'react';
import Image from 'next/image';

async function convertFilesToDataURLs(files: FileList) {
  return Promise.all(
    Array.from(files).map(
      file =>
        new Promise<{
          type: 'file';
          mediaType: string;
          url: string;
        }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              type: 'file',
              mediaType: file.type,
              url: reader.result as string,
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export default function Chat() {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.parts.map((part, index) => {
            if (part.type === 'text') {
              return <span key={`${m.id}-text-${index}`}>{part.text}</span>;
            }
            if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
              return (
                <Image
                  key={`${m.id}-image-${index}`}
                  src={part.url}
                  width={500}
                  height={500}
                  alt={`attachment-${index}`}
                />
              );
            }
            if (part.type === 'file' && part.mediaType === 'application/pdf') {
              return (
                <iframe
                  key={`${m.id}-pdf-${index}`}
                  src={part.url}
                  width={500}
                  height={600}
                  title={`pdf-${index}`}
                />
              );
            }
            return null;
          })}
        </div>
      ))}

      <form
        className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl space-y-2"
        onSubmit={async event => {
          event.preventDefault();

          const fileParts =
            files && files.length > 0
              ? await convertFilesToDataURLs(files)
              : [];

          sendMessage({
            role: 'user',
            parts: [{ type: 'text', text: input }, ...fileParts],
          });

          setInput('');
          setFiles(undefined);

          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }}
      >
        <input
          type="file"
          accept="image/*,application/pdf"
          className=""
          onChange={event => {
            if (event.target.files) {
              setFiles(event.target.files);
            }
          }}
          multiple
          ref={fileInputRef}
        />
        <input
          className="w-full p-2"
          value={input}
          placeholder="Say something..."
          onChange={e => setInput(e.target.value)}
        />
      </form>
    </div>
  );
}
```

In this code, you:

1. Add a helper function `convertFilesToDataURLs` to convert file uploads to data URLs.
1. Create state to hold the input text, files, and a ref to the file input field.
1. Configure `useChat` with `DefaultChatTransport` to specify the API endpoint.
1. Display messages using the `parts` array structure, rendering text, images, and PDFs appropriately.
1. Update the `onSubmit` function to send messages with the `sendMessage` function, including both text and file parts.
1. Add a file input field to the form, including an `onChange` handler to handle updating the files state.

## Running Your Application

With that, you have built everything you need for your multi-modal agent! To start your application, use the command:

<Snippet text="pnpm run dev" />

Head to your browser and open http://localhost:3000. You should see an input field and a button to upload files.

Try uploading an image or PDF and asking the model questions about it. Watch as the model's response is streamed back to you!

## Using Other Providers

With the AI SDK's unified provider interface you can easily switch to other providers that support multi-modal capabilities:

```tsx filename="app/api/chat/route.ts"
// Using Anthropic
const result = streamText({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: await convertToModelMessages(messages),
});

// Using Google
const result = streamText({
  model: 'google/gemini-2.5-flash',
  messages: await convertToModelMessages(messages),
});
```

Install the provider package (`@ai-sdk/anthropic` or `@ai-sdk/google`) and update your API keys in `.env.local`. The rest of your code remains the same.

<Note>
  Different providers may have varying file size limits and performance
  characteristics. Check the [provider
  documentation](/providers/ai-sdk-providers) for specific details.
</Note>

## Where to Next?

You've built a multi-modal AI agent using the AI SDK! Experiment and extend the functionality of this application further by exploring [tool calling](/docs/ai-sdk-core/tools-and-tool-calling).

---
title: Slackbot Agent Guide
description: Learn how to use the AI SDK to build an AI Agent in Slack.
tags: ['agents', 'chatbot']
---

# Building an AI Agent in Slack with the AI SDK

In this guide, you will learn how to build a Slackbot powered by the AI SDK. The bot will be able to respond to direct messages and mentions in channels using the full context of the thread.

## Slack App Setup

Before we start building, you'll need to create and configure a Slack app:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" and choose "From scratch"
3. Give your app a name and select your workspace
4. Under "OAuth & Permissions", add the following bot token scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:write`
   - `assistant:write`
5. Install the app to your workspace (button under "OAuth Tokens" subsection)
6. Copy the Bot User OAuth Token and Signing Secret for the next step
7. Under App Home -> Show Tabs -> Chat Tab, check "Allow users to send Slash commands and messages from the chat tab"

## Project Setup

This project uses the following stack:

- [AI SDK by Vercel](/docs)
- [Slack Web API](https://api.slack.com/web)
- [Vercel](https://vercel.com)
- [OpenAI](https://openai.com)

## Getting Started

1. Clone [the repository](https://github.com/vercel-labs/ai-sdk-slackbot) and check out the `starter` branch

<Snippet
  text={[
    'git clone https://github.com/vercel-labs/ai-sdk-slackbot.git',
    'cd ai-sdk-slackbot',
    'git checkout starter',
  ]}
/>

2. Install dependencies

<Snippet text={['pnpm install']} />

## Project Structure

The starter repository already includes:

- Slack utilities (`lib/slack-utils.ts`) including functions for validating incoming requests, converting Slack threads to AI SDK compatible message formats, and getting the Slackbot's user ID
- General utility functions (`lib/utils.ts`) including initial Exa setup
- Files to handle the different types of Slack events (`lib/handle-messages.ts` and `lib/handle-app-mention.ts`)
- An API endpoint (`POST`) for Slack events (`api/events.ts`)

## Event Handler

First, let's take a look at our API route (`api/events.ts`):

```typescript
import type { SlackEvent } from '@slack/web-api';
import {
  assistantThreadMessage,
  handleNewAssistantMessage,
} from '../lib/handle-messages';
import { waitUntil } from '@vercel/functions';
import { handleNewAppMention } from '../lib/handle-app-mention';
import { verifyRequest, getBotId } from '../lib/slack-utils';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const payload = JSON.parse(rawBody);
  const requestType = payload.type as 'url_verification' | 'event_callback';

  // See https://api.slack.com/events/url_verification
  if (requestType === 'url_verification') {
    return new Response(payload.challenge, { status: 200 });
  }

  await verifyRequest({ requestType, request, rawBody });

  try {
    const botUserId = await getBotId();

    const event = payload.event as SlackEvent;

    if (event.type === 'app_mention') {
      waitUntil(handleNewAppMention(event, botUserId));
    }

    if (event.type === 'assistant_thread_started') {
      waitUntil(assistantThreadMessage(event));
    }

    if (
      event.type === 'message' &&
      !event.subtype &&
      event.channel_type === 'im' &&
      !event.bot_id &&
      !event.bot_profile &&
      event.bot_id !== botUserId
    ) {
      waitUntil(handleNewAssistantMessage(event, botUserId));
    }

    return new Response('Success!', { status: 200 });
  } catch (error) {
    console.error('Error generating response', error);
    return new Response('Error generating response', { status: 500 });
  }
}
```

This file defines a `POST` function that handles incoming requests from Slack. First, you check the request type to see if it's a URL verification request. If it is, you respond with the challenge string provided by Slack. If it's an event callback, you verify the request and then have access to the event data. This is where you can implement your event handling logic.

You then handle three types of events: `app_mention`, `assistant_thread_started`, and `message`:

- For `app_mention`, you call `handleNewAppMention` with the event and the bot user ID.
- For `assistant_thread_started`, you call `assistantThreadMessage` with the event.
- For `message`, you call `handleNewAssistantMessage` with the event and the bot user ID.

Finally, you respond with a success message to Slack. Note, each handler function is wrapped in a `waitUntil` function. Let's take a look at what this means and why it's important.

### The waitUntil Function

Slack expects a response within 3 seconds to confirm the request is being handled. However, generating AI responses can take longer. If you don't respond to the Slack request within 3 seconds, Slack will send another request, leading to another invocation of your API route, another call to the LLM, and ultimately another response to the user. To solve this, you can use the `waitUntil` function, which allows you to run your AI logic after the response is sent, without blocking the response itself.

This means, your API endpoint will:

1. Immediately respond to Slack (within 3 seconds)
2. Continue processing the message asynchronously
3. Send the AI response when it's ready

## Event Handlers

Let's look at how each event type is currently handled.

### App Mentions

When a user mentions your bot in a channel, the `app_mention` event is triggered. The `handleNewAppMention` function in `handle-app-mention.ts` processes these mentions:

1. Checks if the message is from a bot to avoid infinite response loops
2. Creates a status updater to show the bot is "thinking"
3. If the mention is in a thread, it retrieves the thread history
4. Calls the LLM with the message content (using the `generateResponse` function which you will implement in the next section)
5. Updates the initial "thinking" message with the AI response

Here's the code for the `handleNewAppMention` function:

```typescript filename="lib/handle-app-mention.ts"
import { AppMentionEvent } from '@slack/web-api';
import { client, getThread } from './slack-utils';
import { generateResponse } from './ai';

const updateStatusUtil = async (
  initialStatus: string,
  event: AppMentionEvent,
) => {
  const initialMessage = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text: initialStatus,
  });

  if (!initialMessage || !initialMessage.ts)
    throw new Error('Failed to post initial message');

  const updateMessage = async (status: string) => {
    await client.chat.update({
      channel: event.channel,
      ts: initialMessage.ts as string,
      text: status,
    });
  };
  return updateMessage;
};

export async function handleNewAppMention(
  event: AppMentionEvent,
  botUserId: string,
) {
  console.log('Handling app mention');
  if (event.bot_id || event.bot_id === botUserId || event.bot_profile) {
    console.log('Skipping app mention');
    return;
  }

  const { thread_ts, channel } = event;
  const updateMessage = await updateStatusUtil('is thinking...', event);

  if (thread_ts) {
    const messages = await getThread(channel, thread_ts, botUserId);
    const result = await generateResponse(messages, updateMessage);
    updateMessage(result);
  } else {
    const result = await generateResponse(
      [{ role: 'user', content: event.text }],
      updateMessage,
    );
    updateMessage(result);
  }
}
```

Now let's see how new assistant threads and messages are handled.

### Assistant Thread Messages

When a user starts a thread with your assistant, the `assistant_thread_started` event is triggered. The `assistantThreadMessage` function in `handle-messages.ts` handles this:

1. Posts a welcome message to the thread
2. Sets up suggested prompts to help users get started

Here's the code for the `assistantThreadMessage` function:

```typescript filename="lib/handle-messages.ts"
import type { AssistantThreadStartedEvent } from '@slack/web-api';
import { client } from './slack-utils';

export async function assistantThreadMessage(
  event: AssistantThreadStartedEvent,
) {
  const { channel_id, thread_ts } = event.assistant_thread;
  console.log(`Thread started: ${channel_id} ${thread_ts}`);
  console.log(JSON.stringify(event));

  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: thread_ts,
    text: "Hello, I'm an AI assistant built with the AI SDK by Vercel!",
  });

  await client.assistant.threads.setSuggestedPrompts({
    channel_id: channel_id,
    thread_ts: thread_ts,
    prompts: [
      {
        title: 'Get the weather',
        message: 'What is the current weather in London?',
      },
      {
        title: 'Get the news',
        message: 'What is the latest Premier League news from the BBC?',
      },
    ],
  });
}
```

### Direct Messages

For direct messages to your bot, the `message` event is triggered and the event is handled by the `handleNewAssistantMessage` function in `handle-messages.ts`:

1. Verifies the message isn't from a bot
2. Updates the status to show the response is being generated
3. Retrieves the conversation history
4. Calls the LLM with the conversation context
5. Posts the LLM's response to the thread

Here's the code for the `handleNewAssistantMessage` function:

```typescript filename="lib/handle-messages.ts"
import type { GenericMessageEvent } from '@slack/web-api';
import { client, getThread } from './slack-utils';
import { generateResponse } from './ai';

export async function handleNewAssistantMessage(
  event: GenericMessageEvent,
  botUserId: string,
) {
  if (
    event.bot_id ||
    event.bot_id === botUserId ||
    event.bot_profile ||
    !event.thread_ts
  )
    return;

  const { thread_ts, channel } = event;
  const updateStatus = updateStatusUtil(channel, thread_ts);
  updateStatus('is thinking...');

  const messages = await getThread(channel, thread_ts, botUserId);
  const result = await generateResponse(messages, updateStatus);

  await client.chat.postMessage({
    channel: channel,
    thread_ts: thread_ts,
    text: result,
    unfurl_links: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: result,
        },
      },
    ],
  });

  updateStatus('');
}
```

With the event handlers in place, let's now implement the AI logic.

## Implementing AI Logic

The core of our application is the `generateResponse` function in `lib/generate-response.ts`, which processes messages and generates responses using the AI SDK.

Here's how to implement it:

```typescript filename="lib/generate-response.ts"
import { generateText, ModelMessage } from 'ai';
__PROVIDER_IMPORT__;

export const generateResponse = async (
  messages: ModelMessage[],
  updateStatus?: (status: string) => void,
) => {
  const { text } = await generateText({
    model: __MODEL__,
    system: `You are a Slack bot assistant. Keep your responses concise and to the point.
    - Do not tag users.
    - Current date is: ${new Date().toISOString().split('T')[0]}`,
    messages,
  });

  // Convert markdown to Slack mrkdwn format
  return text.replace(/\[(.*?)\]\((.*?)\)/g, '<$2|$1>').replace(/\*\*/g, '*');
};
```

This basic implementation:

1. Uses the AI SDK's `generateText` function to call Anthropic's `claude-sonnet-4.5` model
2. Provides a system prompt to guide the model's behavior
3. Formats the response for Slack's markdown format

## Enhancing with Tools

The real power of the AI SDK comes from tools that enable your bot to perform actions. Let's add two useful tools:

```typescript filename="lib/generate-response.ts"
import { generateText, tool, ModelMessage, isStepCount } from 'ai';
__PROVIDER_IMPORT__;
import { z } from 'zod';
import { exa } from './utils';

export const generateResponse = async (
  messages: ModelMessage[],
  updateStatus?: (status: string) => void,
) => {
  const { text } = await generateText({
    model: __MODEL__,
    system: `You are a Slack bot assistant. Keep your responses concise and to the point.
    - Do not tag users.
    - Current date is: ${new Date().toISOString().split('T')[0]}
    - Always include sources in your final response if you use web search.`,
    messages,
    stopWhen: isStepCount(10),
    tools: {
      getWeather: tool({
        description: 'Get the current weather at a location',
        inputSchema: z.object({
          latitude: z.number(),
          longitude: z.number(),
          city: z.string(),
        }),
        execute: async ({ latitude, longitude, city }) => {
          updateStatus?.(`is getting weather for ${city}...`);

          const response = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode,relativehumidity_2m&timezone=auto`,
          );

          const weatherData = await response.json();
          return {
            temperature: weatherData.current.temperature_2m,
            weatherCode: weatherData.current.weathercode,
            humidity: weatherData.current.relativehumidity_2m,
            city,
          };
        },
      }),
      searchWeb: tool({
        description: 'Use this to search the web for information',
        inputSchema: z.object({
          query: z.string(),
          specificDomain: z
            .string()
            .nullable()
            .describe(
              'a domain to search if the user specifies e.g. bbc.com. Should be only the domain name without the protocol',
            ),
        }),
        execute: async ({ query, specificDomain }) => {
          updateStatus?.(`is searching the web for ${query}...`);
          const { results } = await exa.searchAndContents(query, {
            livecrawl: 'always',
            numResults: 3,
            includeDomains: specificDomain ? [specificDomain] : undefined,
          });

          return {
            results: results.map(result => ({
              title: result.title,
              url: result.url,
              snippet: result.text.slice(0, 1000),
            })),
          };
        },
      }),
    },
  });

  // Convert markdown to Slack mrkdwn format
  return text.replace(/\[(.*?)\]\((.*?)\)/g, '<$2|$1>').replace(/\*\*/g, '*');
};
```

In this updated implementation:

1. You added two tools:

   - `getWeather`: Fetches weather data for a specified location
   - `searchWeb`: Searches the web for information using the Exa API

2. You set `stopWhen: isStepCount(10)` to enable multi-step conversations. This defines the stopping conditions of your agent, when the model generates a tool call. This will automatically send any tool results back to the LLM to trigger additional tool calls or responses as the LLM deems necessary. This turns your LLM call from a one-off operation into a multi-step agentic flow.

## How It Works

When a user interacts with your bot:

1. The Slack event is received and processed by your API endpoint
2. The user's message and the thread history is passed to the `generateResponse` function
3. The AI SDK processes the message and may invoke tools as needed
4. The response is formatted for Slack and sent back to the user

The tools are automatically invoked based on the user's intent. For example, if a user asks "What's the weather in London?", the AI will:

1. Recognize this as a weather query
2. Call the `getWeather` tool with London's coordinates (inferred by the LLM)
3. Process the weather data
4. Generate a final response, answering the user's question

## Deploying the App

1. Install the Vercel CLI

<Snippet text={['pnpm install -g vercel']} />

2. Deploy the app

<Snippet text={['vercel deploy']} />

3. Copy the deployment URL and update the Slack app's Event Subscriptions to point to your Vercel URL
4. Go to your project's deployment settings (Your project -> Settings -> Environment Variables) and add your environment variables

```bash
SLACK_BOT_TOKEN=your_slack_bot_token
SLACK_SIGNING_SECRET=your_slack_signing_secret
OPENAI_API_KEY=your_openai_api_key
EXA_API_KEY=your_exa_api_key
```

<Note>
  Make sure to redeploy your app after updating environment variables.
</Note>

5. Head back to the [https://api.slack.com/](https://api.slack.com/) and navigate to the "Event Subscriptions" page. Enable events and add your deployment URL.

```bash
https://your-vercel-url.vercel.app/api/events
```

6. On the Events Subscription page, subscribe to the following events.
   - `app_mention`
   - `assistant_thread_started`
   - `message:im`

Finally, head to Slack and test the app by sending a message to the bot.

## Next Steps

You've built a Slack chatbot powered by the AI SDK! Here are some ways you could extend it:

1. Add memory for specific users to give the LLM context of previous interactions
2. Implement more tools like database queries or knowledge base searches
3. Add support for rich message formatting with blocks
4. Add analytics to track usage patterns

<Note>
  In a production environment, it is recommended to implement a robust queueing
  system to ensure messages are properly handled.
</Note>

---
title: Natural Language Postgres
description: Learn how to build a Next.js app that lets you talk to a PostgreSQL database in natural language.
tags: ['agents', 'next', 'tools']
---

# Natural Language Postgres Guide

In this guide, you will learn how to build an app that uses AI to interact with a PostgreSQL database using natural language.

The application will:

- Generate SQL queries from a natural language input
- Explain query components in plain English
- Create a chart to visualise query results

You can find a completed version of this project at [natural-language-postgres.vercel.app](https://natural-language-postgres.vercel.app).

## Project setup

This project uses the following stack:

- [Next.js](https://nextjs.org) (App Router)
- [AI SDK](/docs)
- [OpenAI](https://openai.com)
- [Zod](https://zod.dev)
- [Postgres](https://www.postgresql.org/) with [ Vercel Postgres ](https://vercel.com/postgres)
- [shadcn-ui](https://ui.shadcn.com) and [TailwindCSS](https://tailwindcss.com) for styling
- [Recharts](https://recharts.org) for data visualization

### Clone repo

To focus on the AI-powered functionality rather than project setup and configuration we've prepared a starter repository which includes a database schema and a few components.

Clone the starter repository and check out the `starter` branch:

<Snippet
  text={[
    'git clone https://github.com/vercel-labs/natural-language-postgres',
    'cd natural-language-postgres',
    'git checkout starter',
  ]}
/>

### Project setup and data

Let's set up the project and seed the database with the dataset:

1. Install dependencies:

<Snippet text={['pnpm install']} />

2. Copy the example environment variables file:

<Snippet text={['cp .env.example .env']} />

3. Add your environment variables to `.env`:

```bash filename=".env"
OPENAI_API_KEY="your_api_key_here"
POSTGRES_URL="..."
POSTGRES_PRISMA_URL="..."
POSTGRES_URL_NO_SSL="..."
POSTGRES_URL_NON_POOLING="..."
POSTGRES_USER="..."
POSTGRES_HOST="..."
POSTGRES_PASSWORD="..."
POSTGRES_DATABASE="..."
```

4. This project uses CB Insights' Unicorn Companies dataset. You can download the dataset by following these instructions:
   - Navigate to [CB Insights Unicorn Companies](https://www.cbinsights.com/research-unicorn-companies)
   - Enter in your email. You will receive a link to download the dataset.
   - Save it as `unicorns.csv` in your project root

<Note>
  You will need a Postgres database to complete this tutorial. If you don't have
  Postgres setup on your local machine you can: - Create a free Postgres
  database with Vercel (recommended - see instructions below); or - Follow [this
  guide](https://www.prisma.io/dataguide/postgresql/setting-up-a-local-postgresql-database)
  to set it up locally
</Note>

#### Setting up Postgres with Vercel

To set up a Postgres instance on your Vercel account:

1. Go to [Vercel.com](https://vercel.com) and make sure you're logged in
1. Navigate to your team homepage
1. Click on the **Integrations** tab
1. Click **Browse Marketplace**
1. Look for the **Storage** option in the sidebar
1. Select the **Neon** option (recommended, but any other PostgreSQL database provider should work)
1. Click **Install**, then click **Install** again in the top right corner
1. On the "Get Started with Neon" page, click **Create Database** on the right
1. Select your region (e.g., Washington, D.C., U.S. East)
1. Turn off **Auth**
1. Click **Continue**
1. Name your database (you can use the default name or rename it to something like "NaturalLanguagePostgres")
1. Click **Create** in the bottom right corner
1. After seeing "Database created successfully", click **Done**
1. You'll be redirected to your database instance
1. In the Quick Start section, click **Show secrets**
1. Copy the full `DATABASE_URL` environment variable and use it to populate the Postgres environment variables in your `.env` file

### About the dataset

The Unicorn List dataset contains the following information about unicorn startups (companies with a valuation above $1bn):

- Company name
- Valuation
- Date joined (unicorn status)
- Country
- City
- Industry
- Select investors

This dataset contains over 1000 rows of data over 7 columns, giving us plenty of structured data to analyze. This makes it perfect for exploring various SQL queries that can reveal interesting insights about the unicorn startup ecosystem.

5. Now that you have the dataset downloaded and added to your project, you can initialize the database with the following command:

<Snippet text={['pnpm run seed']} />

Note: this step can take a little while. You should see a message indicating the Unicorns table has been created and then that the database has been seeded successfully.

<Note>
  Remember, the dataset should be named `unicorns.csv` and located in root of
  your project.
</Note>

6. Start the development server:

<Snippet text={['pnpm run dev']} />

Your application should now be running at [http://localhost:3000](http://localhost:3000).

## Project structure

The starter repository already includes everything that you will need, including:

- Database seed script (`lib/seed.ts`)
- Basic components built with shadcn/ui (`components/`)
- Function to run SQL queries (`app/actions.ts`)
- Type definitions for the database schema (`lib/types.ts`)

### Existing components

The application contains a single page in `app/page.tsx` that serves as the main interface.

At the top, you'll find a header (`header.tsx`) displaying the application title and description. Below that is an input field and search button (`search.tsx`) where you can enter natural language queries.

Initially, the page shows a collection of suggested example queries (`suggested-queries.tsx`) that you can click to quickly try out the functionality.

When you submit a query:

- The suggested queries section disappears and a loading state appears
- Once complete, a card appears with "TODO - IMPLEMENT ABOVE" (`query-viewer.tsx`) which will eventually show your generated SQL
- Below that is an empty results area with "No results found" (`results.tsx`)

After you implement the core functionality:

- The results section will display data in a table format
- A toggle button will allow switching between table and chart views
- The chart view will visualize your query results

Let's implement the AI-powered functionality to bring it all together.

## Building the application

As a reminder, this application will have three main features:

1. Generate SQL queries from natural language
2. Create a chart from the query results
3. Explain SQL queries in plain English

For each of these features, you'll use the AI SDK via [ Server Actions ](https://react.dev/reference/rsc/server-actions) to interact with OpenAI's GPT-4o and GPT-4o-mini models. Server Actions are a powerful React Server Component feature that allows you to call server-side functions directly from your frontend code.

Let's start with generating a SQL query from natural language.

## Generate SQL queries

### Providing context

For the model to generate accurate SQL queries, it needs context about your database schema, tables, and relationships. You will communicate this information through a prompt that should include:

1. Schema information
2. Example data formats
3. Available SQL operations
4. Best practices for query structure
5. Nuanced advice for specific fields

Let's write a prompt that includes all of this information:

```txt
You are a SQL (postgres) and data visualization expert. Your job is to help the user write a SQL query to retrieve the data they need. The table schema is as follows:

unicorns (
  id SERIAL PRIMARY KEY,
  company VARCHAR(255) NOT NULL UNIQUE,
  valuation DECIMAL(10, 2) NOT NULL,
  date_joined DATE,
  country VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL,
  industry VARCHAR(255) NOT NULL,
  select_investors TEXT NOT NULL
);

Only retrieval queries are allowed.

For things like industry, company names and other string fields, use the ILIKE operator and convert both the search term and the field to lowercase using LOWER() function. For example: LOWER(industry) ILIKE LOWER('%search_term%').

Note: select_investors is a comma-separated list of investors. Trim whitespace to ensure you're grouping properly. Note, some fields may be null or have only one value.
When answering questions about a specific field, ensure you are selecting the identifying column (ie. what is Vercel's valuation would select company and valuation').

The industries available are:
- healthcare & life sciences
- consumer & retail
- financial services
- enterprise tech
- insurance
- media & entertainment
- industrials
- health

If the user asks for a category that is not in the list, infer based on the list above.

Note: valuation is in billions of dollars so 10b would be 10.0.
Note: if the user asks for a rate, return it as a decimal. For example, 0.1 would be 10%.

If the user asks for 'over time' data, return by year.

When searching for UK or USA, write out United Kingdom or United States respectively.

EVERY QUERY SHOULD RETURN QUANTITATIVE DATA THAT CAN BE PLOTTED ON A CHART! There should always be at least two columns. If the user asks for a single column, return the column and the count of the column. If the user asks for a rate, return the rate as a decimal. For example, 0.1 would be 10%.
```

There are several important elements of this prompt:

- Schema description helps the model understand exactly what data fields to work with
- Includes rules for handling queries based on common SQL patterns - for example, always using ILIKE for case-insensitive string matching
- Explains how to handle edge cases in the dataset, like dealing with the comma-separated investors field and ensuring whitespace is properly handled
- Instead of having the model guess at industry categories, it provides the exact list that exists in the data, helping avoid mismatches
- The prompt helps standardize data transformations - like knowing to interpret "10b" as "10.0" billion dollars, or that rates should be decimal values
- Clear rules ensure the query output will be chart-friendly by always including at least two columns of data that can be plotted

This prompt structure provides a strong foundation for query generation, but you should experiment and iterate based on your specific needs and the model you're using.

### Create a Server Action

With the prompt done, let's create a Server Action.

Open `app/actions.ts`. You should see one action already defined (`runGeneratedSQLQuery`).

Add a new action. This action should be asynchronous and take in one parameter - the natural language query.

```ts filename="app/actions.ts"
/* ...rest of the file... */

export const generateQuery = async (input: string) => {};
```

In this action, you'll use the `generateText` function with `Output` from the AI SDK which allows you to constrain the model's output to a pre-defined schema. This process, sometimes called structured output, ensures the model returns only the SQL query without any additional prefixes, explanations, or formatting that would require manual parsing.

```ts filename="app/actions.ts"
/* ...other imports... */
import { generateText, Output } from 'ai';
import { z } from 'zod';

/* ...rest of the file... */

export const generateQuery = async (input: string) => {
  'use server';
  try {
    const result = await generateText({
      model: 'openai/gpt-4o',
      system: `You are a SQL (postgres) ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Generate the query necessary to retrieve the data the user wants: ${input}`,
      output: Output.object({
        schema: z.object({
          query: z.string(),
        }),
      }),
    });
    return result.output.query;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

Note, you are constraining the output to a single string field called `query` using `zod`, a TypeScript schema validation library. This will ensure the model only returns the SQL query itself. The resulting output will then be returned.

### Update the frontend

With the Server Action in place, you can now update the frontend to call this action when the user submits a natural language query. In the root page (`app/page.tsx`), you should see a `handleSubmit` function that is called when the user submits a query.

Import the `generateQuery` function and call it with the user's input.

```typescript filename="app/page.tsx" highlight="21"
/* ...other imports... */
import { runGeneratedSQLQuery, generateQuery } from './actions';

/* ...rest of the file... */

const handleSubmit = async (suggestion?: string) => {
  clearExistingData();

  const question = suggestion ?? inputValue;
  if (inputValue.length === 0 && !suggestion) return;

  if (question.trim()) {
    setSubmitted(true);
  }

  setLoading(true);
  setLoadingStep(1);
  setActiveQuery('');

  try {
    const query = await generateQuery(question);

    if (query === undefined) {
      toast.error('An error occurred. Please try again.');
      setLoading(false);
      return;
    }

    setActiveQuery(query);
    setLoadingStep(2);

    const companies = await runGeneratedSQLQuery(query);
    const columns = companies.length > 0 ? Object.keys(companies[0]) : [];
    setResults(companies);
    setColumns(columns);

    setLoading(false);
  } catch (e) {
    toast.error('An error occurred. Please try again.');
    setLoading(false);
  }
};

/* ...rest of the file... */
```

Now, when the user submits a natural language query (ie. "how many unicorns are from San Francisco?"), that question will be sent to your newly created Server Action. The Server Action will call the model, passing in your system prompt and the users query, and return the generated SQL query in a structured format. This query is then passed to the `runGeneratedSQLQuery` action to run the query against your database. The results are then saved in local state and displayed to the user.

Save the file, make sure the dev server is running, and then head to `localhost:3000` in your browser. Try submitting a natural language query and see the generated SQL query and results. You should see a SQL query generated and displayed under the input field. You should also see the results of the query displayed in a table below the input field.

Try clicking the SQL query to see the full query if it's too long to display in the input field. You should see a button on the right side of the input field with a question mark icon. Clicking this button currently does nothing, but you'll add the "explain query" functionality to it in the next step.

## Explain SQL Queries

Next, let's add the ability to explain SQL queries in plain English. This feature helps users understand how the generated SQL query works by breaking it down into logical sections.
As with the SQL query generation, you'll need a prompt to guide the model when explaining queries.

Let's craft a prompt for the explain query functionality:

```txt
You are a SQL (postgres) expert. Your job is to explain to the user the SQL query you wrote to retrieve the data they asked for. The table schema is as follows:
unicorns (
  id SERIAL PRIMARY KEY,
  company VARCHAR(255) NOT NULL UNIQUE,
  valuation DECIMAL(10, 2) NOT NULL,
  date_joined DATE,
  country VARCHAR(255) NOT NULL,
  city VARCHAR(255) NOT NULL,
  industry VARCHAR(255) NOT NULL,
  select_investors TEXT NOT NULL
);

When you explain you must take a section of the query, and then explain it. Each "section" should be unique. So in a query like: "SELECT * FROM unicorns limit 20", the sections could be "SELECT *", "FROM UNICORNS", "LIMIT 20".
If a section doesn't have any explanation, include it, but leave the explanation empty.
```

Like the prompt for generating SQL queries, you provide the model with the schema of the database. Additionally, you provide an example of what each section of the query might look like. This helps the model understand the structure of the query and how to break it down into logical sections.

### Create a Server Action

Add a new Server Action to generate explanations for SQL queries.

This action takes two parameters - the original natural language input and the generated SQL query.

```ts filename="app/actions.ts"
/* ...rest of the file... */

export const explainQuery = async (input: string, sqlQuery: string) => {
  'use server';
  try {
    const result = await generateText({
      model: 'openai/gpt-4o',
      system: `You are a SQL (postgres) expert. ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Explain the SQL query you generated to retrieve the data the user wanted. Assume the user is not an expert in SQL. Break down the query into steps. Be concise.

      User Query:
      ${input}

      Generated SQL Query:
      ${sqlQuery}`,
    });
    return result.text;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

This action uses the `generateText` function. However, you haven't defined the output schema yet. Let's define it in another file so it can also be used as a type in your components.

Update your `lib/types.ts` file to include the schema for the explanations:

```ts filename="lib/types.ts"
import { z } from 'zod';

/* ...rest of the file... */

export const explanationSchema = z.object({
  section: z.string(),
  explanation: z.string(),
});

export type QueryExplanation = z.infer<typeof explanationSchema>;
```

This schema defines the structure of the explanation that the model will generate. Each explanation will have a `section` and an `explanation`. The `section` is the part of the query being explained, and the `explanation` is the plain English explanation of that section. Go back to your `actions.ts` file and import and use the `explanationSchema`:

```ts filename="app/actions.ts" highlight="2,19,20"
// other imports
import { explanationSchema } from '@/lib/types';

/* ...rest of the file... */

export const explainQuery = async (input: string, sqlQuery: string) => {
  'use server';
  try {
    const result = await generateText({
      model: 'openai/gpt-4o',
      system: `You are a SQL (postgres) expert. ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Explain the SQL query you generated to retrieve the data the user wanted. Assume the user is not an expert in SQL. Break down the query into steps. Be concise.

      User Query:
      ${input}

      Generated SQL Query:
      ${sqlQuery}`,
      output: Output.array({ element: explanationSchema }),
    });
    return result.output;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

<Note>
  You can use `Output.array()` to indicate to the model that you expect an array
  of objects matching the schema to be returned.
</Note>

### Update query viewer

Next, update the `query-viewer.tsx` component to display these explanations. The `handleExplainQuery` function is called every time the user clicks the question icon button on the right side of the query. Let's update this function to use the new `explainQuery` action:

```ts filename="components/query-viewer.tsx" highlight="2,10,11"
/* ...other imports... */
import { explainQuery } from '@/app/actions';

/* ...rest of the component... */

const handleExplainQuery = async () => {
  setQueryExpanded(true);
  setLoadingExplanation(true);

  const explanations = await explainQuery(inputValue, activeQuery);
  setQueryExplanations(explanations);

  setLoadingExplanation(false);
};

/* ...rest of the component... */
```

Now when users click the explanation button (the question mark icon), the component will:

1. Show a loading state
2. Send the active SQL query and the users natural language query to your Server Action
3. The model will generate an array of explanations
4. The explanations will be set in the component state and rendered in the UI

Submit a new query and then click the explanation button. Hover over different elements of the query. You should see the explanations for each section!

## Visualizing query results

Finally, let's render the query results visually in a chart. There are two approaches you could take:

1. Send both the query and data to the model and ask it to return the data in a visualization-ready format. While this provides complete control over the visualization, it requires the model to send back all of the data, which significantly increases latency and costs.

2. Send the query and data to the model and ask it to generate a chart configuration (fixed-size and not many tokens) that maps your data appropriately. This configuration specifies how to visualize the information while delivering the insights from your natural language query. Importantly, this is done without requiring the model return the full dataset.

Since you don't know the SQL query or data shape beforehand, let's use the second approach to dynamically generate chart configurations based on the query results and user intent.

### Generate the chart configuration

For this feature, you'll create a Server Action that takes the query results and the user's original natural language query to determine the best visualization approach. Your application is already set up to use `shadcn` charts (which uses [`Recharts`](https://recharts.org/en-US/) under the hood) so the model will need to generate:

- Chart type (bar, line, area, or pie)
- Axis mappings
- Visual styling

Let's start by defining the schema for the chart configuration in `lib/types.ts`:

```ts filename="lib/types.ts"
/* ...rest of the file... */

export const configSchema = z
  .object({
    description: z
      .string()
      .describe(
        'Describe the chart. What is it showing? What is interesting about the way the data is displayed?',
      ),
    takeaway: z.string().describe('What is the main takeaway from the chart?'),
    type: z.enum(['bar', 'line', 'area', 'pie']).describe('Type of chart'),
    title: z.string(),
    xKey: z.string().describe('Key for x-axis or category'),
    yKeys: z
      .array(z.string())
      .describe(
        'Key(s) for y-axis values this is typically the quantitative column',
      ),
    multipleLines: z
      .boolean()
      .describe(
        'For line charts only: whether the chart is comparing groups of data.',
      )
      .optional(),
    measurementColumn: z
      .string()
      .describe(
        'For line charts only: key for quantitative y-axis column to measure against (eg. values, counts etc.)',
      )
      .optional(),
    lineCategories: z
      .array(z.string())
      .describe(
        'For line charts only: Categories used to compare different lines or data series. Each category represents a distinct line in the chart.',
      )
      .optional(),
    colors: z
      .record(
        z.string().describe('Any of the yKeys'),
        z.string().describe('Color value in CSS format (e.g., hex, rgb, hsl)'),
      )
      .describe('Mapping of data keys to color values for chart elements')
      .optional(),
    legend: z.boolean().describe('Whether to show legend'),
  })
  .describe('Chart configuration object');

export type Config = z.infer<typeof configSchema>;
```

<Note>
  Replace the existing `export type Config = any;` type with the new one.
</Note>

This schema makes extensive use of Zod's `.describe()` function to give the model extra context about each of the key's you are expecting in the chart configuration. This will help the model understand the purpose of each key and generate more accurate results.

Another important technique to note here is that you are defining `description` and `takeaway` fields. Not only are these useful for the user to quickly understand what the chart means and what they should take away from it, but they also force the model to generate a description of the data first, before it attempts to generate configuration attributes like axis and columns. This will help the model generate more accurate and relevant chart configurations.

### Create the Server Action

Create a new action in `app/actions.ts`:

```ts
/* ...other imports... */
import { Config, configSchema, explanationsSchema, Result } from '@/lib/types';

/* ...rest of the file... */

export const generateChartConfig = async (
  results: Result[],
  userQuery: string,
) => {
  'use server';

  try {
    const { output: config } = await generateText({
      model: 'openai/gpt-4o',
      system: 'You are a data visualization expert.',
      prompt: `Given the following data from a SQL query result, generate the chart config that best visualises the data and answers the users query.
      For multiple groups use multi-lines.

      Here is an example complete config:
      export const chartConfig = {
        type: "pie",
        xKey: "month",
        yKeys: ["sales", "profit", "expenses"],
        colors: {
          sales: "#4CAF50",    // Green for sales
          profit: "#2196F3",   // Blue for profit
          expenses: "#F44336"  // Red for expenses
        },
        legend: true
      }

      User Query:
      ${userQuery}

      Data:
      ${JSON.stringify(results, null, 2)}`,
      output: Output.object({ schema: configSchema }),
    });

    // Override with shadcn theme colors
    const colors: Record<string, string> = {};
    config.yKeys.forEach((key, index) => {
      colors[key] = `hsl(var(--chart-${index + 1}))`;
    });

    const updatedConfig = { ...config, colors };
    return { config: updatedConfig };
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate chart suggestion');
  }
};
```

### Update the chart component

With the action in place, you'll want to trigger it automatically after receiving query results. This ensures the visualization appears almost immediately after data loads.

Update the `handleSubmit` function in your root page (`app/page.tsx`) to generate and set the chart configuration after running the query:

```typescript filename="app/page.tsx" highlight="38,39"
/* ...other imports... */
import { getCompanies, generateQuery, generateChartConfig } from './actions';

/* ...rest of the file... */
const handleSubmit = async (suggestion?: string) => {
  clearExistingData();

  const question = suggestion ?? inputValue;
  if (inputValue.length === 0 && !suggestion) return;

  if (question.trim()) {
    setSubmitted(true);
  }

  setLoading(true);
  setLoadingStep(1);
  setActiveQuery('');

  try {
    const query = await generateQuery(question);

    if (query === undefined) {
      toast.error('An error occurred. Please try again.');
      setLoading(false);
      return;
    }

    setActiveQuery(query);
    setLoadingStep(2);

    const companies = await runGeneratedSQLQuery(query);
    const columns = companies.length > 0 ? Object.keys(companies[0]) : [];
    setResults(companies);
    setColumns(columns);

    setLoading(false);

    const { config } = await generateChartConfig(companies, question);
    setChartConfig(config);
  } catch (e) {
    toast.error('An error occurred. Please try again.');
    setLoading(false);
  }
};

/* ...rest of the file... */
```

Now when users submit queries, the application will:

1. Generate and run the SQL query
2. Display the table results
3. Generate a chart configuration for the results
4. Allow toggling between table and chart views

Head back to the browser and test the application with a few queries. You should see the chart visualization appear after the table results.

## Next steps

You've built an AI-powered SQL analysis tool that can convert natural language to SQL queries, visualize query results, and explain SQL queries in plain English.

You could, for example, extend the application to use your own data sources or add more advanced features like customizing the chart configuration schema to support more chart types and options. You could also add more complex SQL query generation capabilities.

---
title: Get started with Computer Use
description: Get started with Claude's Computer Use capabilities with the AI SDK
tags: ['computer-use', 'tools']
---

# Get started with Computer Use

With the [release of Computer Use in Claude 3.5 Sonnet](https://www.anthropic.com/news/3-5-models-and-computer-use), you can now direct AI models to interact with computers like humans do - moving cursors, clicking buttons, and typing text. This capability enables automation of complex tasks while leveraging Claude's advanced reasoning abilities.

The AI SDK is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like Anthropic's Claude alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more. In this guide, you will learn how to integrate Computer Use into your AI SDK applications.

<Note>
  Computer Use is currently in beta with some [ limitations
  ](https://docs.anthropic.com/en/docs/build-with-claude/computer-use#understand-computer-use-limitations).
  The feature may be error-prone at times. Anthropic recommends starting with
  low-risk tasks and implementing appropriate safety measures.
</Note>

## Computer Use

Anthropic recently released a new version of the Claude 3.5 Sonnet model which is capable of 'Computer Use'. This allows the model to interact with computer interfaces through basic actions like:

- Moving the cursor
- Clicking buttons
- Typing text
- Taking screenshots
- Reading screen content

## How It Works

Computer Use enables the model to read and interact with on-screen content through a series of coordinated steps. Here's how the process works:

1. **Start with a prompt and tools**

   Add Anthropic-defined Computer Use tools to your request and provide a task (prompt) for the model. For example: "save an image to your downloads folder."

2. **Select the right tool**

   The model evaluates which computer tools can help accomplish the task. It then sends a formatted `tool_call` to use the appropriate tool.

3. **Execute the action and return results**

   The AI SDK processes Claude's request by running the selected tool. The results can then be sent back to Claude through a `tool_result` message.

4. **Complete the task through iterations**

   Claude analyzes each result to determine if more actions are needed. It continues requesting tool use and processing results until it completes your task or requires additional input.

### Available Tools

There are three main tools available in the Computer Use API:

1. **Computer Tool**: Enables basic computer control like mouse movement, clicking, and keyboard input
2. **Text Editor Tool**: Provides functionality for viewing and editing text files
3. **Bash Tool**: Allows execution of bash commands

### Implementation Considerations

Computer Use tools in the AI SDK are predefined interfaces that require your own implementation of the execution layer. While the SDK provides the type definitions and structure for these tools, you need to:

1. Set up a controlled environment for Computer Use execution
2. Implement core functionality like mouse control and keyboard input
3. Handle screenshot capture and processing
4. Set up rules and limits for how Claude can interact with your system

The recommended approach is to start with [ Anthropic's reference implementation ](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo), which provides:

- A containerized environment configured for safe Computer Use
- Ready-to-use (Python) implementations of Computer Use tools
- An agent loop for API interaction and tool execution
- A web interface for monitoring and control

This reference implementation serves as a foundation to understand the requirements before building your own custom solution.

## Getting Started with the AI SDK

<Note>
  If you have never used the AI SDK before, start by following the [Getting
  Started guide](/docs/getting-started).
</Note>

<Note>
  For a working example of Computer Use implementation with Next.js and the AI
  SDK, check out our [AI SDK Computer Use
  Template](https://github.com/vercel-labs/ai-sdk-computer-use).
</Note>

First, ensure you have the AI SDK and [Anthropic AI SDK provider](/providers/ai-sdk-providers/anthropic) installed:

<Snippet text="pnpm add ai @ai-sdk/anthropic" />

You can add Computer Use to your AI SDK applications using provider-defined-client tools. These tools accept various input parameters (like display height and width in the case of the computer tool) and then require that you define an execute function.

Here's how you could set up the Computer Tool with the AI SDK:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { getScreenshot, executeComputerAction } from '@/utils/computer-use';

const computerTool = anthropic.tools.computer_20250124({
  displayWidthPx: 1920,
  displayHeightPx: 1080,
  execute: async ({ action, coordinate, text }) => {
    switch (action) {
      case 'screenshot': {
        return {
          type: 'image',
          data: getScreenshot(),
        };
      }
      default: {
        return executeComputerAction(action, coordinate, text);
      }
    }
  },
  toModelOutput({ output }) {
    return typeof output === 'string'
      ? [{ type: 'text', text: output }]
      : [{ type: 'image', data: output.data, mediaType: 'image/png' }];
  },
});
```

The `computerTool` handles two main actions: taking screenshots via `getScreenshot()` and executing computer actions like mouse movements and clicks through `executeComputerAction()`. Remember, you have to implement this execution logic (eg. the `getScreenshot` and `executeComputerAction` functions) to handle the actual computer interactions. The `execute` function should handle all low-level interactions with the operating system.

Finally, to send tool results back to the model, use the [`toModelOutput()`](/docs/foundations/prompts#multi-modal-tool-results) function to convert text and image responses into a format the model can process. The AI SDK includes experimental support for these multi-modal tool results when using Anthropic's models.

<Note>
  Computer Use requires appropriate safety measures like using virtual machines,
  limiting access to sensitive data, and implementing human oversight for
  critical actions.
</Note>

### Using Computer Tools with Text Generation

Once your tool is defined, you can use it with both the [`generateText`](/docs/reference/ai-sdk-core/generate-text) and [`streamText`](/docs/reference/ai-sdk-core/stream-text) functions.

For one-shot text generation, use `generateText`:

```ts
const result = await generateText({
  model: 'anthropic/claude-sonnet-4-20250514',
  prompt: 'Move the cursor to the center of the screen and take a screenshot',
  tools: { computer: computerTool },
});

console.log(result.text);
```

For streaming responses, use `streamText` to receive updates in real-time:

```ts
const result = streamText({
  model: 'anthropic/claude-sonnet-4-20250514',
  prompt: 'Open the browser and navigate to vercel.com',
  tools: { computer: computerTool },
});

for await (const chunk of result.textStream) {
  console.log(chunk);
}
```

### Configure Multi-Step (Agentic) Generations

To allow the model to perform multiple steps without user intervention, use the `stopWhen` parameter. This will automatically send any tool results back to the model to trigger a subsequent generation:

```ts highlight="1,7"
import { isStepCount } from 'ai';

const stream = streamText({
  model: 'anthropic/claude-sonnet-4-20250514',
  prompt: 'Open the browser and navigate to vercel.com',
  tools: { computer: computerTool },
  stopWhen: isStepCount(10), // experiment with this value based on your use case
});
```

### Combine Multiple Tools

You can combine multiple tools in a single request to enable more complex workflows. The AI SDK supports all three of Claude's Computer Use tools:

```ts
const computerTool = anthropic.tools.computer_20250124({
  ...
});

const bashTool = anthropic.tools.bash_20250124({
  execute: async ({ command, restart }) => execSync(command).toString()
});

const textEditorTool = anthropic.tools.textEditor_20250124({
  execute: async ({
    command,
    path,
    file_text,
    insert_line,
    new_str,
    insert_text,
    old_str,
    view_range
  }) => {
    // Handle file operations based on command
    switch(command) {
      return executeTextEditorFunction({
        command,
        path,
        fileText: file_text,
        insertLine: insert_line,
        newStr: new_str,
        insertText: insert_text,
        oldStr: old_str,
        viewRange: view_range
      });
    }
  }
});


const response = await generateText({
  model: 'anthropic/claude-sonnet-4-20250514',
  prompt: "Create a new file called example.txt, write 'Hello World' to it, and run 'cat example.txt' in the terminal",
  tools: {
    computer: computerTool,
    bash: bashTool,
    str_replace_editor: textEditorTool,
  },
});
```

<Note>
  Always implement appropriate [security measures](#security-measures) and
  obtain user consent before enabling Computer Use in production applications.
</Note>

### Best Practices for Computer Use

To get the best results when using Computer Use:

1. Specify simple, well-defined tasks with explicit instructions for each step
2. Prompt Claude to verify outcomes through screenshots
3. Use keyboard shortcuts when UI elements are difficult to manipulate
4. Include example screenshots for repeatable tasks
5. Provide explicit tips in system prompts for known tasks

## Security Measures

Remember, Computer Use is a beta feature. Please be aware that it poses unique risks that are distinct from standard API features or chat interfaces. These risks are heightened when using Computer Use to interact with the internet. To minimize risks, consider taking precautions such as:

1. Use a dedicated virtual machine or container with minimal privileges to prevent direct system attacks or accidents.
2. Avoid giving the model access to sensitive data, such as account login information, to prevent information theft.
3. Limit internet access to an allowlist of domains to reduce exposure to malicious content.
4. Ask a human to confirm decisions that may result in meaningful real-world consequences as well as any tasks requiring affirmative consent, such as accepting cookies, executing financial transactions, or agreeing to terms of service.

---
title: Add Skills to Your Agent
description: Learn how to extend your agent with specialized capabilities loaded at runtime with Agent Skills.
tags: ['agent', 'skills', 'tools', 'extensibility']
---

# Add Skills to Your Agent

In this guide, you will learn how to extend your agent with [Agent Skills](https://agentskills.io), a lightweight, open format for adding specialized knowledge and workflows that load at runtime from markdown files.

At its core, a skill is a folder containing a `SKILL.md` file with metadata and instructions that tell an agent how to perform a specific task.

```
my-skill/
├── SKILL.md          # Required: instructions + metadata
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

## How Skills Work

Skills use **progressive disclosure** to manage context efficiently:

1. **Discovery**: At startup, agents load only the name and description of each available skill (just enough to know when it might be relevant)
2. **Activation**: When a task matches a skill's description, the agent reads the full `SKILL.md` instructions into context
3. **Execution**: The agent follows the instructions, optionally loading referenced files or executing bundled code as needed

This approach keeps agents fast while giving them access to more context on demand.

## The SKILL.md File

Every skill starts with a `SKILL.md` file containing YAML frontmatter and Markdown instructions:

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents.
---

# PDF Processing

## When to use this skill
Use this skill when the user needs to work with PDF files...

## How to extract text
1. Use pdfplumber for text extraction...

## How to fill forms
...
```

The frontmatter requires:

- `name`: A short identifier
- `description`: Instructions for when to use this skill

The Markdown body contains the actual skill content with no restrictions on structure or content.

## Prerequisites

To support skills, your agent needs:

1. **Filesystem access** to discover and load skill files (read files, read directories)
2. **A load skill tool** that reads the `SKILL.md` content into context
3. **Command execution** (optional) if skills bundle scripts (e.g. a full sandbox environment)

## Step 1: Define a Sandbox Abstraction

<Note>
  This guide uses a generic sandbox abstraction for flexibility across
  environments. If you're building for Node.js, you can use `fs/promises` and
  `child_process` directly instead.
</Note>

Create a generic sandbox interface that provides a consistent way to interact with the filesystem. This abstraction lets you implement it differently depending on your environment (Node.js fs, a containerized sandbox, cloud storage, etc.):

```ts
interface Sandbox {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readdir(
    path: string,
    opts: { withFileTypes: true },
  ): Promise<{ name: string; isDirectory(): boolean }[]>;
  exec(command: string): Promise<{ stdout: string; stderr: string }>;
}
```

## Step 2: Discover Skills at Startup

Scan skill directories and extract metadata from each `SKILL.md`:

```ts
interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

async function discoverSkills(
  sandbox: Sandbox,
  directories: string[],
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];
  const seenNames = new Set<string>();

  for (const dir of directories) {
    let entries;
    try {
      entries = await sandbox.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Skip directories that don't exist
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = `${dir}/${entry.name}`;
      const skillFile = `${skillDir}/SKILL.md`;

      try {
        const content = await sandbox.readFile(skillFile, 'utf-8');
        const frontmatter = parseFrontmatter(content);

        // First skill with a given name wins (allows project overrides)
        if (seenNames.has(frontmatter.name)) continue;
        seenNames.add(frontmatter.name);

        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          path: skillDir,
        });
      } catch {
        continue; // Skip skills without valid SKILL.md
      }
    }
  }
  return skills;
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) throw new Error('No frontmatter found');
  // Parse YAML using your preferred library
  return yaml.parse(match[1]);
}
```

## Step 3: Build the System Prompt

Include discovered skills in the system prompt so the agent knows what's available:

```ts
function buildSkillsPrompt(skills: SkillMetadata[]): string {
  const skillsList = skills
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  return `
## Skills

Use the \`loadSkill\` tool to load a skill when the user's request
would benefit from specialized instructions.

Available skills:
${skillsList}
`;
}
```

The agent sees only names and descriptions. Full instructions stay out of the context window until loaded.

## Step 4: Create the Load Skill Tool

The load skill tool reads the full `SKILL.md` and returns the body (without frontmatter):

```ts
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

const loadSkillTool = tool({
  description: 'Load a skill to get specialized instructions',
  inputSchema: z.object({
    name: z.string().describe('The skill name to load'),
  }),
  execute: async ({ name }, { context }) => {
    const { sandbox, skills } = context as {
      sandbox: Sandbox;
      skills: SkillMetadata[];
    };

    const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) {
      return { error: `Skill '${name}' not found` };
    }

    const skillFile = `${skill.path}/SKILL.md`;
    const content = await sandbox.readFile(skillFile, 'utf-8');
    const body = stripFrontmatter(content);

    return {
      skillDirectory: skill.path,
      content: body,
    };
  },
});
```

The tool returns the skill directory path alongside the content so the agent can construct full paths to bundled resources.

## Step 5: Create the Agent

Wire up the sandbox and skills using `callOptionsSchema` and `prepareCall`:

```ts
const callOptionsSchema = z.object({
  sandbox: z.custom<Sandbox>(),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      path: z.string(),
    }),
  ),
});

const readFileTool = tool({
  description: 'Read a file from the filesystem',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }, { context }) => {
    const { sandbox } = context as { sandbox: Sandbox };
    return sandbox.readFile(path, 'utf-8');
  },
});

const bashTool = tool({
  description: 'Execute a bash command',
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }, { context }) => {
    const { sandbox } = context as { sandbox: Sandbox };
    return sandbox.exec(command);
  },
});

const agent = new ToolLoopAgent({
  model: yourModel,
  tools: {
    loadSkill: loadSkillTool,
    readFile: readFileTool,
    bash: bashTool,
  },
  callOptionsSchema,
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    instructions: `${settings.instructions}\n\n${buildSkillsPrompt(options.skills)}`,
    context: {
      sandbox: options.sandbox,
      skills: options.skills,
    },
  }),
});
```

## Step 6: Run the Agent

```ts
// Create sandbox (your filesystem/execution abstraction)
const sandbox = createSandbox({ workingDirectory: process.cwd() });

// Discover skills at startup
const skills = await discoverSkills(sandbox, [
  '.agents/skills',
  '~/.config/agent/skills',
]);

// Run the agent
const result = await agent.run({
  prompt: userMessage,
  options: { sandbox, skills },
});
```

When a user asks something that matches a skill description, the agent calls `loadSkill`. The full instructions load into context, and the agent follows them using `bash` and `readFile` to access bundled resources.

## Accessing Bundled Resources

Skills can reference files relative to their directory. The agent uses existing tools to access them:

```markdown
Skill directory: /path/to/.agents/skills/my-skill

# My Skill Instructions

Read the configuration template:
templates/config.json

Run the setup script:
bash scripts/setup.sh
```

The agent sees the skill directory path in the tool result and prepends it when accessing `templates/config.json` or `scripts/setup.sh`. No special resource loading mechanism is needed—the agent uses the same tools it uses for everything else.

## Learn More

- [Agent Skills specification](https://agentskills.io/specification) for the full format details
- [Example skills](https://github.com/anthropics/skills) on GitHub
- [Authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) for writing effective skills
- [Reference library](https://github.com/agentskills/agentskills/tree/main/skills-ref) to validate skills and generate prompt XML
- [skills.sh](https://skills.sh) to browse and discover community skills

---
title: Build a Custom Memory Tool
description: Build an agent that persists memories using a filesystem-backed memory tool.
---

# Build a Custom Memory Tool

Memory means saving the right information at the right time, in the right place, and injecting it back into the conversation when it matters. Without memory, your agent treats every conversation as its first. With memory, your agent builds context over time, recalls previous interactions, and adapts to the user.

## The Storage Primitive: The Filesystem

Where should you store memories? Files organized in a filesystem-like structure are a natural fit:

- **Persistence**: you can persist files across process restarts and conversations
- **Speed**: reading and writing files is fast, even at scale
- **Familiarity**: language models understand files and paths from their training data
- **Hierarchy**: you can use a directory structure to create deep and organized memory banks, grouping memories by topic, time, or type

The key insight is that "filesystem" here is an abstraction. The backing store does not matter. You could use a real sandboxed filesystem, an in-memory virtual filesystem, or a shim over Postgres. What matters is the concept: files organized in a hierarchical structure, and an interface that can manipulate, search, read, and edit those files. That is the primitive.

## The Interface: A Memory Tool

You have files. Now the model needs to interact with them. You give the model a tool, along with instructions for when and how to use it. There are two approaches:

### Structured Actions Tool

Define explicit actions the model can take (`view`, `create`, `update`, `search`) and have the model generate structured input that you handle yourself:

```json
{
  "name": "memory",
  "input": {
    "command": "view",
    "path": "/memories/customer_service_guidelines.xml"
  }
}
```

This is safe by design since you control every operation that runs. However, it requires more upfront implementation and limits the model to only the actions you have built.

### Bash-Backed Tool

The alternative is to back the memory tool with bash. Models are proficient at composing shell commands, which lets them craft flexible queries to access what they need: `cat` a file, `grep` for patterns, pipe commands together, or perform in-place edits with `sed`. This is the more powerful approach, but it requires careful work to build an approval system that prevents prompt injection and blocks dangerous commands.

## Types of Memory

Not all memories are equal. They differ in how you store them, how often the model accesses them, and when they surface:

- **Core Memory**: information included in every turn. This can range from the user's name to instructions for where to find other memories. You inject core memory directly into the system prompt, so the model always has it without needing a tool call.
- **Archival Memory**: a notes folder or file where the model stores detailed knowledge. Think of it as the model's notebook, where it writes down facts, summaries, and observations for later. The model reads and writes archival memory on demand through the memory tool.
- **Recall Memory**: the conversations themselves. By persisting full turn-by-turn history, the model can search previous interactions to surface relevant context from past discussions.

These memory terms are based on [Letta's definitions](https://www.letta.com/blog/agent-memory).

## What We Will Build

This recipe is a simplified demonstration of these concepts. You build one memory tool over a shared `.memory` store, then wire it into an agent with `prepareCall` so core memory is injected before each model call. You can implement the tool with structured actions or with a bash-backed interface.

The memory layout is a `.memory` directory with three files, each mapping to one of the memory types above:

```
.memory/
├── core.md               # Core memory, injected every turn
├── notes.md              # Archival memory, timestamped notes
└── conversations.jsonl   # Recall memory, full turn history (JSONL)
```

## Prerequisites

To follow this guide, you need the following:

1. **AI SDK** with `ToolLoopAgent` and `tool`
2. **Zod** for tool input schemas
3. **Optional for Route B (bash-backed)**: **[just-bash](https://github.com/vercel-labs/just-bash)** for command execution and AST parsing

Install dependencies for both routes:

```bash
pnpm add ai just-bash zod
```

If you only use Route A (structured actions), you can skip `just-bash`.

## Implementation Requirements

Before building the agent, you need shared infrastructure plus one route-specific piece:

1. **Bootstrap the filesystem.** On startup, ensure the memory directory and its files exist with reasonable defaults. This is a one-time setup step: create the directory if missing, seed each file with starter content if it does not already exist, and add the memory directory to `.gitignore` to keep it local and private.

2. **Helper functions for core memory and conversation logging.** You need a way to read core memory (so you can inject it into the system prompt) and a way to append conversation entries. Conversations are stored as JSONL (one JSON object per line), which makes them straightforward to `grep` for keywords and pipe through `jq` for formatting.

3. **Route-specific execution safety.**
   - **Route A (structured actions):** keep the action set small and explicit (`view`, `create`, `update`, `search`) and only operate on known `.memory` paths.
   - **Route B (bash-backed):** validate commands before execution. Users can craft prompts that try to run harmful commands, so use AST-based validation and an allowlist. See the [Appendix](#appendix-command-guard) for a full implementation with `just-bash`.

## Step 1: Define the Memory Tool

Choose your tool interface first. Both routes use the same `.memory` files, the same `prepareCall` injection pattern, and the same conversation logging. The only difference is how the model issues memory operations.

### Route A: Structured Actions Tool

Use this when you want predictable, explicit operations (`view`, `create`, `update`, `search`) and minimal command-safety surface.

Define a schema and route every request through your own `runMemoryCommand` handler:

```ts
import { tool } from 'ai';
import { z } from 'zod';

const memoryInputSchema = z.object({
  command: z
    .enum(['view', 'create', 'update', 'search'])
    .describe(
      'Memory action: view to read, create to write new content, update to change existing content, search to find relevant lines.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Memory path under /memories, such as /memories/core.md or /memories/notes.md. Required for view, create, and update.',
    ),
  content: z
    .string()
    .optional()
    .describe('Text to write for create or update commands.'),
  mode: z
    .enum(['append', 'overwrite'])
    .optional()
    .describe(
      'Write mode for update: append adds to existing content, overwrite replaces it. Defaults to overwrite.',
    ),
  query: z
    .string()
    .optional()
    .describe(
      'Search keywords for the search command. Prefer short focused terms.',
    ),
});

const memoryTool = tool({
  description: `Use this tool to read and maintain long-term memory under /memories.

Rules:
- If the user prompt might depend on preferences, history, constraints, or goals, search first, then reply.
- If the prompt is fully self-contained or general knowledge, reply directly.
- Keep searches short and focused (1-4 words).
- Store durable user facts in /memories/core.md and detailed notes in /memories/notes.md.
- Keep memory operations invisible in user-facing replies.`,
  inputSchema: memoryInputSchema,
  execute: async input => {
    try {
      const output = await runMemoryCommand(input);
      return { output };
    } catch (error) {
      return { output: `Memory action failed: ${(error as Error).message}` };
    }
  },
});
```

This keeps memory operations predictable because the model can only call predefined actions.

### Route B: Bash-Backed Tool

Use this when you want maximum flexibility in reads, writes, and ad-hoc search.

```ts
import { tool } from 'ai';
import { Bash, ReadWriteFs } from 'just-bash';
import { z } from 'zod';

const fs = new ReadWriteFs({ root: process.cwd() });
const bash = new Bash({ fs, cwd: '/' });

const memoryTool = tool({
  description: `Run bash commands only for memory-related tasks.

This tool is restricted to memory workflows. Do not use it for
general project work, code changes, dependency management, or
system administration.

Inside the tool, use paths under /.memory:
- /.memory/core.md for key facts that should be reused later
- /.memory/notes.md for detailed notes
- /.memory/conversations.jsonl for full turn history

Rules:
- Only perform memory-related reads/writes and conversation recall
- Keep /.memory/core.md short and focused
- Prefer append-friendly notes in /.memory/notes.md for details
- If the user asks about prior conversations, search
  /.memory/conversations.jsonl for relevant keywords first
- Use >> to append, > to overwrite, and perl -pi -e for in-place edits

Examples:
- cat /.memory/core.md
- echo "- User prefers concise answers" >> /.memory/core.md
- perl -pi -e 's/concise answers/detailed answers/g' /.memory/core.md
- grep -n "project" /.memory/notes.md
- echo "2026-02-16: started a Rust CLI" >> /.memory/notes.md
- grep -niE "pricing|budget" /.memory/conversations.jsonl
- tail -n 40 /.memory/conversations.jsonl | jq -c '.role + ": " + .content'`,
  inputSchema: z.object({
    command: z.string().describe('The bash command to execute.'),
  }),
  execute: async ({ command }) => {
    const unapprovedCommand = findUnapprovedCommand(command);
    if (unapprovedCommand) {
      return {
        stdout: '',
        stderr: `Blocked unapproved command: ${unapprovedCommand}\n`,
        exitCode: 1,
      };
    }

    const result = await bash.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
});
```

`ReadWriteFs` reads and writes directly to the real filesystem, rooted at `process.cwd()`. Paths inside the bash interpreter map directly to disk: `/.memory/core.md` resolves to `<project-root>/.memory/core.md`.

The safety pipeline has two layers: the AST-based command guard rejects unapproved commands before they reach the interpreter, and `just-bash` itself is a JavaScript-based bash implementation (it does not spawn a real shell process). While the bash interpreter runs in JavaScript, the filesystem is real and commands read and write actual files on disk. This is why the command guard is critical.

The rest of this recipe (agent wiring, `prepareCall`, and run loop) works for either route.

## Step 2: Create the Agent

Wire everything together with `ToolLoopAgent`. The `prepareCall` hook reads core memory fresh before every LLM call and injects it into the system prompt:

```ts
import { ToolLoopAgent } from 'ai';

const today = new Date().toISOString().slice(0, 10);

const memoryAgent = new ToolLoopAgent({
  model: 'anthropic/claude-haiku-4.5',
  tools: { memory: memoryTool },
  prepareCall: async settings => {
    // user-defined function fetches the contents of /.memory/core.md on every turn
    const coreMemory = await readCoreMemory();
    return {
      ...settings,
      instructions: `Today's date is ${today}.

Core memory:
${coreMemory}

You can save and recall important information using the memory tool.`,
    };
  },
});
```

Because `prepareCall` runs before each generate call in the tool loop, the system prompt always reflects the latest state of `core.md`. If the model updates core memory during a conversation, the next loop iteration sees the change immediately.

## Step 3: Run the Agent

Bootstrap the filesystem, record conversations, and run the agent:

```ts
const prompt = 'Remember that my favorite editor is Neovim';

// Record the user message
await appendConversation({
  role: 'user',
  content: prompt,
  timestamp: new Date().toISOString(),
});

// Run the agent (loops automatically on tool calls)
const result = await memoryAgent.generate({ prompt });

// Record the assistant response
await appendConversation({
  role: 'assistant',
  content: result.text,
  timestamp: new Date().toISOString(),
});

console.log(result.text);
```

When the model decides it needs to store or recall information, it calls the `memory` tool. The `ToolLoopAgent` executes the tool and feeds the result back, continuing until the model produces a final text response.

A typical interaction looks like this:

1. User says "Remember that my favorite editor is Neovim"
2. The model calls `memory` with `echo "- Favorite editor: Neovim" >> /.memory/core.md`
3. The tool executes the command and returns the result
4. The model responds: "Got it, I've saved that your favorite editor is Neovim."
5. On the next run, `prepareCall` reads `core.md` and the fact appears in the system prompt

## Learn More

- [AI SDK documentation](https://ai-sdk.dev/docs) for `ToolLoopAgent`, `tool`, and `generateText`
- [just-bash](https://github.com/vercel-labs/just-bash) for the JavaScript-based bash interpreter and AST parser
- [AI SDK examples](https://github.com/vercel/ai/tree/main/examples) for more agent patterns

---

## Appendix: Implementation Details

The code below is the reference implementation for the infrastructure described in [Implementation Requirements](#implementation-requirements). It uses Node.js filesystem APIs and a Bun entrypoint, but you can port the patterns to any runtime.

### Appendix: Filesystem Bootstrap

Define the memory directory structure and bootstrap it on startup. Each file gets reasonable defaults if it does not already exist:

```ts
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MEMORY_DIR = '.memory';
const MEMORY_ROOT = resolve(process.cwd(), MEMORY_DIR);
const CORE_MEMORY_PATH = join(MEMORY_ROOT, 'core.md');
const NOTES_PATH = join(MEMORY_ROOT, 'notes.md');
const CONVERSATIONS_PATH = join(MEMORY_ROOT, 'conversations.jsonl');

const DEFAULT_CORE_MEMORY = `# Core Memory
- Keep this short.
- Put stable user facts here.
`;

const DEFAULT_NOTES = `# Notes
Use this file for detailed memories and timestamped notes.
`;

async function ensureFile(path: string, content: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, content, 'utf8');
  }
}

async function ensureMemoryFilesystem(): Promise<void> {
  await mkdir(MEMORY_ROOT, { recursive: true });
  await ensureFile(CORE_MEMORY_PATH, DEFAULT_CORE_MEMORY);
  await ensureFile(NOTES_PATH, DEFAULT_NOTES);
  await ensureFile(CONVERSATIONS_PATH, '');
}
```

Add `.memory` to your `.gitignore` to keep memory local and private.

### Appendix: Helper Functions

One helper reads core memory for system prompt injection, the other appends conversation entries as JSONL:

```ts
async function readCoreMemory(): Promise<string> {
  try {
    return await readFile(CORE_MEMORY_PATH, 'utf8');
  } catch {
    return '';
  }
}

async function appendConversation(entry: {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}): Promise<void> {
  await appendFile(CONVERSATIONS_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}
```

### Appendix: Structured Actions Handler

The `runMemoryCommand` function used in Route A maps each action to a filesystem operation. Paths are resolved relative to the memory root, and only known memory files are allowed:

```ts
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const MEMORY_FILES = ['core.md', 'notes.md', 'conversations.jsonl'];

function resolveMemoryPath(path: string): string {
  const relativePath = path
    .trim()
    .replace(/^\/?memories\/?/, '')
    .replace(/^\/?\.memory\/?/, '')
    .replace(/^\/+/, '');

  if (!MEMORY_FILES.includes(relativePath)) {
    throw new Error(`Unsupported memory path: ${path}`);
  }

  return join(MEMORY_ROOT, relativePath);
}

async function runMemoryCommand(input: {
  command: 'view' | 'create' | 'update' | 'search';
  path?: string;
  content?: string;
  mode?: 'append' | 'overwrite';
  query?: string;
}): Promise<string> {
  const { command, path, content, mode, query } = input;

  switch (command) {
    case 'view': {
      if (!path) throw new Error('path is required for view');
      return await readFile(resolveMemoryPath(path), 'utf8');
    }
    case 'create':
    case 'update': {
      if (!path) throw new Error('path is required');
      if (!content) throw new Error('content is required');
      const target = resolveMemoryPath(path);
      if (mode === 'append') {
        await appendFile(target, content, 'utf8');
      } else {
        await writeFile(target, content, 'utf8');
      }
      return `${command === 'create' ? 'Created' : 'Updated'} ${path}`;
    }
    case 'search': {
      if (!query) throw new Error('query is required for search');
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const files = path
        ? [resolveMemoryPath(path)]
        : MEMORY_FILES.map(f => join(MEMORY_ROOT, f));
      const matches: string[] = [];

      for (const filePath of files) {
        const lines = (await readFile(filePath, 'utf8')).split('\n');
        for (const [i, line] of lines.entries()) {
          const lower = line.toLowerCase();
          if (terms.some(t => lower.includes(t))) {
            matches.push(`${relative(MEMORY_ROOT, filePath)}:${i + 1}:${line}`);
          }
        }
      }

      return matches.length > 0 ? matches.join('\n') : 'No matches found.';
    }
  }
}
```

### Appendix: Command Guard

The AST-based command guard walks every node in the parsed command (including pipelines, subshells, loops, and conditionals) and rejects anything not in the allowlist. This is more robust than string matching or regex. If a command name is dynamically constructed (e.g., via variable expansion), `extractLiteralWord` returns `null` and the guard skips the allowlist check for that command. Since `just-bash` is a JavaScript-based interpreter (not a real shell), dynamically constructed commands that bypass the allowlist check fail to resolve to real binaries. This is an acceptable tradeoff.

```ts
import {
  type CommandNode,
  parse,
  type ScriptNode,
  type WordNode,
} from 'just-bash';

const approvedCommands = new Set([
  'cat',
  'echo',
  'grep',
  'jq',
  'ls',
  'mkdir',
  'perl',
  'sed',
  'tail',
]);

function extractLiteralWord(word: WordNode | null): string | null {
  if (!word || word.parts.length !== 1) return null;
  const [part] = word.parts;
  if (!part || part.type !== 'Literal') return null;
  return part.value;
}

function collectCommandNames(script: ScriptNode): string[] {
  const names = new Set<string>();

  const visitCommand = (command: CommandNode): void => {
    switch (command.type) {
      case 'SimpleCommand': {
        const name = extractLiteralWord(command.name);
        if (name) names.add(name);
        break;
      }
      case 'If': {
        for (const clause of command.clauses) {
          for (const s of clause.condition) visitStatement(s);
          for (const s of clause.body) visitStatement(s);
        }
        if (command.elseBody) {
          for (const s of command.elseBody) visitStatement(s);
        }
        break;
      }
      case 'For':
      case 'CStyleFor':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group': {
        for (const s of command.body) visitStatement(s);
        break;
      }
      case 'Case': {
        for (const item of command.items) {
          for (const s of item.body) visitStatement(s);
        }
        break;
      }
      case 'FunctionDef': {
        visitCommand(command.body);
        break;
      }
      case 'ArithmeticCommand':
      case 'ConditionalCommand':
        break;
    }
  };

  const visitStatement = (
    statement: ScriptNode['statements'][number],
  ): void => {
    for (const pipeline of statement.pipelines) {
      for (const command of pipeline.commands) {
        visitCommand(command);
      }
    }
  };

  for (const statement of script.statements) {
    visitStatement(statement);
  }

  return [...names].sort();
}

export function findUnapprovedCommand(commandLine: string): string | null {
  let script: ScriptNode;
  try {
    script = parse(commandLine);
  } catch {
    return null;
  }
  const commandNames = collectCommandNames(script);
  return commandNames.find(name => !approvedCommands.has(name)) ?? null;
}
```

---
title: Get started with Gemini 3
description: Get started with Gemini 3 using the AI SDK.
tags: ['getting-started']
---

