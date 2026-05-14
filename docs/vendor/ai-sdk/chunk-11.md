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

By default, `xai(modelId)` uses the Chat API. To use the Responses API with server-side agentic tools, explicitly use `xai.responses(modelId)`.

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

### Provider Options

xAI chat models support additional provider options that are not part of
the [standard call settings](/docs/ai-sdk-core/settings). You can pass them in the `providerOptions` argument:

```ts
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

const model = xai('grok-3-mini');

await generateText({
  model,
  providerOptions: {
    xai: {
      reasoningEffort: 'high',
    } satisfies XaiLanguageModelChatOptions,
  },
});
```

The following optional provider options are available for xAI chat models:

- **reasoningEffort** _'low' | 'high'_

  Reasoning effort for reasoning models.

- **logprobs** _boolean_

  Return log probabilities for output tokens.

- **topLogprobs** _number_

  Number of most likely tokens to return per token position (0-8). When set, `logprobs` is automatically enabled.

- **parallel_function_calling** _boolean_

  Whether to enable parallel function calling during tool use. When true, the model can call multiple functions in parallel. When false, the model will call functions sequentially. Defaults to `true`.

## Responses API (Agentic Tools)

You can use the xAI Responses API with the `xai.responses(modelId)` factory method for server-side agentic tool calling. This enables the model to autonomously orchestrate tool calls and research on xAI's servers.

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

## Live Search

xAI models support Live Search functionality, allowing them to query real-time data from various sources and include it in responses with citations.

### Basic Search

To enable search, specify `searchParameters` with a search mode:

```ts
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';
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
    } satisfies XaiLanguageModelChatOptions,
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
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

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
    } satisfies XaiLanguageModelChatOptions,
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
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

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
    } satisfies XaiLanguageModelChatOptions,
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
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

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
    } satisfies XaiLanguageModelChatOptions,
  },
});
```

#### News source parameters

- **country** _string_: ISO alpha-2 country code
- **excludedWebsites** _string[]_: Max 5 excluded websites
- **safeSearch** _boolean_: Enable safe search (default: true)

#### RSS Feed Search

```ts
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

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
    } satisfies XaiLanguageModelChatOptions,
  },
});
```

#### RSS source parameters

- **links** _string[]_: Array of RSS feed URLs (max 1 currently supported)

### Multiple Sources

You can combine multiple data sources in a single search:

```ts
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

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
    } satisfies XaiLanguageModelChatOptions,
  },
});
```

### Sources and Citations

When search is enabled with `returnCitations: true`, the response includes sources that were used to generate the answer:

```ts
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';

const { text, sources } = await generateText({
  model: xai('grok-3-latest'),
  prompt: 'What are the latest developments in AI?',
  providerOptions: {
    xai: {
      searchParameters: {
        mode: 'auto',
        returnCitations: true,
      },
    } satisfies XaiLanguageModelChatOptions,
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
import { xai, type XaiLanguageModelChatOptions } from '@ai-sdk/xai';
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
    } satisfies XaiLanguageModelChatOptions,
  },
});

for await (const textPart of result.textStream) {
  process.stdout.write(textPart);
}

console.log('Sources:', await result.sources);
```

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
  stopWhen: stepCountIs(2),
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
  stopWhen: stepCountIs(5),
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
import { generateText, stepCountIs } from 'ai';

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
  stopWhen: stepCountIs(5),
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
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: openai.responses('gpt-5.4'),
  prompt: 'What is the weather in San Francisco?',
  stopWhen: stepCountIs(10),
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
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: openai.responses('gpt-5.4'),
  prompt: 'What is the weather in San Francisco?',
  stopWhen: stepCountIs(10),
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
import { generateText, stepCountIs } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-5.2-codex'),
  tools: {
    write_sql: openai.tools.customTool({
      name: 'write_sql',
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
  stopWhen: stepCountIs(3),
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
      name: 'write_sql',
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

- **name** _string_ (required) - The name of the custom tool. Used to identify the tool in tool calls.
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

The cache creation input tokens are then returned in the `providerMetadata` object
for `generateText`, again under the `anthropic` property.
When you use `streamText`, the response contains a promise
that resolves to the metadata. Alternatively you can receive it in the
`onFinish` callback.

```ts highlight="8,18-20,29-30"
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
console.log(result.providerMetadata?.anthropic);
// e.g. { cacheCreationInputTokens: 2118 }
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
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  stopWhen: stepCountIs(10),
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
import { generateText, stepCountIs } from 'ai';

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
  stopWhen: stepCountIs(2),
});
```

#### Text Editor Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, stepCountIs } from 'ai';

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
  stopWhen: stepCountIs(5),
});
```

#### Computer Tool

```ts
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { generateText, stepCountIs } from 'ai';
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

