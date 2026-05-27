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

<Note>
  The Azure provider calls the Responses API by default (unless you specify e.g.
  `azure.chat`).
</Note>

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

OpenAI language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

<Note>
  Azure OpenAI sends larger chunks than OpenAI. This can lead to the perception
  that the response is slower. See [Troubleshooting: Azure OpenAI Slow To
  Stream](/docs/troubleshooting/common-issues/azure-stream-slow)
</Note>

### Provider Options

When using OpenAI language models on Azure, you can configure provider-specific options using `providerOptions.openai`. More information on available configuration options are on [the OpenAI provider page](/providers/ai-sdk-providers/openai#language-models).

```ts highlight="12-14,24-26"
import { azure, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/azure';

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
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});
```

### Chat Models

<Note>
  The URL for calling Azure chat models will be constructed as follows:
  `https://RESOURCE_NAME.openai.azure.com/openai/v1/chat/completions?api-version=v1`
</Note>

You can create models that call the Azure OpenAI chat completions API using the `.chat()` factory method:

```ts
const model = azure.chat('your-deployment-name');
```

Azure OpenAI chat models support also some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
You can pass them as an options argument:

```ts
import { azure, type OpenAILanguageModelChatOptions } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure.chat('your-deployment-name'),
  prompt: 'Write a short story about a robot.',
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

  Whether to enable parallel function calling during tool use. Default to true.

- **user** _string_

  A unique identifier representing your end-user, which can help OpenAI to
  monitor and detect abuse. Learn more.

### Responses Models

Azure OpenAI uses responses API as default with the `azure(deploymentName)` factory method.

```ts
const model = azure('your-deployment-name');
```

Further configuration can be done using OpenAI provider options.
You can validate the provider options using the `OpenAILanguageModelResponsesOptions` type.

<Note>
  In the Responses API, use `azure` as the provider name in `providerOptions`
  instead of `openai`. The `openai` key is still supported for `providerOptions`
  input.
</Note>

```ts
import { azure, OpenAILanguageModelResponsesOptions } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('your-deployment-name'),
  providerOptions: {
    azure: {
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

The Azure OpenAI provider also returns provider-specific metadata:

For Responses models (`azure(deploymentName)`), you can type this metadata using `AzureResponsesProviderMetadata`:

```ts
import { azure, type AzureResponsesProviderMetadata } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('your-deployment-name'),
});

const providerMetadata = result.providerMetadata as
  | AzureResponsesProviderMetadata
  | undefined;

const { responseId, logprobs, serviceTier } = providerMetadata?.azure ?? {};

// responseId can be used to continue a conversation (previousResponseId).
console.log(responseId);
```

The following Azure-specific metadata may be returned:

- **responseId** _string | null | undefined_
  The ID of the response. Can be used to continue a conversation.
- **logprobs** _(optional)_
  Log probabilities of output tokens (when enabled).
- **serviceTier** _(optional)_
  Service tier information returned by the API.

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

The Azure OpenAI provider supports file search through the `azure.tools.fileSearch` tool.

You can force the use of the file search tool by setting the `toolChoice` parameter to `{ type: 'tool', toolName: 'file_search' }`.

```ts
const result = await generateText({
  model: azure('gpt-5'),
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

<Note>
  The 'file_search' tool is only supported with the default responses API, and
  is not supported when using 'azure.chat' or 'azure.completion'
</Note>

#### Image Generation Tool

Azure OpenAI's Responses API supports multi-modal image generation as a provider-defined tool.
Availability is restricted to specific models (for example, `gpt-5` variants).

```ts
import { createAzure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const azure = createAzure({
  headers: {
    'x-ms-oai-image-generation-deployment': 'gpt-image-1', // use your own image model deployment
  },
});

const result = await generateText({
  model: azure('gpt-5'),
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
  The tool must be named `image_generation` when using Azure OpenAI's image
  generation functionality. This name is required by Azure OpenAI's API
  specification and cannot be customized.
</Note>

<Note>
  The 'image_generation' tool is only supported with the default responses API,
  and is not supported when using 'azure.chat' or 'azure.completion'
</Note>

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

The Azure OpenAI provider supports the code interpreter tool through the `azure.tools.codeInterpreter` tool. This allows models to write and execute Python code.

```ts
import { azure } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('gpt-5'),
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

<Note>
  The 'code_interpreter' tool is only supported with the default responses API,
  and is not supported when using 'azure.chat' or 'azure.completion'
</Note>

<Note>
  When working with files generated by the Code Interpreter, reference
  information can be obtained from both [annotations in Text
  Parts](#typed-providermetadata-in-text-parts) and [`providerMetadata` in
  Source Document Parts](#typed-providermetadata-in-source-document-parts).
</Note>

#### PDF support

The Azure OpenAI provider supports reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

```ts
const result = await generateText({
  model: azure('your-deployment-name'),
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

<Note>
  Reading PDF files are only supported with the default responses API, and is
  not supported when using 'azure.chat' or 'azure.completion'
</Note>

#### Typed providerMetadata in Text Parts

When using the Azure OpenAI Responses API, the SDK attaches Azure OpenAI-specific metadata to output parts via `providerMetadata`.

This metadata can be used on the client side for tasks such as rendering citations or downloading files generated by the Code Interpreter.
To enable type-safe handling of this metadata, the AI SDK exports dedicated TypeScript types.

For text parts, when `part.type === 'text'`, the `providerMetadata` is provided in the form of `AzureResponsesTextProviderMetadata`.

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
import { azure, type AzureResponsesTextProviderMetadata } from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('gpt-4.1-mini'),
  prompt:
    'Create a program that generates five random numbers between 1 and 100 with two decimal places, and show me the execution results. Also save the result to a file.',
  tools: {
    code_interpreter: azure.tools.codeInterpreter(),
    web_search_preview: azure.tools.webSearchPreview({}),
    file_search: azure.tools.fileSearch({ vectorStoreIds: ['vs_1234'] }), // requires a configured vector store
  },
});

for (const part of result.content) {
  if (part.type === 'text') {
    const providerMetadata = part.providerMetadata as
      | AzureResponsesTextProviderMetadata
      | undefined;
    if (!providerMetadata) continue;
    const { itemId: _itemId, annotations } = providerMetadata.azure;

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

When using the Azure OpenAI Responses API, reasoning output parts can include provider metadata.
To handle this metadata in a type-safe way, use `AzureResponsesReasoningProviderMetadata`.

For reasoning parts, when `part.type === 'reasoning'`, the `providerMetadata` is provided in the form of `AzureResponsesReasoningProviderMetadata`.

This metadata includes the following fields:

- `itemId`  
  The ID of the reasoning item in the Responses API.
- `reasoningEncryptedContent` (optional)  
  Encrypted reasoning content (only returned when requested via `include: ['reasoning.encrypted_content']`).

```ts
import {
  azure,
  type AzureResponsesReasoningProviderMetadata,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('your-deployment-name'),
  prompt: 'How many "r"s are in the word "strawberry"?',
  providerOptions: {
    azure: {
      store: false,
      include: ['reasoning.encrypted_content'],
    } satisfies OpenAILanguageModelResponsesOptions,
  },
});

for (const part of result.content) {
  if (part.type === 'reasoning') {
    const providerMetadata = part.providerMetadata as
      | AzureResponsesReasoningProviderMetadata
      | undefined;

    const { itemId, reasoningEncryptedContent } = providerMetadata?.azure ?? {};
    console.log(itemId, reasoningEncryptedContent);
  }
}
```

#### Typed providerMetadata in Source Document Parts

For source document parts, when `part.type === 'source'` and `sourceType === 'document'`, the `providerMetadata` is provided as `AzureResponsesSourceDocumentProviderMetadata`.

This metadata is also a discriminated union with a required `type` field. Supported types include:

- `file_citation`
- `container_file_citation`
- `file_path`

Each type includes the identifiers required to work with the referenced resource, such as `fileId` and `containerId`.

```ts
import {
  azure,
  type AzureResponsesSourceDocumentProviderMetadata,
} from '@ai-sdk/azure';
import { generateText } from 'ai';

const result = await generateText({
  model: azure('gpt-4.1-mini'),
  prompt:
    'Create a program that generates five random numbers between 1 and 100 with two decimal places, and show me the execution results. Also save the result to a file.',
  tools: {
    code_interpreter: azure.tools.codeInterpreter(),
    web_search_preview: azure.tools.webSearchPreview({}),
    file_search: azure.tools.fileSearch({ vectorStoreIds: ['vs_1234'] }), // requires a configured vector store
  },
});

for (const part of result.content) {
  if (part.type === 'source') {
    if (part.sourceType === 'document') {
      const providerMetadata = part.providerMetadata as
        | AzureResponsesSourceDocumentProviderMetadata
        | undefined;
      if (!providerMetadata) continue;
      const annotation = providerMetadata.azure;
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
import {
  azure,
  type OpenAILanguageModelCompletionOptions,
} from '@ai-sdk/azure';
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
    } satisfies OpenAILanguageModelCompletionOptions,
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
using the `.embedding()` factory method.

```ts
const model = azure.embedding('your-embedding-deployment');
```

Azure OpenAI embedding models support several additional settings.
You can pass them as an options argument:

```ts
import { azure, type OpenAIEmbeddingModelOptions } from '@ai-sdk/azure';
import { embed } from 'ai';

const { embedding } = await embed({
  model: azure.embedding('your-embedding-deployment'),
  value: 'sunny day at the beach',
  providerOptions: {
    openai: {
      dimensions: 512, // optional, number of dimensions for the embedding
      user: 'test-user', // optional unique user identifier
    } satisfies OpenAIEmbeddingModelOptions,
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
import { generateImage } from 'ai';

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
import { azure, type OpenAITranscriptionModelOptions } from '@ai-sdk/azure';
import { readFile } from 'fs/promises';

const result = await transcribe({
  model: azure.transcription('whisper-1'),
  audio: await readFile('audio.mp3'),
  providerOptions: {
    openai: {
      language: 'en',
    } satisfies OpenAITranscriptionModelOptions,
  },
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

You can create models that call the Azure OpenAI speech API using the `.speech()` factory method.

The first argument is your deployment name for the text-to-speech model (e.g., `tts-1`).

```ts
const model = azure.speech('your-tts-deployment-name');
```

### Example

```ts
import { azure } from '@ai-sdk/azure';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const result = await generateSpeech({
  model: azure.speech('your-tts-deployment-name'),
  text: 'Hello, world!',
  voice: 'alloy', // OpenAI voice ID
});
```

You can also pass additional provider-specific options using the `providerOptions` argument:

```ts
import { azure, type OpenAISpeechModelOptions } from '@ai-sdk/azure';
import { experimental_generateSpeech as generateSpeech } from 'ai';

const result = await generateSpeech({
  model: azure.speech('your-tts-deployment-name'),
  text: 'Hello, world!',
  voice: 'alloy',
  providerOptions: {
    openai: {
      speed: 1.2,
    } satisfies OpenAISpeechModelOptions,
  },
});
```

The following provider options are available:

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

Azure OpenAI supports TTS models through deployments. The capabilities depend on which model version your deployment is using:

| Model Version     | Instructions        |
| ----------------- | ------------------- |
| `tts-1`           | <Cross size={18} /> |
| `tts-1-hd`        | <Cross size={18} /> |
| `gpt-4o-mini-tts` | <Check size={18} /> |

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
  Only one of `apiKey` or `authToken` is required.

- **authToken** _string_

  Auth token that is being sent using the `Authorization: Bearer` header.
  It defaults to the `ANTHROPIC_AUTH_TOKEN` environment variable.
  Only one of `apiKey` or `authToken` is required.

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

You can also use the following aliases for model creation:

- `anthropic.languageModel('claude-3-haiku-20240307')` - Creates a language model
- `anthropic.chat('claude-3-haiku-20240307')` - Alias for `languageModel`
- `anthropic.messages('claude-3-haiku-20240307')` - Alias for `languageModel`

You can use Anthropic language models to generate text with the `generateText` function:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-3-haiku-20240307'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Anthropic language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
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

- `toolStreaming` _boolean_

  Whether to enable tool streaming (and structured output streaming). Default to `true`.

- `structuredOutputMode` _"outputFormat" | "jsonTool" | "auto"_

  Determines how structured outputs are generated. Optional.

  - `"outputFormat"`: Use the `output_format` parameter to specify the structured output format.
  - `"jsonTool"`: Use a special `"json"` tool to specify the structured output format.
  - `"auto"`: Use `"outputFormat"` when supported, otherwise fall back to `"jsonTool"` (default).

- `metadata` _object_

  Optional. Metadata to include with the request. See the [Anthropic API documentation](https://platform.claude.com/docs/en/api/messages/create) for details.

  - `userId` _string_ - An external identifier for the end-user. Should be a UUID, hash, or other opaque identifier. Must not contain PII.

### Structured Outputs and Tool Input Streaming

Tool call streaming is enabled by default. You can opt out by setting the
`toolStreaming` provider option to `false`.

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
});
```

### Effort

Anthropic introduced an `effort` option with `claude-opus-4-5` that affects thinking, text responses, and function calls. Effort defaults to `high` and you can set it to `medium` or `low` to save tokens and to lower time-to-last-token latency (TTLT). `claude-opus-4-7` additionally supports `xhigh` for maximum reasoning effort.

```ts highlight="8-10"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, usage } = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      effort: 'low',
    } satisfies AnthropicLanguageModelOptions,
  },
});

console.log(text); // resulting text
console.log(usage); // token usage
```

### Fast Mode

Anthropic supports a [`speed` option](https://code.claude.com/docs/en/fast-mode) for `claude-opus-4-6` that enables faster inference with approximately 2.5x faster output token speeds.

```ts highlight="8-10"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'Write a short poem about the sea.',
  providerOptions: {
    anthropic: {
      speed: 'fast',
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

The `speed` option accepts `'fast'` or `'standard'` (default behavior).

### Task Budgets

`claude-opus-4-7` supports a `taskBudget` option that informs the model of the total token budget available for an agentic turn. The model uses this information to prioritize work, plan ahead, and wind down gracefully as the budget is consumed.

Task budgets are advisory — they do not enforce a hard token limit. The model will attempt to stay within budget, but actual usage may vary.

```ts highlight="8-13"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
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
    } satisfies AnthropicLanguageModelOptions,
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

### Data Residency

Anthropic supports an [`inferenceGeo` option](https://platform.claude.com/docs/en/build-with-claude/data-residency) that controls where model inference runs for a request.

```ts highlight="8-10"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'Summarize the key points of this document.',
  providerOptions: {
    anthropic: {
      inferenceGeo: 'us',
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

The `inferenceGeo` option accepts `'us'` (US-only infrastructure) or `'global'` (default, any available geography).

### Reasoning

Anthropic models support extended thinking, where Claude shows its reasoning process before providing a final answer.

#### Adaptive Thinking

For newer models (`claude-sonnet-4-6`, `claude-opus-4-6`, and later), use adaptive thinking.
Claude automatically determines how much reasoning to use based on the complexity of the prompt.

```ts highlight="4,8-10"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: anthropic('claude-opus-4-6'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive' },
    } satisfies AnthropicLanguageModelOptions,
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
      effort: 'max', // 'low' | 'medium' | 'high' | 'max'
    } satisfies AnthropicLanguageModelOptions,
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
    } satisfies AnthropicLanguageModelOptions,
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
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoningText, reasoning } = await generateText({
  model: anthropic('claude-sonnet-4-5-20250929'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    } satisfies AnthropicLanguageModelOptions,
  },
});

console.log(reasoningText); // reasoning text
console.log(reasoning); // reasoning details including redacted reasoning
console.log(text); // text response
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

### Context Management

Anthropic's Context Management feature allows you to automatically manage conversation context by clearing tool uses or thinking content when certain conditions are met. This helps optimize token usage and manage long conversations more efficiently.

You can configure context management using the `contextManagement` provider option:

```ts highlight="7-20"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5-20250929'),
  prompt: 'Continue our conversation...',
  providerOptions: {
    anthropic: {
      contextManagement: {
        edits: [
          {
            type: 'clear_tool_uses_20250919',
            trigger: { type: 'input_tokens', value: 10000 },
            keep: { type: 'tool_uses', value: 5 },
            clearAtLeast: { type: 'input_tokens', value: 1000 },
            clearToolInputs: true,
            excludeTools: ['important_tool'],
          },
        ],
      },
    } satisfies AnthropicLanguageModelOptions,
  },
});

// Check what was cleared
console.log(result.providerMetadata?.anthropic?.contextManagement);
```

#### Context Editing

Context editing strategies selectively remove specific content types from earlier in the conversation to reduce token usage without losing the overall conversation flow.

##### Clear Tool Uses

The `clear_tool_uses_20250919` edit type removes old tool call/result pairs from the conversation history:

- **trigger** - Condition that triggers the clearing (e.g., `{ type: 'input_tokens', value: 10000 }` or `{ type: 'tool_uses', value: 10 }`)
- **keep** - How many recent tool uses to preserve (e.g., `{ type: 'tool_uses', value: 5 }`)
- **clearAtLeast** - Minimum amount to clear (e.g., `{ type: 'input_tokens', value: 1000 }`)
- **clearToolInputs** - Whether to clear tool input parameters (boolean)
- **excludeTools** - Array of tool names to never clear

##### Clear Thinking

The `clear_thinking_20251015` edit type removes thinking/reasoning blocks from earlier turns, keeping only the most recent ones:

- **keep** - How many recent thinking turns to preserve (e.g., `{ type: 'thinking_turns', value: 2 }`) or `'all'` to keep everything

```ts
const result = await generateText({
  model: anthropic('claude-opus-4-20250514'),
  prompt: 'Continue reasoning...',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
      contextManagement: {
        edits: [
          {
            type: 'clear_thinking_20251015',
            keep: { type: 'thinking_turns', value: 2 },
          },
        ],
      },
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

#### Compaction

The `compact_20260112` edit type automatically summarizes earlier conversation context when token limits are reached. This is useful for long-running conversations where you want to preserve the essence of earlier exchanges while staying within token limits.

```ts highlight="7-19"
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
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
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

**Configuration:**

- **trigger** - Condition that triggers compaction (e.g., `{ type: 'input_tokens', value: 50000 }`)
- **instructions** - Custom instructions for how the model should summarize the conversation. Use this to guide the compaction summary towards specific aspects of the conversation you want to preserve.
- **pauseAfterCompaction** - When `true`, the model will pause after generating the compaction summary, allowing you to inspect or process it before continuing. Defaults to `false`.

When compaction occurs, the model generates a summary of the earlier context. This summary appears as a text block with special provider metadata.

##### Detecting Compaction in Streams

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

##### Compaction in UI Applications

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

#### Applied Edits Metadata

After generation, you can check which edits were applied in the provider metadata:

```ts
const metadata = result.providerMetadata?.anthropic?.contextManagement;

if (metadata?.appliedEdits) {
  metadata.appliedEdits.forEach(edit => {
    if (edit.type === 'clear_tool_uses_20250919') {
      console.log(`Cleared ${edit.clearedToolUses} tool uses`);
      console.log(`Freed ${edit.clearedInputTokens} tokens`);
    } else if (edit.type === 'clear_thinking_20251015') {
      console.log(`Cleared ${edit.clearedThinkingTurns} thinking turns`);
      console.log(`Freed ${edit.clearedInputTokens} tokens`);
    } else if (edit.type === 'compact_20260112') {
      console.log('Compaction was applied');
    }
  });
}
```

For more details, see [Anthropic's Context Management documentation](https://docs.anthropic.com/en/docs/build-with-claude/context-management).

### Cache Control

In the messages and message parts, you can use the `providerOptions` property to set cache control breakpoints.
You need to set the `anthropic` property in the `providerOptions` object to `{ cacheControl: { type: 'ephemeral' } }` to set a cache control breakpoint.

Cache read and cache write (creation) token counts are returned on the standard
`usage` object for both `generateText` and `streamText`. You can access them at
`result.usage.inputTokenDetails.cacheReadTokens` and
`result.usage.inputTokenDetails.cacheWriteTokens`.

```ts highlight="8,18-20,29-32"
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const errorMessage = '... long error message ...';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
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

```ts highlight="3,7-9"
const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
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
  model: anthropic('claude-haiku-4-5'),
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
  model: anthropic('claude-haiku-4-5'),
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

- 4096 tokens for Claude Opus 4.5
- 1024 tokens for Claude Opus 4.1, Claude Opus 4, Claude Sonnet 4.5, Claude Sonnet 4, Claude Sonnet 3.7, and Claude Opus 3
- 4096 tokens for Claude Haiku 4.5
- 2048 tokens for Claude Haiku 3.5 and Claude Haiku 3

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
const bashTool = anthropic.tools.bash_20250124({
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
  Two versions are available: `bash_20250124` (recommended) and `bash_20241022`.
  Only certain Claude versions are supported.
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

<Note>Only certain Claude versions are supported.</Note>

### Text Editor Tool

The Text Editor Tool provides functionality for viewing and editing text files.

```ts
const tools = {
  str_replace_based_edit_tool: anthropic.tools.textEditor_20250728({
    maxCharacters: 10000, // optional
    async execute({ command, path, old_str, new_str, insert_text }) {
      // ...
    },
  }),
} satisfies ToolSet;
```

<Note>
  Different models support different versions of the tool:

- `textEditor_20250728` - For Claude Sonnet 4, Opus 4, and Opus 4.1 (recommended)
- `textEditor_20250124` - For Claude Sonnet 3.7
- `textEditor_20241022` - For Claude Sonnet 3.5

Note: `textEditor_20250429` is deprecated. Use `textEditor_20250728` instead.

</Note>

Parameters:

- `command` ('view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'): The command to run. Note: `undo_edit` is only available in Claude 3.5 Sonnet and earlier models.
- `path` (string): Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.
- `file_text` (string, optional): Required for `create` command, with the content of the file to be created.
- `insert_line` (number, optional): Required for `insert` command. The line number after which to insert the new string.
- `new_str` (string, optional): New string for `str_replace` command.
- `insert_text` (string, optional): Required for `insert` command, containing the text to insert.
- `old_str` (string, optional): Required for `str_replace` command, containing the string to replace.
- `view_range` (number[], optional): Optional for `view` command to specify line range to show.

### Computer Tool

The Computer Tool enables control of keyboard and mouse actions on a computer:

```ts
const computerTool = anthropic.tools.computer_20251124({
  displayWidthPx: 1920,
  displayHeightPx: 1080,
  displayNumber: 0, // Optional, for X11 environments
  enableZoom: true, // Optional, enables the zoom action

  execute: async ({ action, coordinate, text, region }) => {
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
      case 'zoom': {
        // region is [x1, y1, x2, y2] defining the area to zoom into
        return {
          type: 'image',
          data: fs.readFileSync('./data/zoomed-region.png').toString('base64'),
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

<Note>
  Use `computer_20251124` for Claude Opus 4.5 which supports the zoom action.
  Use `computer_20250124` for Claude Sonnet 4.5, Haiku 4.5, Opus 4.1, Sonnet 4,
  Opus 4, and Sonnet 3.7.
</Note>

Parameters:

- `action` ('key' | 'type' | 'mouse_move' | 'left_click' | 'left_click_drag' | 'right_click' | 'middle_click' | 'double_click' | 'screenshot' | 'cursor_position' | 'zoom'): The action to perform. The `zoom` action is only available with `computer_20251124`.
- `coordinate` (number[], optional): Required for `mouse_move` and `left_click_drag` actions. Specifies the (x, y) coordinates.
- `text` (string, optional): Required for `type` and `key` actions.
- `region` (number[], optional): Required for `zoom` action. Specifies `[x1, y1, x2, y2]` coordinates for the area to inspect.
- `displayWidthPx` (number): The width of the display in pixels.
- `displayHeightPx` (number): The height of the display in pixels.
- `displayNumber` (number, optional): The display number for X11 environments.
- `enableZoom` (boolean, optional): Enable the zoom action. Only available with `computer_20251124`. Default: `false`.

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

### Tool Search

Anthropic provides provider-defined tool search tools that enable Claude to work with hundreds or thousands of tools by dynamically discovering and loading them on-demand. Instead of loading all tool definitions into the context window upfront, Claude searches your tool catalog and loads only the tools it needs.

There are two variants:

- **BM25 Search** - Uses natural language queries to find tools
- **Regex Search** - Uses regex patterns (Python `re.search()` syntax) to find tools

#### Basic Usage

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  prompt: 'What is the weather in San Francisco?',
  tools: {
    toolSearch: anthropic.tools.toolSearchBm25_20251119(),

    get_weather: tool({
      description: 'Get the current weather at a specific location',
      inputSchema: z.object({
        location: z.string().describe('The city and state'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72,
        condition: 'Sunny',
      }),
      // Defer tool here - Claude discovers these via the tool search tool
      providerOptions: {
        anthropic: { deferLoading: true },
      },
    }),
  },
});
```

#### Using Regex Search

For more precise tool matching, you can use the regex variant:

```ts
const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  prompt: 'Get the weather data',
  tools: {
    toolSearch: anthropic.tools.toolSearchRegex_20251119(),
    // ... deferred tools
  },
});
```

Claude will construct regex patterns like `weather|temperature|forecast` to find matching tools.

#### Custom Tool Search

You can implement your own tool search logic (e.g., using embeddings or semantic search) by returning `tool-reference` content blocks via `toModelOutput`:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  prompt: 'What is the weather in San Francisco?',
  tools: {
    // Custom search tool
    searchTools: tool({
      description: 'Search for tools by keyword',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        // Your custom search logic (embeddings, fuzzy match, etc.)
        const allTools = ['get_weather', 'get_forecast', 'get_temperature'];
        return allTools.filter(name => name.includes(query.toLowerCase()));
      },
      toModelOutput: ({ output }) => ({
        type: 'content',
        value: (output as string[]).map(toolName => ({
          type: 'custom' as const,
          providerOptions: {
            anthropic: {
              type: 'tool-reference',
              toolName,
            },
          },
        })),
      }),
    }),

    // Deferred tools
    get_weather: tool({
      description: 'Get the current weather',
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ location, temperature: 72 }),
      providerOptions: {
        anthropic: { deferLoading: true },
      },
    }),
  },
});
```

This sends `tool_reference` blocks to Anthropic, which loads the corresponding deferred tool schemas into Claude's context.

### MCP Connectors

Anthropic supports connecting to [MCP servers](https://docs.claude.com/en/docs/agents-and-tools/mcp-connector) as part of their execution.

You can enable this feature with the `mcpServers` provider option:

```ts
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  prompt: `Call the echo tool with "hello world". what does it respond with back?`,
  providerOptions: {
    anthropic: {
      mcpServers: [
        {
          type: 'url',
          name: 'echo',
          url: 'https://echo.mcp.inevitable.fyi/mcp',
          // optional: authorization token
          authorizationToken: mcpAuthToken,
          // optional: tool configuration
          toolConfiguration: {
            enabled: true,
            allowedTools: ['echo'],
          },
        },
      ],
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

The tool calls and results are dynamic, i.e. the input and output schemas are not known.

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

**Non-streaming (`generateText`):**
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

**Streaming (`streamText`):**
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

**Non-streaming (`generateText`):**
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

**Streaming (`streamText`):**
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

### Programmatic Tool Calling

[Programmatic Tool Calling](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling) allows Claude to write code that calls your tools programmatically within a code execution container, rather than requiring round trips through the model for each tool invocation. This reduces latency for multi-tool workflows and decreases token consumption.

To enable programmatic tool calling, use the `allowedCallers` provider option on tools that you want to be callable from within code execution:

```ts highlight="13-17"
import {
  anthropic,
  forwardAnthropicContainerIdFromLastStep,
} from '@ai-sdk/anthropic';
import { generateText, tool, isStepCount } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  stopWhen: isStepCount(10),
  prompt:
    'Get the weather for Tokyo, Sydney, and London, then calculate the average temperature.',
  tools: {
    code_execution: anthropic.tools.codeExecution_20260120(),

    getWeather: tool({
      description: 'Get current weather data for a city.',
      inputSchema: z.object({
        city: z.string().describe('Name of the city'),
      }),
      execute: async ({ city }) => {
        // Your weather API implementation
        return { temp: 22, condition: 'Sunny' };
      },
      // Enable this tool to be called from within code execution
      providerOptions: {
        anthropic: {
          allowedCallers: ['code_execution_20260120'],
        },
      },
    }),
  },

  // Propagate container ID between steps for code execution continuity
  prepareStep: forwardAnthropicContainerIdFromLastStep,
});
```

In this flow:

1. Claude writes Python code that calls your `getWeather` tool multiple times in parallel
2. The SDK automatically executes your tool and returns results to the code execution container
3. Claude processes the results in code and generates the final response

<Note>
  Programmatic tool calling requires `claude-sonnet-4-6`, `claude-sonnet-4-5`,
  `claude-opus-4-6`, or `claude-opus-4-5` models and uses the
  `code_execution_20260120` or `code_execution_20250825` tool.
</Note>

#### Container Persistence

When using programmatic tool calling across multiple steps, you need to preserve the container ID between steps using `prepareStep`. You can use the `forwardAnthropicContainerIdFromLastStep` helper function to do this automatically. The container ID is available in `providerMetadata.anthropic.container.id` after each step completes.

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
import { anthropic, AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
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
    } satisfies AnthropicLanguageModelOptions,
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
    } satisfies AnthropicLanguageModelOptions,
  },
});
```

<Note>
  Skills use progressive context loading and execute within a sandboxed
  container with code execution capabilities.
</Note>

### PDF support

Anthropic Claude models support reading PDF files.
You can pass PDF files as part of the message content using the `file` type:

Option 1: URL-based PDF document

```ts
const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
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
  model: anthropic('claude-sonnet-4-5'),
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

| Model               | Image Input         | Object Generation   | Tool Usage          | Computer Use        | Web Search          | Tool Search         | Compaction          |
| ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `claude-opus-4-7`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-opus-4-6`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `claude-sonnet-4-6` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-opus-4-5`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-haiku-4-5`  | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-sonnet-4-5` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |
| `claude-opus-4-1`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-opus-4-0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |
| `claude-sonnet-4-0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |                     |                     |

<Note>
  The table above lists popular models. Please see the [Anthropic
  docs](https://docs.anthropic.com/en/docs/about-claude/models) for a full list
  of available models. The table above lists popular models. You can also pass
  any available provider model ID as a string if needed.
</Note>

---
title: Open Responses
description: Learn how to use the Open Responses provider for the AI SDK.
---

# Open Responses Provider

The [Open Responses](https://www.openresponses.org/) provider contains language model support for Open Responses compatible APIs.

## Setup

The Open Responses provider is available in the `@ai-sdk/open-responses` module. You can install it with

<Tabs items={['pnpm', 'npm', 'yarn', 'bun']}>
  <Tab>
    <Snippet text="pnpm add @ai-sdk/open-responses" dark />
  </Tab>
  <Tab>
    <Snippet text="npm install @ai-sdk/open-responses" dark />
  </Tab>
  <Tab>
    <Snippet text="yarn add @ai-sdk/open-responses" dark />
  </Tab>
  <Tab>
    <Snippet text="bun add @ai-sdk/open-responses" dark />
  </Tab>
</Tabs>

## Provider Instance

Create an Open Responses provider instance using `createOpenResponses`:

```ts
import { createOpenResponses } from '@ai-sdk/open-responses';

const openResponses = createOpenResponses({
  name: 'aProvider',
  url: 'http://localhost:1234/v1/responses',
});
```

The `name` and `url` options are required:

- **name** _string_

  Provider name. Used as the key for provider options and metadata.

- **url** _string_

  URL for the Open Responses API POST endpoint.

You can use the following optional settings to customize the Open Responses provider instance:

- **apiKey** _string_

  API key that is being sent using the `Authorization` header.

- **headers** _Record&lt;string,string&gt;_

  Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) => Promise&lt;Response&gt;_

  Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  Defaults to the global `fetch` function.

## Language Models

The Open Responses provider instance is a function that you can invoke to create a language model:

```ts
const model = openResponses('mistralai/ministral-3-14b-reasoning');
```

You can use Open Responses models with the `generateText` and `streamText` functions,
and they support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

### Example

```ts
import { createOpenResponses } from '@ai-sdk/open-responses';
import { generateText } from 'ai';

const openResponses = createOpenResponses({
  name: 'aProvider',
  url: 'http://localhost:1234/v1/responses',
});

const { text } = await generateText({
  model: openResponses('mistralai/ministral-3-14b-reasoning'),
  prompt: 'Invent a new holiday and describe its traditions.',
});
```

## Notes

- Stop sequences, `topK`, and `seed` are not supported and are ignored with warnings.
- Image inputs are supported for user messages with `file` parts using image media types.

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

- **apiKey** _string_

  Optional. API key for authenticating requests using Bearer token authentication.
  When provided, this will be used instead of AWS SigV4 authentication.
  It uses the `AWS_BEARER_TOKEN_BEDROCK` environment variable by default.

- **baseURL** _string_

  Optional. Base URL for the Bedrock API calls.
  Useful for custom endpoints or proxy configurations.

- **headers** _Record&lt;string, string&gt;_

  Optional. Custom headers to include in the requests.

- **fetch** _(input: RequestInfo, init?: RequestInit) =&gt; Promise&lt;Response&gt;_

  Optional. Custom [fetch](https://developer.mozilla.org/en-US/docs/Web/API/fetch) implementation.
  You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.

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
  Amazon Bedrock supports file inputs in combination with specific models, e.g.
  `anthropic.claude-3-haiku-20240307-v1:0`.
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
          data: readFileSync('./data/ai.pdf'),
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
import { type AmazonBedrockLanguageModelOptions } from '@ai-sdk/amazon-bedrock';

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
    } satisfies AmazonBedrockLanguageModelOptions,
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
import { generateText, Output } from 'ai';
import { z } from 'zod';
import fs from 'fs';

const result = await generateText({
  model: bedrock('apac.anthropic.claude-sonnet-4-20250514-v1:0'),
  output: Output.object({
    schema: z.object({
      summary: z.string().describe('Summary of the PDF document'),
      keyPoints: z.array(z.string()).describe('Key points from the PDF'),
    }),
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
          data: readFileSync('./document.pdf'),
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

console.log('Response:', result.output);
```

### Cache Points

<Note>
  Amazon Bedrock prompt caching is currently in preview release. To request
  access, visit the [Amazon Bedrock prompt caching
  page](https://aws.amazon.com/bedrock/prompt-caching/).
</Note>

In messages, you can use the `providerOptions` property to set cache points. Set the `bedrock` property in the `providerOptions` object to `{ cachePoint: { type: 'default' } }` to create a cache point.

You can also specify a TTL (time-to-live) for cache points using the `ttl` property. Supported values are `'5m'` (5 minutes, default) and `'1h'` (1 hour). The 1-hour TTL is only supported by Claude Opus 4.5, Claude Haiku 4.5, and Claude Sonnet 4.5.

```ts
providerOptions: {
  bedrock: { cachePoint: { type: 'default', ttl: '1h' } },
}
```

<Note>
  When using multiple cache points with different TTLs, cache entries with
  longer TTL must appear before shorter TTLs (i.e., 1-hour cache entries must
  come before 5-minute cache entries).
</Note>

Cache usage information is returned in the `providerMetadata` object. See examples below.

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

### Provider Metadata

The following Bedrock-specific metadata may be returned in `providerMetadata.bedrock`:

- **trace** _(optional)_
  Guardrail tracing information (when tracing is enabled).
- **performanceConfig** _(optional)_
  Performance configuration, e.g. `{ latency: 'optimized' }`.
- **serviceTier** _(optional)_
  Service tier information, e.g. `{ type: 'on-demand' }`.
- **usage** _(optional)_
  Cache token usage details including `cacheWriteInputTokens` and `cacheDetails`.
- **stopSequence** _string | null_
  The stop sequence that triggered the stop, if any.

## Reasoning

Amazon Bedrock supports model creator-specific reasoning features:

- Anthropic (e.g. `claude-sonnet-4-5-20250929`): enable via the `reasoningConfig` provider option and specifying a thinking budget in tokens (minimum: `1024`, maximum: `64000`).
- Amazon (e.g. `us.amazon.nova-2-lite-v1:0`): enable via the `reasoningConfig` provider option and specifying a maximum reasoning effort level (`'low' | 'medium' | 'high'`).

```ts
import {
  bedrock,
  type AmazonBedrockLanguageModelOptions,
} from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

// Anthropic example
const anthropicResult = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    bedrock: {
      reasoningConfig: { type: 'enabled', budgetTokens: 1024 },
    } satisfies AmazonBedrockLanguageModelOptions,
  },
});

console.log(anthropicResult.reasoningText); // reasoning text
console.log(anthropicResult.text); // text response

// Nova 2 example
const amazonResult = await generateText({
  model: bedrock('us.amazon.nova-2-lite-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    bedrock: {
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'medium' },
    } satisfies AmazonBedrockLanguageModelOptions,
  },
});

console.log(amazonResult.reasoningText); // reasoning text
console.log(amazonResult.text); // text response
```

See [AI SDK UI: Chatbot](/docs/ai-sdk-ui/chatbot#reasoning) for more details
on how to integrate reasoning into your chatbot.

## Service Tiers

Amazon Bedrock supports selecting an inference service tier per request via the `serviceTier` provider option.

```ts
import {
  bedrock,
  type AmazonBedrockLanguageModelOptions,
} from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const result = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  prompt: 'Summarize this support ticket backlog.',
  providerOptions: {
    bedrock: {
      serviceTier: 'priority',
    } satisfies AmazonBedrockLanguageModelOptions,
  },
});
```

Supported values are:

- `reserved`
- `priority`
- `default`
- `flex`

See the [Amazon Bedrock service tiers documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html) for model availability and behavior.

## Extended Context Window

Claude Sonnet 4 models on Amazon Bedrock support an extended context window of up to 1 million tokens when using the `context-1m-2025-08-07` beta feature.

```ts
import {
  bedrock,
  type AmazonBedrockLanguageModelOptions,
} from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const result = await generateText({
  model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  prompt: 'analyze this large document...',
  providerOptions: {
    bedrock: {
      anthropicBeta: ['context-1m-2025-08-07'],
    } satisfies AmazonBedrockLanguageModelOptions,
  },
});
```

## Computer Use

Via Anthropic, Amazon Bedrock provides three provider-defined tools that can be used to interact with external systems:

1. **Bash Tool**: Allows running bash commands.
2. **Text Editor Tool**: Provides functionality for viewing and editing text files.
3. **Computer Tool**: Enables control of keyboard and mouse actions on a computer.

They are available via the `tools` property of the provider instance.

<Note>
  Amazon Bedrock does not support strict mode on tool definitions. Setting
  `strict: true` on a tool will be ignored and a warning will be emitted.
</Note>

### Bash Tool

The Bash Tool allows running bash commands. Here's how to create and use it:

```ts
const bashTool = bedrock.tools.bash_20241022({
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
const textEditorTool = bedrock.tools.textEditor_20250429({
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

**For Claude 3.5 Sonnet and earlier models:**

```ts
const textEditorTool = bedrock.tools.textEditor_20241022({
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

- `command` ('view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'): The command to run. Note: `undo_edit` is only available in Claude 3.5 Sonnet and earlier models.
- `path` (string): Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.
- `file_text` (string, optional): Required for `create` command, with the content of the file to be created.
- `insert_line` (number, optional): Required for `insert` command. The line number after which to insert the new string.
- `new_str` (string, optional): New string for `str_replace` command.
- `insert_text` (string, optional): Required for `insert` command, containing the text to insert.
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
const computerTool = bedrock.tools.computer_20241022({
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
| `anthropic.claude-3-5-sonnet-20241022-v2:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-5-sonnet-20240620-v1:0`    | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-opus-20240229-v1:0`        | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-sonnet-20240229-v1:0`      | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `anthropic.claude-3-haiku-20240307-v1:0`       | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-20250514-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-20250514-v1:0`     | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-opus-4-1-20250805-v1:0`   | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| `us.anthropic.claude-3-5-sonnet-20240620-v1:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
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
  for a full list of available models. You can also pass any available provider
  model ID as a string if needed.
</Note>

## Embedding Models

You can create models that call the Bedrock API [Bedrock API](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)
using the `.embedding()` factory method.

```ts
const model = bedrock.embedding('amazon.titan-embed-text-v1');
```

Bedrock Titan embedding model amazon.titan-embed-text-v2:0 supports several additional settings.
You can pass them as an options argument:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { type AmazonBedrockEmbeddingModelOptions } from '@ai-sdk/amazon-bedrock';
import { embed } from 'ai';

const model = bedrock.embedding('amazon.titan-embed-text-v2:0');

const { embedding } = await embed({
  model,
  value: 'sunny day at the beach',
  providerOptions: {
    bedrock: {
      dimensions: 512, // optional, number of dimensions for the embedding
      normalize: true, // optional, normalize the output embeddings
    } satisfies AmazonBedrockEmbeddingModelOptions,
  },
});
```

The following optional provider options are available for Bedrock Titan embedding models:

- **dimensions**: _number_

  The number of dimensions the output embeddings should have. The following values are accepted: 1024 (default), 512, 256.

- **normalize** _boolean_

  Flag indicating whether or not to normalize the output embeddings. Defaults to true.

### Nova Embedding Models

Amazon Nova embedding models support additional provider options:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { type AmazonBedrockEmbeddingModelOptions } from '@ai-sdk/amazon-bedrock';
import { embed } from 'ai';

const { embedding } = await embed({
  model: bedrock.embedding('amazon.nova-embed-text-v2:0'),
  value: 'sunny day at the beach',
  providerOptions: {
    bedrock: {
      embeddingDimension: 1024, // optional, number of dimensions
      embeddingPurpose: 'TEXT_RETRIEVAL', // optional, purpose of embedding
      truncate: 'END', // optional, truncation behavior
    } satisfies AmazonBedrockEmbeddingModelOptions,
  },
});
```

The following optional provider options are available for Nova embedding models:

- **embeddingDimension** _number_

  The number of dimensions for the output embeddings. Supported values: 256, 384, 1024 (default), 3072.

- **embeddingPurpose** _string_

  The purpose of the embedding. Accepts: `GENERIC_INDEX` (default), `TEXT_RETRIEVAL`, `IMAGE_RETRIEVAL`, `VIDEO_RETRIEVAL`, `DOCUMENT_RETRIEVAL`, `AUDIO_RETRIEVAL`, `GENERIC_RETRIEVAL`, `CLASSIFICATION`, `CLUSTERING`.

- **truncate** _string_

  Truncation behavior when input exceeds the model's context length. Accepts: `NONE`, `START`, `END` (default).

### Cohere Embedding Models

Cohere embedding models on Bedrock require an `inputType` and support truncation:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { type AmazonBedrockEmbeddingModelOptions } from '@ai-sdk/amazon-bedrock';
import { embed } from 'ai';

const { embedding } = await embed({
  model: bedrock.embedding('cohere.embed-english-v3'),
  value: 'sunny day at the beach',
  providerOptions: {
    bedrock: {
      inputType: 'search_document', // required for Cohere
      truncate: 'END', // optional, truncation behavior
    } satisfies AmazonBedrockEmbeddingModelOptions,
  },
});
```

The following provider options are available for Cohere embedding models:

- **inputType** _string_

  Input type for Cohere embedding models. Accepts: `search_document`, `search_query` (default), `classification`, `clustering`.

- **truncate** _string_

  Truncation behavior when input exceeds the model's context length. Accepts: `NONE`, `START`, `END`.

### Model Capabilities

| Model                          | Default Dimensions | Custom Dimensions   |
| ------------------------------ | ------------------ | ------------------- |
| `amazon.titan-embed-text-v1`   | 1536               | <Cross size={18} /> |
| `amazon.titan-embed-text-v2:0` | 1024               | <Check size={18} /> |
| `amazon.nova-embed-text-v2:0`  | 1024               | <Check size={18} /> |
| `cohere.embed-english-v3`      | 1024               | <Cross size={18} /> |
| `cohere.embed-multilingual-v3` | 1024               | <Cross size={18} /> |

## Reranking Models

You can create models that call the [Bedrock Rerank API](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-api.html)
using the `.reranking()` factory method.

```ts
const model = bedrock.reranking('cohere.rerank-v3-5:0');
```

You can use Amazon Bedrock reranking models to rerank documents with the `rerank` function:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { rerank } from 'ai';

const documents = [
  'sunny day at the beach',
  'rainy afternoon in the city',
  'snowy night in the mountains',
];

const { ranking } = await rerank({
  model: bedrock.reranking('cohere.rerank-v3-5:0'),
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

Amazon Bedrock reranking models support additional provider options that can be passed via `providerOptions.bedrock`:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { rerank } from 'ai';

const { ranking } = await rerank({
  model: bedrock.reranking('cohere.rerank-v3-5:0'),
  documents: ['sunny day at the beach', 'rainy afternoon in the city'],
  query: 'talk about rain',
  providerOptions: {
    bedrock: {
      nextToken: 'pagination_token_here',
    },
  },
});
```

The following provider options are available:

- **nextToken** _string_

  Token for pagination of results.

- **additionalModelRequestFields** _Record&lt;string, unknown&gt;_

  Additional model-specific request fields.

### Model Capabilities

| Model                  |
| ---------------------- |
| `amazon.rerank-v1:0`   |
| `cohere.rerank-v3-5:0` |

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

You can then generate images with the `generateImage` function:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateImage } from 'ai';

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
import { generateImage } from 'ai';

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

### Image Editing

Amazon Nova Canvas supports several image editing task types. When you provide input images via `prompt.images`, the model automatically detects the appropriate editing mode, or you can explicitly specify the `taskType` in provider options.

#### Image Variation

Create variations of an existing image while maintaining its core characteristics:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: {
    text: 'Modernize the style, photo-realistic, 8k, hdr',
    images: [imageBuffer],
  },
  providerOptions: {
    bedrock: {
      taskType: 'IMAGE_VARIATION',
      similarityStrength: 0.7, // 0-1, higher = closer to original
      negativeText: 'bad quality, low resolution',
    },
  },
});
```

- **similarityStrength** _number_

  Controls how similar the output is to the input image. Values range from 0 to 1, where higher values produce results closer to the original.

#### Inpainting

Edit specific parts of an image. You can define the area to modify using either a mask image or a text prompt:

**Using a mask prompt (text-based selection):**

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: {
    text: 'a cute corgi dog in the same style',
    images: [imageBuffer],
  },
  providerOptions: {
    bedrock: {
      maskPrompt: 'cat', // Describe what to replace
    },
  },
  seed: 42,
});
```

**Using a mask image:**

```ts
const image = readFileSync('./input-image.png');
const mask = readFileSync('./mask.png'); // White pixels = area to change

const { images } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: {
    text: 'A sunlit indoor lounge area with a pool containing a flamingo',
    images: [image],
    mask: mask,
  },
});
```

- **maskPrompt** _string_

  A text description of the area to modify. The model will automatically identify and mask the described region.

#### Outpainting

Extend an image beyond its original boundaries:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: {
    text: 'A beautiful sunset landscape with mountains',
    images: [imageBuffer],
  },
  providerOptions: {
    bedrock: {
      taskType: 'OUTPAINTING',
      maskPrompt: 'background',
      outPaintingMode: 'DEFAULT', // or 'PRECISE'
    },
  },
});
```

- **outPaintingMode** _string_

  Controls how the outpainting is performed. Accepts `'DEFAULT'` or `'PRECISE'`.

#### Background Removal

Remove the background from an image:

```ts
const imageBuffer = readFileSync('./input-image.png');

const { images } = await generateImage({
  model: bedrock.image('amazon.nova-canvas-v1:0'),
  prompt: {
    images: [imageBuffer],
  },
  providerOptions: {
    bedrock: {
      taskType: 'BACKGROUND_REMOVAL',
    },
  },
});
```

<Note>
  Background removal does not require a text prompt - only the input image is
  needed.
</Note>

#### Image Editing Provider Options

The following additional provider options are available for image editing:

- **taskType** _string_

  Explicitly set the editing task type. Accepts `'TEXT_IMAGE'` (default for text-only), `'IMAGE_VARIATION'`, `'INPAINTING'`, `'OUTPAINTING'`, or `'BACKGROUND_REMOVAL'`. When images are provided without an explicit taskType, the model defaults to `'IMAGE_VARIATION'` (or `'INPAINTING'` if a mask is provided).

- **maskPrompt** _string_

  Text description of the area to modify (for inpainting/outpainting). Alternative to providing a mask image.

- **similarityStrength** _number_

  For `IMAGE_VARIATION`: Controls similarity to the original (0-1).

- **outPaintingMode** _string_

  For `OUTPAINTING`: Controls the outpainting behavior (`'DEFAULT'` or `'PRECISE'`).

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
  model: bedrockAnthropic('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
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
import { generateText, isStepCount } from 'ai';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  tools: {
    bash: bedrockAnthropic.tools.bash_20241022({
      execute: async ({ command }) => {
        // Implement your bash command execution logic here
        return [{ type: 'text', text: `Executed: ${command}` }];
      },
    }),
  },
  prompt: 'List the files in my directory.',
  stopWhen: isStepCount(2),
});
```

#### Text Editor Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, isStepCount } from 'ai';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  tools: {
    str_replace_editor: bedrockAnthropic.tools.textEditor_20241022({
      execute: async ({ command, path, old_str, new_str, insert_text }) => {
        // Implement your text editing logic here
        return 'File updated successfully';
      },
    }),
  },
  prompt: 'Update my README file.',
  stopWhen: isStepCount(5),
});
```

#### Computer Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, isStepCount } from 'ai';
import fs from 'fs';

const result = await generateText({
  model: bedrockAnthropic('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
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
  stopWhen: isStepCount(3),
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
| `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

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
title: Google
description: Learn how to use Google Provider.
---

# Google Provider

The [Google](https://ai.google.dev) provider contains language and embedding model support for
the [Google](https://ai.google.dev/api/rest) APIs.

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

If you need a customized setup, you can import `createGoogle` from `@ai-sdk/google` and create a provider instance with your settings:

```ts
import { createGoogle } from '@ai-sdk/google';

const google = createGoogle({
  // custom settings
});
```

You can use the following optional settings to customize the Google provider instance:

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

You can use Google language models to generate text with the `generateText` function:

```ts
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

const { text } = await generateText({
  model: google('gemini-2.5-flash'),
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

Google language models can also be used in the `streamText` function
and support structured data generation with [`Output`](/docs/reference/ai-sdk-core/output)
(see [AI SDK Core](/docs/ai-sdk-core)).

Google also supports some model specific settings that are not part of the [standard call settings](/docs/ai-sdk-core/settings).
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

The following optional provider options are available for Google models:

- **cachedContent** _string_

  Optional. The name of the cached content used as context to serve the prediction.
  Format: cachedContents/\{cachedContent\}

- **structuredOutputs** _boolean_

  Optional. Enable structured output. Default is true.

  This is useful when the JSON Schema contains elements that are
  not supported by the OpenAPI schema version that
  Google uses. You can use this to disable
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

  Optional. Configuration for the model's thinking process. Only supported by specific [Google models](https://ai.google.dev/gemini-api/docs/thinking).

  - **thinkingLevel** _'minimal' | 'low' | 'medium' | 'high'_

    Optional. Controls the thinking depth for Gemini 3 models. Gemini 3.1 Pro supports 'low', 'medium', and 'high', Gemini 3 Pro supports 'low' and 'high', while Gemini 3 Flash supports all four levels: 'minimal', 'low', 'medium', and 'high'. Only supported by Gemini 3 models.

  - **thinkingBudget** _number_

    Optional. Gives the model guidance on the number of thinking tokens it can use when generating a response. Setting it to 0 disables thinking, if the model supports it.
    For more information about the possible value ranges for each model see [Google thinking documentation](https://ai.google.dev/gemini-api/docs/thinking#set-budget).

    <Note>
      This option is for Gemini 2.5 models. Gemini 3 models should use
      `thinkingLevel` instead.
    </Note>

  - **includeThoughts** _boolean_

    Optional. If set to true, thought summaries are returned, which are synthesized versions of the model's raw thoughts and offer insights into the model's internal reasoning process.

- **imageConfig** _\{ aspectRatio?: string, imageSize?: string \}_

  Optional. Configuration for the models image generation. Only supported by specific [Google models](https://ai.google.dev/gemini-api/docs/image-generation).

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

The Gemini 2.5 and Gemini 3 series models use an internal "thinking process" that significantly improves their reasoning and multi-step planning abilities, making them highly effective for complex tasks such as coding, advanced mathematics, and data analysis. For more information see [Google thinking documentation](https://ai.google.dev/gemini-api/docs/thinking).

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

The Google provider supports file inputs, e.g. PDF files.

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

Google supports both explicit and implicit caching to help reduce costs on repetitive content.

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
import { GoogleProviderMetadata } from '@ai-sdk/google';
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
  | GoogleProviderMetadata
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
  | GoogleProviderMetadata
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
      "retrievedUrl": "https://ai-sdk.dev/providers/ai-sdk-providers/google",
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
                "uri": "https://ai-sdk.dev/providers/ai-sdk-providers/google",
                "title": "Google - AI SDK Providers"
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
  prompt: `Based on this context: https://ai-sdk.dev/providers/ai-sdk-providers/google, tell me how to use Gemini with AI SDK.
    Also, provide the latest news about AI SDK V5.`,
  tools: {
    google_search: google.tools.googleSearch({}),
    url_context: google.tools.urlContext({}),
  },
});

const metadata = providerMetadata?.google as
  | GoogleProviderMetadata
  | undefined;
const groundingMetadata = metadata?.groundingMetadata;
const urlContextMetadata = metadata?.urlContextMetadata;
```

### Google Maps Grounding

With [Google Maps grounding](https://ai.google.dev/gemini-api/docs/maps-grounding),
the model has access to Google Maps data for location-aware responses. This enables providing local data and geospatial context, such as finding nearby restaurants.

```ts highlight="7-16"
import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { GoogleProviderMetadata } from '@ai-sdk/google';
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
  | GoogleProviderMetadata
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
import { GoogleProviderMetadata } from '@ai-sdk/google';
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
  | GoogleProviderMetadata
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

The following Zod features are known to not work with Google:

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

The Google provider sends API calls to the right endpoint based on the type of embedding:

- **Single embeddings**: When embedding a single value with `embed()`, the provider uses the single `:embedContent` endpoint, which typically has higher rate limits compared to the batch endpoint.
- **Batch embeddings**: When embedding multiple values with `embedMany()` or multiple values in `embed()`, the provider uses the `:batchEmbedContents` endpoint.

Google embedding models support additional settings. You can pass them as an options argument:

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

The following optional provider options are available for Google embedding models:

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

