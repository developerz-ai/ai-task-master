# Groq Provider

The [Groq](https://groq.com/) provider contains language model support for the Groq API.

## Setup

The Groq provider is available via the `@ai-sdk/groq` module.
You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/groq" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/groq" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/groq" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/groq" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `groq` from `@ai-sdk/groq`:

```ts
import { groq } from '@ai-sdk/groq';
```

If you need a customized setup, you can import `createGroq` from `@ai-sdk/groq`
and create a provider instance with your settings:

```ts
import { createGroq } from '@ai-sdk/groq';

const groq = createGroq({
  // custom settings
});
```

You can use the following optional settings to customize the Groq provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.groq.com/openai/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `GROQ_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create [Groq models](https://console.groq.com/docs/models) using a provider instance.
The first argument is the model id, e.g. `gemma2-9b-it`.

```ts
const model = groq('gemma2-9b-it');
```

### Reasoning Models

Groq offers several reasoning models such as `qwen-qwq-32b` and `deepseek-r1-distill-llama-70b`.
You can configure how the reasoning is exposed in the generated text by using the `reasoningFormat` option.
It supports the options `parsed`, `hidden`, and `raw`.

```ts
import { groq, type GroqLanguageModelOptions } from '@ai-sdk/groq';
import { generateText } from 'ai';

const result = await generateText({
  model: groq('qwen/qwen3-32b'),
  providerOptions: {
    groq: {
      reasoningFormat: 'parsed',
      reasoningEffort: 'default',
      parallelToolCalls: true, // Enable parallel function calling (default: true)
      user: 'user-123', // Unique identifier for end-user (optional)
      serviceTier: 'flex', // Use flex tier for higher throughput (optional)
    } satisfies GroqLanguageModelOptions,
  },
  prompt: 'How many "r"s are in the word "strawberry"?',
});
```

The following optional provider options are available for Groq language models:

- **reasoningFormat** _'parsed' | 'raw' | 'hidden'_

  Controls how reasoning is exposed in the generated text. Only supported by reasoning models like `qwen-qwq-32b` and `deepseek-r1-distill-*` models.

  For a complete list of reasoning models and their capabilities, see [Groq's reasoning models documentation](https://console.groq.com/docs/reasoning).

- **reasoningEffort** _'low' | 'medium' | 'high' | 'none' | 'default'_

  Controls the level of effort the model will put into reasoning.

  - `qwen/qwen3-32b`
    - Supported values:
      - `none`: Disable reasoning. The model will not use any reasoning tokens.
      - `default`: Enable reasoning.
  - `gpt-oss20b/gpt-oss120b`
    - Supported values:
      - `low`: Use a low level of reasoning effort.
      - `medium`: Use a medium level of reasoning effort.
      - `high`: Use a high level of reasoning effort.

  Defaults to `default` for `qwen/qwen3-32b.`

- **structuredOutputs** _boolean_

  Whether to use structured outputs.

  Defaults to `true`.

  When enabled, object generation will use the `json_schema` format instead of `json_object` format, providing more reliable structured outputs.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation. When `true`, the model uses constrained decoding to guarantee schema compliance.

  Defaults to `true`.

  Only used when `structuredOutputs` is enabled and a schema is provided. See [Groq's Structured Outputs documentation](https://console.groq.com/docs/structured-outputs) for details on strict mode limitations.

- **parallelToolCalls** _boolean_

  Whether to enable parallel function calling during tool use. Defaults to `true`.

- **user** _string_

  A unique identifier representing your end-user, which can help with monitoring and abuse detection.

- **serviceTier** _'on_demand' | 'performance' | 'flex' | 'auto'_

  Service tier for the request. Defaults to `'on_demand'`.

  - `'on_demand'`: Default tier with consistent performance and fairness
  - `'performance'`: Prioritized tier for latency-sensitive workloads
  - `'flex'`: Higher throughput tier (10x rate limits) optimized for workloads that can handle occasional request failures
  - `'auto'`: Uses on_demand rate limits first, then falls back to flex tier if exceeded

  For more details about service tiers and their benefits, see [Groq's service tiers documentation](https://console.groq.com/docs/service-tiers).

<Note>Only Groq reasoning models support the `reasoningFormat` option.</Note>

#### Structured Outputs

Structured outputs are enabled by default for Groq models.
You can disable them by setting the `structuredOutputs` option to `false`.

```ts
import { groq } from '@ai-sdk/groq';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.string()),
        instructions: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a simple pasta recipe.',
});

console.log(JSON.stringify(result.output, null, 2));
```

You can disable structured outputs for models that don't support them:

```ts highlight="9"
import { groq, type GroqLanguageModelOptions } from '@ai-sdk/groq';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: groq('gemma2-9b-it'),
  providerOptions: {
    groq: {
      structuredOutputs: false,
    } satisfies GroqLanguageModelOptions,
  },
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.string()),
        instructions: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a simple pasta recipe in JSON format.',
});

console.log(JSON.stringify(result.output, null, 2));
```

<Note type="warning">
  Structured outputs are only supported by newer Groq models like
  `moonshotai/kimi-k2-instruct-0905`. For unsupported models, you can disable
  structured outputs by setting `structuredOutputs: false`. When disabled, Groq
  uses the `json_object` format which requires the word "JSON" to be included in
  your messages.
</Note>

### Example

You can use Groq language models to generate text with the `generateText` function:

```ts
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';

