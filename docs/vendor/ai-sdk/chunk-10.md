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
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';

export const yourLogMiddleware: LanguageModelV3Middleware = {
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
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
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
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';

const cache = new Map<string, any>();

export const yourCacheMiddleware: LanguageModelV3Middleware = {
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
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';

export const yourRagMiddleware: LanguageModelV3Middleware = {
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
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';

export const yourGuardrailMiddleware: LanguageModelV3Middleware = {
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
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';

export const yourLogMiddleware: LanguageModelV3Middleware = {
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

- `MockEmbeddingModelV3`: A mock embedding model using the [embedding model v3 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/embedding-model/v3/embedding-model-v3.ts).
- `MockLanguageModelV3`: A mock language model using the [language model v3 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3.ts).
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
import { MockLanguageModelV3 } from 'ai/test';

const result = await generateText({
  model: new MockLanguageModelV3({
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
import { MockLanguageModelV3 } from 'ai/test';

const result = streamText({
  model: new MockLanguageModelV3({
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
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const result = await generateText({
  model: new MockLanguageModelV3({
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
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const result = streamText({
  model: new MockLanguageModelV3({
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

For Next.js applications, please follow the [Next.js OpenTelemetry guide](https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry) to enable telemetry first.

You can then use the `experimental_telemetry` option to enable telemetry on specific function calls while the feature is experimental:

```ts highlight="4"
const result = await generateText({
  model: __MODEL__,
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
  model: __MODEL__,
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
  model: __MODEL__,
  prompt: 'Write a short story about a cat.',
  experimental_telemetry: {
    isEnabled: true,
    tracer: tracerProvider.getTracer('ai'),
  },
});
```

## Telemetry Integrations

Telemetry integrations let you hook into the generation lifecycle to build custom observability — logging, analytics, DevTools, or any other monitoring system. Instead of wiring up individual callbacks on every call, you implement a `TelemetryIntegration` once and pass it via `experimental_telemetry.integrations`.

### Using an integration

Pass one or more integrations to any `generateText` or `streamText` call:

```ts highlight="6-8"
import { streamText } from 'ai';
import { devToolsIntegration } from '@ai-sdk/devtools';

const result = streamText({
  model: openai('gpt-4o'),
  prompt: 'Hello!',
  experimental_telemetry: {
    isEnabled: true,
    integrations: [devToolsIntegration()],
  },
});
```

You can combine multiple integrations — they all receive the same lifecycle events:

```ts
experimental_telemetry: {
  isEnabled: true,
  integrations: [devToolsIntegration(), otelIntegration(), customLogger()],
},
```

Errors inside integrations are caught and do not break the generation flow.

### Building a custom integration

Implement the `TelemetryIntegration` interface from the `ai` package. All methods are optional — implement only the lifecycle events you care about:

```ts
import type { TelemetryIntegration } from 'ai';
import { bindTelemetryIntegration } from 'ai';

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

  async onToolCallFinish(event) {
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
  return bindTelemetryIntegration(new MyIntegration());
}
```

Use `bindTelemetryIntegration` for class-based integrations to ensure `this` is correctly bound when methods are extracted and called as callbacks.

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
      name: 'onToolCallStart',
      type: '(event: OnToolCallStartEvent) => void | PromiseLike<void>',
      description: "Called when a tool's execute function is about to run.",
    },
    {
      name: 'onToolCallFinish',
      type: '(event: OnToolCallFinishEvent) => void | PromiseLike<void>',
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

- `ai.toolCall` (span): a tool call that is made as part of the generateText call. See [Tool call spans](#tool-call-spans) for more details.

- `ai.stream.firstChunk` (event): an event that is emitted when the first chunk of the stream is received.

  - `ai.response.msToFirstChunk`: the time it took to receive the first chunk

- `ai.stream.finish` (event): an event that is emitted when the finish part of the LLM stream is received.

It also records a `ai.stream.firstChunk` event when the first chunk of the stream is received.

### Deprecated object APIs

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

Many spans that use LLMs (`ai.generateText`, `ai.generateText.doGenerate`, `ai.streamText`, `ai.streamText.doStream`) contain the following attributes:

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

### Basic embedding span information

Many spans that use embedding models (`ai.embed`, `ai.embed.doEmbed`, `ai.embedMany`, `ai.embedMany.doEmbed`) contain the following attributes:

- `ai.model.id`: the id of the model
- `ai.model.provider`: the provider of the model
- `ai.request.headers.*`: the request headers that were passed in through `headers`
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

1. **Middleware**: Captures runs and steps from your AI SDK calls
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

### Add the middleware

Wrap your language model with the DevTools middleware using [`wrapLanguageModel`](/docs/ai-sdk-core/middleware):

```ts
import { wrapLanguageModel, gateway } from 'ai';
import { devToolsMiddleware } from '@ai-sdk/devtools';

const model = wrapLanguageModel({
  model: gateway('anthropic/claude-sonnet-4.5'),
  middleware: devToolsMiddleware(),
});
```

The wrapped model can be used with any AI SDK Core function:

```ts highlight="4"
import { generateText } from 'ai';

const result = await generateText({
  model, // wrapped model with DevTools
  prompt: 'What cities are in the United States?',
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

The DevTools middleware captures the following information from your AI SDK calls:

- **Input parameters and prompts**: View the complete input sent to your LLM
- **Output content and tool calls**: Inspect generated text and tool invocations
- **Token usage and timing**: Monitor resource consumption and performance
- **Raw provider data**: Access complete request and response payloads

### Runs and steps

DevTools organizes captured data into runs and steps:

- **Run**: A complete multi-step AI interaction, grouped by the initial prompt
- **Step**: A single LLM call within a run (e.g., one `generateText` or `streamText` call)

Multi-step interactions, such as those created by tool calling or agent loops, are grouped together as a single run with multiple steps.

## How it works

The DevTools middleware intercepts all `generateText` and `streamText` calls through the [language model middleware](/docs/ai-sdk-core/middleware) system. Captured data is stored locally in a JSON file (`.devtools/generations.json`) and served through a web UI built with Hono and React.

<Note type="warning">
  The middleware automatically adds `.devtools` to your `.gitignore` file.
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
description: Subscribe to lifecycle events in generateText and streamText calls
---

# Event Callbacks

The AI SDK provides per-call event callbacks that you can pass to `generateText` and `streamText` to observe lifecycle events. This is useful for building observability tools, logging systems, analytics, and debugging utilities.

## Basic Usage

Pass callbacks directly to `generateText` or `streamText`:

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
      name: 'experimental_onToolCallStart',
      type: '(event: OnToolCallStartEvent) => void | Promise<void>',
      description: "Called when a tool's execute function is about to run.",
    },
    {
      name: 'experimental_onToolCallFinish',
      type: '(event: OnToolCallFinishEvent) => void | Promise<void>',
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

## Event Reference

### `experimental_onStart`

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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata passed to the generation.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description:
        'User-defined context object that flows through the entire generation lifecycle.',
    },
  ]}
/>

### `experimental_onStepStart`

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
      type: 'LanguageModelV3ToolChoice | undefined',
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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata from telemetry settings.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description:
        'User-defined context object. May be updated from prepareStep between steps.',
    },
  ]}
/>

### `experimental_onToolCallStart`

Called before a tool's `execute` function runs.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather?',
  tools: { getWeather },
  experimental_onToolCallStart: event => {
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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata from telemetry settings.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description:
        'User-defined context object flowing through the generation.',
    },
  ]}
/>

### `experimental_onToolCallFinish`

Called after a tool's `execute` function completes or errors. Uses a discriminated union on the `success` field.

```ts
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is the weather?',
  tools: { getWeather },
  experimental_onToolCallFinish: event => {
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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata from telemetry settings.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description:
        'User-defined context object flowing through the generation.',
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

### `onStepFinish`

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
      type: 'Array<ReasoningPart>',
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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata from telemetry settings.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description:
        'User-defined context object flowing through the generation.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Additional provider-specific metadata.',
    },
  ]}
/>

### `onFinish`

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
      type: 'Array<ReasoningPart>',
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
      name: 'metadata',
      type: 'Record<string, unknown> | undefined',
      description: 'Additional metadata from telemetry settings.',
    },
    {
      name: 'experimental_context',
      type: 'unknown',
      description: 'The final state of the user-defined context object.',
    },
    {
      name: 'providerMetadata',
      type: 'ProviderMetadata | undefined',
      description: 'Additional provider-specific metadata from the final step.',
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
  experimental_onToolCallStart: event => {
    console.log(`Tool "${event.toolCall.toolName}" starting...`);
  },
  experimental_onToolCallFinish: event => {
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

## Error Handling

Errors thrown inside callbacks are caught and do not break the generation flow. This ensures that monitoring code cannot disrupt your application:

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

## Sources

Some providers such as [Perplexity](/providers/ai-sdk-providers/perplexity#sources) and
[Google Generative AI](/providers/ai-sdk-providers/google-generative-ai#sources) include sources in the response.

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
import { convertToModelMessages, streamText, UIMessage, stepCountIs } from 'ai';
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
    stopWhen: stepCountIs(5),
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
import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const result = streamText({
    model: __MODEL__,
    system: 'You are a friendly assistant!',
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
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
import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
__PROVIDER_IMPORT__;
import { tools } from '@/ai/tools';

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const result = streamText({
    model: __MODEL__,
    system: 'You are a friendly assistant!',
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(5),
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

  Use a different URL prefix for API calls. The default prefix is `https://ai-gateway.vercel.sh/v3/ai`.

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

AI Gateway language models can also be used in the `streamText` function and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output) (see [AI SDK Core](/docs/ai-sdk-core)).

## Reranking Models

You can create reranking models using the `rerankingModel` method on the provider instance:

```ts
import { rerank } from "ai";
import { gateway } from "@ai-sdk/gateway";

const { ranking } = await rerank({
  model: gateway.rerankingModel("cohere/rerank-v3.5"),
  query: "What is the capital of France?",
  documents: [
    "Paris is the capital of France.",
    "Berlin is the capital of Germany.",
    "Madrid is the capital of Spain.",
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
import { gateway, generateText } from "ai";

// Make a request
const result = await generateText({
  model: gateway("anthropic/claude-sonnet-4"),
  prompt: "Explain quantum entanglement briefly",
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
import { gateway, streamText } from "ai";

const result = streamText({
  model: gateway("anthropic/claude-sonnet-4"),
  prompt: "Explain quantum entanglement briefly",
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
  - Multiple credentials: `byok: { 'vertex': [{ project: 'proj-1', googleCredentials: { privateKey: '...', clientEmail: '...' } }, { project: 'proj-2', googleCredentials: { privateKey: '...', clientEmail: '...' } }] }`
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
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { generateText } from "ai";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-4.6",
  prompt: "Explain quantum computing",
  providerOptions: {
    gateway: {
      order: ["vertex", "anthropic"],
    } satisfies GatewayProviderOptions,
    anthropic: {
      thinking: { type: "enabled", budgetTokens: 12000 },
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

