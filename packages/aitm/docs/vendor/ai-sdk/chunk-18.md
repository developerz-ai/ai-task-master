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
  the Gemini API. When used with the Google provider, a warning
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

Cache read and cache write (creation) token counts are returned on the standard
`usage` object for both `generateText` and `streamText`. You can access them at
`result.usage.inputTokenDetails.cacheReadTokens` and
`result.usage.inputTokenDetails.cacheWriteTokens`.

```ts highlight="8,18-20,29-32"
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
console.log('Cache read tokens:', result.usage.inputTokenDetails.cacheReadTokens);
console.log(
  'Cache write tokens:',
  result.usage.inputTokenDetails.cacheWriteTokens,
);
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

Some Mistral models support configurable reasoning, which you can control via the `reasoning` parameter.
You can use the AI SDK's top-level `reasoning` setting to control reasoning effort:

```ts
import { mistral } from '@ai-sdk/mistral';
import { generateText } from 'ai';

const result = await generateText({
  model: mistral('mistral-small-latest'),
  reasoning: 'high',
  prompt: 'What is 15 * 24?',
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