const { text } = await generateText({
  model: groq('gemma2-9b-it'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

### Image Input

Groq's multi-modal models like `meta-llama/llama-4-scout-17b-16e-instruct` support image inputs. You can include images in your messages using either URLs or base64-encoded data:

```ts
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';

const { text } = await generateText({
  model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What do you see in this image?' },
        {
          type: 'image',
          image: 'https://example.com/image.jpg',
        },
      ],
    },
  ],
});
```

You can also use base64-encoded images:

```ts
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { readFileSync } from 'fs';

const imageData = readFileSync('path/to/image.jpg', 'base64');

const { text } = await generateText({
  model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in detail.' },
        {
          type: 'image',
          image: `data:image/jpeg;base64,${imageData}`,
        },
      ],
    },
  ],
});
```

## Model Capabilities

| Model                                           | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `gemma2-9b-it`                                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `llama-3.1-8b-instant`                          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `llama-3.3-70b-versatile`                       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/llama-guard-4-12b`                  | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `deepseek-r1-distill-llama-70b`                 | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/llama-4-scout-17b-16e-instruct`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/llama-prompt-guard-2-22m`           | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta-llama/llama-prompt-guard-2-86m`           | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `moonshotai/kimi-k2-instruct-0905`              | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `qwen/qwen3-32b`                                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `llama-guard-3-8b`                              | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `llama3-70b-8192`                               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `llama3-8b-8192`                                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mixtral-8x7b-32768`                            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `qwen-qwq-32b`                                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `qwen-2.5-32b`                                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-r1-distill-qwen-32b`                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai/gpt-oss-20b`                            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai/gpt-oss-120b`                           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The tables above list the most commonly used models. Please see the [Groq
  docs](https://console.groq.com/docs/models) for a complete list of available
  models. You can also pass any available provider model ID as a string if
  needed.
</Note>

## Browser Search Tool

Groq provides a browser search tool that offers interactive web browsing capabilities. Unlike traditional web search, browser search navigates websites interactively, providing more detailed and comprehensive results.

### Supported Models

Browser search is only available for these specific models:

- `openai/gpt-oss-20b`
- `openai/gpt-oss-120b`

<Note type="warning">
  Browser search will only work with the supported models listed above. Using it
  with other models will generate a warning and the tool will be ignored.
</Note>

### Basic Usage

```ts
import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';

const result = await generateText({
  model: groq('openai/gpt-oss-120b'), // Must use supported model
  prompt:
    'What are the latest developments in AI? Please search for recent news.',
  tools: {
    browser_search: groq.tools.browserSearch({}),
  },
  toolChoice: 'required', // Ensure the tool is used
});

console.log(result.text);
```

### Streaming Example

```ts
import { groq } from '@ai-sdk/groq';
import { streamText } from 'ai';

const result = streamText({
  model: groq('openai/gpt-oss-120b'),
  prompt: 'Search for the latest tech news and summarize it.',
  tools: {
    browser_search: groq.tools.browserSearch({}),
  },
  toolChoice: 'required',
});

for await (const delta of result.fullStream) {
  if (delta.type === 'text-delta') {
    process.stdout.write(delta.text);
  }
}
```

### Key Features

- **Interactive Browsing**: Navigates websites like a human user
- **Comprehensive Results**: More detailed than traditional search snippets
- **Server-side Execution**: Runs on Groq's infrastructure, no setup required
- **Powered by Exa**: Uses Exa search engine for optimal results
- **Currently Free**: Available at no additional charge during beta

### Best Practices

- Use `toolChoice: 'required'` to ensure the browser search is activated
- Only supported on `openai/gpt-oss-20b` and `openai/gpt-oss-120b` models
- The tool works automatically - no configuration parameters needed
- Server-side execution means no additional API keys or setup required

### Model Validation

The provider automatically validates model compatibility:

```ts
// ✅ Supported - will work
const result = await generateText({
  model: groq('openai/gpt-oss-120b'),
  tools: { browser_search: groq.tools.browserSearch({}) },
});

// ❌ Unsupported - will show warning and ignore tool
const result = await generateText({
  model: groq('gemma2-9b-it'),
  tools: { browser_search: groq.tools.browserSearch({}) },
});
// Warning: "Browser search is only supported on models: openai/gpt-oss-20b, openai/gpt-oss-120b"
```

<Note>
  For more details about browser search capabilities and limitations, see the
  [Groq Browser Search
  Documentation](https://console.groq.com/docs/browser-search).
</Note>

## Transcription Models

You can create models that call the [Groq transcription API](https://console.groq.com/docs/speech-to-text)
using the `.transcription()` factory method.

The first argument is the model id e.g. `whisper-large-v3`.

```ts
const model = groq.transcription('whisper-large-v3');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the input language in ISO-639-1 (e.g. `en`) format will improve accuracy and latency.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import { groq, type GroqTranscriptionModelOptions } from '@ai-sdk/groq';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: groq.transcription('whisper-large-v3'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    groq: { language: 'en' } satisfies GroqTranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **timestampGranularities** _string[]_
  The granularity of the timestamps in the transcription.
  Defaults to `['segment']`.
  Possible values are `['word']`, `['segment']`, and `['word', 'segment']`.
  Note: There is no additional latency for segment timestamps, but generating word timestamps incurs additional latency.
  **Important:** Requires `responseFormat` to be set to `'verbose_json'`.

- **responseFormat** _string_
  The format of the response. Set to `'verbose_json'` to receive timestamps for audio segments and enable `timestampGranularities`.
  Set to `'text'` to return only the transcribed text.
  Optional.

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

### Model Capabilities

| Model                    | Transcription       | Duration            | Segments            | Language            |
| ------------------------ | ------------------- | ------------------- | ------------------- | ------------------- |
| `whisper-large-v3`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `whisper-large-v3-turbo` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: Fal
description: Learn how to use Fal AI models with the AI SDK.
---

# Fal Provider

[Fal AI](https://fal.ai/) provides a generative media platform for developers with lightning-fast inference capabilities. Their platform offers optimized performance for running diffusion models, with speeds up to 4x faster than alternatives.

## Setup

The Fal provider is available via the `@ai-sdk/fal` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/fal" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/fal" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/fal" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/fal" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `fal` from `@ai-sdk/fal`:

```ts
import { fal } from '@ai-sdk/fal';
```

If you need a customized setup, you can import `createFal` and create a provider instance with your settings:

```ts
import { createFal } from '@ai-sdk/fal';

const fal = createFal({
  apiKey: 'your-api-key', // optional, defaults to FAL_API_KEY environment variable, falling back to FAL_KEY
  baseURL: 'custom-url', // optional
  headers: {
    /* custom headers */
  }, // optional
});
```

You can use the following optional settings to customize the Fal provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://fal.run`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `FAL_API_KEY` environment variable, falling back to `FAL_KEY`.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Image Models

You can create Fal image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

### Basic Usage

```ts
import { fal } from '@ai-sdk/fal';
import { generateImage } from 'ai';
import fs from 'fs';

const { image, providerMetadata } = await generateImage({
  model: fal.image('fal-ai/flux/dev'),
  prompt: 'A serene mountain landscape at sunset',
});

const filename = `image-${Date.now()}.png`;
fs.writeFileSync(filename, image.uint8Array);
console.log(`Image saved to ${filename}`);
```

Fal image models may return additional information for the images and the request.

Here are some examples of properties that may be set for each image

```js
providerMetadata.fal.images[0].nsfw; // boolean, image is not safe for work
providerMetadata.fal.images[0].width; // number, image width
providerMetadata.fal.images[0].height; // number, image height
providerMetadata.fal.images[0].contentType; // string, mime type of the image
```

### Model Capabilities

Fal offers many models optimized for different use cases. Here are a few popular examples. For a full list of models, see the [Fal AI Search Page](https://fal.ai/explore/search).

| Model                                          | Description                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fal-ai/flux/dev`                              | FLUX.1 [dev] model for high-quality image generation                                                                              |
| `fal-ai/flux-pro/kontext`                      | FLUX.1 Kontext [pro] handles both text and reference images as inputs, enabling targeted edits and complex transformations        |
| `fal-ai/flux-pro/kontext/max`                  | FLUX.1 Kontext [max] with improved prompt adherence and typography generation                                                     |
| `fal-ai/flux-lora`                             | Super fast endpoint for FLUX.1 with LoRA support                                                                                  |
| `fal-ai/ideogram/character`                    | Generate consistent character appearances across multiple images. Maintain facial features, proportions, and distinctive traits   |
| `fal-ai/qwen-image`                            | Qwen-Image foundation model with significant advances in complex text rendering and precise image editing                         |
| `fal-ai/omnigen-v2`                            | Unified image generation model for Image Editing, Personalized Image Generation, Virtual Try-On, Multi Person Generation and more |
| `fal-ai/bytedance/dreamina/v3.1/text-to-image` | Dreamina showcases superior picture effects with improvements in aesthetics, precise and diverse styles, and rich details         |
| `fal-ai/recraft/v3/text-to-image`              | SOTA in image generation with vector art and brand style capabilities                                                             |
| `fal-ai/wan/v2.2-a14b/text-to-image`           | High-resolution, photorealistic images with fine-grained detail                                                                   |

Fal models support the following aspect ratios:

- 1:1 (square HD)
- 16:9 (landscape)
- 9:16 (portrait)
- 4:3 (landscape)
- 3:4 (portrait)
- 16:10 (1280x800)
- 10:16 (800x1280)
- 21:9 (2560x1080)
- 9:21 (1080x2560)

Key features of Fal models include:

- Up to 4x faster inference speeds compared to alternatives
- Optimized by the Fal Inference Engine™
- Support for real-time infrastructure
- Cost-effective scaling with pay-per-use pricing
- LoRA training capabilities for model personalization

#### Modify Image

Transform existing images using text prompts.

```ts
await generateImage({
  model: fal.image('fal-ai/flux-pro/kontext/max'),
  prompt: {
    text: 'Put a donut next to the flour.',
    images: [
      'https://v3.fal.media/files/rabbit/rmgBxhwGYb2d3pl3x9sKf_output.png',
    ],
  },
});
```

Images can also be passed as base64-encoded string, a `Uint8Array`, an `ArrayBuffer`, or a `Buffer`.
A mask can be passed as well

```ts
await generateImage({
  model: fal.image('fal-ai/flux-pro/kontext/max'),
  prompt: {
    text: 'Put a donut next to the flour.',
    images: [imageBuffer],
    mask: maskBuffer,
  },
});
```

### Provider Options

Fal image models support flexible provider options through the `providerOptions.fal` object. You can pass any parameters supported by the specific Fal model's API. Common options include:

- **imageUrl** - Reference image URL for image-to-image generation (deprecated, use `prompt.images` instead)
- **strength** - Controls how much the output differs from the input image
- **guidanceScale** - Controls adherence to the prompt (range: 1-20)
- **numInferenceSteps** - Number of denoising steps (range: 1-50)
- **enableSafetyChecker** - Enable/disable safety filtering
- **outputFormat** - Output format: 'jpeg' or 'png'
- **syncMode** - Wait for completion before returning response
- **acceleration** - Speed of generation: 'none', 'regular', or 'high'
- **safetyTolerance** - Content safety filtering level (1-6, where 1 is strictest)
- **useMultipleImages** - When true, converts multiple input images to `image_urls` array for models that support multiple images (e.g., fal-ai/flux-2/edit)

<Note type="warning">
  **Deprecation Notice**: snake_case parameter names (e.g., `image_url`,
  `guidance_scale`) are deprecated and will be removed in a future version.
  Please use camelCase names (e.g., `imageUrl`, `guidanceScale`) instead.
</Note>

Refer to the [Fal AI model documentation](https://fal.ai/models) for model-specific parameters.

### Advanced Features

Fal's platform offers several advanced capabilities:

- **Private Model Inference**: Run your own diffusion transformer models with up to 50% faster inference
- **LoRA Training**: Train and personalize models in under 5 minutes
- **Real-time Infrastructure**: Enable new user experiences with fast inference times
- **Scalable Architecture**: Scale to thousands of GPUs when needed

For more details about Fal's capabilities and features, visit the [Fal AI documentation](https://fal.ai/docs).

## Transcription Models

You can create models that call the [Fal transcription API](https://docs.fal.ai/guides/convert-speech-to-text)
using the `.transcription()` factory method.

The first argument is the model id without the `fal-ai/` prefix e.g. `wizper`.

```ts
const model = fal.transcription('wizper');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the `batchSize` option will increase the number of audio chunks processed in parallel.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import { fal, type FalTranscriptionModelOptions } from '@ai-sdk/fal';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: fal.transcription('wizper'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    fal: { batchSize: 10 } satisfies FalTranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **language** _string_
  Language of the audio file. Defaults to 'en'. If set to null, the language will be automatically detected.
  Accepts ISO language codes like 'en', 'fr', 'zh', etc.
  Optional.

- **diarize** _boolean_
  Whether to diarize the audio file (identify different speakers).
  Defaults to true.
  Optional.

- **chunkLevel** _string_
  Level of the chunks to return. Either 'segment' or 'word'.
  Default value: "segment"
  Optional.

- **version** _string_
  Version of the model to use. All models are Whisper large variants.
  Default value: "3"
  Optional.

- **batchSize** _number_
  Batch size for processing.
  Default value: 64
  Optional.

- **numSpeakers** _number_
  Number of speakers in the audio file. If not provided, the number of speakers will be automatically detected.
  Optional.

### Model Capabilities

| Model     | Transcription       | Duration            | Segments            | Language            |
| --------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `whisper` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `wizper`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

## Speech Models

You can create models that call Fal text-to-speech endpoints using the `.speech()` factory method.

### Basic Usage

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { fal } from '@ai-sdk/fal';

const result = await generateSpeech({
  model: fal.speech('fal-ai/minimax/speech-02-hd'),
  text: 'Hello from the AI SDK!',
});
```

### Model Capabilities

| Model                                     | Description                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fal-ai/minimax/voice-clone`              | Clone a voice from a sample audio and generate speech from text prompts                                                                                               |
| `fal-ai/minimax/voice-design`             | Design a personalized voice from a text description and generate speech from text prompts                                                                             |
| `fal-ai/dia-tts/voice-clone`              | Clone dialog voices from a sample audio and generate dialogs from text prompts                                                                                        |
| `fal-ai/minimax/speech-02-hd`             | Generate speech from text prompts and different voices                                                                                                                |
| `fal-ai/minimax/speech-02-turbo`          | Generate fast speech from text prompts and different voices                                                                                                           |
| `fal-ai/dia-tts`                          | Directly generates realistic dialogue from transcripts with audio conditioning for emotion control. Produces natural nonverbals like laughter and throat clearing     |
| `resemble-ai/chatterboxhd/text-to-speech` | Generate expressive, natural speech with Resemble AI's Chatterbox. Features unique emotion control, instant voice cloning from short audio, and built-in watermarking |

### Provider Options

Pass provider-specific options via `providerOptions.fal` depending on the model:

- **voice_setting** _object_

  - `voice_id` (string): predefined voice ID
  - `speed` (number): 0.5–2.0
  - `vol` (number): 0–10
  - `pitch` (number): -12–12
  - `emotion` (enum): happy | sad | angry | fearful | disgusted | surprised | neutral
  - `english_normalization` (boolean)

- **audio_setting** _object_
  Audio configuration settings specific to the model.

- **language_boost** _enum_
  Chinese | Chinese,Yue | English | Arabic | Russian | Spanish | French | Portuguese | German | Turkish | Dutch | Ukrainian | Vietnamese | Indonesian | Japanese | Italian | Korean | Thai | Polish | Romanian | Greek | Czech | Finnish | Hindi | auto

- **pronunciation_dict** _object_
  Custom pronunciation dictionary for specific words.

Model-specific parameters (e.g., `audio_url`, `prompt`, `preview_text`, `ref_audio_url`, `ref_text`) can be passed directly under `providerOptions.fal` and will be forwarded to the Fal API.

---
title: AssemblyAI
description: Learn how to use the AssemblyAI provider for the AI SDK.
---

# AssemblyAI Provider

The [AssemblyAI](https://assemblyai.com/) provider contains language model support for the AssemblyAI transcription API.

## Setup

The AssemblyAI provider is available in the `@ai-sdk/assemblyai` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/assemblyai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/assemblyai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/assemblyai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/assemblyai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `assemblyai` from `@ai-sdk/assemblyai`:

```ts
import { assemblyai } from '@ai-sdk/assemblyai';
```

If you need a customized setup, you can import `createAssemblyAI` from `@ai-sdk/assemblyai` and create a provider instance with your settings:

```ts
import { createAssemblyAI } from '@ai-sdk/assemblyai';

const assemblyai = createAssemblyAI({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the AssemblyAI provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `ASSEMBLYAI_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Transcription Models

You can create models that call the [AssemblyAI transcription API](https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file/typescript)
using the `.transcription()` factory method.

The first argument is the model id e.g. `best`.

```ts
const model = assemblyai.transcription('best');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the `contentSafety` option will enable content safety filtering.

```ts highlight="7"
import { experimental_transcribe as transcribe } from 'ai';
import { assemblyai } from '@ai-sdk/assemblyai';
import { type AssemblyAITranscriptionModelOptions } from '@ai-sdk/assemblyai';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: assemblyai.transcription('best'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    assemblyai: {
      contentSafety: true,
    } satisfies AssemblyAITranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **audioEndAt** _number_

  End time of the audio in milliseconds.
  Optional.

- **audioStartFrom** _number_

  Start time of the audio in milliseconds.
  Optional.

- **autoChapters** _boolean_

  Whether to automatically generate chapters for the transcription.
  Optional.

- **autoHighlights** _boolean_

  Whether to automatically generate highlights for the transcription.
  Optional.

- **boostParam** _enum_

  Boost parameter for the transcription.
  Allowed values: `'low'`, `'default'`, `'high'`.
  Optional.

- **contentSafety** _boolean_

  Whether to enable content safety filtering.
  Optional.

- **contentSafetyConfidence** _number_

  Confidence threshold for content safety filtering (25-100).
  Optional.

- **customSpelling** _array of objects_

  Custom spelling rules for the transcription.
  Each object has `from` (array of strings) and `to` (string) properties.
  Optional.

- **disfluencies** _boolean_

  Whether to include disfluencies (um, uh, etc.) in the transcription.
  Optional.

- **entityDetection** _boolean_

  Whether to detect entities in the transcription.
  Optional.

- **filterProfanity** _boolean_

  Whether to filter profanity in the transcription.
  Optional.

- **formatText** _boolean_

  Whether to format the text in the transcription.
  Optional.

- **iabCategories** _boolean_

  Whether to include IAB categories in the transcription.
  Optional.

- **languageCode** _string_

  Language code for the audio.
  Supports numerous ISO-639-1 and ISO-639-3 language codes.
  Optional.

- **languageConfidenceThreshold** _number_

  Confidence threshold for language detection.
  Optional.

- **languageDetection** _boolean_

  Whether to enable language detection.
  Optional.

- **multichannel** _boolean_

  Whether to process multiple audio channels separately.
  Optional.

- **punctuate** _boolean_

  Whether to add punctuation to the transcription.
  Optional.

- **redactPii** _boolean_

  Whether to redact personally identifiable information.
  Optional.

- **redactPiiAudio** _boolean_

  Whether to redact PII in the audio file.
  Optional.

- **redactPiiAudioQuality** _enum_

  Quality of the redacted audio file.
  Allowed values: `'mp3'`, `'wav'`.
  Optional.

- **redactPiiPolicies** _array of enums_

  Policies for PII redaction, specifying which types of information to redact.
  Supports numerous types like `'person_name'`, `'phone_number'`, etc.
  Optional.

- **redactPiiSub** _enum_

  Substitution method for redacted PII.
  Allowed values: `'entity_name'`, `'hash'`.
  Optional.

- **sentimentAnalysis** _boolean_

  Whether to perform sentiment analysis on the transcription.
  Optional.

- **speakerLabels** _boolean_

  Whether to label different speakers in the transcription.
  Optional.

- **speakersExpected** _number_

  Expected number of speakers in the audio.
  Optional.

- **speechThreshold** _number_

  Threshold for speech detection (0-1).
  Optional.

- **summarization** _boolean_

  Whether to generate a summary of the transcription.
  Optional.

- **summaryModel** _enum_

  Model to use for summarization.
  Allowed values: `'informative'`, `'conversational'`, `'catchy'`.
  Optional.

- **summaryType** _enum_

  Type of summary to generate.
  Allowed values: `'bullets'`, `'bullets_verbose'`, `'gist'`, `'headline'`, `'paragraph'`.
  Optional.

- **webhookAuthHeaderName** _string_

  Name of the authentication header for webhook requests.
  Optional.

- **webhookAuthHeaderValue** _string_

  Value of the authentication header for webhook requests.
  Optional.

- **webhookUrl** _string_

  URL to send webhook notifications to.
  Optional.

- **wordBoost** _array of strings_

  List of words to boost in the transcription.
  Optional.

### Model Capabilities

| Model  | Transcription       | Duration            | Segments            | Language            |
| ------ | ------------------- | ------------------- | ------------------- | ------------------- |
| `best` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `nano` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: DeepInfra
description: Learn how to use DeepInfra's models with the AI SDK.
---

# DeepInfra Provider

The [DeepInfra](https://deepinfra.com) provider contains support for state-of-the-art models through the DeepInfra API, including Llama 3, Mixtral, Qwen, and many other popular open-source models.

## Setup

The DeepInfra provider is available via the `@ai-sdk/deepinfra` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/deepinfra" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/deepinfra" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/deepinfra" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/deepinfra" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `deepinfra` from `@ai-sdk/deepinfra`:

```ts
import { deepinfra } from '@ai-sdk/deepinfra';
```

If you need a customized setup, you can import `createDeepInfra` from `@ai-sdk/deepinfra` and create a provider instance with your settings:

```ts
import { createDeepInfra } from '@ai-sdk/deepinfra';

const deepinfra = createDeepInfra({
  apiKey: process.env.DEEPINFRA_API_KEY ?? '',
});
```

You can use the following optional settings to customize the DeepInfra provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.deepinfra.com/v1`.

  Note: Language models and embeddings use OpenAI-compatible endpoints at `{baseURL}/openai`,
  while image models use `{baseURL}/inference`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `DEEPINFRA_API_KEY` environment variable.

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
import { deepinfra } from '@ai-sdk/deepinfra';
import { generateText } from 'ai';

const { text } = await generateText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

DeepInfra language models can also be used in the `streamText` function (see [AI SDK Core](/docs/ai-sdk-core)).

## Model Capabilities

| Model                                               | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| --------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta-llama/Llama-4-Scout-17B-16E-Instruct`         | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-3.3-70B-Instruct`                 | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Meta-Llama-3.1-405B-Instruct`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo`      | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Meta-Llama-3.1-70B-Instruct`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `meta-llama/Meta-Llama-3.1-8B-Instruct`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-3.2-11B-Vision-Instruct`          | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `meta-llama/Llama-3.2-90B-Vision-Instruct`          | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `mistralai/Mixtral-8x7B-Instruct-v0.1`              | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `deepseek-ai/DeepSeek-V3`                           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-R1`                           | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `deepseek-ai/DeepSeek-R1-Distill-Llama-70B`         | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `deepseek-ai/DeepSeek-R1-Turbo`                     | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `nvidia/Llama-3.1-Nemotron-70B-Instruct`            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `Qwen/Qwen2-7B-Instruct`                            | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `Qwen/Qwen2.5-72B-Instruct`                         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `Qwen/Qwen2.5-Coder-32B-Instruct`                   | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `Qwen/QwQ-32B-Preview`                              | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `google/codegemma-7b-it`                            | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `google/gemma-2-9b-it`                              | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `microsoft/WizardLM-2-8x22B`                        | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. Please see the [DeepInfra
  docs](https://deepinfra.com) for a full list of available models. You can also
  pass any available provider model ID as a string if needed.
</Note>

## Image Models

You can create DeepInfra image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

```ts
import { deepinfra } from '@ai-sdk/deepinfra';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: deepinfra.image('stabilityai/sd3.5'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
});
```

<Note>
  Model support for `size` and `aspectRatio` parameters varies by model. Please
  check the individual model documentation on [DeepInfra's models
  page](https://deepinfra.com/models/text-to-image) for supported options and
  additional parameters.
</Note>

### Model-specific options

You can pass model-specific parameters using the `providerOptions.deepinfra` field:

```ts
import { deepinfra } from '@ai-sdk/deepinfra';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: deepinfra.image('stabilityai/sd3.5'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
  providerOptions: {
    deepinfra: {
      num_inference_steps: 30, // Control the number of denoising steps (1-50)
    },
  },
});
```

### Image Editing

DeepInfra supports image editing through models like `Qwen/Qwen-Image-Edit`. Pass input images via `prompt.images` to transform or edit existing images.

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: deepinfra.image('Qwen/Qwen-Image-Edit'),
  prompt: {
    text: 'Turn the cat into a golden retriever dog',
    images: [imageBuffer],
  },
  size: '1024x1024',
});
```

#### Inpainting with Mask

Edit specific parts of an image using a mask. Transparent areas in the mask indicate where the image should be edited:

```ts
const image = readFileSync('./input-image.png');
const mask = readFileSync('./mask.png');

const { images } = await generateImage({
  model: deepinfra.image('Qwen/Qwen-Image-Edit'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask: mask,
  },
});
```

#### Multi-Image Combining

Combine multiple reference images into a single output:

```ts
const cat = readFileSync('./cat.png');
const dog = readFileSync('./dog.png');

const { images } = await generateImage({
  model: deepinfra.image('Qwen/Qwen-Image-Edit'),
  prompt: {
    text: 'Create a scene with both animals together, playing as friends',
    images: [cat, dog],
  },
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings. DeepInfra uses an OpenAI-compatible image editing API
  at `https://api.deepinfra.com/v1/openai/images/edits`.
</Note>

### Model Capabilities

For models supporting aspect ratios, the following ratios are typically supported:
`1:1 (default), 16:9, 1:9, 3:2, 2:3, 4:5, 5:4, 9:16, 9:21`

For models supporting size parameters, dimensions must typically be:

- Multiples of 32
- Width and height between 256 and 1440 pixels
- Default size is 1024x1024

| Model                                  | Dimensions Specification | Notes                                                    |
| -------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `stabilityai/sd3.5`                    | Aspect Ratio             | Premium quality base model, 8B parameters                |
| `black-forest-labs/FLUX-1.1-pro`       | Size                     | Latest state-of-art model with superior prompt following |
| `black-forest-labs/FLUX-1-schnell`     | Size                     | Fast generation in 1-4 steps                             |
| `black-forest-labs/FLUX-1-dev`         | Size                     | Optimized for anatomical accuracy                        |
| `black-forest-labs/FLUX-pro`           | Size                     | Flagship Flux model                                      |
| `black-forest-labs/FLUX.1-Kontext-dev` | Size                     | Image editing and transformation model                   |
| `black-forest-labs/FLUX.1-Kontext-pro` | Size                     | Professional image editing and transformation            |
| `stabilityai/sd3.5-medium`             | Aspect Ratio             | Balanced 2.5B parameter model                            |
| `stabilityai/sdxl-turbo`               | Aspect Ratio             | Optimized for fast generation                            |

For more details and pricing information, see the [DeepInfra text-to-image models page](https://deepinfra.com/models/text-to-image).

## Embedding Models

You can create DeepInfra embedding models using the `.embeddingModel()` factory method.
For more on embedding models with the AI SDK see [embed()](/docs/reference/ai-sdk-core/embed).

```ts
import { deepinfra } from '@ai-sdk/deepinfra';
import { embed } from 'ai';

const { embedding } = await embed({
  model: deepinfra.embeddingModel('BAAI/bge-large-en-v1.5'),
  value: 'sunny day at the beach',
});
```

### Model Capabilities

| Model                                                 | Dimensions | Max Tokens |
| ----------------------------------------------------- | ---------- | ---------- |
| `BAAI/bge-base-en-v1.5`                               | 768        | 512        |
| `BAAI/bge-large-en-v1.5`                              | 1024       | 512        |
| `BAAI/bge-m3`                                         | 1024       | 8192       |
| `intfloat/e5-base-v2`                                 | 768        | 512        |
| `intfloat/e5-large-v2`                                | 1024       | 512        |
| `intfloat/multilingual-e5-large`                      | 1024       | 512        |
| `sentence-transformers/all-MiniLM-L12-v2`             | 384        | 256        |
| `sentence-transformers/all-MiniLM-L6-v2`              | 384        | 256        |
| `sentence-transformers/all-mpnet-base-v2`             | 768        | 384        |
| `sentence-transformers/clip-ViT-B-32`                 | 512        | 77         |
| `sentence-transformers/clip-ViT-B-32-multilingual-v1` | 512        | 77         |
| `sentence-transformers/multi-qa-mpnet-base-dot-v1`    | 768        | 512        |
| `sentence-transformers/paraphrase-MiniLM-L6-v2`       | 384        | 128        |
| `shibing624/text2vec-base-chinese`                    | 768        | 512        |
| `thenlper/gte-base`                                   | 768        | 512        |
| `thenlper/gte-large`                                  | 1024       | 512        |

<Note>
  For a complete list of available embedding models, see the [DeepInfra
  embeddings page](https://deepinfra.com/models/embeddings).
</Note>

---
title: Deepgram
description: Learn how to use the Deepgram provider for the AI SDK.
---

# Deepgram Provider

The [Deepgram](https://deepgram.com/) provider contains language model support for the Deepgram transcription and speech generation APIs.

## Setup

The Deepgram provider is available in the `@ai-sdk/deepgram` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/deepgram" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/deepgram" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/deepgram" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/deepgram" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `deepgram` from `@ai-sdk/deepgram`:

```ts
import { deepgram } from '@ai-sdk/deepgram';
```

If you need a customized setup, you can import `createDeepgram` from `@ai-sdk/deepgram` and create a provider instance with your settings:

```ts
import { createDeepgram } from '@ai-sdk/deepgram';

const deepgram = createDeepgram({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the Deepgram provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `DEEPGRAM_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Speech Models

You can create models that call the [Deepgram text-to-speech API](https://developers.deepgram.com/docs/text-to-speech)
using the `.speech()` factory method.

The first argument is the model id, which includes the voice. Deepgram embeds the voice directly in the model ID (e.g., `aura-2-helena-en`).

```ts
const model = deepgram.speech('aura-2-helena-en');
```

You can use the model with the `generateSpeech` function:

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { deepgram } from '@ai-sdk/deepgram';

const result = await generateSpeech({
  model: deepgram.speech('aura-2-helena-en'),
  text: 'Hello, world!',
});
```

You can also pass additional provider-specific options using the `providerOptions` argument:

```ts highlight="7-11"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { deepgram, type DeepgramSpeechModelOptions } from '@ai-sdk/deepgram';

const result = await generateSpeech({
  model: deepgram.speech('aura-2-helena-en'),
  text: 'Hello, world!',
  providerOptions: {
    deepgram: {
      encoding: 'linear16',
      sampleRate: 24000,
    } satisfies DeepgramSpeechModelOptions,
  },
});
```

The following provider options are available:

- **encoding** _string_

  Encoding type for the audio output.
  Supported values: `'linear16'`, `'mulaw'`, `'alaw'`, `'mp3'`, `'opus'`, `'flac'`, `'aac'`.
  Optional.

- **container** _string_

  Container format for the output audio.
  Supported values: `'wav'`, `'ogg'`, `'none'`.
  Optional.

- **sampleRate** _number_

  Sample rate for the output audio in Hz.
  Supported values depend on the encoding: `8000`, `16000`, `24000`, `32000`, `48000`.
  Optional.

- **bitRate** _number | string_

  Bitrate of the audio in bits per second.
  For `mp3`: `32000` or `48000`.
  For `opus`: `4000` to `650000`.
  For `aac`: `4000` to `192000`.
  Optional.

- **callback** _string_

  URL to which Deepgram will make a callback request with the audio.
  Optional.

- **callbackMethod** _enum_

  HTTP method for the callback request.
  Allowed values: `'POST'`, `'PUT'`.
  Optional.

- **mipOptOut** _boolean_

  Opts out requests from the Deepgram Model Improvement Program.
  Optional.

- **tag** _string | array of strings_

  Label your requests for identification during usage reporting.
  Optional.

### Model Capabilities

| Model                                                            |
| ---------------------------------------------------------------- |
| `aura-2-asteria-en`                                              |
| `aura-2-thalia-en`                                               |
| `aura-2-helena-en`                                               |
| `aura-2-orpheus-en`                                              |
| `aura-2-zeus-en`                                                 |
| `aura-asteria-en`                                                |
| `aura-luna-en`                                                   |
| `aura-stella-en`                                                 |
| [+ more voices](https://developers.deepgram.com/docs/tts-models) |

## Transcription Models

You can create models that call the [Deepgram transcription API](https://developers.deepgram.com/docs/pre-recorded-audio)
using the `.transcription()` factory method.

The first argument is the model id e.g. `nova-3`.

```ts
const model = deepgram.transcription('nova-3');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the `summarize` option will enable summaries for sections of content.

```ts highlight="6"
import { experimental_transcribe as transcribe } from 'ai';
import {
  deepgram,
  type DeepgramTranscriptionModelOptions,
} from '@ai-sdk/deepgram';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: deepgram.transcription('nova-3'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    deepgram: {
      summarize: true,
    } satisfies DeepgramTranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **language** _string_

  Language code for the audio.
  Supports numerous ISO-639-1 and ISO-639-3 language codes.
  Optional.

- **detectLanguage** _boolean_

  Whether to enable automatic language detection.
  When true, Deepgram will detect the language of the audio.
  Optional.

- **smartFormat** _boolean_

  Whether to apply smart formatting to the transcription.
  Optional.

- **punctuate** _boolean_

  Whether to add punctuation to the transcription.
  Optional.

- **summarize** _enum | boolean_

  Whether to generate a summary of the transcription.
  Allowed values: `'v2'`, `false`.
  Optional.

- **topics** _boolean_

  Whether to detect topics in the transcription.
  Optional.

- **detectEntities** _boolean_

  Whether to detect entities in the transcription.
  Optional.

- **redact** _string | array of strings_

  Specifies what content to redact from the transcription.
  Optional.

- **search** _string_

  Search term to find in the transcription.
  Optional.

- **diarize** _boolean_

  Whether to identify different speakers in the transcription.
  Defaults to `true`.
  Optional.

- **utterances** _boolean_

  Whether to segment the transcription into utterances.
  Optional.

- **uttSplit** _number_

  Threshold for splitting utterances.
  Optional.

- **fillerWords** _boolean_

  Whether to include filler words (um, uh, etc.) in the transcription.
  Optional.

### Model Capabilities

| Model                                                                                              | Transcription       | Duration            | Segments            | Language            |
| -------------------------------------------------------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `nova-3` (+ [variants](https://developers.deepgram.com/docs/models-languages-overview#nova-3))     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `nova-2` (+ [variants](https://developers.deepgram.com/docs/models-languages-overview#nova-2))     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `nova` (+ [variants](https://developers.deepgram.com/docs/models-languages-overview#nova))         | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `enhanced` (+ [variants](https://developers.deepgram.com/docs/models-languages-overview#enhanced)) | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `base` (+ [variants](https://developers.deepgram.com/docs/models-languages-overview#base))         | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |

---
title: Black Forest Labs
description: Learn how to use Black Forest Labs models with the AI SDK.
---

# Black Forest Labs Provider

[Black Forest Labs](https://bfl.ai/) provides a generative image platform for developers with FLUX-based models. Their platform offers fast, high quality, and in-context image generation and editing with precise and coherent results.

## Setup

The Black Forest Labs provider is available via the `@ai-sdk/black-forest-labs` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/black-forest-labs" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/black-forest-labs" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/black-forest-labs" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/black-forest-labs" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `blackForestLabs` from `@ai-sdk/black-forest-labs`:

```ts
import { blackForestLabs } from '@ai-sdk/black-forest-labs';
```

If you need a customized setup, you can import `createBlackForestLabs` and create a provider instance with your settings:

```ts
import { createBlackForestLabs } from '@ai-sdk/black-forest-labs';

const blackForestLabs = createBlackForestLabs({
  apiKey: 'your-api-key', // optional, defaults to BFL_API_KEY environment variable
  baseURL: 'custom-url', // optional
  headers: {
    /* custom headers */
  }, // optional
});
```

You can use the following optional settings to customize the Black Forest Labs provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use a regional endpoint.
  The default prefix is `https://api.bfl.ai/v1`.

- **apiKey** _string_

  API key that is being sent using the `x-key` header.
  It defaults to the `BFL_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **pollIntervalMillis** _number_

  Interval in milliseconds between polling attempts when waiting for image generation to complete.
  Defaults to 500ms.

- **pollTimeoutMillis** _number_

  Overall timeout in milliseconds for polling before giving up.
  Defaults to 60000ms (60 seconds).

## Image Models

You can create Black Forest Labs image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

### Basic Usage

```ts
import { writeFileSync } from 'node:fs';
import { blackForestLabs } from '@ai-sdk/black-forest-labs';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: blackForestLabs.image('flux-pro-1.1'),
  prompt: 'A serene mountain landscape at sunset',
});

const filename = `image-${Date.now()}.png`;
writeFileSync(filename, image.uint8Array);
console.log(`Image saved to ${filename}`);
```

### Model Capabilities

Black Forest Labs offers many models optimized for different use cases. Here are a few popular examples. For a full list of models, see the [Black Forest Labs Models Page](https://bfl.ai/models).

| Model                | Description                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `flux-kontext-pro`   | FLUX.1 Kontext [pro] handles both text and reference images as inputs, enabling targeted edits and complex transformations |
| `flux-kontext-max`   | FLUX.1 Kontext [max] with improved prompt adherence and typography generation                                              |
| `flux-pro-1.1-ultra` | Ultra-fast, ultra high-resolution image creation                                                                           |
| `flux-pro-1.1`       | Fast, high-quality image generation from text.                                                                             |
| `flux-pro-1.0-fill`  | Inpainting model for filling masked regions of images with new content                                                     |

Black Forest Labs models support aspect ratios from 3:7 (portrait) to 7:3 (landscape).

### Image Editing

Black Forest Labs Kontext models support powerful image editing capabilities using reference images. Pass input images via `prompt.images` to transform, combine, or edit existing images.

#### Single Image Editing

Transform an existing image using text prompts:

```ts
import {
  blackForestLabs,
  BlackForestLabsImageModelOptions,
} from '@ai-sdk/black-forest-labs';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: blackForestLabs.image('flux-kontext-pro'),
  prompt: {
    text: 'A baby elephant with a shirt that has the logo from the input image.',
    images: [
      'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png',
    ],
  },
  providerOptions: {
    blackForestLabs: {
      width: 1024,
      height: 768,
    } satisfies BlackForestLabsImageModelOptions,
  },
});
```

#### Multi-Reference Editing

Combine multiple reference images for complex transformations. Black Forest Labs supports up to 10 input images:

```ts
import { blackForestLabs } from '@ai-sdk/black-forest-labs';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: blackForestLabs.image('flux-kontext-pro'),
  prompt: {
    text: 'Combine the style of image 1 with the subject of image 2',
    images: [
      'https://example.com/style-reference.jpg',
      'https://example.com/subject-reference.jpg',
    ],
  },
});
```

<Note>
  Input images can be provided as URLs or base64-encoded strings. They support
  up to 20MB or 20 megapixels per image.
</Note>

#### Inpainting

The `flux-pro-1.0-fill` model supports inpainting, which allows you to fill masked regions of an image with new content. Pass the source image via `prompt.images` and a mask image via `prompt.mask`:

```ts
import { blackForestLabs } from '@ai-sdk/black-forest-labs';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: blackForestLabs.image('flux-pro-1.0-fill'),
  prompt: {
    text: 'A beautiful garden with flowers',
    images: ['https://example.com/source-image.jpg'],
    mask: 'https://example.com/mask-image.png',
  },
});
```

The mask image should be a grayscale image where white areas indicate regions to be filled and black areas indicate regions to preserve.

### Provider Options

Black Forest Labs image models support flexible provider options through the `providerOptions.blackForestLabs` object. The supported parameters depend on the used model ID:

- **width** _number_ - Output width in pixels (256–1920). When set, this overrides any width derived from `size`.
- **height** _number_ - Output height in pixels (256–1920). When set, this overrides any height derived from `size`.
- **outputFormat** _string_ - Desired format of the output image (`"jpeg"` or `"png"`).
- **steps** _number_ - Number of inference steps. Higher values may improve quality but increase generation time.
- **guidance** _number_ - Guidance scale for generation. Higher values follow the prompt more closely.
- **imagePrompt** _string_ - Base64-encoded image to use as additional visual context for generation.
- **imagePromptStrength** _number_ - Strength of the image prompt influence on generation (0.0 to 1.0).
- **promptUpsampling** _boolean_ - If true, performs upsampling on the prompt.
- **raw** _boolean_ - Enable raw mode for more natural, authentic aesthetics.
- **safetyTolerance** _number_ - Moderation level for inputs and outputs (0 = most strict, 6 = more permissive).
- **pollIntervalMillis** _number_ - Interval in milliseconds between polling attempts (default 500ms).
- **pollTimeoutMillis** _number_ - Overall timeout in milliseconds for polling before timing out (default 60s).
- **webhookUrl** _string_ - URL for asynchronous completion notification. Must be a valid HTTP/HTTPS URL.
- **webhookSecret** _string_ - Secret for webhook signature verification, sent in the `X-Webhook-Secret` header.

<Note>
  To pass reference images for editing, use `prompt.images` instead of provider
  options. This supports up to 10 images as URLs or base64-encoded strings.
</Note>

### Provider Metadata

The `generateImage` response includes provider-specific metadata in `providerMetadata.blackForestLabs.images[]`. Each image object may contain the following properties:

- **seed** _number_ - The seed used for generation. Useful for reproducing results.
- **start_time** _number_ - Unix timestamp when generation started.
- **end_time** _number_ - Unix timestamp when generation completed.
- **duration** _number_ - Generation duration in seconds.
- **cost** _number_ - Cost of the generation request.
- **inputMegapixels** _number_ - Input image size in megapixels.
- **outputMegapixels** _number_ - Output image size in megapixels.

```ts
import { blackForestLabs } from '@ai-sdk/black-forest-labs';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: blackForestLabs.image('flux-pro-1.1'),
  prompt: 'A serene mountain landscape at sunset',
});

// Access provider metadata
const metadata = providerMetadata?.blackForestLabs?.images?.[0];
console.log('Seed:', metadata?.seed);
console.log('Cost:', metadata?.cost);
console.log('Duration:', metadata?.duration);
```

### Regional Endpoints

By default, requests are sent to `https://api.bfl.ai/v1`. You can select a [regional endpoint](https://docs.bfl.ai/api_integration/integration_guidelines#regional-endpoints) by setting `baseURL` when creating the provider instance:

```ts
import { createBlackForestLabs } from '@ai-sdk/black-forest-labs';

const blackForestLabs = createBlackForestLabs({
  baseURL: 'https://api.eu.bfl.ai/v1', // or https://api.us.bfl.ai/v1
});
```

---
title: Gladia
description: Learn how to use the Gladia provider for the AI SDK.
---

# Gladia Provider

The [Gladia](https://gladia.io/) provider contains language model support for the Gladia transcription API.

## Setup

The Gladia provider is available in the `@ai-sdk/gladia` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/gladia" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/gladia" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/gladia" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/gladia" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `gladia` from `@ai-sdk/gladia`:

```ts
import { gladia } from '@ai-sdk/gladia';
```

If you need a customized setup, you can import `createGladia` from `@ai-sdk/gladia` and create a provider instance with your settings:

```ts
import { createGladia } from '@ai-sdk/gladia';

const gladia = createGladia({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the Gladia provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `GLADIA_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Transcription Models

You can create models that call the [Gladia transcription API](https://docs.gladia.io/chapters/pre-recorded-stt/getting-started)
using the `.transcription()` factory method.

```ts
const model = gladia.transcription();
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the `summarize` option will enable summaries for sections of content.

```ts highlight="7"
import { experimental_transcribe as transcribe } from 'ai';
import { gladia } from '@ai-sdk/gladia';
import { type GladiaTranscriptionModelOptions } from '@ai-sdk/gladia';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: gladia.transcription(),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    gladia: {
      summarization: true,
    } satisfies GladiaTranscriptionModelOptions,
  },
});
```

<Note>
  Gladia does not have various models, so you can omit the standard `model` id
  parameter.
</Note>

The following provider options are available:

- **contextPrompt** _string_

  Context to feed the transcription model with for possible better accuracy.
  Optional.

- **customVocabulary** _boolean | any[]_

  Custom vocabulary to improve transcription accuracy.
  Optional.

- **customVocabularyConfig** _object_

  Configuration for custom vocabulary.
  Optional.

  - **vocabulary** _Array&lt;string | \{ value: string, intensity?: number, pronunciations?: string[], language?: string \}&gt;_
  - **defaultIntensity** _number_

- **detectLanguage** _boolean_

  Whether to automatically detect the language.
  Optional.

- **enableCodeSwitching** _boolean_

  Enable code switching for multilingual audio.
  Optional.

- **codeSwitchingConfig** _object_

  Configuration for code switching.
  Optional.

  - **languages** _string[]_

- **language** _string_

  Specify the language of the audio.
  Optional.

- **callback** _boolean_

  Enable callback when transcription is complete.
  Optional.

- **callbackConfig** _object_

  Configuration for callback.
  Optional.

  - **url** _string_
  - **method** _'POST' | 'PUT'_

- **subtitles** _boolean_

  Generate subtitles from the transcription.
  Optional.

- **subtitlesConfig** _object_

  Configuration for subtitles.
  Optional.

  - **formats** _Array&lt;'srt' | 'vtt'&gt;_
  - **minimumDuration** _number_
  - **maximumDuration** _number_
  - **maximumCharactersPerRow** _number_
  - **maximumRowsPerCaption** _number_
  - **style** _'default' | 'compliance'_

- **diarization** _boolean_

  Enable speaker diarization.
  Optional.

- **diarizationConfig** _object_

  Configuration for diarization.
  Optional.

  - **numberOfSpeakers** _number_
  - **minSpeakers** _number_
  - **maxSpeakers** _number_
  - **enhanced** _boolean_

- **translation** _boolean_

  Enable translation of the transcription.
  Optional.

- **translationConfig** _object_

  Configuration for translation.
  Optional.

  - **targetLanguages** _string[]_
  - **model** _'base' | 'enhanced'_
  - **matchOriginalUtterances** _boolean_

- **summarization** _boolean_

  Enable summarization of the transcription.
  Optional.

- **summarizationConfig** _object_

  Configuration for summarization.
  Optional.

  - **type** _'general' | 'bullet_points' | 'concise'_

- **moderation** _boolean_

  Enable content moderation.
  Optional.

- **namedEntityRecognition** _boolean_

  Enable named entity recognition.
  Optional.

- **chapterization** _boolean_

  Enable chapterization of the transcription.
  Optional.

- **nameConsistency** _boolean_

  Enable name consistency in the transcription.
  Optional.

- **customSpelling** _boolean_

  Enable custom spelling.
  Optional.

- **customSpellingConfig** _object_

  Configuration for custom spelling.
  Optional.

  - **spellingDictionary** _Record&lt;string, string[]&gt;_

- **structuredDataExtraction** _boolean_

  Enable structured data extraction.
  Optional.

- **structuredDataExtractionConfig** _object_

  Configuration for structured data extraction.
  Optional.

  - **classes** _string[]_

- **sentimentAnalysis** _boolean_

  Enable sentiment analysis.
  Optional.

- **audioToLlm** _boolean_

  Enable audio to LLM processing.
  Optional.

- **audioToLlmConfig** _object_

  Configuration for audio to LLM.
  Optional.

  - **prompts** _string[]_

- **customMetadata** _Record&lt;string, any&gt;_

  Custom metadata to include with the request.
  Optional.

- **sentences** _boolean_

  Enable sentence detection.
  Optional.

- **displayMode** _boolean_

  Enable display mode.
  Optional.

- **punctuationEnhanced** _boolean_

  Enable enhanced punctuation.
  Optional.

### Model Capabilities

| Model     | Transcription       | Duration            | Segments            | Language            |
| --------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `Default` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: LMNT
description: Learn how to use the LMNT provider for the AI SDK.
---

# LMNT Provider

The [LMNT](https://lmnt.com/) provider contains speech model support for the LMNT speech synthesis API.

## Setup

The LMNT provider is available in the `@ai-sdk/lmnt` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/lmnt" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/lmnt" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/lmnt" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/lmnt" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `lmnt` from `@ai-sdk/lmnt`:

```ts
import { lmnt } from '@ai-sdk/lmnt';
```

If you need a customized setup, you can import `createLMNT` from `@ai-sdk/lmnt` and create a provider instance with your settings:

```ts
import { createLMNT } from '@ai-sdk/lmnt';

const lmnt = createLMNT({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the LMNT provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `LMNT_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Speech Models

You can create models that call the [LMNT speech API](https://docs.lmnt.com/api-reference/speech/synthesize-speech-bytes)
using the `.speech()` factory method.

The first argument is the model id e.g. `aurora`.

```ts
const model = lmnt.speech('aurora');
```

The `voice` parameter can be set to a voice ID from LMNT. You can find available voices in the [LMNT documentation](https://docs.lmnt.com/api-reference/voices/list-voices).

```ts highlight="7"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { lmnt } from '@ai-sdk/lmnt';

const result = await generateSpeech({
  model: lmnt.speech('aurora'),
  text: 'Hello, world!',
  voice: 'ava',
  language: 'en',
});
```

You can also pass additional provider-specific options using the `providerOptions` argument:

```ts highlight="10-14"
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { lmnt } from '@ai-sdk/lmnt';
import { type LMNTSpeechModelOptions } from '@ai-sdk/lmnt';

const result = await generateSpeech({
  model: lmnt.speech('aurora'),
  text: 'Hello, world!',
  voice: 'ava',
  language: 'en',
  providerOptions: {
    lmnt: {
      conversational: true,
      speed: 1.2,
    } satisfies LMNTSpeechModelOptions,
  },
});
```

### Provider Options

The LMNT provider accepts the following options via `providerOptions.lmnt`:

- **format** _'aac' | 'mp3' | 'mulaw' | 'raw' | 'wav'_

  The audio format to return. Defaults to `'mp3'`.

- **sampleRate** _8000 | 16000 | 24000_

  The sample rate of the audio in Hz. Defaults to `24000`.

- **speed** _number_

  The speed of the speech. Must be between 0.25 and 2. Defaults to `1`.

- **seed** _number_

  An optional seed for deterministic generation.

- **conversational** _boolean_

  Whether to use a conversational style. Defaults to `false`. Does not work with the `blizzard` model.

- **length** _number_

  Maximum length of the audio in seconds. Maximum value is 300. Does not work with the `blizzard` model.

- **topP** _number_

  Top-p sampling parameter. Must be between 0 and 1. Defaults to `1`.

- **temperature** _number_

  Temperature parameter for sampling. Must be at least 0. Defaults to `1`.

### Model Capabilities

| Model      | Instructions        |
| ---------- | ------------------- |
| `aurora`   | <Cross size={18} /> |
| `blizzard` | <Cross size={18} /> |

---
title: Google Generative AI
description: Learn how to use Google Generative AI Provider.
---

# Google Generative AI Provider

The [Google Generative AI](https://ai.google.dev) provider contains language and embedding model support for
the [Google Generative AI](https://ai.google.dev/api/rest) APIs.

## Setup

The Google provider is available in the `@ai-sdk/google` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/google" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/google" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/google" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/google" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `google` from `@ai-sdk/google`:

```ts
import { google } from '@ai-sdk/google';
```

If you need a customized setup, you can import `createGoogleGenerativeAI` from `@ai-sdk/google` and create a provider instance with your settings:

```ts
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({
  // custom settings
});
```

You can use the following optional settings to customize the Google Generative AI provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://generativelanguage.googleapis.com/v1beta`.

- **apiKey** _string_

  API key that is being sent using the `x-goog-api-key` header.
  It defaults to the `GOOGLE_GENERATIVE_AI_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **generateId** _() => string_

  Optional function to generate unique IDs for each request.
  Defaults to the SDK's built-in ID generator.

- **name** _string_

  Custom provider name.
  Defaults to `'google.generative-ai'`.

## Language Models

You can create models that call the [Google Generative AI API](https://ai.google.dev/api/rest) using the provider instance.
The first argument is the model id, e.g. `gemini-2.5-flash`.
The models support tool calls and some have multi-modal capabilities.

```ts
const model = google('gemini-2.5-flash');
```

You can use Google Generative AI language models to generate text with the `generateText` function:

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text } = await generateText({
  model: google('gemini-2.5-flash'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Google Generative AI language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

Google Generative AI also supports some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';

const model = google('gemini-2.5-flash');

await generateText({
  model,
  providerOptions: {
    google: {
      safetySettings: [
        {
          category: 'HARM_CATEGORY_UNSPECIFIED',
          threshold: 'BLOCK_LOW_AND_ABOVE',
        },
      ],
    } satisfies GoogleLanguageModelOptions,
  },
});
```

The following optional provider options are available for Google Generative AI models:

- **cachedContent** _string_

  Optional. The name of the cached content used as context to serve the prediction.
  Format: cachedContents/\{cachedContent\}

- **structuredOutputs** _boolean_

  Optional. Enable structured output. Default is true.

  This is useful when the JSON Schema contains elements that are
  not supported by the OpenAPI schema version that
  Google Generative AI uses. You can use this to disable
  structured outputs if you need to.

  See [Troubleshooting: Schema Limitations](#schema-limitations) for more details.

- **safetySettings** _Array\<\{ category: string; threshold: string \}\>_

  Optional. Safety settings for the model.

  - **category** _string_

    The category of the safety setting. Can be one of the following:

    - `HARM_CATEGORY_UNSPECIFIED`
    - `HARM_CATEGORY_HATE_SPEECH`
    - `HARM_CATEGORY_DANGEROUS_CONTENT`
    - `HARM_CATEGORY_HARASSMENT`
    - `HARM_CATEGORY_SEXUALLY_EXPLICIT`
    - `HARM_CATEGORY_CIVIC_INTEGRITY`

  - **threshold** _string_

    The threshold of the safety setting. Can be one of the following:

    - `HARM_BLOCK_THRESHOLD_UNSPECIFIED`
    - `BLOCK_LOW_AND_ABOVE`
    - `BLOCK_MEDIUM_AND_ABOVE`
    - `BLOCK_ONLY_HIGH`
    - `BLOCK_NONE`
    - `OFF`

- **responseModalities** _string[]_
  The modalities to use for the response. The following modalities are supported: `TEXT`, `IMAGE`. When not defined or empty, the model defaults to returning only text.

- **thinkingConfig** _\{ thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'; thinkingBudget?: number; includeThoughts?: boolean \}_

  Optional. Configuration for the model's thinking process. Only supported by specific [Google Generative AI models](https://ai.google.dev/gemini-api/docs/thinking).

  - **thinkingLevel** _'minimal' | 'low' | 'medium' | 'high'_

    Optional. Controls the thinking depth for Gemini 3 models. Gemini 3.1 Pro supports 'low', 'medium', and 'high', Gemini 3 Pro supports 'low' and 'high', while Gemini 3 Flash supports all four levels: 'minimal', 'low', 'medium', and 'high'. Only supported by Gemini 3 models.

  - **thinkingBudget** _number_

    Optional. Gives the model guidance on the number of thinking tokens it can use when generating a response. Setting it to 0 disables thinking, if the model supports it.
    For more information about the possible value ranges for each model see [Google Generative AI thinking documentation](https://ai.google.dev/gemini-api/docs/thinking#set-budget).

    <Note>
      This option is for Gemini 2.5 models. Gemini 3 models should use
      `thinkingLevel` instead.
    </Note>

  - **includeThoughts** _boolean_

    Optional. If set to true, thought summaries are returned, which are synthesized versions of the model's raw thoughts and offer insights into the model's internal reasoning process.

- **imageConfig** _\{ aspectRatio?: string, imageSize?: string \}_

  Optional. Configuration for the models image generation. Only supported by specific [Google Generative AI models](https://ai.google.dev/gemini-api/docs/image-generation).

  - **aspectRatio** _string_

    Model defaults to generate 1:1 squares, or to matching the output image size to that of your input image. Can be one of the following:

    - 1:1
    - 2:3
    - 3:2
    - 3:4
    - 4:3
    - 4:5
    - 5:4
    - 9:16
    - 16:9
    - 21:9

  - **imageSize** _string_

    Controls the output image resolution. Defaults to 1K. Can be one of the following:

    - 1K
    - 2K
    - 4K

- **audioTimestamp** _boolean_

  Optional. Enables timestamp understanding for audio-only files.
  See [Google Cloud audio understanding documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/audio-understanding).

- **mediaResolution** _string_

  Optional. If specified, the media resolution specified will be used. Can be one of the following:

  - `MEDIA_RESOLUTION_UNSPECIFIED`
  - `MEDIA_RESOLUTION_LOW`
  - `MEDIA_RESOLUTION_MEDIUM`
  - `MEDIA_RESOLUTION_HIGH`

  See [Google API MediaResolution documentation](https://ai.google.dev/api/generate-content#MediaResolution).

- **labels** _Record&lt;string, string&gt;_

  Optional. Defines labels used in billing reports. Available on Vertex AI only.
  See [Google Cloud labels documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/add-labels-to-api-calls).

- **serviceTier** _'standard' | 'flex' | 'priority'_

  Optional. The service tier to use for the request.
  Set to 'flex' for 50% cheaper processing at the cost of increased latency.
  Set to 'priority' for ultra-low latency at a 75-100% price premium over 'standard'.

- **threshold** _string_

  Optional. Standalone threshold setting that can be used independently of `safetySettings`.
  Uses the same values as the `safetySettings` threshold.

### Thinking

The Gemini 2.5 and Gemini 3 series models use an internal "thinking process" that significantly improves their reasoning and multi-step planning abilities, making them highly effective for complex tasks such as coding, advanced mathematics, and data analysis. For more information see [Google Generative AI thinking documentation](https://ai.google.dev/gemini-api/docs/thinking).

#### Gemini 3 Models

For Gemini 3 models, use the `thinkingLevel` parameter to control the depth of reasoning:

```ts
import { google, GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText } from 'ai';

const model = google('gemini-3.1-pro-preview');

const { text, reasoning } = await generateText({
  model: model,
  prompt: 'What is the sum of the first 10 prime numbers?',
  providerOptions: {
    google: {
      thinkingConfig: {
        thinkingLevel: 'high',
        includeThoughts: true,
      },
    } satisfies GoogleLanguageModelOptions,
  },
});

console.log(text);

console.log(reasoning); // Reasoning summary
```

#### Gemini 2.5 Models

For Gemini 2.5 models, use the `thinkingBudget` parameter to control the number of thinking tokens:

```ts
import { google, GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText } from 'ai';

const model = google('gemini-2.5-flash');

const { text, reasoning } = await generateText({
  model: model,
  prompt: 'What is the sum of the first 10 prime numbers?',
  providerOptions: {
    google: {
      thinkingConfig: {
        thinkingBudget: 8192,
        includeThoughts: true,
      },
    } satisfies GoogleLanguageModelOptions,
  },
});

console.log(text);

console.log(reasoning); // Reasoning summary
```

### File Inputs

The Google Generative AI provider supports file inputs, e.g. PDF files.

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: google('gemini-2.5-flash'),
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

You can also use YouTube URLs directly:

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: google('gemini-2.5-flash'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Summarize this video',
        },
        {
          type: 'file',
          data: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          mediaType: 'video/mp4',
        },
      ],
    },
  ],
});
```

<Note>
  The AI SDK will automatically download URLs if you pass them as data, except
  for `https://generativelanguage.googleapis.com/v1beta/files/` and YouTube
  URLs. You can use the Google Generative AI Files API to upload larger files to
  that location. YouTube URLs (public or unlisted videos) are supported directly
  - you can specify one YouTube video URL per request.
</Note>

See [File Parts](/docs/foundations/prompts#file-parts) for details on how to use files in prompts.

### Cached Content

Google Generative AI supports both explicit and implicit caching to help reduce costs on repetitive content.

#### Implicit Caching

Gemini 2.5 models automatically provide cache cost savings without needing to create an explicit cache. When you send requests that share common prefixes with previous requests, you'll receive a 75% token discount on cached content.

To maximize cache hits with implicit caching:

- Keep content at the beginning of requests consistent
- Add variable content (like user questions) at the end of prompts
- Ensure requests meet minimum token requirements:
  - Gemini 2.5 Flash: 1024 tokens minimum
  - Gemini 2.5 Pro: 2048 tokens minimum

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

// Structure prompts with consistent content at the beginning
const baseContext =
  'You are a cooking assistant with expertise in Italian cuisine. Here are 1000 lasagna recipes for reference...';

const { text: veggieLasagna } = await generateText({
  model: google('gemini-2.5-pro'),
  prompt: `${baseContext}\n\nWrite a vegetarian lasagna recipe for 4 people.`,
});

// Second request with same prefix - eligible for cache hit
const { text: meatLasagna, providerMetadata } = await generateText({
  model: google('gemini-2.5-pro'),
  prompt: `${baseContext}\n\nWrite a meat lasagna recipe for 12 people.`,
});

// Check cached token count in usage metadata
console.log('Cached tokens:', providerMetadata.google);
// e.g.
// {
//   groundingMetadata: null,
//   safetyRatings: null,
//   usageMetadata: {
//     cachedContentTokenCount: 2027,
//     thoughtsTokenCount: 702,
//     promptTokenCount: 2152,
//     candidatesTokenCount: 710,
//     totalTokenCount: 3564
//   }
// }
```

<Note>
  Usage metadata was added to `providerMetadata` in `@ai-sdk/google@1.2.23`. If
  you are using an older version, usage metadata is available in the raw HTTP
  `response` body returned as part of the return value from `generateText`.
</Note>

#### Explicit Caching

For guaranteed cost savings, you can still use explicit caching with Gemini 2.5 and 2.0 models. See the [models page](https://ai.google.dev/gemini-api/docs/models) to check if caching is supported for the used model:

```ts
import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { generateText } from 'ai';

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

const model = 'gemini-2.5-pro';

// Create a cache with the content you want to reuse
const cache = await ai.caches.create({
  model,
  config: {
    contents: [
      {
        role: 'user',
        parts: [{ text: '1000 Lasagna Recipes...' }],
      },
    ],
    ttl: '300s', // Cache expires after 5 minutes
  },
});

const { text: veggieLasagnaRecipe } = await generateText({
  model: google(model),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  providerOptions: {
    google: {
      cachedContent: cache.name,
    } satisfies GoogleLanguageModelOptions,
  },
});

const { text: meatLasagnaRecipe } = await generateText({
  model: google(model),
  prompt: 'Write a meat lasagna recipe for 12 people.',
  providerOptions: {
    google: {
      cachedContent: cache.name,
    } satisfies GoogleLanguageModelOptions,
  },
});
```

### Code Execution

With [Code Execution](https://ai.google.dev/gemini-api/docs/code-execution), certain models can generate and execute Python code to perform calculations, solve problems, or provide more accurate information.

You can enable code execution by adding the `code_execution` tool to your request.

```ts
import { google } from '@ai-sdk/google';
import { googleTools } from '@ai-sdk/google/internal';
import { generateText } from 'ai';

const { text, toolCalls, toolResults } = await generateText({
  model: google('gemini-2.5-pro'),
  tools: { code_execution: google.tools.codeExecution({}) },
  prompt: 'Use python to calculate the 20th fibonacci number.',
});
```

The response will contain the tool calls and results from the code execution.

### Google Search

With [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search),
the model has access to the latest information using Google Search.

```ts highlight="8,17-20"
import { google } from '@ai-sdk/google';
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text, sources, providerMetadata } = await generateText({
  model: google('gemini-2.5-flash'),
  tools: {
    google_search: google.tools.googleSearch({}),
  },
  prompt:
    'List the top 5 San Francisco news from the past week.' +
    'You must include the date of each article.',
});

// access the grounding metadata. Casting to the provider metadata type
// is optional but provides autocomplete and type safety.
const metadata = providerMetadata?.google as
  | GoogleGenerativeAIProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
const safetyRatings = metadata?.safetyRatings;
```

The `googleSearch` tool accepts the following optional configuration options:

- **searchTypes** _object_

  Enables specific search types. Both can be combined.

  - `webSearch`: Enable web search grounding (pass `{}` to enable). This is the default.
  - `imageSearch`: Enable [image search grounding](https://ai.google.dev/gemini-api/docs/image-generation#image-search) (pass `{}` to enable).

- **timeRangeFilter** _object_

  Restricts search results to a specific time range. Both `startTime` and `endTime` are required.

  - `startTime`: Start time in ISO 8601 format (e.g. `'2025-01-01T00:00:00Z'`).
  - `endTime`: End time in ISO 8601 format (e.g. `'2025-12-31T23:59:59Z'`).

```ts
google.tools.googleSearch({
  searchTypes: { webSearch: {} },
  timeRangeFilter: {
    startTime: '2025-01-01T00:00:00Z',
    endTime: '2025-12-31T23:59:59Z',
  },
});
```

When Google Search grounding is enabled, the model will include sources in the response.

Additionally, the grounding metadata includes detailed information about how search results were used to ground the model's response. Here are the available fields:

- **`webSearchQueries`** (`string[] | null`)

  - Array of search queries used to retrieve information
  - Example: `["What's the weather in Chicago this weekend?"]`

- **`searchEntryPoint`** (`{ renderedContent: string } | null`)

  - Contains the main search result content used as an entry point
  - The `renderedContent` field contains the formatted content

- **`groundingSupports`** (Array of support objects | null)
  - Contains details about how specific response parts are supported by search results
  - Each support object includes:
    - **`segment`**: Information about the grounded text segment
      - `text`: The actual text segment
      - `startIndex`: Starting position in the response
      - `endIndex`: Ending position in the response
    - **`groundingChunkIndices`**: References to supporting search result chunks
    - **`confidenceScores`**: Confidence scores (0-1) for each supporting chunk

Example response:

```json
{
  "groundingMetadata": {
    "webSearchQueries": ["What's the weather in Chicago this weekend?"],
    "searchEntryPoint": {
      "renderedContent": "..."
    },
    "groundingSupports": [
      {
        "segment": {
          "startIndex": 0,
          "endIndex": 65,
          "text": "Chicago weather changes rapidly, so layers let you adjust easily."
        },
        "groundingChunkIndices": [0],
        "confidenceScores": [0.99]
      }
    ]
  }
}
```

### Enterprise Web Search

With [Enterprise Web Search](https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/web-grounding-enterprise),
the model has access to a compliance-focused web index designed for highly-regulated industries such as finance, healthcare, and public sector.

<Note>
  Enterprise Web Search is only available on Vertex AI. You must use the Google
  Vertex provider (`@ai-sdk/google-vertex`) instead of the standard Google
  provider (`@ai-sdk/google`) to use this feature. Requires Gemini 2.0 or newer
  models.
</Note>

```ts
import { createVertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const vertex = createVertex({
  project: 'my-project',
  location: 'us-central1',
});

const { text, sources, providerMetadata } = await generateText({
  model: vertex('gemini-2.5-flash'),
  tools: {
    enterprise_web_search: vertex.tools.enterpriseWebSearch({}),
  },
  prompt: 'What are the latest regulatory updates for financial services?',
});
```

Enterprise Web Search provides the following benefits:

- Does not log customer data
- Supports VPC service controls
- Compliance-focused web index for regulated industries

### File Search

The [File Search tool](https://ai.google.dev/gemini-api/docs/file-search) lets Gemini retrieve context from your own documents that you have indexed in File Search stores. Only Gemini 2.5 and Gemini 3 models support this feature.

```ts highlight="9-13"
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text, sources } = await generateText({
  model: google('gemini-2.5-pro'),
  tools: {
    file_search: google.tools.fileSearch({
      fileSearchStoreNames: [
        'projects/my-project/locations/us/fileSearchStores/my-store',
      ],
      metadataFilter: 'author = "Robert Graves"',
      topK: 8,
    }),
  },
  prompt: "Summarise the key themes of 'I, Claudius'.",
});
```

File Search responses include citations via the normal `sources` field and expose raw [grounding metadata](#google-search) in `providerMetadata.google.groundingMetadata`.

### URL Context

Google provides a provider-defined URL context tool.

The URL context tool allows you to provide specific URLs that you want the model to analyze directly in from the prompt.

```ts highlight="9,13-17"
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text, sources, providerMetadata } = await generateText({
  model: google('gemini-2.5-flash'),
  prompt: `Based on the document: https://ai.google.dev/gemini-api/docs/url-context.
          Answer this question: How many links we can consume in one request?`,
  tools: {
    url_context: google.tools.urlContext({}),
  },
});

const metadata = providerMetadata?.google as
  | GoogleGenerativeAIProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
const urlContextMetadata = metadata?.urlContextMetadata;
```

The URL context metadata includes detailed information about how the model used the URL context to generate the response. Here are the available fields:

- **`urlMetadata`** (`{ retrievedUrl: string; urlRetrievalStatus: string; }[] | null`)

  - Array of URL context metadata
  - Each object includes:
    - **`retrievedUrl`**: The URL of the context
    - **`urlRetrievalStatus`**: The status of the URL retrieval

Example response:

```json
{
  "urlMetadata": [
    {
      "retrievedUrl": "https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai",
      "urlRetrievalStatus": "URL_RETRIEVAL_STATUS_SUCCESS"
    }
  ]
}
```

With the URL context tool, you will also get the `groundingMetadata`.

```json
"groundingMetadata": {
    "groundingChunks": [
        {
            "web": {
                "uri": "https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai",
                "title": "Google Generative AI - AI SDK Providers"
            }
        }
    ],
    "groundingSupports": [
        {
            "segment": {
                "startIndex": 67,
                "endIndex": 157,
                "text": "**Installation**: Install the `@ai-sdk/google` module using your preferred package manager"
            },
            "groundingChunkIndices": [
                0
            ]
        },
    ]
}
```

<Note>You can add up to 20 URLs per request.</Note>

<Note>
  The URL context tool is only supported for Gemini 2.0 Flash models and above.
  Check the [supported models for URL context
  tool](https://ai.google.dev/gemini-api/docs/url-context#supported-models).
</Note>

#### Combine URL Context with Search Grounding

You can combine the URL context tool with search grounding to provide the model with the latest information from the web.

```ts highlight="9-10"
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text, sources, providerMetadata } = await generateText({
  model: google('gemini-2.5-flash'),
  prompt: `Based on this context: https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai, tell me how to use Gemini with AI SDK.
    Also, provide the latest news about AI SDK V5.`,
  tools: {
    google_search: google.tools.googleSearch({}),
    url_context: google.tools.urlContext({}),
  },
});

const metadata = providerMetadata?.google as
  | GoogleGenerativeAIProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
const urlContextMetadata = metadata?.urlContextMetadata;
```

### Google Maps Grounding

With [Google Maps grounding](https://ai.google.dev/gemini-api/docs/maps-grounding),
the model has access to Google Maps data for location-aware responses. This enables providing local data and geospatial context, such as finding nearby restaurants.

```ts highlight="7-16"
import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text, sources, providerMetadata } = await generateText({
  model: google('gemini-2.5-flash'),
  tools: {
    google_maps: google.tools.googleMaps({}),
  },
  providerOptions: {
    google: {
      retrievalConfig: {
        latLng: { latitude: 34.090199, longitude: -117.881081 },
      },
    } satisfies GoogleLanguageModelOptions,
  },
  prompt:
    'What are the best Italian restaurants within a 15-minute walk from here?',
});

const metadata = providerMetadata?.google as
  | GoogleGenerativeAIProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
```

The optional `retrievalConfig.latLng` provider option provides location context for queries about nearby places. This configuration applies to any grounding tools that support location context, including Google Maps and Google Search.

When Google Maps grounding is enabled, the model's response will include sources pointing to Google Maps URLs. The grounding metadata includes `maps` chunks with place information:

```json
{
  "groundingMetadata": {
    "groundingChunks": [
      {
        "maps": {
          "uri": "https://maps.google.com/?cid=12345",
          "title": "Restaurant Name",
          "placeId": "places/ChIJ..."
        }
      }
    ]
  }
}
```

<Note>Google Maps grounding is supported on Gemini 2.0 and newer models.</Note>

### RAG Engine Grounding

With [RAG Engine Grounding](https://cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/use-vertexai-search#generate-content-using-gemini-api),
the model has access to your custom knowledge base using the Vertex RAG Engine.
This enables the model to provide answers based on your specific data sources and documents.

<Note>
  RAG Engine Grounding is only supported with Vertex Gemini models. You must use
  the Google Vertex provider (`@ai-sdk/google-vertex`) instead of the standard
  Google provider (`@ai-sdk/google`) to use this feature.
</Note>

```ts highlight="8,17-20"
import { createVertex } from '@ai-sdk/google-vertex';
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google';
import { generateText } from 'ai';

const vertex = createVertex({
  project: 'my-project',
  location: 'us-central1',
});

const { text, sources, providerMetadata } = await generateText({
  model: vertex('gemini-2.5-flash'),
  tools: {
    vertex_rag_store: vertex.tools.vertexRagStore({
      ragCorpus:
        'projects/my-project/locations/us-central1/ragCorpora/my-rag-corpus',
      topK: 5,
    }),
  },
  prompt:
    'What are the key features of our product according to our documentation?',
});

// access the grounding metadata. Casting to the provider metadata type
// is optional but provides autocomplete and type safety.
const metadata = providerMetadata?.google as
  | GoogleGenerativeAIProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
const safetyRatings = metadata?.safetyRatings;
```

When RAG Engine Grounding is enabled, the model will include sources from your RAG corpus in the response.

Additionally, the grounding metadata includes detailed information about how RAG results were used to ground the model's response. Here are the available fields:

- **`groundingChunks`** (Array of chunk objects | null)

  - Contains the retrieved context chunks from your RAG corpus
  - Each chunk includes:
    - **`retrievedContext`**: Information about the retrieved context
      - `uri`: The URI or identifier of the source document
      - `title`: The title of the source document (optional)
      - `text`: The actual text content of the chunk

- **`groundingSupports`** (Array of support objects | null)

  - Contains details about how specific response parts are supported by RAG results
  - Each support object includes:
    - **`segment`**: Information about the grounded text segment
      - `text`: The actual text segment
      - `startIndex`: Starting position in the response
      - `endIndex`: Ending position in the response
    - **`groundingChunkIndices`**: References to supporting RAG result chunks
    - **`confidenceScores`**: Confidence scores (0-1) for each supporting chunk

Example response:

```json
{
  "groundingMetadata": {
    "groundingChunks": [
      {
        "retrievedContext": {
          "uri": "gs://my-bucket/docs/product-guide.pdf",
          "title": "Product User Guide",
          "text": "Our product includes advanced AI capabilities, real-time processing, and enterprise-grade security features."
        }
      }
    ],
    "groundingSupports": [
      {
        "segment": {
          "startIndex": 0,
          "endIndex": 45,
          "text": "Our product includes advanced AI capabilities and real-time processing."
        },
        "groundingChunkIndices": [0],
        "confidenceScores": [0.95]
      }
    ]
  }
}
```

#### Configuration Options

The `vertexRagStore` tool accepts the following configuration options:

- **`ragCorpus`** (`string`, required)

  - The RagCorpus resource name in the format: `projects/{project}/locations/{location}/ragCorpora/{rag_corpus}`
  - This identifies your specific RAG corpus to search against

- **`topK`** (`number`, optional)

  - The number of top contexts to retrieve from your RAG corpus
  - Defaults to the corpus configuration if not specified

### Image Outputs

Gemini models with image generation capabilities (e.g. `gemini-2.5-flash-image`) support generating images as part of a multimodal response. Images are exposed as files in the response.

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: google('gemini-2.5-flash-image'),
  prompt:
    'Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme',
});

for (const file of result.files) {
  if (file.mediaType.startsWith('image/')) {
    console.log('Generated image:', file);
  }
}
```

<Note>
  If you primarily want to generate images without text output, you can also use
  Gemini image models with the `generateImage()` function. See [Gemini Image
  Models](#gemini-image-models) for details.
</Note>

### Safety Ratings

The safety ratings provide insight into the safety of the model's response.
See [Google AI documentation on safety settings](https://ai.google.dev/gemini-api/docs/safety-settings).

Example response excerpt:

```json
{
  "safetyRatings": [
    {
      "category": "HARM_CATEGORY_HATE_SPEECH",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.11027937,
      "severity": "HARM_SEVERITY_LOW",
      "severityScore": 0.28487435
    },
    {
      "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
      "probability": "HIGH",
      "blocked": true,
      "probabilityScore": 0.95422274,
      "severity": "HARM_SEVERITY_MEDIUM",
      "severityScore": 0.43398145
    },
    {
      "category": "HARM_CATEGORY_HARASSMENT",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.11085559,
      "severity": "HARM_SEVERITY_NEGLIGIBLE",
      "severityScore": 0.19027223
    },
    {
      "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.22901751,
      "severity": "HARM_SEVERITY_NEGLIGIBLE",
      "severityScore": 0.09089675
    }
  ]
}
```

### Troubleshooting

#### Schema Limitations

The Google Generative AI API uses a subset of the OpenAPI 3.0 schema,
which does not support features such as unions.
The errors that you get in this case look like this:

`GenerateContentRequest.generation_config.response_schema.properties[occupation].type: must be specified`

By default, structured outputs are enabled (and for tool calling they are required).
You can disable structured outputs for object generation as a workaround:

```ts highlight="3,8"
const { output } = await generateText({
  model: google('gemini-2.5-flash'),
  providerOptions: {
    google: {
      structuredOutputs: false,
    } satisfies GoogleLanguageModelOptions,
  },
  output: Output.object({
    schema: z.object({
      name: z.string(),
      age: z.number(),
      contact: z.union([
        z.object({
          type: z.literal('email'),
          value: z.string(),
        }),
        z.object({
          type: z.literal('phone'),
          value: z.string(),
        }),
      ]),
    }),
  }),
  prompt: 'Generate an example person for testing.',
});
```

The following Zod features are known to not work with Google Generative AI:

- `z.union`
- `z.record`

### Model Capabilities

| Model                                 | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      | Google Search       | URL Context         |
| ------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `gemini-3.1-pro-preview`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-3.1-flash-image-preview`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-3.1-flash-lite-preview`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-3-pro-preview`                | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-3-pro-image-preview`          | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-3-flash-preview`              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-pro`                      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-flash`                    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-flash-lite`               | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-flash-lite-preview-06-17` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.0-flash`                    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [Google Generative AI
  docs](https://ai.google.dev/gemini-api/docs/models/) for a full list of
  available models. The table above lists popular models. You can also pass any
  available provider model ID as a string if needed.
</Note>

## Gemma Models

You can use [Gemma models](https://deepmind.google/models/gemma/) with the Google Generative AI API.
The following Gemma models are available:

- `gemma-3-27b-it`
- `gemma-3-12b-it`

Gemma models don't natively support the `systemInstruction` parameter, but the provider automatically handles system instructions by prepending them to the first user message. This allows you to use system instructions with Gemma models seamlessly:

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text } = await generateText({
  model: google('gemma-3-27b-it'),
  system: 'You are a helpful assistant that responds concisely.',
  prompt: 'What is machine learning?',
});
```

The system instruction is automatically formatted and included in the conversation, so Gemma models can follow the guidance without any additional configuration.

## Embedding Models

You can create models that call the [Google Generative AI embeddings API](https://ai.google.dev/gemini-api/docs/embeddings)
using the `.embedding()` factory method.

```ts
const model = google.embedding('gemini-embedding-001');
```

The Google Generative AI provider sends API calls to the right endpoint based on the type of embedding:

- **Single embeddings**: When embedding a single value with `embed()`, the provider uses the single `:embedContent` endpoint, which typically has higher rate limits compared to the batch endpoint.
- **Batch embeddings**: When embedding multiple values with `embedMany()` or multiple values in `embed()`, the provider uses the `:batchEmbedContents` endpoint.

Google Generative AI embedding models support additional settings. You can pass them as an options argument:

```ts
import { google, type GoogleEmbeddingModelOptions } from '@ai-sdk/google';
import { embed } from 'ai';

const model = google.embedding('gemini-embedding-001');

const { embedding } = await embed({
  model,
  value: 'sunny day at the beach',
  providerOptions: {
    google: {
      outputDimensionality: 512, // optional, number of dimensions for the embedding
      taskType: 'SEMANTIC_SIMILARITY', // optional, specifies the task type for generating embeddings
      content: [[{ text: 'additional context' }]], // optional, per-value multimodal content (only 1 here, since `value` is only a single one)
    } satisfies GoogleEmbeddingModelOptions,
  },
});
```

When using `embedMany`, provide per-value multimodal content via the `content` option. Each entry corresponds to a value at the same index; use `null` for text-only entries:

```ts
import { google, type GoogleEmbeddingModelOptions } from '@ai-sdk/google';
import { embedMany } from 'ai';

const { embeddings } = await embedMany({
  model: google.embedding('gemini-embedding-2-preview'),
  values: ['sunny day at the beach', 'rainy afternoon in the city'],
  providerOptions: {
    google: {
      // content array must have the same length as values
      content: [
        [{ inlineData: { mimeType: 'image/png', data: '<base64>' } }], // pairs with values[0]
        null, // text-only, pairs with values[1]
      ],
    } satisfies GoogleEmbeddingModelOptions,
  },
});
```

The following optional provider options are available for Google Generative AI embedding models:

- **outputDimensionality**: _number_

  Optional reduced dimension for the output embedding. If set, excessive values in the output embedding are truncated from the end.

- **taskType**: _string_

  Optional. Specifies the task type for generating embeddings. Supported task types include:

  - `SEMANTIC_SIMILARITY`: Optimized for text similarity.
  - `CLASSIFICATION`: Optimized for text classification.
  - `CLUSTERING`: Optimized for clustering texts based on similarity.
  - `RETRIEVAL_DOCUMENT`: Optimized for document retrieval.
  - `RETRIEVAL_QUERY`: Optimized for query-based retrieval.
  - `QUESTION_ANSWERING`: Optimized for answering questions.
  - `FACT_VERIFICATION`: Optimized for verifying factual information.
  - `CODE_RETRIEVAL_QUERY`: Optimized for retrieving code blocks based on natural language queries.

- **content**: _array_

  Optional. Per-value multimodal content parts for embedding non-text content (images, video, PDF, audio). Each entry corresponds to the embedding value at the same index — its parts are merged with the text value in the request. Use `null` for entries that are text-only. The array length must match the number of values being embedded. Each non-null entry is an array of parts, where each part can be either `{ text: string }` or `{ inlineData: { mimeType: string, data: string } }`. Supported by `gemini-embedding-2-preview`.

### Model Capabilities

| Model                        | Default Dimensions | Custom Dimensions   | Multimodal          |
| ---------------------------- | ------------------ | ------------------- | ------------------- |
| `gemini-embedding-001`       | 3072               | <Check size={18} /> | <Cross size={18} /> |
| `gemini-embedding-2-preview` | 3072               | <Check size={18} /> | <Check size={18} /> |

## Image Models

You can create image models that call the Google Generative AI API using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

The Google provider supports two types of image models:

- **Imagen models**: Dedicated image generation models using the `:predict` API
- **Gemini image models**: Multimodal language models with image output capabilities using the `:generateContent` API

### Imagen Models

[Imagen](https://ai.google.dev/gemini-api/docs/imagen) models are dedicated image generation models.

```ts
import { google } from '@ai-sdk/google';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: google.image('imagen-4.0-generate-001'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
});
```

Further configuration can be done using Google provider options. You can validate the provider options using the `GoogleImageModelOptions` type.

```ts
import { google } from '@ai-sdk/google';
import { GoogleImageModelOptions } from '@ai-sdk/google';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: google.image('imagen-4.0-generate-001'),
  providerOptions: {
    google: {
      personGeneration: 'dont_allow',
    } satisfies GoogleImageModelOptions,
  },
  // ...
});
```

The following provider options are available for Imagen models:

- **personGeneration** `allow_adult` | `allow_all` | `dont_allow`
  Whether to allow person generation. Defaults to `allow_adult`.

<Note>
  Imagen models do not support the `size` parameter. Use the `aspectRatio`
  parameter instead.
</Note>

#### Imagen Model Capabilities

| Model                           | Aspect Ratios             |
| ------------------------------- | ------------------------- |
| `imagen-4.0-generate-001`       | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-4.0-ultra-generate-001` | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-4.0-fast-generate-001`  | 1:1, 3:4, 4:3, 9:16, 16:9 |

### Gemini Image Models

[Gemini image models](https://ai.google.dev/gemini-api/docs/image-generation) (e.g. `gemini-2.5-flash-image`) are technically multimodal output language models, but they can be used with the `generateImage()` function for a simpler image generation experience. Internally, the provider calls the language model API with `responseModalities: ['IMAGE']`.

```ts
import { google } from '@ai-sdk/google';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: google.image('gemini-2.5-flash-image'),
  prompt: 'A photorealistic image of a cat wearing a wizard hat',
  aspectRatio: '1:1',
});
```

Gemini image models also support image editing by providing input images:

```ts
import { google } from '@ai-sdk/google';
import { generateImage } from 'ai';
import fs from 'node:fs';

const sourceImage = fs.readFileSync('./cat.png');

const { image } = await generateImage({
  model: google.image('gemini-2.5-flash-image'),
  prompt: {
    text: 'Add a small wizard hat to this cat',
    images: [sourceImage],
  },
});
```

You can also use URLs for input images:

```ts
import { google } from '@ai-sdk/google';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: google.image('gemini-2.5-flash-image'),
  prompt: {
    text: 'Add a small wizard hat to this cat',
    images: ['https://example.com/cat.png'],
  },
});
```

<Note>
  Gemini image models do not support the `size` or `n` parameters. Use
  `aspectRatio` instead of `size`. Mask-based inpainting is also not supported.
</Note>

<Note>
  For more advanced use cases where you need both text and image outputs, or
  want more control over the generation process, you can use Gemini image models
  directly with `generateText()`. See [Image Outputs](#image-outputs) for
  details.
</Note>

#### Gemini Image Model Capabilities

| Model                            | Image Generation    | Image Editing       | Aspect Ratios                                       |
| -------------------------------- | ------------------- | ------------------- | --------------------------------------------------- |
| `gemini-2.5-flash-image`         | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| `gemini-3-pro-image-preview`     | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| `gemini-3.1-flash-image-preview` | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |

<Note>
  `gemini-3-pro-image-preview` supports additional features including up to 14
  reference images for editing (6 objects, 5 humans), resolution options (1K,
  2K, 4K via `providerOptions.google.imageConfig.imageSize`), and Google Search
  grounding.
</Note>

---
title: Hume
description: Learn how to use the Hume provider for the AI SDK.
---

# Hume Provider

The [Hume](https://hume.ai/) provider contains support for the Hume text-to-speech (TTS) API.

## Setup

The Hume provider is available in the `@ai-sdk/hume` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/hume" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/hume" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/hume" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/hume" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `hume` from `@ai-sdk/hume`:

```ts
import { hume } from '@ai-sdk/hume';
```

If you need a customized setup, you can import `createHume` from `@ai-sdk/hume` and create a provider instance with your settings:

```ts
import { createHume } from '@ai-sdk/hume';

const hume = createHume({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the Hume provider instance:

- **apiKey** _string_

  API key that is being sent using the `X-Hume-Api-Key` header.
  It defaults to the `HUME_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Speech Models

You can create models that call the [Hume speech API](https://dev.hume.ai/docs/text-to-speech-tts/overview)
using the `.speech()` factory method.

```ts
const model = hume.speech();
```

You can pass standard speech generation options like `voice`, `speed`, `instructions`, and `outputFormat`:

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { hume } from '@ai-sdk/hume';

const result = await generateSpeech({
  model: hume.speech(),
  text: 'Hello, world!',
  voice: 'd8ab67c6-953d-4bd8-9370-8fa53a0f1453',
  speed: 1.0,
  instructions: 'Speak in a friendly, conversational tone.',
  outputFormat: 'mp3',
});
```

### Supported Parameters

- **text** _string_ (required)

  The text to convert to speech.

- **voice** _string_

  The voice ID to use for the generated audio.
  Defaults to `'d8ab67c6-953d-4bd8-9370-8fa53a0f1453'`.

- **speed** _number_

  Speech rate multiplier.

- **instructions** _string_

  Description or instructions for how the text should be spoken.

- **outputFormat** _string_

  The audio format to generate. Supported values: `'mp3'`, `'pcm'`, `'wav'`.
  Defaults to `'mp3'`.

<Note>
  The `language` parameter is not supported by Hume speech models and will be
  ignored with a warning.
</Note>

### Provider Options

You can pass additional provider-specific options using the `providerOptions` argument:

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { hume } from '@ai-sdk/hume';
import { type HumeSpeechModelOptions } from '@ai-sdk/hume';

const result = await generateSpeech({
  model: hume.speech(),
  text: 'Hello, world!',
  providerOptions: {
    hume: {
      context: {
        generationId: 'previous-generation-id',
      },
    } satisfies HumeSpeechModelOptions,
  },
});
```

The following provider options are available:

- **context** _object_

  Context for the speech synthesis request. Can be either:

  - `{ generationId: string }` - ID of a previously generated speech synthesis to use as context.
  - `{ utterances: Utterance[] }` - An array of utterance objects for context, where each utterance has:
    - `text` _string_ (required) - The text content.
    - `description` _string_ - Instructions for how the text should be spoken.
    - `speed` _number_ - Speech rate multiplier.
    - `trailingSilence` _number_ - Duration of silence to add after the utterance in seconds.
    - `voice` _object_ - Voice configuration, either `{ id: string, provider?: 'HUME_AI' | 'CUSTOM_VOICE' }` or `{ name: string, provider?: 'HUME_AI' | 'CUSTOM_VOICE' }`.

### Model Capabilities

| Model     | Instructions        | Speed               | Output Formats |
| --------- | ------------------- | ------------------- | -------------- |
| `default` | <Check size={18} /> | <Check size={18} /> | mp3, pcm, wav  |

---
title: Google Vertex AI
description: Learn how to use the Google Vertex AI provider.
---

# Google Vertex Provider

The Google Vertex provider for the [AI SDK](/docs) contains language model support for the [Google Vertex AI](https://cloud.google.com/vertex-ai) APIs. This includes support for [Google's Gemini models](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models), [Anthropic's Claude partner models](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude), and [MaaS (Model as a Service) open models](https://cloud.google.com/vertex-ai/generative-ai/docs/maas/use-open-models).

<Note>
  The Google Vertex provider is compatible with both Node.js and Edge runtimes.
  The Edge runtime is supported through the `@ai-sdk/google-vertex/edge`
  sub-module. More details can be found in the [Google Vertex Edge
  Runtime](#google-vertex-edge-runtime), [Google Vertex Anthropic Edge
  Runtime](#google-vertex-anthropic-edge-runtime), and [Google Vertex MaaS Edge
  Runtime](#google-vertex-maas-edge-runtime) sections below.
</Note>

## Setup

The Google Vertex and Google Vertex Anthropic providers are both available in the `@ai-sdk/google-vertex` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/google-vertex" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/google-vertex" dark />
  </Tab>
  <Tab>
    <Snippet
      text="yarn add @ai-sdk/google-vertex @google-cloud/vertexai"
      dark
    />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/google-vertex" dark />
  </Tab>
</Tabs>

## Google Vertex Provider Usage

The Google Vertex provider instance is used to create model instances that call the Vertex AI API. The models available with this provider include [Google's Gemini models](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models). If you're looking to use [Anthropic's Claude models](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude), see the [Google Vertex Anthropic Provider](#google-vertex-anthropic-provider-usage) section below.

### Provider Instance

You can import the default provider instance `vertex` from `@ai-sdk/google-vertex`:

```ts
import { vertex } from '@ai-sdk/google-vertex';
```

If you need a customized setup, you can import `createVertex` from `@ai-sdk/google-vertex` and create a provider instance with your settings:

```ts
import { createVertex } from '@ai-sdk/google-vertex';

const vertex = createVertex({
  project: 'my-project', // optional
  location: 'us-central1', // optional
});
```

Google Vertex supports multiple authentication methods depending on your runtime environment and requirements.

#### Node.js Runtime

The Node.js runtime is the default runtime supported by the AI SDK. It supports all standard Google Cloud authentication options through the [`google-auth-library`](https://github.com/googleapis/google-auth-library-nodejs?tab=readme-ov-file#ways-to-authenticate). Typical use involves setting a path to a json credentials file in the `GOOGLE_APPLICATION_CREDENTIALS` environment variable. The credentials file can be obtained from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

If you want to customize the Google authentication options you can pass them as options to the `createVertex` function, for example:

```ts
import { createVertex } from '@ai-sdk/google-vertex';

const vertex = createVertex({
  googleAuthOptions: {
    credentials: {
      client_email: 'my-email',
      private_key: 'my-private-key',
    },
  },
});
```

##### Optional Provider Settings

You can use the following optional settings to customize the provider instance:

- **project** _string_

  The Google Cloud project ID that you want to use for the API calls.
  It uses the `GOOGLE_VERTEX_PROJECT` environment variable by default.

- **location** _string_

  The Google Cloud location that you want to use for the API calls, e.g. `us-central1`.
  It uses the `GOOGLE_VERTEX_LOCATION` environment variable by default.

- **googleAuthOptions** _object_

  Optional. The Authentication options used by the [Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs/). See also the [GoogleAuthOptions](https://github.com/googleapis/google-auth-library-nodejs/blob/08978822e1b7b5961f0e355df51d738e012be392/src/auth/googleauth.ts#L87C18-L87C35) interface.

  - **authClient** _object_
    An `AuthClient` to use.

  - **keyFilename** _string_
    Path to a .json, .pem, or .p12 key file.

  - **keyFile** _string_
    Path to a .json, .pem, or .p12 key file.

  - **credentials** _object_
    Object containing client_email and private_key properties, or the external account client options.

  - **clientOptions** _object_
    Options object passed to the constructor of the client.

  - **scopes** _string | string[]_
    Required scopes for the desired API request.

  - **projectId** _string_
    Your project ID.

  - **universeDomain** _string_
    The default service domain for a given Cloud universe.

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in the requests. Can be provided in multiple formats:

  - A record of header key-value pairs: `Record<string, string | undefined>`
  - A function that returns headers: `() => Record<string, string | undefined>`
  - An async function that returns headers: `async () => Record<string, string | undefined>`
  - A promise that resolves to headers: `Promise<Record<string, string | undefined>>`

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **baseURL** _string_

  Optional. Base URL for the Google Vertex API calls e.g. to use proxy servers. By default, it is constructed using the location and project:
  `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`

<a id="google-vertex-edge-runtime"></a>
#### Edge Runtime

Edge runtimes (like Vercel Edge Functions and Cloudflare Workers) are lightweight JavaScript environments that run closer to users at the network edge.
They only provide a subset of the standard Node.js APIs.
For example, direct file system access is not available, and many Node.js-specific libraries
(including the standard Google Auth library) are not compatible.

The Edge runtime version of the Google Vertex provider supports Google's [Application Default Credentials](https://github.com/googleapis/google-auth-library-nodejs?tab=readme-ov-file#application-default-credentials) through environment variables. The values can be obtained from a json credentials file from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

You can import the default provider instance `vertex` from `@ai-sdk/google-vertex/edge`:

```ts
import { vertex } from '@ai-sdk/google-vertex/edge';
```

<Note>
  The `/edge` sub-module is included in the `@ai-sdk/google-vertex` package, so
  you don't need to install it separately. You must import from
  `@ai-sdk/google-vertex/edge` to differentiate it from the Node.js provider.
</Note>

If you need a customized setup, you can import `createVertex` from `@ai-sdk/google-vertex/edge` and create a provider instance with your settings:

```ts
import { createVertex } from '@ai-sdk/google-vertex/edge';

const vertex = createVertex({
  project: 'my-project', // optional
  location: 'us-central1', // optional
});
```

For Edge runtime authentication, you'll need to set these environment variables from your Google Default Application Credentials JSON file:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_PRIVATE_KEY_ID` (optional)

These values can be obtained from a service account JSON file from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

##### Optional Provider Settings

You can use the following optional settings to customize the provider instance:

- **project** _string_

  The Google Cloud project ID that you want to use for the API calls.
  It uses the `GOOGLE_VERTEX_PROJECT` environment variable by default.

- **location** _string_

  The Google Cloud location that you want to use for the API calls, e.g. `us-central1`.
  It uses the `GOOGLE_VERTEX_LOCATION` environment variable by default.

- **googleCredentials** _object_

  Optional. The credentials used by the Edge provider for authentication. These credentials are typically set through environment variables and are derived from a service account JSON file.

  - **clientEmail** _string_
    The client email from the service account JSON file. Defaults to the contents of the `GOOGLE_CLIENT_EMAIL` environment variable.

  - **privateKey** _string_
    The private key from the service account JSON file. Defaults to the contents of the `GOOGLE_PRIVATE_KEY` environment variable.

  - **privateKeyId** _string_
    The private key ID from the service account JSON file (optional). Defaults to the contents of the `GOOGLE_PRIVATE_KEY_ID` environment variable.

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in the requests. Can be provided in multiple formats:

  - A record of header key-value pairs: `Record<string, string | undefined>`
  - A function that returns headers: `() => Record<string, string | undefined>`
  - An async function that returns headers: `async () => Record<string, string | undefined>`
  - A promise that resolves to headers: `Promise<Record<string, string | undefined>>`

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

#### Express Mode

Express mode provides a simplified authentication method using an API key instead of OAuth or service account credentials. When using express mode, the `project` and `location` settings are not required.

```ts
import { createVertex } from '@ai-sdk/google-vertex';

const vertex = createVertex({
  apiKey: process.env.GOOGLE_VERTEX_API_KEY,
});
```

##### Optional Provider Settings

- **apiKey** _string_

  The API key for Google Vertex AI. When provided, the provider uses express mode with API key authentication instead of OAuth.
  It uses the `GOOGLE_VERTEX_API_KEY` environment variable by default.

### Language Models

You can create models that call the Vertex API using the provider instance.
The first argument is the model id, e.g. `gemini-2.5-pro`.

```ts
const model = vertex('gemini-2.5-pro');
```

<Note>
  If you are using [your own
  models](https://cloud.google.com/vertex-ai/docs/training-overview), the name
  of your model needs to start with `projects/`.
</Note>

Google Vertex models support also some model specific settings that are not part
of the [standard call settings](/docs/ai-sdk-core/settings). You can pass them as
an options argument:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';

const model = vertex('gemini-2.5-pro');

await generateText({
  model,
  providerOptions: {
    vertex: {
      safetySettings: [
        {
          category: 'HARM_CATEGORY_UNSPECIFIED',
          threshold: 'BLOCK_LOW_AND_ABOVE',
        },
      ],
    } satisfies GoogleLanguageModelOptions,
  },
});
```

The following optional provider options are available for Google Vertex models:

- **cachedContent** _string_

  Optional. The name of the cached content used as context to serve the prediction.
  Format: projects/\{project\}/locations/\{location\}/cachedContents/\{cachedContent\}

- **structuredOutputs** _boolean_

  Optional. Enable structured output. Default is true.

  This is useful when the JSON Schema contains elements that are
  not supported by the OpenAPI schema version that
  Google Vertex uses. You can use this to disable
  structured outputs if you need to.

  See [Troubleshooting: Schema Limitations](#schema-limitations) for more details.

- **safetySettings** _Array\<\{ category: string; threshold: string \}\>_

  Optional. Safety settings for the model.

  - **category** _string_

    The category of the safety setting. Can be one of the following:

    - `HARM_CATEGORY_UNSPECIFIED`
    - `HARM_CATEGORY_HATE_SPEECH`
    - `HARM_CATEGORY_DANGEROUS_CONTENT`
    - `HARM_CATEGORY_HARASSMENT`
    - `HARM_CATEGORY_SEXUALLY_EXPLICIT`
    - `HARM_CATEGORY_CIVIC_INTEGRITY`

  - **threshold** _string_

    The threshold of the safety setting. Can be one of the following:

    - `HARM_BLOCK_THRESHOLD_UNSPECIFIED`
    - `BLOCK_LOW_AND_ABOVE`
    - `BLOCK_MEDIUM_AND_ABOVE`
    - `BLOCK_ONLY_HIGH`
    - `BLOCK_NONE`

- **audioTimestamp** _boolean_

  Optional. Enables timestamp understanding for audio files. Defaults to false.

  This is useful for generating transcripts with accurate timestamps.
  Consult [Google's Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/audio-understanding) for usage details.

- **labels** _object_

  Optional. Defines labels used in billing reports.

  Consult [Google's Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/add-labels-to-api-calls) for usage details.

- **streamFunctionCallArguments** _boolean_

  Optional. When set to true, function call arguments will be streamed
  incrementally in streaming responses. This enables `tool-input-delta` events
  to arrive as the model generates function call arguments, reducing perceived
  latency for tool calls. Defaults to `false`. Only supported on the Vertex AI API (not the Gemini API) with Gemini 3+ models.

  Consult [Google's Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling#streaming-fc) for details.

You can use Google Vertex language models to generate text with the `generateText` function:

```ts highlight="1,4"
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const { text } = await generateText({
  model: vertex('gemini-2.5-pro'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Google Vertex language models can also be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

#### Code Execution

With [Code Execution](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/code-execution), certain Gemini models on Vertex AI can generate and execute Python code. This allows the model to perform calculations, data manipulation, and other programmatic tasks to enhance its responses.

You can enable code execution by adding the `code_execution` tool to your request.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-pro'),
  tools: { code_execution: vertex.tools.codeExecution({}) },
  prompt:
    'Use python to calculate 20th fibonacci number. Then find the nearest palindrome to it.',
});
```

The response will contain `tool-call` and `tool-result` parts for the executed code.

#### URL Context

URL Context allows Gemini models to retrieve and analyze content from URLs. Supported models: Gemini 2.5 Flash-Lite, 2.5 Pro, 2.5 Flash, 2.0 Flash.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-pro'),
  tools: { url_context: vertex.tools.urlContext({}) },
  prompt: 'What are the key points from https://example.com/article?',
});
```

#### Google Search

Google Search enables Gemini models to access real-time web information. Supported models: Gemini 2.5 Flash-Lite, 2.5 Flash, 2.0 Flash, 2.5 Pro.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-pro'),
  tools: { google_search: vertex.tools.googleSearch({}) },
  prompt: 'What are the latest developments in AI?',
});
```

#### Enterprise Web Search

[Enterprise Web Search](https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/web-grounding-enterprise) provides grounding using a compliance-focused web index designed for highly-regulated industries such as finance, healthcare, and the public sector. Unlike standard Google Search grounding, Enterprise Web Search does not log customer data and supports VPC service controls. Supported models: Gemini 2.0 and newer.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-flash'),
  tools: {
    enterprise_web_search: vertex.tools.enterpriseWebSearch({}),
  },
  prompt: 'What are the latest FDA regulations for clinical trials?',
});
```

#### Google Maps

Google Maps grounding enables Gemini models to access Google Maps data for location-aware responses. Supported models: Gemini 2.5 Flash-Lite, 2.5 Flash, 2.0 Flash, 2.5 Pro, 3.0 Pro.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-flash'),
  tools: {
    google_maps: vertex.tools.googleMaps({}),
  },
  providerOptions: {
    vertex: {
      retrievalConfig: {
        latLng: { latitude: 34.090199, longitude: -117.881081 },
      },
    } satisfies GoogleLanguageModelOptions,
  },
  prompt: 'What are the best Italian restaurants nearby?',
});
```

The optional `retrievalConfig.latLng` provider option provides location context for queries about nearby places. This configuration applies to any grounding tools that support location context.

#### Streaming Function Call Arguments

For Gemini 3 Pro and later models on Vertex AI, you can stream function call
arguments as they are generated by setting `streamFunctionCallArguments` to
`true`. This reduces perceived latency when functions need to be called, as
`tool-input-delta` events arrive incrementally instead of waiting for the
complete arguments. This option defaults to `false`.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { streamText } from 'ai';
import { z } from 'zod';

const result = streamText({
  model: vertex('gemini-3.1-pro-preview'),
  prompt: 'What is the weather in Boston and San Francisco?',
  tools: {
    getWeather: {
      description: 'Get the current weather in a given location',
      inputSchema: z.object({
        location: z.string().describe('City name'),
      }),
    },
  },
  providerOptions: {
    vertex: {
      streamFunctionCallArguments: true,
    } satisfies GoogleLanguageModelOptions,
  },
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'tool-input-start':
      console.log(`Tool call started: ${part.toolName}`);
      break;
    case 'tool-input-delta':
      process.stdout.write(part.delta);
      break;
    case 'tool-call':
      console.log(`Tool call complete: ${part.toolName}`, part.input);
      break;
  }
}
```

<Note>
  This feature is only available on the Vertex AI API. It is not supported on
  the Gemini API. When used with the Google Generative AI provider, a warning
  will be emitted and the option will be ignored.
</Note>

#### Reasoning (Thinking Tokens)

Google Vertex AI, through its support for Gemini models, can also emit "thinking" tokens, representing the model's reasoning process. The AI SDK exposes these as reasoning information.

To enable thinking tokens for compatible Gemini models via Vertex, set `includeThoughts: true` in the `thinkingConfig` provider option. These options are passed through `providerOptions.vertex`:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText, streamText } from 'ai';

// For generateText:
const { text, reasoningText, reasoning } = await generateText({
  model: vertex('gemini-2.0-flash-001'), // Or other supported model via Vertex
  providerOptions: {
    vertex: {
      thinkingConfig: {
        includeThoughts: true,
        // thinkingBudget: 2048, // Optional
      },
    } satisfies GoogleLanguageModelOptions,
  },
  prompt: 'Explain quantum computing in simple terms.',
});

console.log('Reasoning:', reasoningText);
console.log('Reasoning Details:', reasoning);
console.log('Final Text:', text);

// For streamText:
const result = streamText({
  model: vertex('gemini-2.0-flash-001'), // Or other supported model via Vertex
  providerOptions: {
    vertex: {
      thinkingConfig: {
        includeThoughts: true,
        // thinkingBudget: 2048, // Optional
      },
    } satisfies GoogleLanguageModelOptions,
  },
  prompt: 'Explain quantum computing in simple terms.',
});

for await (const part of result.fullStream) {
  if (part.type === 'reasoning') {
    process.stdout.write(`THOUGHT: ${part.textDelta}\n`);
  } else if (part.type === 'text-delta') {
    process.stdout.write(part.textDelta);
  }
}
```

When `includeThoughts` is true, parts of the API response marked with `thought: true` will be processed as reasoning.

- In `generateText`, these contribute to the `reasoningText` (string) and `reasoning` (array) fields.
- In `streamText`, these are emitted as `reasoning` stream parts.

<Note>
  Refer to the [Google Vertex AI documentation on
  "thinking"](https://cloud.google.com/vertex-ai/generative-ai/docs/thinking)
  for model compatibility and further details.
</Note>

#### File Inputs

The Google Vertex provider supports file inputs, e.g. PDF files.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

const { text } = await generateText({
  model: vertex('gemini-2.5-pro'),
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

<Note>
  The AI SDK will automatically download URLs if you pass them as data, except
  for `gs://` URLs. You can use the Google Cloud Storage API to upload larger
  files to that location.
</Note>

See [File Parts](/docs/foundations/prompts#file-parts) for details on how to use files in prompts.

### Cached Content

Google Vertex AI supports both explicit and implicit caching to help reduce costs on repetitive content.

#### Implicit Caching

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';

// Structure prompts with consistent content at the beginning
const baseContext =
  'You are a cooking assistant with expertise in Italian cuisine. Here are 1000 lasagna recipes for reference...';

const { text: veggieLasagna } = await generateText({
  model: vertex('gemini-2.5-pro'),
  prompt: `${baseContext}\n\nWrite a vegetarian lasagna recipe for 4 people.`,
});

// Second request with same prefix - eligible for cache hit
const { text: meatLasagna, providerMetadata } = await generateText({
  model: vertex('gemini-2.5-pro'),
  prompt: `${baseContext}\n\nWrite a meat lasagna recipe for 12 people.`,
});

// Check cached token count in usage metadata
console.log('Cached tokens:', providerMetadata.vertex);
// e.g.
// {
//   groundingMetadata: null,
//   safetyRatings: null,
//   usageMetadata: {
//     cachedContentTokenCount: 2027,
//     thoughtsTokenCount: 702,
//     promptTokenCount: 2152,
//     candidatesTokenCount: 710,
//     totalTokenCount: 3564
//   }
// }
```

#### Explicit Caching

You can use explicit caching with Gemini models. See the [Vertex AI context caching documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview) to check if caching is supported for your model.

First, create a cache using the Google GenAI SDK with Vertex mode enabled:

```ts
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_VERTEX_PROJECT,
  location: process.env.GOOGLE_VERTEX_LOCATION,
});

const model = 'gemini-2.5-pro';

// Create a cache with the content you want to reuse
const cache = await ai.caches.create({
  model,
  config: {
    contents: [
      {
        role: 'user',
        parts: [{ text: '1000 Lasagna Recipes...' }],
      },
    ],
    ttl: '300s', // Cache expires after 5 minutes
  },
});

console.log('Cache created:', cache.name);
// e.g. projects/my-project/locations/us-central1/cachedContents/abc123
```

Then use the cache with the AI SDK:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text: veggieLasagnaRecipe } = await generateText({
  model: vertex('gemini-2.5-pro'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
  providerOptions: {
    vertex: {
      cachedContent: cache.name,
    } satisfies GoogleLanguageModelOptions,
  },
});

const { text: meatLasagnaRecipe } = await generateText({
  model: vertex('gemini-2.5-pro'),
  prompt: 'Write a meat lasagna recipe for 12 people.',
  providerOptions: {
    vertex: {
      cachedContent: cache.name,
    } satisfies GoogleLanguageModelOptions,
  },
});
```

### Safety Ratings

The safety ratings provide insight into the safety of the model's response.
See [Google Vertex AI documentation on configuring safety filters](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/configure-safety-filters).

Example response excerpt:

```json
{
  "safetyRatings": [
    {
      "category": "HARM_CATEGORY_HATE_SPEECH",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.11027937,
      "severity": "HARM_SEVERITY_LOW",
      "severityScore": 0.28487435
    },
    {
      "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
      "probability": "HIGH",
      "blocked": true,
      "probabilityScore": 0.95422274,
      "severity": "HARM_SEVERITY_MEDIUM",
      "severityScore": 0.43398145
    },
    {
      "category": "HARM_CATEGORY_HARASSMENT",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.11085559,
      "severity": "HARM_SEVERITY_NEGLIGIBLE",
      "severityScore": 0.19027223
    },
    {
      "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "probability": "NEGLIGIBLE",
      "probabilityScore": 0.22901751,
      "severity": "HARM_SEVERITY_NEGLIGIBLE",
      "severityScore": 0.09089675
    }
  ]
}
```

For more details, see the [Google Vertex AI documentation on grounding with Google Search](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/ground-gemini#ground-to-search).

### Troubleshooting

#### Schema Limitations

The Google Vertex API uses a subset of the OpenAPI 3.0 schema,
which does not support features such as unions.
The errors that you get in this case look like this:

`GenerateContentRequest.generation_config.response_schema.properties[occupation].type: must be specified`

By default, structured outputs are enabled (and for tool calling they are required).
You can disable structured outputs for object generation as a workaround:

```ts highlight="7,12"
import { vertex } from '@ai-sdk/google-vertex';
import { type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { generateText, Output } from 'ai';

const result = await generateText({
  model: vertex('gemini-2.5-pro'),
  providerOptions: {
    vertex: {
      structuredOutputs: false,
    } satisfies GoogleLanguageModelOptions,
  },
  output: Output.object({
    schema: z.object({
      name: z.string(),
      age: z.number(),
      contact: z.union([
        z.object({
          type: z.literal('email'),
          value: z.string(),
        }),
        z.object({
          type: z.literal('phone'),
          value: z.string(),
        }),
      ]),
    }),
  }),
  prompt: 'Generate an example person for testing.',
});
```

The following Zod features are known to not work with Google Vertex:

- `z.union`
- `z.record`

### Model Capabilities

| Model                  | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ---------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `gemini-3-pro-preview` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-pro`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.5-flash`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `gemini-2.0-flash-001` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [Google Vertex AI
  docs](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference#supported-models)
  for a full list of available models. The table above lists popular models. You
  can also pass any available provider model ID as a string if needed.
</Note>

### Embedding Models

You can create models that call the Google Vertex AI embeddings API using the `.embeddingModel()` factory method:

```ts
const model = vertex.embeddingModel('text-embedding-005');
```

Google Vertex AI embedding models support additional settings. You can pass them as an options argument:

```ts
import {
  vertex,
  type GoogleVertexEmbeddingModelOptions,
} from '@ai-sdk/google-vertex';
import { embed } from 'ai';

const model = vertex.embeddingModel('text-embedding-005');

const { embedding } = await embed({
  model,
  value: 'sunny day at the beach',
  providerOptions: {
    vertex: {
      outputDimensionality: 512, // optional, number of dimensions for the embedding
      taskType: 'SEMANTIC_SIMILARITY', // optional, specifies the task type for generating embeddings
      autoTruncate: false, // optional
    } satisfies GoogleVertexEmbeddingModelOptions,
  },
});
```

The following optional provider options are available for Google Vertex AI embedding models:

- **outputDimensionality**: _number_

  Optional reduced dimension for the output embedding. If set, excessive values in the output embedding are truncated from the end.

- **taskType**: _string_

  Optional. Specifies the task type for generating embeddings. Supported task types include:

  - `SEMANTIC_SIMILARITY`: Optimized for text similarity.
  - `CLASSIFICATION`: Optimized for text classification.
  - `CLUSTERING`: Optimized for clustering texts based on similarity.
  - `RETRIEVAL_DOCUMENT`: Optimized for document retrieval.
  - `RETRIEVAL_QUERY`: Optimized for query-based retrieval.
  - `QUESTION_ANSWERING`: Optimized for answering questions.
  - `FACT_VERIFICATION`: Optimized for verifying factual information.
  - `CODE_RETRIEVAL_QUERY`: Optimized for retrieving code blocks based on natural language queries.

- **title**: _string_

  Optional. The title of the document being embedded. This helps the model produce better embeddings by providing additional context. Only valid when `taskType` is set to `'RETRIEVAL_DOCUMENT'`.

- **autoTruncate**: _boolean_

  Optional. When set to `true`, input text will be truncated if it exceeds the maximum length. When set to `false`, an error is returned if the input text is too long. Defaults to `true`.

#### Model Capabilities

| Model                        | Max Values Per Call | Parallel Calls      | Multimodal          |
| ---------------------------- | ------------------- | ------------------- | ------------------- |
| `text-embedding-005`         | 2048                | <Check size={18} /> | <Cross size={18} /> |
| `gemini-embedding-2-preview` | 2048                | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. You can also pass any available provider
  model ID as a string if needed.
</Note>

### Image Models

You can create image models using the `.image()` factory method. The Google Vertex provider supports both [Imagen](https://cloud.google.com/vertex-ai/generative-ai/docs/image/overview) and [Gemini image models](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image). For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

#### Imagen Models

[Imagen models](https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-images) generate images using the Imagen on Vertex AI API.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: vertex.image('imagen-4.0-generate-001'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
});
```

Further configuration can be done using Google Vertex provider options. You can validate the provider options using the `GoogleVertexImageModelOptions` type.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: vertex.image('imagen-4.0-generate-001'),
  providerOptions: {
    vertex: {
      negativePrompt: 'pixelated, blurry, low-quality',
    } satisfies GoogleVertexImageModelOptions,
  },
  // ...
});
```

The following provider options are available:

- **negativePrompt** _string_
  A description of what to discourage in the generated images.

- **personGeneration** `allow_adult` | `allow_all` | `dont_allow`
  Whether to allow person generation. Defaults to `allow_adult`.

- **safetySetting** `block_low_and_above` | `block_medium_and_above` | `block_only_high` | `block_none`
  Whether to block unsafe content. Defaults to `block_medium_and_above`.

- **addWatermark** _boolean_
  Whether to add an invisible watermark to the generated images. Defaults to `true`.

- **storageUri** _string_
  Cloud Storage URI to store the generated images.

<Note>
  Imagen models do not support the `size` parameter. Use the `aspectRatio`
  parameter instead.
</Note>

Additional information about the images can be retrieved using Google Vertex meta data.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: vertex.image('imagen-4.0-generate-001'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
});

console.log(
  `Revised prompt: ${providerMetadata.vertex.images[0].revisedPrompt}`,
);
```

##### Image Editing

Google Vertex Imagen models support image editing through inpainting, outpainting, and other edit modes. Pass input images via `prompt.images` and optionally a mask via `prompt.mask`.

<Note>
  Image editing is supported by `imagen-3.0-capability-001`. The
  `imagen-4.0-generate-001` model does not currently support editing operations.
</Note>

###### Inpainting (Insert Objects)

Insert or replace objects in specific areas using a mask:

```ts
import { vertex, GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';
import fs from 'fs';

const image = fs.readFileSync('./input-image.png');
const mask = fs.readFileSync('./mask.png'); // White = edit area

const { images } = await generateImage({
  model: vertex.image('imagen-3.0-capability-001'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask,
  },
  providerOptions: {
    vertex: {
      edit: {
        baseSteps: 50,
        mode: 'EDIT_MODE_INPAINT_INSERTION',
        maskMode: 'MASK_MODE_USER_PROVIDED',
        maskDilation: 0.01,
      },
    } satisfies GoogleVertexImageModelOptions,
  },
});
```

###### Outpainting (Extend Image)

Extend an image beyond its original boundaries:

```ts
import { vertex, GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';
import fs from 'fs';

const image = fs.readFileSync('./input-image.png');
const mask = fs.readFileSync('./outpaint-mask.png'); // White = extend area

const { images } = await generateImage({
  model: vertex.image('imagen-3.0-capability-001'),
  prompt: {
    text: 'Extend the scene with more of the forest background',
    images: [image],
    mask,
  },
  providerOptions: {
    vertex: {
      edit: {
        baseSteps: 50,
        mode: 'EDIT_MODE_OUTPAINT',
        maskMode: 'MASK_MODE_USER_PROVIDED',
      },
    } satisfies GoogleVertexImageModelOptions,
  },
});
```

###### Edit Provider Options

The following options are available under `providerOptions.vertex.edit`:

- **mode** - The edit mode to use:

  - `EDIT_MODE_INPAINT_INSERTION` - Insert objects into masked areas
  - `EDIT_MODE_INPAINT_REMOVAL` - Remove objects from masked areas
  - `EDIT_MODE_OUTPAINT` - Extend image beyond boundaries
  - `EDIT_MODE_CONTROLLED_EDITING` - Controlled editing
  - `EDIT_MODE_PRODUCT_IMAGE` - Product image editing
  - `EDIT_MODE_BGSWAP` - Background swap

- **baseSteps** _number_ - Number of sampling steps (35-75). Higher values = better quality but slower.

- **maskMode** - How to interpret the mask:

  - `MASK_MODE_USER_PROVIDED` - Use the provided mask directly
  - `MASK_MODE_DEFAULT` - Default mask mode
  - `MASK_MODE_DETECTION_BOX` - Mask from detected bounding boxes
  - `MASK_MODE_CLOTHING_AREA` - Mask from clothing segmentation
  - `MASK_MODE_PARSED_PERSON` - Mask from person parsing

- **maskDilation** _number_ - Percentage (0-1) to grow the mask. Recommended: 0.01.

<Note>
  Input images must be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings. URL-based images are not supported for Google Vertex
  image editing.
</Note>

##### Imagen Model Capabilities

| Model                           | Aspect Ratios             |
| ------------------------------- | ------------------------- |
| `imagen-3.0-generate-001`       | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-3.0-generate-002`       | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-3.0-fast-generate-001`  | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-4.0-generate-001`       | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-4.0-fast-generate-001`  | 1:1, 3:4, 4:3, 9:16, 16:9 |
| `imagen-4.0-ultra-generate-001` | 1:1, 3:4, 4:3, 9:16, 16:9 |

#### Gemini Image Models

[Gemini image models](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-image) (e.g. `gemini-2.5-flash-image`) are multimodal output language models that can be used with `generateImage()` for a simpler image generation experience. Internally, the provider calls the language model API with `responseModalities: ['IMAGE']`.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: vertex.image('gemini-2.5-flash-image'),
  prompt: 'A photorealistic image of a cat wearing a wizard hat',
  aspectRatio: '1:1',
});
```

Gemini image models also support image editing by providing input images:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';
import fs from 'node:fs';

const sourceImage = fs.readFileSync('./cat.png');

const { image } = await generateImage({
  model: vertex.image('gemini-2.5-flash-image'),
  prompt: {
    text: 'Add a small wizard hat to this cat',
    images: [sourceImage],
  },
});
```

You can also use URLs (including `gs://` Cloud Storage URIs) for input images:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: vertex.image('gemini-2.5-flash-image'),
  prompt: {
    text: 'Add a small wizard hat to this cat',
    images: ['https://example.com/cat.png'],
  },
});
```

<Note>
  Gemini image models do not support the `size` or `n` parameters. Use
  `aspectRatio` instead of `size`. Mask-based inpainting is also not supported.
</Note>

<Note>
  Gemini image models are multimodal output models that can generate both text
  and images. For more advanced use cases where you need both text and image
  outputs, or want more control over the generation process, you can use them
  directly with `generateText()`.
</Note>

##### Gemini Image Model Capabilities

| Model                            | Image Generation    | Image Editing       | Aspect Ratios                                       |
| -------------------------------- | ------------------- | ------------------- | --------------------------------------------------- |
| `gemini-3.1-flash-image-preview` | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| `gemini-3-pro-image-preview`     | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| `gemini-2.5-flash-image`         | <Check size={18} /> | <Check size={18} /> | 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |

<Note>
  `gemini-3-pro-image-preview` supports additional features including up to 14
  reference images for editing (6 objects, 5 humans), resolution options (1K,
  2K, 4K via `providerOptions.vertex.imageConfig.imageSize`), and Google Search
  grounding.
</Note>

### Video Models

You can create [Veo](https://cloud.google.com/vertex-ai/generative-ai/docs/video/overview) video models that call the Vertex AI API
using the `.video()` factory method. For more on video generation with the AI SDK see [generateVideo()](/docs/reference/ai-sdk-core/generate-video).

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: vertex.video('veo-3.1-generate-001'),
  prompt:
    'A pangolin curled on a mossy stone in a glowing bioluminescent forest',
  aspectRatio: '16:9',
});
```

You can configure resolution and duration:

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: vertex.video('veo-3.1-generate-001'),
  prompt: 'A serene mountain landscape at sunset',
  aspectRatio: '16:9',
  resolution: '1920x1080',
  duration: 8,
});
```

#### Provider Options

Further configuration can be done using Google Vertex provider options. You can validate the provider options using the `GoogleVertexVideoModelOptions` type.

```ts
import { vertex } from '@ai-sdk/google-vertex';
import { GoogleVertexVideoModelOptions } from '@ai-sdk/google-vertex';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: vertex.video('veo-3.1-generate-001'),
  prompt: 'A serene mountain landscape at sunset',
  aspectRatio: '16:9',
  providerOptions: {
    vertex: {
      generateAudio: true,
      personGeneration: 'allow_adult',
    } satisfies GoogleVertexVideoModelOptions,
  },
});
```

The following provider options are available:

- **generateAudio** _boolean_

  Whether to generate audio along with the video.

- **personGeneration** `'dont_allow'` | `'allow_adult'` | `'allow_all'`

  Whether to allow person generation in the video.

- **negativePrompt** _string_

  A description of what to discourage in the generated video.

- **gcsOutputDirectory** _string_

  Cloud Storage URI to store the generated videos.

- **referenceImages** _Array\<\{ bytesBase64Encoded?: string; gcsUri?: string \}\>_

  Reference images for style or asset guidance.

- **pollIntervalMs** _number_

  Polling interval in milliseconds for checking task status.

- **pollTimeoutMs** _number_

  Maximum wait time in milliseconds for video generation.

<Note>
  Video generation is an asynchronous process that can take several minutes. For
  longer videos or higher resolutions, consider setting `pollTimeoutMs` to at
  least 10 minutes (600000ms).
</Note>

#### Model Capabilities

| Model                       | Audio Support |
| --------------------------- | ------------- |
| `veo-3.1-generate-001`      | Yes           |
| `veo-3.1-fast-generate-001` | Yes           |
| `veo-3.0-generate-001`      | Yes           |
| `veo-3.0-fast-generate-001` | Yes           |
| `veo-2.0-generate-001`      | No            |

<Note>
  The table above lists popular models. You can also pass any available provider
  model ID as a string if needed.
</Note>

## Google Vertex Anthropic Provider Usage

The Google Vertex Anthropic provider for the [AI SDK](/docs) offers support for Anthropic's Claude models through the Google Vertex AI APIs. This section provides details on how to set up and use the Google Vertex Anthropic provider.

### Provider Instance

You can import the default provider instance `vertexAnthropic` from `@ai-sdk/google-vertex/anthropic`:

```typescript
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
```

If you need a customized setup, you can import `createVertexAnthropic` from `@ai-sdk/google-vertex/anthropic` and create a provider instance with your settings:

```typescript
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';

const vertexAnthropic = createVertexAnthropic({
  project: 'my-project', // optional
  location: 'us-central1', // optional
});
```

#### Node.js Runtime

For Node.js environments, the Google Vertex Anthropic provider supports all standard Google Cloud authentication options through the `google-auth-library`. You can customize the authentication options by passing them to the `createVertexAnthropic` function:

```typescript
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';

const vertexAnthropic = createVertexAnthropic({
  googleAuthOptions: {
    credentials: {
      client_email: 'my-email',
      private_key: 'my-private-key',
    },
  },
});
```

##### Optional Provider Settings

You can use the following optional settings to customize the Google Vertex Anthropic provider instance:

- **project** _string_

  The Google Cloud project ID that you want to use for the API calls.
  It uses the `GOOGLE_VERTEX_PROJECT` environment variable by default.

- **location** _string_

  The Google Cloud location that you want to use for the API calls, e.g. `us-central1`.
  It uses the `GOOGLE_VERTEX_LOCATION` environment variable by default.

- **googleAuthOptions** _object_

  Optional. The Authentication options used by the [Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs/). See also the [GoogleAuthOptions](https://github.com/googleapis/google-auth-library-nodejs/blob/08978822e1b7b5961f0e355df51d738e012be392/src/auth/googleauth.ts#L87C18-L87C35) interface.

  - **authClient** _object_
    An `AuthClient` to use.

  - **keyFilename** _string_
    Path to a .json, .pem, or .p12 key file.

  - **keyFile** _string_
    Path to a .json, .pem, or .p12 key file.

  - **credentials** _object_
    Object containing client_email and private_key properties, or the external account client options.

  - **clientOptions** _object_
    Options object passed to the constructor of the client.

  - **scopes** _string | string[]_
    Required scopes for the desired API request.

  - **projectId** _string_
    Your project ID.

  - **universeDomain** _string_
    The default service domain for a given Cloud universe.

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in the requests. Can be provided in multiple formats:

  - A record of header key-value pairs: `Record<string, string | undefined>`
  - A function that returns headers: `() => Record<string, string | undefined>`
  - An async function that returns headers: `async () => Record<string, string | undefined>`
  - A promise that resolves to headers: `Promise<Record<string, string | undefined>>`

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

<a id="google-vertex-anthropic-edge-runtime"></a>
#### Edge Runtime

Edge runtimes (like Vercel Edge Functions and Cloudflare Workers) are lightweight JavaScript environments that run closer to users at the network edge.
They only provide a subset of the standard Node.js APIs.
For example, direct file system access is not available, and many Node.js-specific libraries
(including the standard Google Auth library) are not compatible.

The Edge runtime version of the Google Vertex Anthropic provider supports Google's [Application Default Credentials](https://github.com/googleapis/google-auth-library-nodejs?tab=readme-ov-file#application-default-credentials) through environment variables. The values can be obtained from a json credentials file from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

For Edge runtimes, you can import the provider instance from `@ai-sdk/google-vertex/anthropic/edge`:

```typescript
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic/edge';
```

To customize the setup, use `createVertexAnthropic` from the same module:

```typescript
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic/edge';

const vertexAnthropic = createVertexAnthropic({
  project: 'my-project', // optional
  location: 'us-central1', // optional
});
```

For Edge runtime authentication, set these environment variables from your Google Default Application Credentials JSON file:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_PRIVATE_KEY_ID` (optional)

##### Optional Provider Settings

You can use the following optional settings to customize the provider instance:

- **project** _string_

  The Google Cloud project ID that you want to use for the API calls.
  It uses the `GOOGLE_VERTEX_PROJECT` environment variable by default.

- **location** _string_

  The Google Cloud location that you want to use for the API calls, e.g. `us-central1`.
  It uses the `GOOGLE_VERTEX_LOCATION` environment variable by default.

- **googleCredentials** _object_

  Optional. The credentials used by the Edge provider for authentication. These credentials are typically set through environment variables and are derived from a service account JSON file.

  - **clientEmail** _string_
    The client email from the service account JSON file. Defaults to the contents of the `GOOGLE_CLIENT_EMAIL` environment variable.

  - **privateKey** _string_
    The private key from the service account JSON file. Defaults to the contents of the `GOOGLE_PRIVATE_KEY` environment variable.

  - **privateKeyId** _string_
    The private key ID from the service account JSON file (optional). Defaults to the contents of the `GOOGLE_PRIVATE_KEY_ID` environment variable.

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in the requests. Can be provided in multiple formats:

  - A record of header key-value pairs: `Record<string, string | undefined>`
  - A function that returns headers: `() => Record<string, string | undefined>`
  - An async function that returns headers: `async () => Record<string, string | undefined>`
  - A promise that resolves to headers: `Promise<Record<string, string | undefined>>`

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

### Language Models

You can create models that call the [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages_post) using the provider instance.
The first argument is the model id, e.g. `claude-3-haiku-20240307`.
Some models have multi-modal capabilities.

```ts
const model = anthropic('claude-3-haiku-20240307');
```

You can use Anthropic language models to generate text with the `generateText` function:

```ts
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: vertexAnthropic('claude-3-haiku-20240307'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Anthropic language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

<Note>
  The Anthropic API returns streaming tool calls all at once after a delay. This
  causes structured output generation to complete fully after a delay instead of
  streaming incrementally.
</Note>

The following optional provider options are available for Anthropic models:

- `sendReasoning` _boolean_

  Optional. Include reasoning content in requests sent to the model. Defaults to `true`.

  If you are experiencing issues with the model handling requests involving
  reasoning content, you can set this to `false` to omit them from the request.

- `thinking` _object_

  Optional. See [Reasoning section](#reasoning) for more details.

- `metadata` _object_

  Optional. Metadata to include with the request. See the [Anthropic API documentation](https://platform.claude.com/docs/en/api/messages/create) for details.

  - `userId` _string_ - An external identifier for the end-user.

### Reasoning

Anthropic has reasoning support for the `claude-3-7-sonnet@20250219` model.

You can enable it using the `thinking` provider option
and specifying a thinking budget in tokens.

```ts
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: vertexAnthropic('claude-3-7-sonnet@20250219'),
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

#### Cache Control

<Note>
  Anthropic cache control is in a Pre-Generally Available (GA) state on Google
  Vertex. For more see [Google Vertex Anthropic cache control
  documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude-prompt-caching).
</Note>

In the messages and message parts, you can use the `providerOptions` property to set cache control breakpoints.
You need to set the `anthropic` property in the `providerOptions` object to `{ cacheControl: { type: 'ephemeral' } }` to set a cache control breakpoint.

The cache creation input tokens are then returned in the `providerMetadata` object
for `generateText`, again under the `anthropic` property.
When you use `streamText`, the response contains a promise
that resolves to the metadata. Alternatively you can receive it in the
`onFinish` callback.

```ts highlight="8,18-20,29-30"
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { generateText } from 'ai';

const errorMessage = '... long error message ...';

const result = await generateText({
  model: vertexAnthropic('claude-3-5-sonnet-20240620'),
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
// e.g. { cacheCreationInputTokens: 2118, cacheReadInputTokens: 0 }
```

You can also use cache control on system messages by providing multiple system messages at the head of your messages array:

```ts highlight="3,9-11"
const result = await generateText({
  model: vertexAnthropic('claude-3-5-sonnet-20240620'),
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

For more on prompt caching with Anthropic, see [Google Vertex AI's Claude prompt caching documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude-prompt-caching) and [Anthropic's Cache Control documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).

### Tools

Google Vertex Anthropic supports a subset of Anthropic's built-in tools. The following tools are available via the `tools` property of the provider instance:

1. **Bash Tool**: Allows running bash commands.
2. **Text Editor Tool**: Provides functionality for viewing and editing text files.
3. **Computer Tool**: Enables control of keyboard and mouse actions on a computer.
4. **Web Search Tool**: Provides access to real-time web content.

<Note>
  Only a subset of Anthropic tools are supported on Google Vertex. Tools like
  Code Execution, Memory, and Web Fetch are not available. Use the regular
  `@ai-sdk/anthropic` provider if you need access to all Anthropic tools.
</Note>

<Note>
  Google Vertex Anthropic does not support strict mode on tool definitions.
  Setting `strict: true` on a tool will be ignored and a warning will be
  emitted.
</Note>

For more background on Anthropic tools, see [Anthropic's documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

#### Bash Tool

The Bash Tool allows running bash commands. Here's how to create and use it:

```ts
const bashTool = vertexAnthropic.tools.bash_20250124({
  execute: async ({ command, restart }) => {
    // Implement your bash command execution logic here
    // Return the result of the command execution
  },
});
```

Parameters:

- `command` (string): The bash command to run. Required unless the tool is being restarted.
- `restart` (boolean, optional): Specifying true will restart this tool.

#### Text Editor Tool

The Text Editor Tool provides functionality for viewing and editing text files:

```ts
const textEditorTool = vertexAnthropic.tools.textEditor_20250124({
  execute: async ({
    command,
    path,
    file_text,
    insert_line,
    new_str,
    insert_text,
    old_str,
    view_range,
  }) => {
    // Implement your text editing logic here
    // Return the result of the text editing operation
  },
});
```

Parameters:

- `command` ('view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'): The command to run. Note: `undo_edit` is not supported in `textEditor_20250429` and `textEditor_20250728`.
- `path` (string): Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.
- `file_text` (string, optional): Required for `create` command, with the content of the file to be created.
- `insert_line` (number, optional): Required for `insert` command. The line number after which to insert the new string.
- `new_str` (string, optional): New string for `str_replace` command.
- `insert_text` (string, optional): Required for `insert` command, containing the text to insert.
- `old_str` (string, optional): Required for `str_replace` command, containing the string to replace.
- `view_range` (number[], optional): Optional for `view` command to specify line range to show.
- `max_characters` (number, optional): Optional maximum number of characters to view in the file (only available in `textEditor_20250728`).

#### Computer Tool

The Computer Tool enables control of keyboard and mouse actions on a computer:

```ts
const computerTool = vertexAnthropic.tools.computer_20241022({
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
  toModelOutput({ output }) {
    return typeof output === 'string'
      ? [{ type: 'text', text: output }]
      : [{ type: 'image', data: output.data, mediaType: 'image/png' }];
  },
});
```

Parameters:

- `action` ('key' | 'type' | 'mouse_move' | 'left_click' | 'left_click_drag' | 'right_click' | 'middle_click' | 'double_click' | 'screenshot' | 'cursor_position'): The action to perform.
- `coordinate` (number[], optional): Required for `mouse_move` and `left_click_drag` actions. Specifies the (x, y) coordinates.
- `text` (string, optional): Required for `type` and `key` actions.

#### Web Search Tool

The Web Search Tool provides Claude with direct access to real-time web content:

```ts
const webSearchTool = vertexAnthropic.tools.webSearch_20250305({
  maxUses: 5, // Optional: Maximum number of web searches Claude can perform
  allowedDomains: ['example.com'], // Optional: Only search these domains
  blockedDomains: ['spam.com'], // Optional: Never search these domains
  userLocation: {
    // Optional: Provide location for geographically relevant results
    type: 'approximate',
    city: 'San Francisco',
    region: 'CA',
    country: 'US',
    timezone: 'America/Los_Angeles',
  },
});
```

Parameters:

- `maxUses` (number, optional): Maximum number of web searches Claude can perform during the conversation.
- `allowedDomains` (string[], optional): Optional list of domains that Claude is allowed to search.
- `blockedDomains` (string[], optional): Optional list of domains that Claude should avoid when searching.
- `userLocation` (object, optional): Optional user location information to provide geographically relevant search results.
  - `type` ('approximate'): The type of location (must be approximate).
  - `city` (string, optional): The city name.
  - `region` (string, optional): The region or state.
  - `country` (string, optional): The country.
  - `timezone` (string, optional): The IANA timezone ID.

These tools can be used in conjunction with supported Claude models to enable more complex interactions and tasks.

### Model Capabilities

The latest Anthropic model list on Vertex AI is available [here](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#model-list).
See also [Anthropic Model Comparison](https://docs.anthropic.com/en/docs/about-claude/models#model-comparison).

| Model                           | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      | Computer Use        |
| ------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `claude-3-7-sonnet@20250219`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-3-5-sonnet-v2@20241022` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-3-5-sonnet@20240620`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `claude-3-5-haiku@20241022`     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `claude-3-sonnet@20240229`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `claude-3-haiku@20240307`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `claude-3-opus@20240229`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. You can also pass any available provider
  model ID as a string if needed.
</Note>

## Google Vertex MaaS Provider Usage

The Google Vertex MaaS (Model as a Service) provider offers access to partner and open models hosted on Vertex AI through an OpenAI-compatible Chat Completions API. This includes models from DeepSeek, Qwen, Meta, MiniMax, Moonshot, and OpenAI.

For more information, see the [Vertex AI MaaS documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/maas/use-open-models).

### Provider Instance

You can import the default provider instance `vertexMaas` from `@ai-sdk/google-vertex/maas`:

```typescript
import { vertexMaas } from '@ai-sdk/google-vertex/maas';
```

If you need a customized setup, you can import `createVertexMaas` from `@ai-sdk/google-vertex/maas` and create a provider instance with your settings:

```typescript
import { createVertexMaas } from '@ai-sdk/google-vertex/maas';

const vertexMaas = createVertexMaas({
  project: 'my-project', // optional
  location: 'us-east5', // optional, defaults to 'global'
});
```

#### Node.js Runtime

For Node.js environments, the Google Vertex MaaS provider supports all standard Google Cloud authentication options through the `google-auth-library`:

```typescript
import { createVertexMaas } from '@ai-sdk/google-vertex/maas';

const vertexMaas = createVertexMaas({
  googleAuthOptions: {
    credentials: {
      client_email: 'my-email',
      private_key: 'my-private-key',
    },
  },
});
```

##### Optional Provider Settings

- **project** _string_

  The Google Cloud project ID. Defaults to the `GOOGLE_VERTEX_PROJECT` environment variable.

- **location** _string_

  The Google Cloud location, e.g. `us-east5` or `global`. Defaults to the `GOOGLE_VERTEX_LOCATION` environment variable. If not set, defaults to `global`.

- **googleAuthOptions** _object_

  Optional. The Authentication options used by the [Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs/).

- **headers** _Resolvable&lt;Record&lt;string, string | undefined&gt;&gt;_

  Headers to include in requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

<a id="google-vertex-maas-edge-runtime"></a>

#### Edge Runtime

For Edge runtimes, import from `@ai-sdk/google-vertex/maas/edge`:

```typescript
import { vertexMaas } from '@ai-sdk/google-vertex/maas/edge';
```

```typescript
import { createVertexMaas } from '@ai-sdk/google-vertex/maas/edge';

const vertexMaas = createVertexMaas({
  project: 'my-project',
  location: 'us-east5',
});
```

For Edge runtime authentication, set these environment variables:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_PRIVATE_KEY_ID` (optional)

### Language Models

You can create models using the provider instance. The first argument is the model ID:

```ts
import { vertexMaas } from '@ai-sdk/google-vertex/maas';
import { generateText } from 'ai';

const { text } = await generateText({
  model: vertexMaas('deepseek-ai/deepseek-v3.2-maas'),
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

Streaming is also supported:

```ts
import { vertexMaas } from '@ai-sdk/google-vertex/maas';
import { streamText } from 'ai';

const result = streamText({
  model: vertexMaas('deepseek-ai/deepseek-v3.2-maas'),
  prompt: 'Invent a new holiday and describe its traditions.',
});

for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}
```

### Available Models

The following models are available through the MaaS provider. You can also pass any valid model ID as a string.

| Model ID                                       | Provider |
| ---------------------------------------------- | -------- |
| `deepseek-ai/deepseek-r1-0528-maas`           | DeepSeek |
| `deepseek-ai/deepseek-v3.1-maas`              | DeepSeek |
| `deepseek-ai/deepseek-v3.2-maas`              | DeepSeek |
| `openai/gpt-oss-120b-maas`                    | OpenAI   |
| `openai/gpt-oss-20b-maas`                     | OpenAI   |
| `meta/llama-4-maverick-17b-128e-instruct-maas` | Meta     |
| `meta/llama-4-scout-17b-16e-instruct-maas`    | Meta     |
| `minimax/minimax-m2-maas`                      | MiniMax  |
| `qwen/qwen3-coder-480b-a35b-instruct-maas`    | Qwen     |
| `qwen/qwen3-next-80b-a3b-instruct-maas`       | Qwen     |
| `qwen/qwen3-next-80b-a3b-thinking-maas`       | Qwen     |
| `moonshotai/kimi-k2-thinking-maas`             | Moonshot |

<Note>
  Model availability depends on your Google Cloud project and region. Check the
  [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
  for the latest available models.
</Note>

---
title: Rev.ai
description: Learn how to use the Rev.ai provider for the AI SDK.
---

# Rev.ai Provider

The [Rev.ai](https://www.rev.ai/) provider contains language model support for the Rev.ai transcription API.

## Setup

The Rev.ai provider is available in the `@ai-sdk/revai` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/revai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/revai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/revai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/revai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `revai` from `@ai-sdk/revai`:

```ts
import { revai } from '@ai-sdk/revai';
```

If you need a customized setup, you can import `createRevai` from `@ai-sdk/revai` and create a provider instance with your settings:

```ts
import { createRevai } from '@ai-sdk/revai';

const revai = createRevai({
  // custom settings, e.g.
  fetch: customFetch,
});
```

You can use the following optional settings to customize the Rev.ai provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `REVAI_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Transcription Models

You can create models that call the [Rev.ai transcription API](https://www.rev.ai/docs/api/transcription)
using the `.transcription()` factory method.

The first argument is the model id e.g. `machine`.

```ts
const model = revai.transcription('machine');
```

You can also pass additional provider-specific options using the `providerOptions` argument. For example, supplying the input language in ISO-639-1 (e.g. `en`) format can sometimes improve transcription performance if known beforehand.

```ts highlight="7"
import { experimental_transcribe as transcribe } from 'ai';
import { revai } from '@ai-sdk/revai';
import { type RevaiTranscriptionModelOptions } from '@ai-sdk/revai';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: revai.transcription('machine'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    revai: { language: 'en' } satisfies RevaiTranscriptionModelOptions,
  },
});
```

The following provider options are available:

- **metadata** _string_

  Optional metadata string to associate with the transcription job.

- **notification_config** _object_

  Configuration for webhook notifications when job is complete.

  - **url** _string_ - URL to send the notification to.
  - **auth_headers** _object_ - Optional authorization headers for the notification request.
    - **Authorization** _string_ - Authorization header value.

- **delete_after_seconds** _integer_

  Number of seconds after which the job will be automatically deleted.

- **verbatim** _boolean_

  Whether to include filler words and false starts in the transcription.

- **rush** _boolean_

  [HIPAA Unsupported] Whether to prioritize the job for faster processing. Only available for human transcriber option.

- **test_mode** _boolean_

  Whether to run the job in test mode. Default is `false`.

- **segments_to_transcribe** _Array_

  Specific segments of the audio to transcribe.

  - **start** _number_ - Start time of the segment in seconds.
  - **end** _number_ - End time of the segment in seconds.

- **speaker_names** _Array_

  Names to assign to speakers in the transcription.

  - **display_name** _string_ - Display name for the speaker.

- **skip_diarization** _boolean_

  Whether to skip speaker diarization. Default is `false`.

- **skip_postprocessing** _boolean_

  Whether to skip post-processing steps. Only available for English and Spanish languages. Default is `false`.

- **skip_punctuation** _boolean_

  Whether to skip adding punctuation to the transcription. Default is `false`.

- **remove_disfluencies** _boolean_

  Whether to remove disfluencies (um, uh, etc.) from the transcription. Default is `false`.

- **remove_atmospherics** _boolean_

  Whether to remove atmospheric sounds (like `<laugh>`, `<affirmative>`) from the transcription. Default is `false`.

- **filter_profanity** _boolean_

  Whether to filter profanity from the transcription by replacing characters with asterisks except for the first and last. Default is `false`.

- **speaker_channels_count** _integer_

  Number of speaker channels in the audio. Only available for English, Spanish and French languages.

- **speakers_count** _integer_

  Expected number of speakers in the audio. Only available for English, Spanish and French languages.

- **diarization_type** _string_

  Type of diarization to use. Possible values: "standard" (default), "premium".

- **custom_vocabulary_id** _string_

  ID of a custom vocabulary to use for the transcription, submitted through the Custom Vocabularies API.

- **custom_vocabularies** _Array_

  Custom vocabularies to use for the transcription.

- **strict_custom_vocabulary** _boolean_

  Whether to strictly enforce custom vocabulary.

- **summarization_config** _object_

  Configuration for generating a summary of the transcription.

  - **model** _string_ - Model to use for summarization. Possible values: "standard" (default), "premium".
  - **type** _string_ - Format of the summary. Possible values: "paragraph" (default), "bullets".
  - **prompt** _string_ - Custom prompt for the summarization (mutually exclusive with type).

- **translation_config** _object_

  Configuration for translating the transcription.

  - **target_languages** _Array_ - Target languages for translation. Each item is an object with:
    - **language** _string_ - Language code. Possible values: "en", "en-us", "en-gb", "ar", "pt", "pt-br", "pt-pt", "fr", "fr-ca", "es", "es-es", "es-la", "it", "ja", "ko", "de", "ru".
  - **model** _string_ - Model to use for translation. Possible values: "standard" (default), "premium".

- **language** _string_

  Language of the audio content, provided as an ISO 639-1 language code. Default is "en".

- **forced_alignment** _boolean_

  Whether to perform forced alignment, which provides improved accuracy for per-word timestamps.
  Default is `false`.

  Currently supported languages:

  - English (en, en-us, en-gb)
  - French (fr)
  - Italian (it)
  - German (de)
  - Spanish (es)

  Note: This option is not available in low-cost environments.

### Model Capabilities

| Model      | Transcription       | Duration            | Segments            | Language            |
| ---------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `machine`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `low_cost` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `fusion`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

---
title: Baseten
description: Learn how to use Baseten models with the AI SDK.
---

# Baseten Provider

[Baseten](https://baseten.co/) is an inference platform for serving frontier, enterprise-grade opensource AI models via their [API](https://docs.baseten.co/overview).

## Setup

The Baseten provider is available via the `@ai-sdk/baseten` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/baseten" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/baseten" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/baseten" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `baseten` from `@ai-sdk/baseten`:

```ts
import { baseten } from '@ai-sdk/baseten';
```

If you need a customized setup, you can import `createBaseten` from `@ai-sdk/baseten`
and create a provider instance with your settings:

```ts
import { createBaseten } from '@ai-sdk/baseten';

const baseten = createBaseten({
  apiKey: process.env.BASETEN_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Baseten provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://inference.baseten.co/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `BASETEN_API_KEY` environment variable. It is recommended you set the environment variable using `export` so you do not need to include the field every time.
  You can grab your Baseten API Key [here](https://app.baseten.co/settings/api_keys)

- **modelURL** _string_

  Custom model URL for specific models (chat or embeddings). If not provided,
  the default Model APIs will be used.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Model APIs

You can select [Baseten models](https://www.baseten.co/products/model-apis/) using a provider instance.
The first argument is the model id, e.g. `'moonshotai/Kimi-K2-Instruct-0905'`: The complete supported models under Model APIs can be found [here](https://docs.baseten.co/development/model-apis/overview#supported-models).

```ts
const model = baseten('moonshotai/Kimi-K2-Instruct-0905');
```

### Example

You can use Baseten language models to generate text with the `generateText` function:

```ts
import { baseten } from '@ai-sdk/baseten';
import { generateText } from 'ai';

const { text } = await generateText({
  model: baseten('moonshotai/Kimi-K2-Instruct-0905'),
  prompt: 'What is the meaning of life? Answer in one sentence.',
});
```

Baseten language models can also be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

## Dedicated Models

Baseten supports dedicated model URLs for both chat and embedding models. You have to specify a `modelURL` when creating the provider:

### OpenAI-Compatible Endpoints (`/sync/v1`)

For models deployed with Baseten's OpenAI-compatible endpoints:

```ts
import { createBaseten } from '@ai-sdk/baseten';

const baseten = createBaseten({
  modelURL: 'https://model-{MODEL_ID}.api.baseten.co/sync/v1',
});
// No modelId is needed because we specified modelURL
const model = baseten();
const { text } = await generateText({
  model: model,
  prompt: 'Say hello from a Baseten chat model!',
});
```

### `/predict` Endpoints

`/predict` endpoints are currently NOT supported for chat models. You must use `/sync/v1` endpoints for chat functionality.

## Embedding Models

You can create models that call the Baseten embeddings API using the `.embeddingModel()` factory method. The Baseten provider uses the high-performance `@basetenlabs/performance-client` for optimal embedding performance.

<Note>
  **Important:** Embedding models require a dedicated deployment with a custom
  `modelURL`. Unlike chat models, embeddings cannot use Baseten's default Model
  APIs and must specify a dedicated model endpoint.
</Note>

```ts
import { createBaseten } from '@ai-sdk/baseten';
import { embed, embedMany } from 'ai';

const baseten = createBaseten({
  modelURL: 'https://model-{MODEL_ID}.api.baseten.co/sync',
});

const embeddingModel = baseten.embeddingModel();

// Single embedding
const { embedding } = await embed({
  model: embeddingModel,
  value: 'sunny day at the beach',
});

// Batch embeddings
const { embeddings } = await embedMany({
  model: embeddingModel,
  values: [
    'sunny day at the beach',
    'rainy afternoon in the city',
    'snowy mountain peak',
  ],
});
```

### Endpoint Support for Embeddings

**Supported:**

- `/sync` endpoints (Performance Client automatically adds `/v1/embeddings`)
- `/sync/v1` endpoints (automatically strips `/v1` before passing to Performance Client)

**Not Supported:**

- `/predict` endpoints (not compatible with Performance Client)

### Performance Features

The embedding implementation includes:

- **High-performance client**: Uses `@basetenlabs/performance-client` for optimal performance
- **Automatic batching**: Efficiently handles multiple texts in a single request
- **Connection reuse**: Performance Client is created once and reused for all requests
- **Built-in retries**: Automatic retry logic for failed requests

## Error Handling

The Baseten provider includes built-in error handling for common API errors:

```ts
import { baseten } from '@ai-sdk/baseten';
import { generateText } from 'ai';

try {
  const { text } = await generateText({
    model: baseten('moonshotai/Kimi-K2-Instruct-0905'),
    prompt: 'Hello, world!',
  });
} catch (error) {
  console.error('Baseten API error:', error.message);
}
```

### Common Error Scenarios

```ts
// Embeddings require a modelURL
try {
  baseten.embeddingModel();
} catch (error) {
  // Error: "No model URL provided for embeddings. Please set modelURL option for embeddings."
}

// /predict endpoints are not supported for chat models
try {
  const baseten = createBaseten({
    modelURL:
      'https://model-{MODEL_ID}.api.baseten.co/environments/production/predict',
  });
  baseten(); // This will throw an error
} catch (error) {
  // Error: "Not supported. You must use a /sync/v1 endpoint for chat models."
}

// /sync/v1 endpoints are now supported for embeddings
const baseten = createBaseten({
  modelURL:
    'https://model-{MODEL_ID}.api.baseten.co/environments/production/sync/v1',
});
const embeddingModel = baseten.embeddingModel(); // This works fine!

// /predict endpoints are not supported for embeddings
try {
  const baseten = createBaseten({
    modelURL:
      'https://model-{MODEL_ID}.api.baseten.co/environments/production/predict',
  });
  baseten.embeddingModel(); // This will throw an error
} catch (error) {
  // Error: "Not supported. You must use a /sync or /sync/v1 endpoint for embeddings."
}

// Image models are not supported
try {
  baseten.imageModel('test-model');
} catch (error) {
  // Error: NoSuchModelError for imageModel
}
```

<Note>
  For more information about Baseten models and deployment options, see the
  [Baseten documentation](https://docs.baseten.co/).
</Note>

---
title: Hugging Face
description: Learn how to use Hugging Face Provider.
---

# Hugging Face Provider

The [Hugging Face](https://huggingface.co/) provider offers access to thousands of language models through [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index), including models from Meta, DeepSeek, Qwen, and more.

API keys can be obtained from [Hugging Face Settings](https://huggingface.co/settings/tokens).

## Setup

The Hugging Face provider is available via the `@ai-sdk/huggingface` module. You can install it with:

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/huggingface" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/huggingface" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/huggingface" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/huggingface" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `huggingface` from `@ai-sdk/huggingface`:

```ts
import { huggingface } from '@ai-sdk/huggingface';
```

For custom configuration, you can import `createHuggingFace` and create a provider instance with your settings:

```ts
import { createHuggingFace } from '@ai-sdk/huggingface';

const huggingface = createHuggingFace({
  apiKey: process.env.HUGGINGFACE_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Hugging Face provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://router.huggingface.co/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `HUGGINGFACE_API_KEY` environment variable. You can get your API key
  from [Hugging Face Settings](https://huggingface.co/settings/tokens).

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Language Models

You can create language models using a provider instance:

```ts
import { huggingface } from '@ai-sdk/huggingface';
import { generateText } from 'ai';

const { text } = await generateText({
  model: huggingface('deepseek-ai/DeepSeek-V3-0324'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can also use the `.responses()` or `.languageModel()` factory methods:

```ts
const model = huggingface.responses('deepseek-ai/DeepSeek-V3-0324');
// or
const model = huggingface.languageModel('moonshotai/Kimi-K2-Instruct');
```

Hugging Face language models can be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

You can explore the latest and trending models with their capabilities, context size, throughput and pricing on the [Hugging Face Inference Models](https://huggingface.co/inference/models) page.

### Provider Options

Hugging Face language models support provider-specific options that you can pass via `providerOptions.huggingface`:

```ts
import { huggingface } from '@ai-sdk/huggingface';
import { generateText } from 'ai';

const { text } = await generateText({
  model: huggingface('deepseek-ai/DeepSeek-R1'),
  prompt: 'Explain the theory of relativity.',
  providerOptions: {
    huggingface: {
      reasoningEffort: 'high',
      instructions: 'Respond in a clear and educational manner.',
    },
  },
});
```

The following provider options are available:

- **metadata** _Record&lt;string, string&gt;_

  Additional metadata to include with the request.

- **instructions** _string_

  Instructions for the model. Can be used to provide additional context or guidance.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation for structured outputs. Defaults to `false`.

- **reasoningEffort** _string_

  Controls the reasoning effort for reasoning models like DeepSeek-R1. Higher values result in more thorough reasoning.

### Reasoning Output

For reasoning models like `deepseek-ai/DeepSeek-R1`, you can control the reasoning effort and access the model's reasoning process in the response:

```ts
import { huggingface } from '@ai-sdk/huggingface';
import { streamText } from 'ai';

const result = streamText({
  model: huggingface('deepseek-ai/DeepSeek-R1'),
  prompt: 'How many r letters are in the word strawberry?',
  providerOptions: {
    huggingface: {
      reasoningEffort: 'high',
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

For non-streaming calls with `generateText`, the reasoning content is available in the `reasoning` field of the response:

```ts
import { huggingface } from '@ai-sdk/huggingface';
import { generateText } from 'ai';

const result = await generateText({
  model: huggingface('deepseek-ai/DeepSeek-R1'),
  prompt: 'What is 25 * 37?',
  providerOptions: {
    huggingface: {
      reasoningEffort: 'medium',
    },
  },
});

console.log('Reasoning:', result.reasoning);
console.log('Answer:', result.text);
```

### Image Input

For vision-capable models like `Qwen/Qwen2.5-VL-7B-Instruct`, you can pass images as part of the message content:

```ts
import { huggingface } from '@ai-sdk/huggingface';
import { generateText } from 'ai';
import { readFileSync } from 'fs';

const result = await generateText({
  model: huggingface('Qwen/Qwen2.5-VL-7B-Instruct'),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in detail.' },
        {
          type: 'image',
          image: readFileSync('./image.png'),
        },
      ],
    },
  ],
});
```

You can also pass image URLs:

```ts
{
  type: 'image',
  image: 'https://example.com/image.png',
}
```

## Model Capabilities

| Model                                           | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `meta-llama/Llama-3.1-8B-Instruct`              | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-3.1-70B-Instruct`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-3.3-70B-Instruct`             | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-V3.1`                     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-V3-0324`                  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-R1`                       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-R1-Distill-Llama-70B`     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `Qwen/Qwen3-32B`                                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `Qwen/Qwen2.5-VL-7B-Instruct`                   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `google/gemma-3-27b-it`                         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `moonshotai/Kimi-K2-Instruct`                   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. You can explore all available models on
  the [Hugging Face Inference Models](https://huggingface.co/inference/models)
  page. The capabilities depend on the specific model you're using. Check the
  model documentation on Hugging Face Hub for detailed information about each
  model's features.
</Note>

---
title: Mistral AI
description: Learn how to use Mistral.
---

# Mistral AI Provider

The [Mistral AI](https://mistral.ai/) provider contains language model support for the Mistral chat API.

## Setup

The Mistral provider is available in the `@ai-sdk/mistral` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/mistral" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/mistral" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/mistral" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/mistral" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `mistral` from `@ai-sdk/mistral`:

```ts
import { mistral } from '@ai-sdk/mistral';
```

If you need a customized setup, you can import `createMistral` from `@ai-sdk/mistral`
and create a provider instance with your settings:

```ts
import { createMistral } from '@ai-sdk/mistral';

const mistral = createMistral({
  // custom settings
});
```

You can use the following optional settings to customize the Mistral provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.mistral.ai/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `MISTRAL_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create models that call the [Mistral chat API](https://docs.mistral.ai/api/#operation/createChatCompletion) using a provider instance.
The first argument is the model id, e.g. `mistral-large-latest`.
Some Mistral chat models support tool calls.

```ts
const model = mistral('mistral-large-latest');
```

Mistral chat models also support additional model settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument and utilize `MistralLanguageModelOptions` for typing:

```ts
import { mistral, type MistralLanguageModelOptions } from '@ai-sdk/mistral';
const model = mistral('mistral-large-latest');

await generateText({
  model,
  providerOptions: {
    mistral: {
      safePrompt: true, // optional safety prompt injection
      parallelToolCalls: false, // disable parallel tool calls (one tool per response)
    } satisfies MistralLanguageModelOptions,
  },
});
```

The following optional provider options are available for Mistral models:

- **safePrompt** _boolean_

  Whether to inject a safety prompt before all conversations.

  Defaults to `false`.

- **documentImageLimit** _number_

  Maximum number of images to process in a document.

- **documentPageLimit** _number_

  Maximum number of pages to process in a document.

- **strictJsonSchema** _boolean_

  Whether to use strict JSON schema validation for structured outputs. Only applies when a schema is provided and only sets the [`strict` flag](https://docs.mistral.ai/api/#tag/chat/operation/chat_completion_v1_chat_completions_post) in addition to using [Custom Structured Outputs](https://docs.mistral.ai/capabilities/structured-output/custom_structured_output/), which is used by default if a schema is provided.

  Defaults to `false`.

- **structuredOutputs** _boolean_

  Whether to use [structured outputs](#structured-outputs). When enabled, tool calls and object generation will be strict and follow the provided schema.

  Defaults to `true`.

- **parallelToolCalls** _boolean_

  Whether to enable parallel function calling during tool use. When set to false, the model will use at most one tool per response.

  Defaults to `true`.

### Document OCR

Mistral chat models support document OCR for PDF files.
You can optionally set image and page limits using the provider options.

```ts
import { mistral, type MistralLanguageModelOptions } from '@ai-sdk/mistral';
import { generateText } from 'ai';

const result = await generateText({
  model: mistral('mistral-small-latest'),
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
            'https://github.com/vercel/ai/blob/main/examples/ai-functions/data/ai.pdf?raw=true',
          ),
          mediaType: 'application/pdf',
        },
      ],
    },
  ],
  // optional settings:
  providerOptions: {
    mistral: {
      documentImageLimit: 8,
      documentPageLimit: 64,
    } satisfies MistralLanguageModelOptions,
  },
});
```

### Reasoning Models

Mistral offers reasoning models that provide step-by-step thinking capabilities:

- **magistral-small-2507**: Smaller reasoning model for efficient step-by-step thinking
- **magistral-medium-2507**: More powerful reasoning model balancing performance and cost

These models return structured reasoning content that the AI SDK extracts automatically. The reasoning is available via the `reasoningText` property in the result:

```ts
import { mistral } from '@ai-sdk/mistral';
import { generateText } from 'ai';

const result = await generateText({
  model: mistral('magistral-small-2507'),
  prompt: 'What is 15 * 24?',
});

console.log('REASONING:', result.reasoningText);
// Output: "Let me calculate this step by step..."

console.log('ANSWER:', result.text);
// Output: "360"
```

The SDK automatically parses Mistral's native reasoning format and provides separate `reasoningText` and `text` properties in the result. No middleware is needed.

#### Configurable Reasoning

Some Mistral models support configurable reasoning, which you can control via the `reasoningEffort` option.

```ts
import { mistral, type MistralLanguageModelOptions } from '@ai-sdk/mistral';
import { generateText } from 'ai';

const result = await generateText({
  model: mistral('mistral-small-latest'),
  prompt: 'What is 15 * 24?',
  providerOptions: {
    mistral: {
      reasoningEffort: 'high',
    } satisfies MistralLanguageModelOptions,
  },
});

console.log('REASONING:', result.reasoningText);
console.log('ANSWER:', result.text);
```

So far, Mistral only supports `'high'` and `'none'` as effort levels.

### Example

You can use Mistral language models to generate text with the `generateText` function:

```ts
import { mistral } from '@ai-sdk/mistral';
import { generateText } from 'ai';

const { text } = await generateText({
  model: mistral('mistral-large-latest'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Mistral language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

#### Structured Outputs

Mistral chat models support structured outputs using JSON Schema. You can use `generateText` or `streamText` with [`Output`](/docs/reference/ai-sdk-core/output)
and Zod, Valibot, or raw JSON Schema. The SDK sends your schema via Mistral's `response_format: { type: 'json_schema' }`.

```ts
import { mistral } from '@ai-sdk/mistral';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: mistral('mistral-large-latest'),
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.string()),
        instructions: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a simple pasta recipe.',
});

console.log(JSON.stringify(result.output, null, 2));
```

You can enable strict JSON Schema validation using a provider option:

```ts highlight="7-11"
import { mistral, type MistralLanguageModelOptions } from '@ai-sdk/mistral';
import { generateText, Output } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: mistral('mistral-large-latest'),
  providerOptions: {
    mistral: {
      strictJsonSchema: true,
    } satisfies MistralLanguageModelOptions,
  },
  output: Output.object({
    schema: z.object({
      title: z.string(),
      items: z.array(
        z.object({ id: z.string(), qty: z.number().int().min(1) }),
      ),
    }),
  }),
  prompt: 'Generate a small shopping list.',
});
```

<Note>
  When using structured outputs, the SDK no longer injects an extra "answer with
  JSON" instruction. It relies on Mistral's native `json_schema`/`json_object`
  response formats instead. You can customize the schema name/description via
  the standard structured-output APIs.
</Note>

### Model Capabilities

| Model                   | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `pixtral-large-latest`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral-large-latest`  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral-medium-latest` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral-medium-2508`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral-medium-2505`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `mistral-small-latest`  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `magistral-small-2507`  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `magistral-medium-2507` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `magistral-small-2506`  | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `magistral-medium-2506` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `ministral-3b-latest`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `ministral-8b-latest`   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `pixtral-12b-2409`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `open-mistral-7b`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `open-mixtral-8x7b`     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `open-mixtral-8x22b`    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [Mistral
  docs](https://docs.mistral.ai/getting-started/models/models_overview/) for a
  full list of available models. The table above lists popular models. You can
  also pass any available provider model ID as a string if needed.
</Note>

## Embedding Models

You can create models that call the [Mistral embeddings API](https://docs.mistral.ai/api/#operation/createEmbedding)
using the `.embedding()` factory method.

```ts
const model = mistral.embedding('mistral-embed');
```

You can use Mistral embedding models to generate embeddings with the `embed` function:

```ts
import { mistral } from '@ai-sdk/mistral';
import { embed } from 'ai';

const { embedding } = await embed({
  model: mistral.embedding('mistral-embed'),
  value: 'sunny day at the beach',
});
```

### Model Capabilities

| Model           | Default Dimensions |
| --------------- | ------------------ |
| `mistral-embed` | 1024               |

---
title: Together.ai
description: Learn how to use Together.ai's models with the AI SDK.
---

# Together.ai Provider

The [Together.ai](https://together.ai) provider contains support for 200+ open-source models through the [Together.ai API](https://docs.together.ai/reference).

## Setup

The Together.ai provider is available via the `@ai-sdk/togetherai` module. You can
install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/togetherai" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/togetherai" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/togetherai" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/togetherai" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `togetherai` from `@ai-sdk/togetherai`:

```ts
import { togetherai } from '@ai-sdk/togetherai';
```

If you need a customized setup, you can import `createTogetherAI` from `@ai-sdk/togetherai`
and create a provider instance with your settings:

```ts
import { createTogetherAI } from '@ai-sdk/togetherai';

const togetherai = createTogetherAI({
  apiKey: process.env.TOGETHER_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Together.ai provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.together.xyz/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `TOGETHER_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

## Language Models

You can create [Together.ai models](https://docs.together.ai/docs/serverless-models) using a provider instance. The first argument is the model id, e.g. `google/gemma-2-9b-it`.

```ts
const model = togetherai('google/gemma-2-9b-it');
```

### Reasoning Models

Together.ai exposes the thinking of `deepseek-ai/DeepSeek-R1` in the generated text using the `<think>` tag.
You can use the `extractReasoningMiddleware` to extract this reasoning and expose it as a `reasoning` property on the result:

```ts
import { togetherai } from '@ai-sdk/togetherai';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';

const enhancedModel = wrapLanguageModel({
  model: togetherai('deepseek-ai/DeepSeek-R1'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});
```

You can then use that enhanced model in functions like `generateText` and `streamText`.

### Example

You can use Together.ai language models to generate text with the `generateText` function:

```ts
import { togetherai } from '@ai-sdk/togetherai';
import { generateText } from 'ai';

const { text } = await generateText({
  model: togetherai('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Together.ai language models can also be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

The Together.ai provider also supports [completion models](https://docs.together.ai/docs/serverless-models#language-models) via (following the above example code) `togetherai.completionModel()` and [embedding models](https://docs.together.ai/docs/serverless-models#embedding-models) via `togetherai.embeddingModel()`.

## Model Capabilities

| Model                                               | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| --------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `moonshotai/Kimi-K2.5`                              | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `Qwen/Qwen3.5-397B-A17B`                            | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `MiniMaxAI/MiniMax-M2.5`                            | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `zai-org/GLM-5`                                     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `deepseek-ai/DeepSeek-V3.1`                         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai/gpt-oss-120b`                               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `openai/gpt-oss-20b`                                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |

<Note>
  The table above lists popular models. Please see the [Together.ai
  docs](https://docs.together.ai/docs/serverless-models) for a full list of
  available models. You can also pass any available provider model ID as a
  string if needed.
</Note>

## Image Models

You can create Together.ai image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

```ts
import { togetherai } from '@ai-sdk/togetherai';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: togetherai.image('black-forest-labs/FLUX.1-dev'),
  prompt: 'A delighted resplendent quetzal mid flight amidst raindrops',
});
```

You can pass optional provider-specific request parameters using the `providerOptions` argument.

```ts
import {
  togetherai,
  type TogetherAIImageModelOptions,
} from '@ai-sdk/togetherai';
import { generateImage } from 'ai';

const { images } = await generateImage({
  model: togetherai.image('black-forest-labs/FLUX.1-dev'),
  prompt: 'A delighted resplendent quetzal mid flight amidst raindrops',
  size: '512x512',
  // Optional additional provider-specific request parameters
  providerOptions: {
    togetherai: {
      steps: 40,
    } satisfies TogetherAIImageModelOptions,
  },
});
```

The following provider options are available:

- **steps** _number_

  Number of generation steps. Higher values can improve quality.

- **guidance** _number_

  Guidance scale for image generation.

- **negative_prompt** _string_

  Negative prompt to guide what to avoid.

- **disable_safety_checker** _boolean_

  Disable the safety checker for image generation.
  When true, the API will not reject images flagged as potentially NSFW.
  Not available for Flux Schnell Free and Flux Pro models.

### Image Editing

Together AI supports image editing through FLUX Kontext models. Pass input images via `prompt.images` to transform or edit existing images.

<Note>
  Together AI does not support mask-based inpainting. Instead, use descriptive
  prompts to specify what you want to change in the image.
</Note>

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: togetherai.image('black-forest-labs/FLUX.1-kontext-pro'),
  prompt: {
    text: 'Turn the cat into a golden retriever dog',
    images: [imageBuffer],
  },
  size: '1024x1024',
  providerOptions: {
    togetherai: {
      steps: 28,
    } satisfies TogetherAIImageModelOptions,
  },
});
```

#### Editing with URL Reference

You can also pass image URLs directly:

```ts
const { images } = await generateImage({
  model: togetherai.image('black-forest-labs/FLUX.1-kontext-pro'),
  prompt: {
    text: 'Make the background a lush rainforest',
    images: ['https://example.com/photo.png'],
  },
  size: '1024x1024',
  providerOptions: {
    togetherai: {
      steps: 28,
    } satisfies TogetherAIImageModelOptions,
  },
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`,
  base64-encoded strings, or URLs. Together AI only supports a single input
  image per request.
</Note>

#### Supported Image Editing Models

| Model                                  | Description                        |
| -------------------------------------- | ---------------------------------- |
| `black-forest-labs/FLUX.1-kontext-pro` | Production quality, balanced speed |
| `black-forest-labs/FLUX.1-kontext-max` | Maximum image fidelity             |
| `black-forest-labs/FLUX.1-kontext-dev` | Development and experimentation    |

### Model Capabilities

Together.ai image models support various image dimensions that vary by model. Common sizes include 512x512, 768x768, and 1024x1024, with some models supporting up to 1792x1792. The default size is 1024x1024.

| Available Models                           |
| ------------------------------------------ |
| `stabilityai/stable-diffusion-xl-base-1.0` |
| `black-forest-labs/FLUX.1-dev`             |
| `black-forest-labs/FLUX.1-dev-lora`        |
| `black-forest-labs/FLUX.1-schnell`         |
| `black-forest-labs/FLUX.1-canny`           |
| `black-forest-labs/FLUX.1-depth`           |
| `black-forest-labs/FLUX.1-redux`           |
| `black-forest-labs/FLUX.1.1-pro`           |
| `black-forest-labs/FLUX.1-pro`             |
| `black-forest-labs/FLUX.1-schnell-Free`    |
| `black-forest-labs/FLUX.1-kontext-pro`     |
| `black-forest-labs/FLUX.1-kontext-max`     |
| `black-forest-labs/FLUX.1-kontext-dev`     |

<Note>
  Please see the [Together.ai models
  page](https://docs.together.ai/docs/serverless-models#image-models) for a full
  list of available image models and their capabilities.
</Note>

## Embedding Models

You can create Together.ai embedding models using the `.embeddingModel()` factory method.
For more on embedding models with the AI SDK see [embed()](/docs/reference/ai-sdk-core/embed).

```ts
import { togetherai } from '@ai-sdk/togetherai';
import { embed } from 'ai';

const { embedding } = await embed({
  model: togetherai.embeddingModel('togethercomputer/m2-bert-80M-2k-retrieval'),
  value: 'sunny day at the beach',
});
```

### Model Capabilities

| Model                                     | Dimensions | Max Tokens |
| ----------------------------------------- | ---------- | ---------- |
| `BAAI/bge-large-en-v1.5`                  | 1024       | 512        |
| `Alibaba-NLP/gte-modernbert-base`         | 768        | 8192       |
| `intfloat/multilingual-e5-large-instruct` | 1024       | 514        |

<Note>
  For a complete list of available embedding models, see the [Together.ai models
  page](https://docs.together.ai/docs/serverless-models#embedding-models).
</Note>

## Reranking Models

You can create Together.ai reranking models using the `.reranking()` factory method.
For more on reranking with the AI SDK see [rerank()](/docs/reference/ai-sdk-core/rerank).

```ts
import { togetherai } from '@ai-sdk/togetherai';
import { rerank } from 'ai';

const documents = [
  'sunny day at the beach',
  'rainy afternoon in the city',
  'snowy night in the mountains',
];

const { ranking } = await rerank({
  model: togetherai.reranking('mixedbread-ai/Mxbai-Rerank-Large-V2'),
  documents,
  query: 'talk about rain',
  topN: 2,
});

console.log(ranking);
// [
//   { originalIndex: 1, score: 0.9, document: 'rainy afternoon in the city' },
//   { originalIndex: 0, score: 0.3, document: 'sunny day at the beach' }
// ]
```

Together.ai reranking models support additional provider options for object documents. You can specify which fields to use for ranking:

```ts
import {
  togetherai,
  type TogetherAIRerankingModelOptions,
} from '@ai-sdk/togetherai';
import { rerank } from 'ai';

const documents = [
  {
    from: 'Paul Doe',
    subject: 'Follow-up',
    text: 'We are happy to give you a discount of 20%.',
  },
  {
    from: 'John McGill',
    subject: 'Missing Info',
    text: 'Here is the pricing from Oracle: $5000/month',
  },
];

const { ranking } = await rerank({
  model: togetherai.reranking('mixedbread-ai/Mxbai-Rerank-Large-V2'),
  documents,
  query: 'Which pricing did we get from Oracle?',
  providerOptions: {
    togetherai: {
      rankFields: ['from', 'subject', 'text'], // Specify which fields to rank by
    } satisfies TogetherAIRerankingModelOptions,
  },
});
```

The following provider options are available:

- **rankFields** _string[]_

  Array of field names to use for ranking when documents are JSON objects. If not specified, all fields are used.

### Model Capabilities

| Model                                 |
| ------------------------------------- |
| `mixedbread-ai/Mxbai-Rerank-Large-V2` |

---
title: Cohere
description: Learn how to use the Cohere provider for the AI SDK.
---

# Cohere Provider

The [Cohere](https://cohere.com/) provider contains language and embedding model support for the Cohere chat API.

## Setup

The Cohere provider is available in the `@ai-sdk/cohere` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/cohere" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/cohere" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/cohere" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/cohere" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `cohere` from `@ai-sdk/cohere`:

```ts
import { cohere } from '@ai-sdk/cohere';
```

If you need a customized setup, you can import `createCohere` from `@ai-sdk/cohere`
and create a provider instance with your settings:

```ts
import { createCohere } from '@ai-sdk/cohere';

const cohere = createCohere({
  // custom settings
});
```

You can use the following optional settings to customize the Cohere provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.cohere.com/v2`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.
  It defaults to the `COHERE_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

- **generateId** _() => string_

  Optional function to generate unique IDs for each request.
  Defaults to the SDK's built-in ID generator.

## Language Models

You can create models that call the [Cohere chat API](https://docs.cohere.com/v2/docs/chat-api) using a provider instance.
The first argument is the model id, e.g. `command-r-plus`.
Some Cohere chat models support tool calls.

```ts
const model = cohere('command-r-plus');
```

### Example

You can use Cohere language models to generate text with the `generateText` function:

```ts
import { cohere } from '@ai-sdk/cohere';
import { generateText } from 'ai';

const { text } = await generateText({
  model: cohere('command-r-plus'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Cohere language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

### Model Capabilities

| Model                         | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ----------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `command-a-03-2025`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-a-reasoning-08-2025` | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r7b-12-2024`         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r-plus-04-2024`      | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r-plus`              | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r-08-2024`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r-03-2024`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command-r`                   | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `command`                     | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `command-nightly`             | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `command-light`               | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `command-light-nightly`       | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. Please see the [Cohere
  docs](https://docs.cohere.com/v2/docs/models#command) for a full list of
  available models. You can also pass any available provider model ID as a
  string if needed.
</Note>

#### Reasoning

Cohere has introduced reasoning with the `command-a-reasoning-08-2025` model. You can learn more at https://docs.cohere.com/docs/reasoning.

```ts
import { cohere, type CohereLanguageModelOptions } from '@ai-sdk/cohere';
import { generateText } from 'ai';

async function main() {
  const { text, reasoning } = await generateText({
    model: cohere('command-a-reasoning-08-2025'),
    prompt:
      "Alice has 3 brothers and she also has 2 sisters. How many sisters does Alice's brother have?",
    // optional: reasoning options
    providerOptions: {
      cohere: {
        thinking: {
          type: 'enabled',
          tokenBudget: 100,
        },
      } satisfies CohereLanguageModelOptions,
    },
  });

  console.log(reasoning);
  console.log(text);
}

main().catch(console.error);
```

## Embedding Models

You can create models that call the [Cohere embed API](https://docs.cohere.com/v2/reference/embed)
using the `.embedding()` factory method.

```ts
const model = cohere.embedding('embed-english-v3.0');
```

You can use Cohere embedding models to generate embeddings with the `embed` function:

```ts
import { cohere, type CohereEmbeddingModelOptions } from '@ai-sdk/cohere';
import { embed } from 'ai';

const { embedding } = await embed({
  model: cohere.embedding('embed-english-v3.0'),
  value: 'sunny day at the beach',
  providerOptions: {
    cohere: {
      inputType: 'search_document',
    } satisfies CohereEmbeddingModelOptions,
  },
});
```

Cohere embedding models support additional provider options that can be passed via `providerOptions.cohere`:

```ts
import { cohere, type CohereEmbeddingModelOptions } from '@ai-sdk/cohere';
import { embed } from 'ai';

const { embedding } = await embed({
  model: cohere.embedding('embed-english-v3.0'),
  value: 'sunny day at the beach',
  providerOptions: {
    cohere: {
      inputType: 'search_document',
      truncate: 'END',
    } satisfies CohereEmbeddingModelOptions,
  },
});
```

The following provider options are available:

- **inputType** _'search_document' | 'search_query' | 'classification' | 'clustering'_

  Specifies the type of input passed to the model. Default is `search_query`.

  - `search_document`: Used for embeddings stored in a vector database for search use-cases.
  - `search_query`: Used for embeddings of search queries run against a vector DB to find relevant documents.
  - `classification`: Used for embeddings passed through a text classifier.
  - `clustering`: Used for embeddings run through a clustering algorithm.

- **truncate** _'NONE' | 'START' | 'END'_

  Specifies how the API will handle inputs longer than the maximum token length.
  Default is `END`.

  - `NONE`: If selected, when the input exceeds the maximum input token length will return an error.
  - `START`: Will discard the start of the input until the remaining input is exactly the maximum input token length for the model.
  - `END`: Will discard the end of the input until the remaining input is exactly the maximum input token length for the model.

### Model Capabilities

| Model                           | Embedding Dimensions |
| ------------------------------- | -------------------- |
| `embed-english-v3.0`            | 1024                 |
| `embed-multilingual-v3.0`       | 1024                 |
| `embed-english-light-v3.0`      | 384                  |
| `embed-multilingual-light-v3.0` | 384                  |
| `embed-english-v2.0`            | 4096                 |
| `embed-english-light-v2.0`      | 1024                 |
| `embed-multilingual-v2.0`       | 768                  |

## Reranking Models

You can create models that call the [Cohere rerank API](https://docs.cohere.com/v2/reference/rerank)
using the `.reranking()` factory method.

```ts
const model = cohere.reranking('rerank-v3.5');
```

You can use Cohere reranking models to rerank documents with the `rerank` function:

```ts
import { cohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const documents = [
  'sunny day at the beach',
  'rainy afternoon in the city',
  'snowy night in the mountains',
];

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents,
  query: 'talk about rain',
  topN: 2,
});

console.log(ranking);
// [
//   { originalIndex: 1, score: 0.9, document: 'rainy afternoon in the city' },
//   { originalIndex: 0, score: 0.3, document: 'sunny day at the beach' }
// ]
```

Cohere reranking models support additional provider options that can be passed via `providerOptions.cohere`:

```ts
import { cohere, type CohereRerankingModelOptions } from '@ai-sdk/cohere';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: cohere.reranking('rerank-v3.5'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  providerOptions: {
    cohere: {
      maxTokensPerDoc: 1000,
      priority: 1,
    } satisfies CohereRerankingModelOptions,
  },
});
```

The following provider options are available:

- **maxTokensPerDoc** _number_

  Maximum number of tokens per document. Default is `4096`.

- **priority** _number_

  Priority of the request. Default is `0`.

### Model Capabilities

| Model                      |
| -------------------------- |
| `rerank-v3.5`              |
| `rerank-english-v3.0`      |
| `rerank-multilingual-v3.0` |

---
title: Fireworks
description: Learn how to use Fireworks models with the AI SDK.
---

# Fireworks Provider

[Fireworks](https://fireworks.ai/) is a platform for running and testing LLMs through their [API](https://readme.fireworks.ai/).

## Setup

The Fireworks provider is available via the `@ai-sdk/fireworks` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/fireworks" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/fireworks" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/fireworks" dark />
  </Tab>

  <Tab>
    <Snippet text="bun add @ai-sdk/fireworks" dark />
  </Tab>
</Tabs>

## Provider Instance

You can import the default provider instance `fireworks` from `@ai-sdk/fireworks`:

```ts
import { fireworks } from '@ai-sdk/fireworks';
```

If you need a customized setup, you can import `createFireworks` from `@ai-sdk/fireworks`
and create a provider instance with your settings:

```ts
import { createFireworks } from '@ai-sdk/fireworks';

const fireworks = createFireworks({
  apiKey: process.env.FIREWORKS_API_KEY ?? '',
});
```

You can use the following optional settings to customize the Fireworks provider instance:

- **baseURL** _string_

  Use a different URL prefix for API calls, e.g. to use proxy servers.
  The default prefix is `https://api.fireworks.ai/inference/v1`.

- **apiKey** _string_

  API key that is being sent using the `Authorization` header. It defaults to
  the `FIREWORKS_API_KEY` environment variable.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.

## Language Models

You can create [Fireworks models](https://fireworks.ai/models) using a provider instance.
The first argument is the model id, e.g. `accounts/fireworks/models/firefunction-v1`:

```ts
const model = fireworks('accounts/fireworks/models/firefunction-v1');
```

### Reasoning Models

Fireworks exposes the thinking of `deepseek-r1` in the generated text using the `<think>` tag.
You can use the `extractReasoningMiddleware` to extract this reasoning and expose it as a `reasoning` property on the result:

```ts
import { fireworks } from '@ai-sdk/fireworks';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';

const enhancedModel = wrapLanguageModel({
  model: fireworks('accounts/fireworks/models/deepseek-r1'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});
```

You can then use that enhanced model in functions like `generateText` and `streamText`.

### Example

You can use Fireworks language models to generate text with the `generateText` function:

```ts
import { fireworks } from '@ai-sdk/fireworks';
import { generateText } from 'ai';

const { text } = await generateText({
  model: fireworks('accounts/fireworks/models/firefunction-v1'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Fireworks language models can also be used in the `streamText` function
(see [AI SDK Core](/docs/ai-sdk-core)).

### Provider Options

Fireworks chat models support additional provider options that are not part of
the [standard call settings](/docs/ai-sdk-core/settings). You can pass them in the `providerOptions` argument:

```ts
import {
  fireworks,
  type FireworksLanguageModelOptions,
} from '@ai-sdk/fireworks';
import { generateText } from 'ai';

const { text, reasoningText } = await generateText({
  model: fireworks('accounts/fireworks/models/kimi-k2p5'),
  providerOptions: {
    fireworks: {
      thinking: { type: 'enabled', budgetTokens: 4096 },
      reasoningHistory: 'interleaved',
    } satisfies FireworksLanguageModelOptions,
  },
  prompt: 'How many "r"s are in the word "strawberry"?',
});
```

The following optional provider options are available for Fireworks chat models:

- **thinking** _object_

  Configuration for thinking/reasoning models like Kimi K2.5.

  - **type** _'enabled' | 'disabled'_

    Whether to enable thinking mode.

  - **budgetTokens** _number_

    Maximum number of tokens for thinking (minimum 1024).

- **reasoningHistory** _'disabled' | 'interleaved' | 'preserved'_

  Controls how reasoning history is handled in multi-turn conversations:

  - `'disabled'`: Remove reasoning from history
  - `'interleaved'`: Include reasoning between tool calls within a single turn
  - `'preserved'`: Keep all reasoning in history

### Completion Models

You can create models that call the Fireworks completions API using the `.completionModel()` factory method:

```ts
const model = fireworks.completionModel(
  'accounts/fireworks/models/firefunction-v1',
);
```

### Model Capabilities

| Model                                                      | Image Input         | Object Generation   | Tool Usage          | Tool Streaming      |
| ---------------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `accounts/fireworks/models/firefunction-v1`                | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `accounts/fireworks/models/deepseek-r1`                    | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/deepseek-v3`                    | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/llama-v3p1-405b-instruct`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `accounts/fireworks/models/llama-v3p1-8b-instruct`         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/llama-v3p2-3b-instruct`         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/llama-v3p3-70b-instruct`        | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/mixtral-8x7b-instruct`          | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/mixtral-8x7b-instruct-hf`       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/mixtral-8x22b-instruct`         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/qwen2p5-coder-32b-instruct`     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/qwen2p5-72b-instruct`           | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/qwen-qwq-32b-preview`           | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/qwen2-vl-72b-instruct`          | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/llama-v3p2-11b-vision-instruct` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/qwq-32b`                        | <Cross size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/yi-large`                       | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/kimi-k2-instruct`               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/kimi-k2-thinking`               | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/kimi-k2p5`                      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |
| `accounts/fireworks/models/minimax-m2`                     | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |

<Note>
  The table above lists popular models. Please see the [Fireworks models
  page](https://fireworks.ai/models) for a full list of available models.
</Note>

## Embedding Models

You can create models that call the Fireworks embeddings API using the `.embeddingModel()` factory method:

```ts
const model = fireworks.embeddingModel('nomic-ai/nomic-embed-text-v1.5');
```

You can use Fireworks embedding models to generate embeddings with the `embed` function:

```ts
import { fireworks } from '@ai-sdk/fireworks';
import { embed } from 'ai';

const { embedding } = await embed({
  model: fireworks.embeddingModel('nomic-ai/nomic-embed-text-v1.5'),
  value: 'sunny day at the beach',
});
```

### Model Capabilities

| Model                            | Dimensions | Max Tokens |
| -------------------------------- | ---------- | ---------- |
| `nomic-ai/nomic-embed-text-v1.5` | 768        | 8192       |

<Note>
  For more embedding models, see the [Fireworks models
  page](https://fireworks.ai/models) for a full list of available models.
</Note>

## Image Models

You can create Fireworks image models using the `.image()` factory method.
For more on image generation with the AI SDK see [generateImage()](/docs/reference/ai-sdk-core/generate-image).

```ts
import { fireworks } from '@ai-sdk/fireworks';
import { generateImage } from 'ai';

const { image } = await generateImage({
  model: fireworks.image('accounts/fireworks/models/flux-1-dev-fp8'),
  prompt: 'A futuristic cityscape at sunset',
  aspectRatio: '16:9',
});
```

<Note>
  Model support for `size` and `aspectRatio` parameters varies. See the [Model
  Capabilities](#model-capabilities-1) section below for supported dimensions,
  or check the model's documentation on [Fireworks models
  page](https://fireworks.ai/models) for more details.
</Note>

### Image Editing

Fireworks supports image editing through FLUX Kontext models (`flux-kontext-pro` and `flux-kontext-max`). Pass input images via `prompt.images` to transform or edit existing images.

<Note>
  Fireworks Kontext models do not support explicit masks. Editing is
  prompt-driven — describe what you want to change in the text prompt.
</Note>

#### Basic Image Editing

Transform an existing image using text prompts:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: fireworks.image('accounts/fireworks/models/flux-kontext-pro'),
  prompt: {
    text: 'Turn the cat into a golden retriever dog',
    images: [imageBuffer],
  },
  providerOptions: {
    fireworks: {
      output_format: 'jpeg',
    },
  },
});
```

#### Style Transfer

Apply artistic styles to an image:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: fireworks.image('accounts/fireworks/models/flux-kontext-pro'),
  prompt: {
    text: 'Transform this into a watercolor painting style',
    images: [imageBuffer],
  },
  aspectRatio: '1:1',
});
```

<Note>
  Input images can be provided as `Buffer`, `ArrayBuffer`, `Uint8Array`, or
  base64-encoded strings. Fireworks only supports a single input image per
  request.
</Note>

### Model Capabilities

For all models supporting aspect ratios, the following aspect ratios are supported:

`1:1 (default), 2:3, 3:2, 4:5, 5:4, 16:9, 9:16, 9:21, 21:9`

For all models supporting size, the following sizes are supported:

`640 x 1536, 768 x 1344, 832 x 1216, 896 x 1152, 1024x1024 (default), 1152 x 896, 1216 x 832, 1344 x 768, 1536 x 640`

| Model                                                        | Dimensions Specification | Image Editing       |
| ------------------------------------------------------------ | ------------------------ | ------------------- |
| `accounts/fireworks/models/flux-kontext-pro`                 | Aspect Ratio             | <Check size={18} /> |
| `accounts/fireworks/models/flux-kontext-max`                 | Aspect Ratio             | <Check size={18} /> |
| `accounts/fireworks/models/flux-1-dev-fp8`                   | Aspect Ratio             | <Cross size={18} /> |
| `accounts/fireworks/models/flux-1-schnell-fp8`               | Aspect Ratio             | <Cross size={18} /> |
| `accounts/fireworks/models/playground-v2-5-1024px-aesthetic` | Size                     | <Cross size={18} /> |
| `accounts/fireworks/models/japanese-stable-diffusion-xl`     | Size                     | <Cross size={18} /> |
| `accounts/fireworks/models/playground-v2-1024px-aesthetic`   | Size                     | <Cross size={18} /> |
| `accounts/fireworks/models/SSD-1B`                           | Size                     | <Cross size={18} /> |
| `accounts/fireworks/models/stable-diffusion-xl-1024-v1-0`    | Size                     | <Cross size={18} /> |

For more details, see the [Fireworks models page](https://fireworks.ai/models).

#### Stability AI Models

Fireworks also presents several Stability AI models backed by Stability AI API
keys and endpoint. The AI SDK Fireworks provider does not currently include
support for these models:

| Model ID                               |
| -------------------------------------- |
| `accounts/stability/models/sd3-turbo`  |
| `accounts/stability/models/sd3-medium` |
| `accounts/stability/models/sd3`        |

---
title: DeepSeek
description: Learn how to use DeepSeek's models with the AI SDK.
---

