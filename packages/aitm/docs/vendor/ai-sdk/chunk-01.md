// CONTRIBUTING GUIDE
// https://github.com/vercel/ai/blob/main/contributing/add-new-tool-to-registry.md

export interface Tool {
  slug: string;
  name: string;
  description: string;
  packageName: string;
  tags?: string[];
  apiKeyEnvName?: string;
  installCommand: {
    pnpm: string;
    npm: string;
    yarn: string;
    bun: string;
  };
  codeExample: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  websiteUrl?: string;
  npmUrl?: string;
}

export const tools: Tool[] = [
  {
    slug: 'code-execution',
    name: 'Code Execution',
    description:
      'Execute Python code in a sandboxed environment using Vercel Sandbox. Run calculations, data processing, and other computational tasks safely in an isolated environment with Python 3.13.',
    packageName: 'ai-sdk-tool-code-execution',
    tags: ['code-execution', 'sandbox'],
    apiKeyEnvName: 'VERCEL_OIDC_TOKEN',
    installCommand: {
      pnpm: 'pnpm add ai-sdk-tool-code-execution',
      npm: 'npm install ai-sdk-tool-code-execution',
      yarn: 'yarn add ai-sdk-tool-code-execution',
      bun: 'bun add ai-sdk-tool-code-execution',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { executeCode } from 'ai-sdk-tool-code-execution';

const { text } = await generateText({
  model: 'openai/gpt-5.1-codex',
  prompt: 'What is 5 + 5 minus 84 cubed?',
  tools: {
    executeCode: executeCode(),
  },
  stopWhen: stepCountIs(5),
});

console.log(text);`,
    docsUrl: 'https://vercel.com/docs/vercel-sandbox',
    apiKeyUrl: 'https://vercel.com/docs/vercel-sandbox#authentication',
    websiteUrl: 'https://vercel.com/docs/vercel-sandbox',
    npmUrl: 'https://www.npmjs.com/package/ai-sdk-tool-code-execution',
  },
  {
    slug: 'exa',
    name: 'Exa',
    description:
      'Exa is a web search API that adds web search capabilities to your LLMs. Exa can search the web for code docs, current information, news, articles, and a lot more. Exa performs real-time web searches and can get page content from specific URLs. Add Exa web search tool to your LLMs in just a few lines of code.',
    packageName: '@exalabs/ai-sdk',
    tags: ['search', 'web', 'extraction'],
    apiKeyEnvName: 'EXA_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @exalabs/ai-sdk',
      npm: 'npm install @exalabs/ai-sdk',
      yarn: 'yarn add @exalabs/ai-sdk',
      bun: 'bun add @exalabs/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { webSearch } from '@exalabs/ai-sdk';

const { text } = await generateText({
  model: 'google/gemini-3-pro-preview',
  prompt: 'Tell me the latest developments in AI',
  tools: {
    webSearch: webSearch(),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.exa.ai/reference/vercel',
    apiKeyUrl: 'https://dashboard.exa.ai/api-keys',
    websiteUrl: 'https://exa.ai',
    npmUrl: 'https://www.npmjs.com/package/@exalabs/ai-sdk',
  },
  {
    slug: 'parallel',
    name: 'Parallel',
    description:
      'Parallel gives AI agents best-in-class tools to search and extract context from the web. Web results returned by Parallel are compressed for optimal token efficiency at inference time.',
    packageName: '@parallel-web/ai-sdk-tools',
    tags: ['search', 'web', 'extraction'],
    apiKeyEnvName: 'PARALLEL_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @parallel-web/ai-sdk-tools',
      npm: 'npm install @parallel-web/ai-sdk-tools',
      yarn: 'yarn add @parallel-web/ai-sdk-tools',
      bun: 'bun add @parallel-web/ai-sdk-tools',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { searchTool, extractTool } from '@parallel-web/ai-sdk-tools';

const { text } = await generateText({
  model: 'google/gemini-3-pro-preview',
  prompt: 'When was Vercel Ship AI?',
  tools: {
    webSearch: searchTool,
    webExtract: extractTool,
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    apiKeyUrl: 'https://platform.parallel.ai',
    websiteUrl: 'https://parallel.ai',
    npmUrl: 'https://www.npmjs.com/package/@parallel-web/ai-sdk-tools',
  },
  {
    slug: 'ctx-zip',
    name: 'ctx-zip',
    description:
      'Transform MCP tools and AI SDK tools into code, write it to a Vercel sandbox file system and have the agent import the tools, write code, and execute it.',
    packageName: 'ctx-zip',
    tags: ['code-execution', 'sandbox', 'mcp', 'code-mode'],
    apiKeyEnvName: 'VERCEL_OIDC_TOKEN',
    installCommand: {
      pnpm: 'pnpm add ctx-zip',
      npm: 'npm install ctx-zip',
      yarn: 'yarn add ctx-zip',
      bun: 'bun add ctx-zip',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { createVercelSandboxCodeMode, SANDBOX_SYSTEM_PROMPT } from 'ctx-zip';

const { tools } = await createVercelSandboxCodeMode({
  servers: [
    {
      name: 'vercel',
      url: 'https://mcp.vercel.com',
      useSSE: false,
      headers: {
        Authorization: \`Bearer \${process.env.VERCEL_API_KEY}\`,
      },
    },
  ],
  standardTools: {
    weather: weatherTool,
  },
});

const { text } = await generateText({
  model: 'openai/gpt-5.2',
  tools,
  stopWhen: stepCountIs(20),
  system: SANDBOX_SYSTEM_PROMPT,
  messages: [
    {
      role: 'user',
      content: 'What tools are available from the Vercel MCP server?',
    },
  ],
});

console.log(text);
`,
    docsUrl: 'https://github.com/karthikscale3/ctx-zip/blob/main/README.md',
    apiKeyUrl: 'https://vercel.com/docs/vercel-sandbox#authentication',
    websiteUrl: 'https://github.com/karthikscale3/ctx-zip/blob/main/README.md',
    npmUrl: 'https://www.npmjs.com/package/ctx-zip',
  },
  {
    slug: 'perplexity-search',
    name: 'Perplexity Search',
    description:
      "Search the web with real-time results and advanced filtering powered by Perplexity's Search API. Provides ranked search results with domain, language, date range, and recency filters. Supports multi-query searches and regional search results.",
    packageName: '@perplexity-ai/ai-sdk',
    tags: ['search', 'web'],
    apiKeyEnvName: 'PERPLEXITY_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @perplexity-ai/ai-sdk',
      npm: 'npm install @perplexity-ai/ai-sdk',
      yarn: 'yarn add @perplexity-ai/ai-sdk',
      bun: 'bun add @perplexity-ai/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { perplexitySearch } from '@perplexity-ai/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5.2',
  prompt: 'What are the latest AI developments? Use search to find current information.',
  tools: {
    search: perplexitySearch(),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.perplexity.ai/guides/search-quickstart',
    apiKeyUrl: 'https://www.perplexity.ai/account/api/keys',
    websiteUrl: 'https://www.perplexity.ai',
    npmUrl: 'https://www.npmjs.com/package/@perplexity-ai/ai-sdk',
  },
  {
    slug: 'tavily',
    name: 'Tavily',
    description:
      'Tavily is a web intelligence platform offering real-time web search optimized for AI applications. Tavily provides comprehensive web research capabilities including search, content extraction, website crawling, and site mapping to power AI agents with current information.',
    packageName: '@tavily/ai-sdk',
    tags: ['search', 'extract', 'crawl'],
    apiKeyEnvName: 'TAVILY_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @tavily/ai-sdk',
      npm: 'npm install @tavily/ai-sdk',
      yarn: 'yarn add @tavily/ai-sdk',
      bun: 'bun add @tavily/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { tavilySearch } from '@tavily/ai-sdk';

const { text } = await generateText({
  model: 'google/gemini-3-pro-preview',
  prompt: 'What are the latest developments in agentic search?',
  tools: {
    webSearch: tavilySearch,
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.tavily.com/documentation/integrations/vercel',
    apiKeyUrl: 'https://app.tavily.com/home',
    websiteUrl: 'https://tavily.com',
    npmUrl: 'https://www.npmjs.com/package/@tavily/ai-sdk',
  },
  {
    slug: 'firecrawl',
    name: 'Firecrawl',
    description:
      'Firecrawl tools for the AI SDK. Web scraping, search, crawling, and data extraction for AI applications. Scrape any website into clean markdown, search the web, crawl entire sites, and extract structured data.',
    packageName: 'firecrawl-aisdk',
    tags: ['scraping', 'search', 'crawling', 'extraction', 'web'],
    apiKeyEnvName: 'FIRECRAWL_API_KEY',
    installCommand: {
      pnpm: 'pnpm add firecrawl-aisdk',
      npm: 'npm install firecrawl-aisdk',
      yarn: 'yarn add firecrawl-aisdk',
      bun: 'bun add firecrawl-aisdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { scrapeTool } from 'firecrawl-aisdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'Scrape https://firecrawl.dev and summarize what it does',
  tools: {
    scrape: scrapeTool,
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.firecrawl.dev/integrations/ai-sdk',
    apiKeyUrl: 'https://firecrawl.dev/app/api-keys',
    websiteUrl: 'https://firecrawl.dev',
    npmUrl: 'https://www.npmjs.com/package/firecrawl-aisdk',
  },
  {
    slug: 'bedrock-agentcore',
    name: 'Amazon Bedrock AgentCore',
    description:
      'Fully managed Browser and Code Interpreter tools for AI agents. Browser is a fast and secure cloud-based runtime for interacting with web applications, filling forms, navigating websites, and extracting information. Code Interpreter provides an isolated sandbox for executing Python, JavaScript, and TypeScript code to solve complex tasks.',
    packageName: 'bedrock-agentcore',
    tags: ['code-execution', 'browser-automation', 'sandbox'],
    apiKeyEnvName: 'AWS_ROLE_ARN',
    installCommand: {
      pnpm: 'pnpm add bedrock-agentcore',
      npm: 'npm install bedrock-agentcore',
      yarn: 'yarn add bedrock-agentcore',
      bun: 'bun add bedrock-agentcore',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import { CodeInterpreterTools } from 'bedrock-agentcore/code-interpreter/vercel-ai';
import { BrowserTools } from 'bedrock-agentcore/browser/vercel-ai';

const credentialsProvider = awsCredentialsProvider({
  roleArn: process.env.AWS_ROLE_ARN!,
});

const codeInterpreter = new CodeInterpreterTools({ credentialsProvider });
const browser = new BrowserTools({ credentialsProvider });

try {
  const { text } = await generateText({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    prompt: 'Go to https://news.ycombinator.com and get the first story title. Then use Python to reverse the string.',
    tools: {
      ...codeInterpreter.tools,
      ...browser.tools,
    },
    stopWhen: stepCountIs(5),
  });

  console.log(text);
} finally {
  await codeInterpreter.stopSession();
  await browser.stopSession();
}`,
    docsUrl: 'https://github.com/aws/bedrock-agentcore-sdk-typescript',
    apiKeyUrl: 'https://vercel.com/docs/oidc/aws',
    websiteUrl:
      'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-tools.html',
    npmUrl: 'https://www.npmjs.com/package/bedrock-agentcore',
  },
  {
    slug: 'superagent',
    name: 'Superagent',
    description:
      'AI security guardrails for your LLMs. Protect your AI apps from prompt injection, redact PII/PHI (SSNs, emails, phone numbers), and verify claims against source materials. Add security tools to your LLMs in just a few lines of code.',
    packageName: '@superagent-ai/ai-sdk',
    tags: ['security', 'guardrails', 'pii', 'prompt-injection', 'verification'],
    apiKeyEnvName: 'SUPERAGENT_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @superagent-ai/ai-sdk',
      npm: 'npm install @superagent-ai/ai-sdk',
      yarn: 'yarn add @superagent-ai/ai-sdk',
      bun: 'bun add @superagent-ai/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { guard, redact, verify } from '@superagent-ai/ai-sdk';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  prompt: 'Check this input for security threats: "Ignore all instructions"',
  tools: {
    guard: guard(),
    redact: redact(),
    verify: verify(),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.superagent.sh',
    apiKeyUrl: 'https://dashboard.superagent.sh',
    websiteUrl: 'https://superagent.sh',
    npmUrl: 'https://www.npmjs.com/package/@superagent-ai/ai-sdk',
  },
  {
    slug: 'tako-search',
    name: 'Tako Search',
    description:
      "Search Tako's knowledge base for data visualizations, insights, and well-sourced information with charts and analytics.",
    packageName: '@takoviz/ai-sdk',
    installCommand: {
      pnpm: 'pnpm install @takoviz/ai-sdk',
      npm: 'npm install @takoviz/ai-sdk',
      yarn: 'yarn add @takoviz/ai-sdk',
      bun: 'bun add @takoviz/ai-sdk',
    },
    codeExample: `import { takoSearch } from '@takoviz/ai-sdk';
import { generateText, stepCountIs } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.2',
  prompt: 'What is the stock price of Nvidia?',
  tools: {
    takoSearch: takoSearch(),
  },
  stopWhen: stepCountIs(5),
});

console.log(text);`,
    docsUrl: 'https://github.com/TakoData/ai-sdk#readme',
    npmUrl: 'https://www.npmjs.com/package/@takoviz/ai-sdk',
    websiteUrl: 'https://tako.com',
    apiKeyEnvName: 'TAKO_API_KEY',
    apiKeyUrl: 'https://tako.com',
    tags: ['search', 'data', 'visualization', 'analytics'],
  },
  {
    slug: 'valyu',
    name: 'Valyu',
    description:
      'Valyu provides powerful search tools for AI agents. Web search for real-time information, plus specialized domain-specific searchtools: financeSearch (stock prices, earnings, income statements, cash flows, etc), paperSearch (full-text PubMed, arXiv, bioRxiv, medRxiv), bioSearch (clinical trials, FDA drug labels, PubMed, medRxiv, bioRxiv), patentSearch (USPTO patents), secSearch (10-k/10-Q/8-k), economicsSearch (BLS, FRED, World Bank data), and companyResearch (comprehensive company research reports).',
    packageName: '@valyu/ai-sdk',
    tags: ['search', 'web', 'domain-search'],
    apiKeyEnvName: 'VALYU_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @valyu/ai-sdk',
      npm: 'npm install @valyu/ai-sdk',
      yarn: 'yarn add @valyu/ai-sdk',
      bun: 'bun add @valyu/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { webSearch } from '@valyu/ai-sdk';
// Available specialised search tools: financeSearch, paperSearch,
// bioSearch, patentSearch, secSearch, economicsSearch, companyResearch

const { text } = await generateText({
  model: 'google/gemini-3-pro-preview',
  prompt: 'Latest data center projects for AI inference?',
  tools: {
    webSearch: webSearch(),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.valyu.ai/integrations/vercel-ai-sdk',
    apiKeyUrl: 'https://platform.valyu.ai',
    websiteUrl: 'https://valyu.ai',
    npmUrl: 'https://www.npmjs.com/package/@valyu/ai-sdk',
  },
  {
    slug: 'airweave',
    name: 'Airweave',
    description:
      'Airweave is an open-source platform that makes any app searchable for your agent. Sync and search across 35+ data sources (Notion, Slack, Google Drive, databases, and more) with semantic search. Add unified search across all your connected data to your AI applications in just a few lines of code.',
    packageName: '@airweave/vercel-ai-sdk',
    tags: ['search', 'rag', 'data-sources', 'semantic-search'],
    apiKeyEnvName: 'AIRWEAVE_API_KEY',
    installCommand: {
      pnpm: 'pnpm install @airweave/vercel-ai-sdk',
      npm: 'npm install @airweave/vercel-ai-sdk',
      yarn: 'yarn add @airweave/vercel-ai-sdk',
      bun: 'bun add @airweave/vercel-ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { airweaveSearch } from '@airweave/vercel-ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.5',
  prompt: 'What were the key decisions from last week?',
  tools: {
    search: airweaveSearch({
      defaultCollection: 'my-knowledge-base',
    }),
  },
  stopWhen: stepCountIs(3),
});

console.log(text);`,
    docsUrl: 'https://docs.airweave.ai',
    apiKeyUrl: 'https://app.airweave.ai/settings/api-keys',
    websiteUrl: 'https://airweave.ai',
    npmUrl: 'https://www.npmjs.com/package/@airweave/vercel-ai-sdk',
  },
  {
    slug: 'bash-tool',
    name: 'bash-tool',
    description:
      'Provides bash, readFile, and writeFile tools for AI agents. Supports @vercel/sandbox for full VM isolation.',
    packageName: 'bash-tool',
    tags: ['bash', 'file-system', 'sandbox', 'code-execution'],
    installCommand: {
      pnpm: 'pnpm install bash-tool',
      npm: 'npm install bash-tool',
      yarn: 'yarn add bash-tool',
      bun: 'bun add bash-tool',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { createBashTool } from 'bash-tool';

const { tools } = await createBashTool({
  files: { 'src/index.ts': "export const hello = 'world';" },
});

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4',
  prompt: 'List the files in src/ and show me the contents of index.ts',
  tools,
  stopWhen: stepCountIs(5),
});

console.log(text);`,
    docsUrl: 'https://github.com/vercel/bash-tool',
    websiteUrl: 'https://github.com/vercel/bash-tool',
    npmUrl: 'https://www.npmjs.com/package/bash-tool',
  },
  {
    slug: 'browserbase',
    name: 'Browserbase',
    description:
      'Browserbase provides browser automation tools for AI agents powered by Stagehand. Navigate websites, take screenshots, click buttons, fill forms, extract structured data, and execute multi-step browser tasks in cloud-hosted sessions with built-in CAPTCHA solving and anti-bot stealth mode.',
    packageName: '@browserbasehq/ai-sdk',
    tags: ['browser', 'browser-automation', 'web', 'extraction'],
    apiKeyEnvName: 'BROWSERBASE_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @browserbasehq/ai-sdk',
      npm: 'npm install @browserbasehq/ai-sdk',
      yarn: 'yarn add @browserbasehq/ai-sdk',
      bun: 'bun add @browserbasehq/ai-sdk',
    },
    codeExample: `import { generateText, stepCountIs } from 'ai';
import { createBrowserbaseTools } from '@browserbasehq/ai-sdk';

const browserbase = createBrowserbaseTools();

const { text } = await generateText({
  model: 'google/gemini-3-pro-preview',
  tools: browserbase.tools,
  stopWhen: stepCountIs(10),
  prompt: 'Open https://news.ycombinator.com and summarize the top 3 stories.',
});

console.log(text);
await browserbase.closeSession();`,
    docsUrl: 'https://docs.browserbase.com',
    apiKeyUrl: 'https://www.browserbase.com/settings',
    websiteUrl: 'https://www.browserbase.com',
    npmUrl: 'https://www.npmjs.com/package/@browserbasehq/ai-sdk',
  },
];

---
title: RAG Agent
description: Learn how to build a RAG Agent with the AI SDK and Next.js
---

# RAG Chatbot Guide

In this guide, you will learn how to build a retrieval-augmented generation (RAG) Agent.

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

In this project, you will build a chatbot that will only respond with information that it has within its knowledge base. The chatbot will be able to both store and retrieve information. This project has many interesting use cases from customer support through to building your own second brain!

This project will use the following stack:

- [Next.js](https://nextjs.org) 14 (App Router)
- [ AI SDK ](/docs)
- [OpenAI](https://openai.com)
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

You will need a Postgres database to complete this tutorial. If you don’t have Postgres setup on your local machine you can:

- Create a free Postgres database with [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres); or
- Follow [this guide](https://www.prisma.io/dataguide/postgresql/setting-up-a-local-postgresql-database) to set it up locally

### Migrate Database

Once you have a Postgres database, you need to add the connection string as an environment secret.

Make a copy of the `.env.example` file and rename it to `.env`.

<Snippet text="cp .env.example .env" />

Open the new `.env` file. You should see an item called `DATABASE_URL`. Copy in your database connection string after the equals sign.

With that set up, you can now run your first database migration. Run the following command:

<Snippet text="pnpm db:migrate" />

This will first add the `pgvector` extension to your database. Then it will create a new table for your `resources` schema that is defined in `lib/db/schema/resources.ts`. This schema has four columns: `id`, `content`, `createdAt`, and `updatedAt`.

<Note>
  If you experience an error with the migration, open your migration file
  (`lib/db/migrations/0000_yielding_bloodaxe.sql`), cut (copy and remove) the
  first line, and run it directly on your postgres instance. You should now be
  able to run the updated migration. [More
  info](https://github.com/vercel/ai-sdk-rag-starter/issues/1).
</Note>

### OpenAI API Key

For this guide, you will need an OpenAI API key. To generate an API key, go to [platform.openai.com](http://platform.openai.com/).

Once you have your API key, paste it into your `.env` file (`OPENAI_API_KEY`).

## Build

Let’s build a quick task list of what needs to be done:

1. Create a table in your database to store embeddings
2. Add logic to chunk and create embeddings when creating resources
3. Create a chatbot
4. Give the chatbot tools to query / create resources for it’s knowledge base

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

<Snippet text="pnpm add ai @ai-sdk/react @ai-sdk/openai" />

This will install the [AI SDK](/docs), AI SDK's React hooks, and AI SDK's [OpenAI provider](/providers/ai-sdk-providers/openai).

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
import { openai } from '@ai-sdk/openai';

const embeddingModel = openai.embedding('text-embedding-ada-002');

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

Great! Let's build the frontend. The AI SDK’s [`useChat`](/docs/reference/ai-sdk-ui/use-chat) hook allows you to easily create a conversational user interface for your chatbot application.

Replace your root page (`app/page.tsx`) with the following code.

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      <div className="space-y-4">
        {messages.map(m => (
          <div key={m.id} className="whitespace-pre-wrap">
            <div>
              <div className="font-bold">{m.role}</div>
              <p>{m.content}</p>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

The `useChat` hook enables the streaming of chat messages from your AI provider (you will be using OpenAI), manages the state for chat input, and updates the UI automatically as new messages are received.

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
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
  });

  return result.toDataStreamResponse();
}
```

In this code, you declare and export an asynchronous function called POST. You retrieve the `messages` from the request body and then pass them to the [`streamText`](/docs/reference/ai-sdk-core/stream-text) function imported from the AI SDK, alongside the model you would like to use. Finally, you return the model’s response in `AIStreamResponse` format.

Head back to the browser and try to send a message again. You should see a response from the model streamed directly in!

### Refining your prompt

While you now have a working chatbot, it isn't doing anything special.

Let’s add system instructions to refine and restrict the model’s behavior. In this case, you want the model to only use information it has retrieved to generate responses. Update your route handler with the following code:

```tsx filename="app/api/chat/route.ts" highlight="12-14"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    messages,
  });

  return result.toDataStreamResponse();
}
```

Head back to the browser and try to ask the model what your favorite food is. The model should now respond exactly as you instructed above (“Sorry, I don’t know”) given it doesn’t have any relevant information.

In its current form, your chatbot is now, well, useless. How do you give the model the ability to add and query information?

### Using Tools

A [tool](/docs/foundations/tools) is a function that can be called by the model to perform a specific task. You can think of a tool like a program you give to the model that it can run as and when it deems necessary.

Let’s see how you can create a tool to give the model the ability to create, embed and save a resource to your chatbots’ knowledge base.

### Add Resource Tool

Update your route handler with the following code:

```tsx filename="app/api/chat/route.ts" highlight="18-29"
import { createResource } from '@/lib/actions/resources';
import { openai } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    messages,
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        parameters: z.object({
          content: z
            .string()
            .describe('the content or resource to add to the knowledge base'),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
    },
  });

  return result.toDataStreamResponse();
}
```

In this code, you define a tool called `addResource`. This tool has three elements:

- **description**: description of the tool that will influence when the tool is picked.
- **parameters**: [Zod schema](/docs/foundations/tools#schema-specification-and-validation-with-zod) that defines the parameters necessary for the tool to run.
- **execute**: An asynchronous function that is called with the arguments from the tool call.

In simple terms, on each generation, the model will decide whether it should call the tool. If it deems it should call the tool, it will extract the parameters from the input and then append a new `message` to the `messages` array of type `tool-call`. The AI SDK will then run the `execute` function with the parameters provided by the `tool-call` message.

Head back to the browser and tell the model your favorite food. You should see an empty response in the UI. Did anything happen? Let’s see. Run the following command in a new terminal window.

<Snippet text="pnpm db:studio" />

This will start Drizzle Studio where we can view the rows in our database. You should see a new row in both the `embeddings` and `resources` table with your favorite food!

Let’s make a few changes in the UI to communicate to the user when a tool has been called. Head back to your root page (`app/page.tsx`) and add the following code:

```tsx filename="app/page.tsx" highlight="14-22"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      <div className="space-y-4">
        {messages.map(m => (
          <div key={m.id} className="whitespace-pre-wrap">
            <div>
              <div className="font-bold">{m.role}</div>
              <p>
                {m.content.length > 0 ? (
                  m.content
                ) : (
                  <span className="italic font-light">
                    {'calling tool: ' + m?.toolInvocations?.[0].toolName}
                  </span>
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

With this change, you now conditionally render the tool that has been called directly in the UI. Save the file and head back to browser. Tell the model your favorite movie. You should see which tool is called in place of the model’s typical text response.

### Improving UX with Multi-Step Calls

It would be nice if the model could summarize the action too. However, technically, once the model calls a tool, it has completed its generation as it ‘generated’ a tool call. How could you achieve this desired behaviour?

The AI SDK has a feature called [`maxSteps`](/docs/ai-sdk-core/tools-and-tool-calling#multi-step-calls) which will automatically send tool call results back to the model!

Open your root page (`app/page.tsx`) and add the following key to the `useChat` configuration object:

```tsx filename="app/page.tsx" highlight="3-5"
// ... Rest of your code

const { messages, input, handleInputChange, handleSubmit } = useChat({
  maxSteps: 3,
});

// ... Rest of your code
```

Head back to the browser and tell the model your favorite pizza topping (note: pineapple is not an option). You should see a follow-up response from the model confirming the action.

### Retrieve Resource Tool

The model can now add and embed arbitrary information to your knowledge base. However, it still isn’t able to query it. Let’s create a new tool to allow the model to answer questions by finding relevant information in your knowledge base.

To find similar content, you will need to embed the users query, search the database for semantic similarities, then pass those items to the model as context alongside the query. To achieve this, let’s update your embedding logic file (`lib/ai/embedding.ts`):

```tsx filename="lib/ai/embedding.ts" highlight="1,3-5,27-34,36-49"
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import { db } from '../db';
import { cosineDistance, desc, gt, sql } from 'drizzle-orm';
import { embeddings } from '../db/schema/embeddings';

const embeddingModel = openai.embedding('text-embedding-ada-002');

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

```ts filename="api/chat/route.ts" highlight="5,30-36"
import { createResource } from '@/lib/actions/resources';
import { openai } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { findRelevantContent } from '@/lib/ai/embedding';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    if no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    tools: {
      addResource: tool({
        description: `add a resource to your knowledge base.
          If the user provides a random piece of knowledge unprompted, use this tool without asking for confirmation.`,
        parameters: z.object({
          content: z
            .string()
            .describe('the content or resource to add to the knowledge base'),
        }),
        execute: async ({ content }) => createResource({ content }),
      }),
      getInformation: tool({
        description: `get information from your knowledge base to answer questions.`,
        parameters: z.object({
          question: z.string().describe('the users question'),
        }),
        execute: async ({ question }) => findRelevantContent(question),
      }),
    },
  });

  return result.toDataStreamResponse();
}
```

Head back to the browser, refresh the page, and ask for your favorite food. You should see the model call the `getInformation` tool, and then use the relevant information to formulate a response!

## Conclusion

Congratulations, you have successfully built an AI chatbot that can dynamically add and retrieve information to and from a knowledge base. Throughout this guide, you learned how to create and store embeddings, set up server actions to manage resources, and use tools to extend the capabilities of your chatbot.

---
title: Multi-Modal Chatbot
description: Learn how to build a multi-modal chatbot that can process images and PDFs with the AI SDK.
tags: ['multi-modal', 'chatbot', 'images', 'pdf', 'vision', 'next']
---

# Multi-Modal Chatbot

In this guide, you will build a multi-modal AI-chatbot capable of understanding both images and PDFs.

Multi-modal refers to the ability of the chatbot to understand and generate responses in multiple formats, such as text, images, PDFs, and videos. In this example, we will focus on sending images and PDFs and generating text-based responses.

Different AI providers have varying levels of multi-modal support, for example:

- OpenAI (GPT-4o): Supports image input
- Anthropic (Sonnet 3.5): Supports image and PDF input
- Google (Gemini 2.0): Supports image and PDF input

<Note>
  For a complete list of providers that support both image and PDF inputs, visit
  the [providers documentation](/providers/ai-sdk-providers).
</Note>

We'll first build a chatbot capable of generating responses based on an image input using OpenAI, then show how to switch providers to handle PDFs.

## Prerequisites

To follow this quickstart, you'll need:

- Node.js 18+ and pnpm installed on your local development machine.
- An OpenAI API key.
- An Anthropic API Key.

If you haven't obtained your OpenAI API key, you can do so by [signing up](https://platform.openai.com/signup/) on the OpenAI website.

If you haven't obtained your Anthropic API key, you can do so by [signing up](https://console.anthropic.com/) on Anthropic's website.

## Create Your Application

Start by creating a new Next.js application. This command will create a new directory named `multi-modal-chatbot` and set up a basic Next.js application inside it.

<div className="mb-4">
  <Note>
    Be sure to select yes when prompted to use the App Router. If you are
    looking for the Next.js Pages Router quickstart guide, you can find it
    [here](/docs/getting-started/nextjs-pages-router).
  </Note>
</div>

<Snippet text="pnpm create next-app@latest multi-modal-chatbot" />

Navigate to the newly created directory:

<Snippet text="cd multi-modal-chatbot" />

### Install dependencies

Install `ai` and `@ai-sdk/openai`, the Vercel AI package and the AI SDK's [ OpenAI provider ](/providers/ai-sdk-providers/openai) respectively.

<Note>
  The AI SDK is designed to be a unified interface to interact with any large
  language model. This means that you can change model and providers with just
  one line of code! Learn more about [available providers](/providers) and
  [building custom providers](/providers/community-providers/custom-providers)
  in the [providers](/providers) section.
</Note>
<div className="my-4">
  <Tabs items={['pnpm', 'npm', 'yarn']}>
    <Tab>
      <Snippet text="pnpm add ai @ai-sdk/react @ai-sdk/openai" dark />
    </Tab>
    <Tab>
      <Snippet text="npm install ai @ai-sdk/react @ai-sdk/openai" dark />
    </Tab>
    <Tab>
      <Snippet text="yarn add ai @ai-sdk/react @ai-sdk/openai" dark />
    </Tab>
  </Tabs>
</div>

### Configure OpenAI API key

Create a `.env.local` file in your project root and add your OpenAI API Key. This key is used to authenticate your application with the OpenAI service.

<Snippet text="touch .env.local" />

Edit the `.env.local` file:

```env filename=".env.local"
OPENAI_API_KEY=xxxxxxxxx
```

Replace `xxxxxxxxx` with your actual OpenAI API key.

<Note className="mb-4">
  The AI SDK's OpenAI Provider will default to using the `OPENAI_API_KEY`
  environment variable.
</Note>

## Implementation Plan

To build a multi-modal chatbot, you will need to:

- Create a Route Handler to handle incoming chat messages and generate responses.
- Wire up the UI to display chat messages, provide a user input, and handle submitting new messages.
- Add the ability to upload images and attach them alongside the chat messages.

## Create a Route Handler

Create a route handler, `app/api/chat/route.ts` and add the following code:

```tsx filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, UIMessage } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Let's take a look at what is happening in this code:

1. Define an asynchronous `POST` request handler and extract `messages` from the body of the request. The `messages` variable contains a history of the conversation between you and the chatbot and provides the chatbot with the necessary context to make the next generation.
2. Convert the UI messages to model messages using `convertToModelMessages`, which transforms the UI-focused message format to the format expected by the language model.
3. Call [`streamText`](/docs/reference/ai-sdk-core/stream-text), which is imported from the `ai` package. This function accepts a configuration object that contains a `model` provider (imported from `@ai-sdk/openai`) and `messages` (converted in step 2). You can pass additional [settings](/docs/ai-sdk-core/settings) to further customise the model's behaviour.
4. The `streamText` function returns a [`StreamTextResult`](/docs/reference/ai-sdk-core/stream-text#result-object). This result object contains the [ `toUIMessageStreamResponse` ](/docs/reference/ai-sdk-core/stream-text#to-ui-message-stream-response) function which converts the result to a streamed response object.
5. Finally, return the result to the client to stream the response.

This Route Handler creates a POST request endpoint at `/api/chat`.

## Wire up the UI

Now that you have a Route Handler that can query a large language model (LLM), it's time to setup your frontend. [ AI SDK UI ](/docs/ai-sdk-ui) abstracts the complexity of a chat interface into one hook, [`useChat`](/docs/reference/ai-sdk-ui/use-chat).

Update your root page (`app/page.tsx`) with the following code to show a list of chat messages and provide a user message input:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.content}
        </div>
      ))}

      <form
        onSubmit={handleSubmit}
        className="fixed bottom-0 w-full max-w-md mb-8 border border-gray-300 rounded shadow-xl"
      >
        <input
          className="w-full p-2"
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

<Note>
  Make sure you add the `"use client"` directive to the top of your file. This
  allows you to add interactivity with Javascript.
</Note>

This page utilizes the `useChat` hook, which will, by default, use the `POST` API route you created earlier (`/api/chat`). The hook provides functions and state for handling user input and form submission. The `useChat` hook provides multiple utility functions and state variables:

- `messages` - the current chat messages (an array of objects with `id`, `role`, and `content` properties).
- `input` - the current value of the user's input field.
- `handleInputChange` and `handleSubmit` - functions to handle user interactions (typing into the input field and submitting the form, respectively).
- `status` - the status of the API request.

## Add Image Upload

To make your chatbot multi-modal, let's add the ability to upload and send images to the model. There are two ways to send attachments alongside a message with the `useChat` hook: by providing a `FileList` object or a list of URLs to the `handleSubmit` function. In this guide, you will be using the `FileList` approach as it does not require any additional setup.

Update your root page (`app/page.tsx`) with the following code:

```tsx filename="app/page.tsx" highlight="4-5,10-11,19-33,39-49,51-61"
'use client';

import { useChat } from '@ai-sdk/react';
import { useRef, useState } from 'react';
import Image from 'next/image';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.content}
          <div>
            {m?.attachments
              ?.filter(attachment =>
                attachment?.contentType?.startsWith('image/'),
              )
              .map((attachment, index) => (
                <Image
                  key={`${m.id}-${index}`}
                  src={attachment.url}
                  width={500}
                  height={500}
                  alt={attachment.name ?? `attachment-${index}`}
                />
              ))}
          </div>
        </div>
      ))}

      <form
        className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl space-y-2"
        onSubmit={event => {
          handleSubmit(event, {
            attachments: files,
          });

          setFiles(undefined);

          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }}
      >
        <input
          type="file"
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
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

In this code, you:

1. Create state to hold the files and create a ref to the file input field.
2. Display the "uploaded" files in the UI.
3. Update the `onSubmit` function, to call the `handleSubmit` function manually, passing the files as an option using the `attachments` key.
4. Add a file input field to the form, including an `onChange` handler to handle updating the files state.

## Running Your Application

With that, you have built everything you need for your multi-modal chatbot! To start your application, use the command:

<Snippet text="pnpm run dev" />

Head to your browser and open http://localhost:3000. You should see an input field and a button to upload an image.

Upload an image and ask the model to describe what it sees. Watch as the model's response is streamed back to you!

## Working with PDFs

To enable PDF support, you can switch to a provider that handles PDFs like Google's Gemini or Anthropic's Claude. Here's how to modify the code to use Anthropic:

1. First install the Anthropic provider:

<Snippet text="pnpm add @ai-sdk/anthropic" />

2. Update your environment variables:

```env filename=".env.local" highlight="2"
OPENAI_API_KEY=xxxxxxxxx
ANTHROPIC_API_KEY=xxxxxxxxx
```

3. Modify your route handler:

```tsx filename="app/api/chat/route.ts" highlight="2,10-15,18-21"
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { streamText, convertToModelMessages, UIMessage } from 'ai';

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // check if user has sent a PDF
  const messagesHavePDF = messages.some(message =>
    message.attachments?.some(a => a.contentType === 'application/pdf'),
  );

  const result = streamText({
    model: messagesHavePDF
      ? anthropic('claude-3-5-sonnet-latest')
      : openai('gpt-4o'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Now your chatbot can process both images and PDFs! You automatically route PDF requests to Claude Sonnet 3.5 and image requests to OpenAI's gpt-4o model.

Finally, to display PDFs in your chat interface, update the message rendering code in your frontend to show PDF attachments in an `<iframe>`:

```tsx filename="app/page.tsx" highlight="20-44"
'use client';

import { useChat } from '@ai-sdk/react';
import { useRef, useState } from 'react';
import Image from 'next/image';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  const [files, setFiles] = useState<FileList | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(m => (
        <div key={m.id} className="whitespace-pre-wrap">
          {m.role === 'user' ? 'User: ' : 'AI: '}
          {m.content}
          <div>
            {m?.attachments
              ?.filter(
                attachment =>
                  attachment?.contentType?.startsWith('image/') ||
                  attachment?.contentType?.startsWith('application/pdf'),
              )
              .map((attachment, index) =>
                attachment.contentType?.startsWith('image/') ? (
                  <Image
                    key={`${m.id}-${index}`}
                    src={attachment.url}
                    width={500}
                    height={500}
                    alt={attachment.name ?? `attachment-${index}`}
                  />
                ) : attachment.contentType?.startsWith('application/pdf') ? (
                  <iframe
                    key={`${m.id}-${index}`}
                    src={attachment.url}
                    width={500}
                    height={600}
                    title={attachment.name ?? `attachment-${index}`}
                  />
                ) : null,
              )}
          </div>
        </div>
      ))}

      <form
        className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl space-y-2"
        onSubmit={event => {
          handleSubmit(event, {
            attachments: files,
          });

          setFiles(undefined);

          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }}
      >
        <input
          type="file"
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
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

Try uploading a PDF and asking questions about its contents.

<Note>
  When switching providers, be sure to check the [provider
  documentation](/providers/ai-sdk-providers) for specific file size limits and
  supported file types.
</Note>

## Where to Next?

You've built a multi-modal AI chatbot using the AI SDK! Experiment and extend the functionality of this application further by exploring [tool calling](/docs/ai-sdk-core/tools-and-tool-calling) or introducing more granular control over [AI and UI states](/docs/ai-sdk-rsc/generative-ui-state).

If you are looking to leverage the broader capabilities of LLMs, Vercel [AI SDK Core](/docs/ai-sdk-core) provides a comprehensive set of lower-level tools and APIs that will help you unlock a wider range of AI functionalities beyond the chatbot paradigm.

---
title: Slackbot Guide
description: Learn how to use the AI SDK to build an AI Slackbot.
tags: ['agents', 'chatbot']
---

# Building a Slack AI Chatbot with the AI SDK

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
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';

export const generateResponse = async (
  messages: ModelMessage[],
  updateStatus?: (status: string) => void,
) => {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
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

1. Uses the AI SDK's `generateText` function to call OpenAI's `gpt-4o` model
2. Provides a system prompt to guide the model's behavior
3. Formats the response for Slack's markdown format

## Enhancing with Tools

The real power of the AI SDK comes from tools that enable your bot to perform actions. Let's add two useful tools:

```typescript filename="lib/generate-response.ts"
import { openai } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { exa } from './utils';

export const generateResponse = async (
  messages: ModelMessage[],
  updateStatus?: (status: string) => void,
) => {
  const { text } = await generateText({
    model: openai('gpt-4o'),
    system: `You are a Slack bot assistant. Keep your responses concise and to the point.
    - Do not tag users.
    - Current date is: ${new Date().toISOString().split('T')[0]}
    - Always include sources in your final response if you use web search.`,
    messages,
    maxSteps: 10,
    tools: {
      getWeather: tool({
        description: 'Get the current weather at a location',
        parameters: z.object({
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
        parameters: z.object({
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

2. You set `maxSteps: 10` to enable multi-step conversations. This will automatically send any tool results back to the LLM to trigger additional tool calls or responses as the LLM deems necessary. This turns your LLM call from a one-off operation into a multi-step agentic flow.

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

<Note>
  This project uses Vercel Postgres. You can learn more about how to set up at
  the [Vercel Postgres documentation](https://vercel.com/postgres).
</Note>

4. This project uses CB Insights' Unicorn Companies dataset. You can download the dataset by following these instructions:
   - Navigate to [CB Insights Unicorn Companies](https://www.cbinsights.com/research-unicorn-companies)
   - Enter in your email. You will receive a link to download the dataset.
   - Save it as `unicorns.csv` in your project root

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

In this action, you'll use the `generateObject` function from the AI SDK which allows you to constrain the model's output to a pre-defined schema. This process, sometimes called structured output, ensures the model returns only the SQL query without any additional prefixes, explanations, or formatting that would require manual parsing.

```ts filename="app/actions.ts"
/* ...other imports... */
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

/* ...rest of the file... */

export const generateQuery = async (input: string) => {
  'use server';
  try {
    const result = await generateObject({
      model: openai('gpt-4o'),
      system: `You are a SQL (postgres) ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Generate the query necessary to retrieve the data the user wants: ${input}`,
      schema: z.object({
        query: z.string(),
      }),
    });
    return result.object.query;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

Note, you are constraining the output to a single string field called `query` using `zod`, a TypeScript schema validation library. This will ensure the model only returns the SQL query itself. The resulting generated query will then be returned.

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
You are a SQL (postgres) expert. Your job is to explain to the user write a SQL query you wrote to retrieve the data they asked for. The table schema is as follows:
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
    const result = await generateObject({
      model: openai('gpt-4o'),
      system: `You are a SQL (postgres) expert. ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Explain the SQL query you generated to retrieve the data the user wanted. Assume the user is not an expert in SQL. Break down the query into steps. Be concise.

      User Query:
      ${input}

      Generated SQL Query:
      ${sqlQuery}`,
    });
    return result.object;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

This action uses the `generateObject` function again. However, you haven't defined the schema yet. Let's define it in another file so it can also be used as a type in your components.

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
    const result = await generateObject({
      model: openai('gpt-4o'),
      system: `You are a SQL (postgres) expert. ...`, // SYSTEM PROMPT AS ABOVE - OMITTED FOR BREVITY
      prompt: `Explain the SQL query you generated to retrieve the data the user wanted. Assume the user is not an expert in SQL. Break down the query into steps. Be concise.

      User Query:
      ${input}

      Generated SQL Query:
      ${sqlQuery}`,
      schema: explanationSchema,
      output: 'array',
    });
    return result.object;
  } catch (e) {
    console.error(e);
    throw new Error('Failed to generate query');
  }
};
```

<Note>
  You can use `output: "array"` to indicate to the model that you expect an
  array of objects matching the schema to be returned.
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

2. Send the query and data to the model and ask it to generate a chart configuration (fixed-size and not many tokens) that maps your data appropriately. This configuration specifies how to visualize the information while delivering the insights from your natural language query. Importnatly, this is done without requiring the model return the full dataset.

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
    const { object: config } = await generateObject({
      model: openai('gpt-4o'),
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
      schema: configSchema,
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

First, ensure you have the AI SDK and [Anthropic AI SDK provider](/providers/ai-sdk-providers/anthropic) installed:

<Snippet text="pnpm add ai @ai-sdk/anthropic" />

You can add Computer Use to your AI SDK applications using provider-defined-client tools. These tools accept various input parameters (like display height and width in the case of the computer tool) and then require that you define an execute function.

Here's how you could set up the Computer Tool with the AI SDK:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { getScreenshot, executeComputerAction } from '@/utils/computer-use';

const computerTool = anthropic.tools.computer_20241022({
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
  experimental_toToolResultContent(result) {
    return typeof result === 'string'
      ? [{ type: 'text', text: result }]
      : [{ type: 'image', data: result.data, mediaType: 'image/png' }];
  },
});
```

The `computerTool` handles two main actions: taking screenshots via `getScreenshot()` and executing computer actions like mouse movements and clicks through `executeComputerAction()`. Remember, you have to implement this execution logic (eg. the `getScreenshot` and `executeComputerAction` functions) to handle the actual computer interactions. The `execute` function should handle all low-level interactions with the operating system.

Finally, to send tool results back to the model, use the [`experimental_toToolResultContent()`](/docs/foundations/prompts#multi-modal-tool-results) function to convert text and image responses into a format the model can process. The AI SDK includes experimental support for these multi-modal tool results when using Anthropic's models.

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
  model: anthropic('claude-3-5-sonnet-20241022'),
  prompt: 'Move the cursor to the center of the screen and take a screenshot',
  tools: { computer: computerTool },
});

console.log(result.text);
```

For streaming responses, use `streamText` to receive updates in real-time:

```ts
const result = streamText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  prompt: 'Open the browser and navigate to vercel.com',
  tools: { computer: computerTool },
});

for await (const chunk of result.textStream) {
  console.log(chunk);
}
```

### Configure Multi-Step (Agentic) Generations

To allow the model to perform multiple steps without user intervention, specify a `maxSteps` value. This will automatically send any tool results back to the model to trigger a subsequent generation:

```ts highlight="5"
const stream = streamText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  prompt: 'Open the browser and navigate to vercel.com',
  tools: { computer: computerTool },
  maxSteps: 10, // experiment with this value based on your use case
});
```

### Combine Multiple Tools

You can combine multiple tools in a single request to enable more complex workflows. The AI SDK supports all three of Claude's Computer Use tools:

```ts
const computerTool = anthropic.tools.computer_20241022({
  ...
});

const bashTool = anthropic.tools.bash_20241022({
  execute: async ({ command, restart }) => execSync(command).toString()
});

const textEditorTool = anthropic.tools.textEditor_20241022({
  execute: async ({
    command,
    path,
    file_text,
    insert_line,
    new_str,
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
        oldStr: old_str,
        viewRange: view_range
      });
    }
  }
});


const response = await generateText({
  model: anthropic("claude-3-5-sonnet-20241022"),
  prompt: "Create a new file called example.txt, write 'Hello World' to it, and run 'cat example.txt' in the terminal",
  tools: {
    computer: computerTool,
    bash: bashTool
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
title: Get started with Claude 4
description: Get started with Claude 4 using the AI SDK.
tags: ['getting-started']
---

# Get started with Claude 4

With the release of Claude 4, there has never been a better time to start building AI applications, particularly those that require complex reasoning capabilities and advanced intelligence.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like Claude 4 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## Claude 4

Claude 4 is Anthropic's most advanced model family to date, offering exceptional capabilities across reasoning, instruction following, coding, and knowledge tasks. Available in two variants—Sonnet and Opus—Claude 4 delivers state-of-the-art performance with enhanced reliability and control. Claude 4 builds on the extended thinking capabilities introduced in Claude 3.7, allowing for even more sophisticated problem-solving through careful, step-by-step reasoning.

Claude 4 excels at complex reasoning, code generation and analysis, detailed content creation, and agentic capabilities, making it ideal for powering sophisticated AI workflows, customer-facing agents, and applications requiring nuanced understanding and responses. Claude Opus 4 is an excellent coding model, leading on SWE-bench (72.5%) and Terminal-bench (43.2%), with the ability to sustain performance on long-running tasks that require focused effort and thousands of steps. Claude Sonnet 4 significantly improves on Sonnet 3.7, excelling in coding with 72.7% on SWE-bench while balancing performance and efficiency.

### Prompt Engineering for Claude 4 Models

Claude 4 models respond well to clear, explicit instructions. The following best practices can help achieve optimal performance:

1. **Provide explicit instructions**: Clearly state what you want the model to do, including specific steps or formats for the response.
2. **Include context and motivation**: Explain why a task is being performed to help the model better understand the underlying goals.
3. **Avoid negative examples**: When providing examples, only demonstrate the behavior you want to see, not what you want to avoid.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call Claude 3.7 Sonnet with the AI SDK:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoning, reasoningDetails } = await generateText({
  model: anthropic('claude-4-sonnet-20250514'),
  prompt: 'How will quantum computing impact cryptography by 2050?',
});
console.log(text);
```

### Reasoning Ability

Claude 4 enhances the extended thinking capabilities first introduced in Claude 3.7 Sonnet—the ability to solve complex problems with careful, step-by-step reasoning. Additionally, both Opus 4 and Sonnet 4 can now use tools during extended thinking, allowing Claude to alternate between reasoning and tool use to improve responses. You can enable extended thinking using the `thinking` provider option and specifying a thinking budget in tokens. For interleaved thinking (where Claude can think in between tool calls) you'll need to enable a beta feature using the `anthropic-beta` header:

```ts
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoning, reasoningDetails } = await generateText({
  model: anthropic('claude-4-sonnet-20250514'),
  prompt: 'How will quantum computing impact cryptography by 2050?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 15000 },
    } satisfies AnthropicProviderOptions,
  },
  headers: {
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
  },
});

console.log(text); // text response
console.log(reasoning); // reasoning text
console.log(reasoningDetails); // reasoning details including redacted reasoning
```

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, SvelteKit, and SolidStart.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), [`useObject`](/docs/reference/ai-sdk-ui/use-object), and [`useAssistant`](/docs/reference/ai-sdk-ui/use-assistant) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and Claude Sonnet 4:

In a new Next.js application, first install the AI SDK and the Anthropic provider:

<Snippet text="pnpm install ai @ai-sdk/anthropic" />

Then, create a route handler for the chat endpoint:

```tsx filename="app/api/chat/route.ts"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: anthropic('claude-4-sonnet-20250514'),
    messages,
    headers: {
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    },
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 15000 },
      } satisfies AnthropicProviderOptions,
    },
  });

  return result.toDataStreamResponse({
    sendReasoning: true,
  });
}
```

<Note>
  You can forward the model's reasoning tokens to the client with
  `sendReasoning: true` in the `toDataStreamResponse` method.
</Note>

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-4">
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map(message => (
          <div
            key={message.id}
            className={`p-3 rounded-lg ${
              message.role === 'user' ? 'bg-blue-50 ml-auto' : 'bg-gray-50'
            }`}
          >
            <p className="font-semibold">
              {message.role === 'user' ? 'You' : 'Claude 4'}
            </p>
            {message.parts.map((part, index) => {
              if (part.type === 'text') {
                return (
                  <div key={index} className="mt-1">
                    {part.text}
                  </div>
                );
              }
              if (part.type === 'reasoning') {
                return (
                  <pre
                    key={index}
                    className="bg-gray-100 p-2 rounded mt-2 text-xs overflow-x-auto"
                  >
                    <details>
                      <summary className="cursor-pointer">
                        View reasoning
                      </summary>
                      {part.details.map(detail =>
                        detail.type === 'text' ? detail.text : '<redacted>',
                      )}
                    </details>
                  </pre>
                );
              }
            })}
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          name="prompt"
          value={input}
          onChange={handleInputChange}
          className="flex-1 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Ask Claude 4 something..."
        />
        <button
          type="submit"
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

<Note>
  You can access the model's reasoning tokens with the `reasoning` part on the
  message `parts`.
</Note>

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

### Claude 4 Model Variants

Claude 4 is available in two variants, each optimized for different use cases:

- **Claude Sonnet 4**: Balanced performance suitable for most enterprise applications, with significant improvements over Sonnet 3.7.
- **Claude Opus 4**: Anthropic's most powerful model and the best coding model available. Excels at sustained performance on long-running tasks that require focused effort and thousands of steps, with the ability to work continuously for several hours.

## Get Started

Ready to dive in? Here's how you can begin:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) at [ai-sdk.dev/docs/guides](/docs/guides).
4. Use ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: OpenAI Responses API
description: Get started with the OpenAI Responses API using the AI SDK.
tags: ['getting-started', 'agents']
---

# Get started with OpenAI Responses API

With the [release of OpenAI's responses API](https://openai.com/index/new-tools-for-building-agents/), there has never been a better time to start building AI applications, particularly those that require a deeper understanding of the world.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## OpenAI Responses API

OpenAI recently released the Responses API, a brand new way to build applications on OpenAI's platform. The new API offers a way to persist chat history, a web search tool for grounding LLM responses, file search tool for finding relevant files, and a computer use tool for building agents that can interact with and operate computers. Let's explore how to use the Responses API with the AI SDK.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call GPT-4o with the new Responses API using the AI SDK:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai.responses('gpt-4o'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

### Generating Structured Data

While text generation can be useful, you might want to generate structured JSON data. For example, you might want to extract information from text, classify data, or generate synthetic data. AI SDK Core provides two functions ([`generateObject`](/docs/reference/ai-sdk-core/generate-object) and [`streamObject`](/docs/reference/ai-sdk-core/stream-object)) to generate structured data, allowing you to constrain model outputs to a specific schema.

```ts
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { object } = await generateObject({
  model: openai.responses('gpt-4o'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This code snippet will generate a type-safe recipe that conforms to the specified zod schema.

### Using Tools with the AI SDK

The Responses API supports tool calling out of the box, allowing it to interact with external systems and perform discrete tasks. Here's an example of using tool calling with the AI SDK:

```ts
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai.responses('gpt-4o'),
  prompt: 'What is the weather like today in San Francisco?',
  tools: {
    getWeather: tool({
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
});
```

In this example, the `getWeather` tool allows the model to fetch real-time weather data (simulated for simplicity), enhancing its ability to provide accurate and up-to-date information.

### Web Search Tool

The Responses API introduces a built-in tool for grounding responses called `webSearch`. With this tool, the model can access the internet to find relevant information for its responses.

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-4o-mini'),
  prompt: 'What happened in San Francisco last week?',
  tools: {
    web_search_preview: openai.tools.webSearchPreview(),
  },
});

console.log(result.text);
console.log(result.sources);
```

The `webSearch` tool also allows you to specify query-specific metadata that can be used to improve the quality of the search results.

```ts
import { generateText } from 'ai';

const result = await generateText({
  model: openai.responses('gpt-4o-mini'),
  prompt: 'What happened in San Francisco last week?',
  tools: {
    web_search_preview: openai.tools.webSearchPreview({
      searchContextSize: 'high',
      userLocation: {
        type: 'approximate',
        city: 'San Francisco',
        region: 'California',
      },
    }),
  },
});

console.log(result.text);
console.log(result.sources);
```

## Using Persistence

With the Responses API, you can persist chat history with OpenAI across requests. This allows you to send just the user's last message and OpenAI can access the entire chat history:

```tsx filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const result1 = await generateText({
  model: openai.responses('gpt-4o-mini'),
  prompt: 'Invent a new holiday and describe its traditions.',
});

const result2 = await generateText({
  model: openai.responses('gpt-4o-mini'),
  prompt: 'Summarize in 2 sentences',
  providerOptions: {
    openai: {
      previousResponseId: result1.providerMetadata?.openai.responseId as string,
    },
  },
});
```

## Migrating from Completions API

Migrating from the OpenAI Completions API (via the AI SDK) to the new Responses API is simple. To migrate, simply change your provider instance from `openai(modelId)` to `openai.responses(modelId)`:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Completions API
const { text } = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Explain the concept of quantum entanglement.',
});

// Responses API
const { text } = await generateText({
  model: openai.responses('gpt-4o'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

When using the Responses API, provider specific options that were previously specified on the model provider instance have now moved to the `providerOptions` object:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Completions API
const { text } = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Explain the concept of quantum entanglement.',
  providerOptions: {
    openai: {
      parallelToolCalls: false,
    },
  },
});

// Responses API
const { text } = await generateText({
  model: openai.responses('gpt-4o'),
  prompt: 'Explain the concept of quantum entanglement.',
  providerOptions: {
    openai: {
      parallelToolCalls: false,
    },
  },
});
```

## Get Started

Ready to get started? Here's how you can dive in:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the full capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action and get inspired for your own projects.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) and multi-modal chat at [ai-sdk.dev/docs/guides](/docs/guides).
4. Check out ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Get started with Claude 3.7 Sonnet
description: Get started with Claude 3.7 Sonnet using the AI SDK.
tags: ['getting-started']
---

# Get started with Claude 3.7 Sonnet

With the [release of Claude 3.7 Sonnet](https://www.anthropic.com/news/claude-3-7-sonnet), there has never been a better time to start building AI applications, particularly those that require complex reasoning capabilities.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like Claude 3.7 Sonnet alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## Claude 3.7 Sonnet

Claude 3.7 Sonnet is Anthropic's most intelligent model to date and the first Claude model to offer extended thinking—the ability to solve complex problems with careful, step-by-step reasoning. With Claude 3.7 Sonnet, you can balance speed and quality by choosing between standard thinking for near-instant responses or extended thinking or advanced reasoning. Claude 3.7 Sonnet is state-of-the-art for coding, and delivers advancements in computer use, agentic capabilities, complex reasoning, and content generation. With frontier performance and more control over speed, Claude 3.7 Sonnet is a great choice for powering AI agents, especially customer-facing agents, and complex AI workflows.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call Claude 3.7 Sonnet with the AI SDK:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoning, reasoningDetails } = await generateText({
  model: anthropic('claude-3-7-sonnet-20250219'),
  prompt: 'How many people will live in the world in 2040?',
});
console.log(text); // text response
```

The unified interface also means that you can easily switch between providers by changing just two lines of code. For example, to use Claude 3.7 Sonnet via Amazon Bedrock:

```ts
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

const { reasoning, text } = await generateText({
  model: bedrock('anthropic.claude-3-7-sonnet-20250219-v1:0'),
  prompt: 'How many people will live in the world in 2040?',
});
```

### Reasoning Ability

Claude 3.7 Sonnet introduces a new extended thinking—the ability to solve complex problems with careful, step-by-step reasoning. You can enable it using the `thinking` provider option and specifying a thinking budget in tokens:

```ts
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const { text, reasoning, reasoningDetails } = await generateText({
  model: anthropic('claude-3-7-sonnet-20250219'),
  prompt: 'How many people will live in the world in 2040?',
  providerOptions: {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: 12000 },
    } satisfies AnthropicProviderOptions,
  },
});

console.log(reasoning); // reasoning text
console.log(reasoningDetails); // reasoning details including redacted reasoning
console.log(text); // text response
```

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and Claude 3.7 Sonnet:

In a new Next.js application, first install the AI SDK and the Anthropic provider:

<Snippet text="npm install ai @ai-sdk/anthropic" />

Then, create a route handler for the chat endpoint:

```tsx filename="app/api/chat/route.ts"
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { streamText, UIMessage, convertToModelMessages } from 'ai';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: anthropic('claude-3-7-sonnet-20250219'),
    messages: convertToModelMessages(messages),
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 12000 },
      } satisfies AnthropicProviderOptions,
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
```

<Note>
  You can forward the model's reasoning tokens to the client with
  `sendReasoning: true` in the `toUIMessageStreamResponse` method.
</Note>

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

  return (
    <>
      {messages.map(message => (
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
      ))}
      <form onSubmit={handleSubmit}>
        <input name="prompt" value={input} onChange={handleInputChange} />
        <button type="submit">Submit</button>
      </form>
    </>
  );
}
```

<Note>
  You can access the model's reasoning tokens with the `reasoning` part on the
  message `parts`.
</Note>

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Get Started

Ready to dive in? Here's how you can begin:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) at [ai-sdk.dev/docs/guides](/docs/guides).
4. Use ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

Claude 3.7 Sonnet opens new opportunities for reasoning-intensive AI applications. Start building today and leverage the power of advanced reasoning in your AI projects.

---
title: Get started with Llama 3.1
description: Get started with Llama 3.1 using the AI SDK.
tags: ['getting-started']
---

# Get started with Llama 3.1

<Note>
  The current generation of Llama models is 3.3. Please note that while this
  guide focuses on Llama 3.1, the newer Llama 3.3 models are now available and
  may offer improved capabilities. The concepts and integration techniques
  described here remain applicable, though you may want to use the latest
  generation models for optimal performance.
</Note>

With the [release of Llama 3.1](https://ai.meta.com/blog/meta-llama-3-1/), there has never been a better time to start building AI applications.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI application with large language models (LLMs) like Llama 3.1 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more

## Llama 3.1

The release of Meta's Llama 3.1 is an important moment in AI development. As the first state-of-the-art open weight AI model, Llama 3.1 is helping accelerate developers building AI apps. Available in 8B, 70B, and 405B sizes, these instruction-tuned models work well for tasks like dialogue generation, translation, reasoning, and code generation.

## Benchmarks

Llama 3.1 surpasses most available open-source chat models on common industry benchmarks and even outperforms some closed-source models, offering superior performance in language nuances, contextual understanding, and complex multi-step tasks. The models' refined post-training processes significantly improve response alignment, reduce false refusal rates, and enhance answer diversity, making Llama 3.1 a powerful and accessible tool for building generative AI applications.

![Llama 3.1 Benchmarks](/images/llama-3_1-benchmarks.png)
Source: [Meta AI - Llama 3.1 Model Card](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/MODEL_CARD.md)

## Choosing Model Size

Llama 3.1 includes a new 405B parameter model, becoming the largest open-source model available today. This model is designed to handle the most complex and demanding tasks.

When choosing between the different sizes of Llama 3.1 models (405B, 70B, 8B), consider the trade-off between performance and computational requirements. The 405B model offers the highest accuracy and capability for complex tasks but requires significant computational resources. The 70B model provides a good balance of performance and efficiency for most applications, while the 8B model is suitable for simpler tasks or resource-constrained environments where speed and lower computational overhead are priorities.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call Llama 3.1 (using [DeepInfra](https://deepinfra.com)) with the AI SDK:

```ts
import { deepinfra } from '@ai-sdk/deepinfra';
import { generateText } from 'ai';

const { text } = await generateText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-405B-Instruct'),
  prompt: 'What is love?',
});
```

<Note>
  Llama 3.1 is available to use with many AI SDK providers including
  [DeepInfra](/providers/ai-sdk-providers/deepinfra), [Amazon
  Bedrock](/providers/ai-sdk-providers/amazon-bedrock),
  [Baseten](/providers/openai-compatible-providers/baseten)
  [Fireworks](/providers/ai-sdk-providers/fireworks), and more.
</Note>

AI SDK Core abstracts away the differences between model providers, allowing you to focus on building great applications. Prefer to use [Amazon Bedrock](/providers/ai-sdk-providers/amazon-bedrock)? The unified interface also means that you can easily switch between models by changing just two lines of code.

```tsx highlight="2,5"
import { generateText } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

const { text } = await generateText({
  model: bedrock('meta.llama3-1-405b-instruct-v1'),
  prompt: 'What is love?',
});
```

### Streaming the Response

To stream the model's response as it's being generated, update your code snippet to use the [`streamText`](/docs/reference/ai-sdk-core/stream-text) function.

```tsx
import { streamText } from 'ai';
import { deepinfra } from '@ai-sdk/deepinfra';

const { textStream } = streamText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-405B-Instruct'),
  prompt: 'What is love?',
});
```

### Generating Structured Data

While text generation can be useful, you might want to generate structured JSON data. For example, you might want to extract information from text, classify data, or generate synthetic data. AI SDK Core provides two functions ([`generateObject`](/docs/reference/ai-sdk-core/generate-object) and [`streamObject`](/docs/reference/ai-sdk-core/stream-object)) to generate structured data, allowing you to constrain model outputs to a specific schema.

```ts
import { generateObject } from 'ai';
import { deepinfra } from '@ai-sdk/deepinfra';
import { z } from 'zod';

const { object } = await generateObject({
  model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This code snippet will generate a type-safe recipe that conforms to the specified zod schema.

### Tools

While LLMs have incredible generation capabilities, they struggle with discrete tasks (e.g. mathematics) and interacting with the outside world (e.g. getting the weather). The solution: tools, which are like programs that you provide to the model, which it can choose to call as necessary.

### Using Tools with the AI SDK

The AI SDK supports tool usage across several of its functions, including [`generateText`](/docs/reference/ai-sdk-core/generate-text) and [`streamUI`](/docs/reference/ai-sdk-rsc/stream-ui). By passing one or more tools to the `tools` parameter, you can extend the capabilities of LLMs, allowing them to perform discrete tasks and interact with external systems.

Here's an example of how you can use a tool with the AI SDK and Llama 3.1:

```ts
import { generateText, tool } from 'ai';
import { deepinfra } from '@ai-sdk/deepinfra';
import { z } from 'zod';

const { text } = await generateText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
  prompt: 'What is the weather like today?',
  tools: {
    getWeather: tool({
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
});
```

In this example, the `getWeather` tool allows the model to fetch real-time weather data, enhancing its ability to provide accurate and up-to-date information.

### Agents

Agents take your AI applications a step further by allowing models to execute multiple steps (i.e. tools) in a non-deterministic way, making decisions based on context and user input.

Agents use LLMs to choose the next step in a problem-solving process. They can reason at each step and make decisions based on the evolving context.

### Implementing Agents with the AI SDK

The AI SDK supports agent implementation through the `maxSteps` parameter. This allows the model to make multiple decisions and tool calls in a single interaction.

Here's an example of an agent that solves math problems:

```tsx
import { generateText, tool } from 'ai';
import { deepinfra } from '@ai-sdk/deepinfra';
import * as mathjs from 'mathjs';
import { z } from 'zod';

const problem =
  'Calculate the profit for a day if revenue is $5000 and expenses are $3500.';

const { text: answer } = await generateText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
  system:
    'You are solving math problems. Reason step by step. Use the calculator when necessary.',
  prompt: problem,
  tools: {
    calculate: tool({
      description: 'A tool for evaluating mathematical expressions.',
      parameters: z.object({ expression: z.string() }),
      execute: async ({ expression }) => mathjs.evaluate(expression),
    }),
  },
  maxSteps: 5,
});
```

In this example, the agent can use the calculator tool multiple times if needed, reasoning through the problem step by step.

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and Llama 3.1 (via [DeepInfra](https://deepinfra.com)):

```tsx filename="app/api/chat/route.ts"
import { deepinfra } from '@ai-sdk/deepinfra';
import { convertToModelMessages, streamText } from 'ai';

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

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

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then streamed back in real-time and displayed in the chat UI.

This enables a seamless chat experience where the user can see the AI response as soon as it is available, without having to wait for the entire response to be received.

### Going Beyond Text

The AI SDK's React Server Components (RSC) API enables you to create rich, interactive interfaces that go beyond simple text generation. With the [`streamUI`](/docs/reference/ai-sdk-rsc/stream-ui) function, you can dynamically stream React components from the server to the client.

Let's dive into how you can leverage tools with [AI SDK RSC](/docs/ai-sdk-rsc/overview) to build a generative user interface with Next.js (App Router).

First, create a Server Action.

```tsx filename="app/actions.tsx"
'use server';

import { streamUI } from '@ai-sdk/rsc';
import { deepinfra } from '@ai-sdk/deepinfra';
import { z } from 'zod';

export async function streamComponent() {
  const result = await streamUI({
    model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
    prompt: 'Get the weather for San Francisco',
    text: ({ content }) => <div>{content}</div>,
    tools: {
      getWeather: {
        description: 'Get the weather for a location',
        parameters: z.object({ location: z.string() }),
        generate: async function* ({ location }) {
          yield <div>loading...</div>;
          const weather = '25c'; // await getWeather(location);
          return (
            <div>
              the weather in {location} is {weather}.
            </div>
          );
        },
      },
    },
  });
  return result.value;
}
```

In this example, if the model decides to use the `getWeather` tool, it will first yield a `div` while fetching the weather data, then return a weather component with the fetched data (note: static data in this example). This allows for a more dynamic and responsive UI that can adapt based on the AI's decisions and external data.

On the frontend, you can call this Server Action like any other asynchronous function in your application. In this case, the function returns a regular React component.

```tsx filename="app/page.tsx"
'use client';

import { useState } from 'react';
import { streamComponent } from './actions';

export default function Page() {
  const [component, setComponent] = useState<React.ReactNode>();

  return (
    <div>
      <form
        onSubmit={async e => {
          e.preventDefault();
          setComponent(await streamComponent());
        }}
      >
        <button>Stream Component</button>
      </form>
      <div>{component}</div>
    </div>
  );
}
```

To see AI SDK RSC in action, check out our open-source [Next.js Gemini Chatbot](https://gemini.vercel.ai/).

## Migrate from OpenAI

One of the key advantages of the AI SDK is its unified API, which makes it incredibly easy to switch between different AI models and providers. This flexibility is particularly useful when you want to migrate from one model to another, such as moving from OpenAI's GPT models to Meta's Llama models hosted on DeepInfra.

Here's how simple the migration process can be:

**OpenAI Example:**

```tsx
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('gpt-4.1'),
  prompt: 'What is love?',
});
```

**Llama on DeepInfra Example:**

```tsx
import { generateText } from 'ai';
import { deepinfra } from '@ai-sdk/deepinfra';

const { text } = await generateText({
  model: deepinfra('meta-llama/Meta-Llama-3.1-70B-Instruct'),
  prompt: 'What is love?',
});
```

Thanks to the unified API, the core structure of the code remains the same. The main differences are:

1. Creating a DeepInfra client
2. Changing the model name from `openai("gpt-4.1")` to `deepinfra("meta-llama/Meta-Llama-3.1-70B-Instruct")`.

With just these few changes, you've migrated from using OpenAI's GPT-4-Turbo to Meta's Llama 3.1 hosted on DeepInfra. The `generateText` function and its usage remain identical, showcasing the power of the AI SDK's unified API.

This feature allows you to easily experiment with different models, compare their performance, and choose the best one for your specific use case without having to rewrite large portions of your codebase.

## Prompt Engineering and Fine-tuning

While the Llama 3.1 family of models are powerful out-of-the-box, their performance can be enhanced through effective prompt engineering and fine-tuning techniques.

### Prompt Engineering

Prompt engineering is the practice of crafting input prompts to elicit desired outputs from language models. It involves structuring and phrasing prompts in ways that guide the model towards producing more accurate, relevant, and coherent responses.

For more information on prompt engineering techniques (specific to Llama models), check out these resources:

- [Official Llama 3.1 Prompt Guide](https://llama.meta.com/docs/how-to-guides/prompting)
- [Prompt Engineering with Llama 3](https://github.com/amitsangani/Llama/blob/main/Llama_3_Prompt_Engineering.ipynb)
- [How to prompt Llama 3](https://huggingface.co/blog/llama3#how-to-prompt-llama-3)

### Fine-tuning

Fine-tuning involves further training a pre-trained model on a specific dataset or task to customize its performance for particular use cases. This process allows you to adapt Llama 3.1 to your specific domain or application, potentially improving its accuracy and relevance for your needs.

To learn more about fine-tuning Llama models, check out these resources:

- [Official Fine-tuning Llama Guide](https://llama.meta.com/docs/how-to-guides/fine-tuning)
- [Fine-tuning and Inference with Llama 3](https://docs.inferless.com/how-to-guides/how-to-finetune--and-inference-llama3)
- [Fine-tuning Models with Fireworks AI](https://docs.fireworks.ai/fine-tuning/fine-tuning-models)
- [Fine-tuning Llama with Modal](https://modal.com/docs/examples/llm-finetuning)

## Conclusion

The AI SDK offers a powerful and flexible way to integrate cutting-edge AI models like Llama 3.1 into your applications. With AI SDK Core, you can seamlessly switch between different AI models and providers by changing just two lines of code. This flexibility allows for quick experimentation and adaptation, reducing the time required to change models from days to minutes.

The AI SDK ensures that your application remains clean and modular, accelerating development and future-proofing against the rapidly evolving landscape.

Ready to get started? Here's how you can dive in:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the full capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action and get inspired for your own projects.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) and multi-modal chat at [ai-sdk.dev/docs/guides](/docs/guides).
4. Check out ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Get started with GPT-4.5
description: Get started with GPT-4.5 using the AI SDK.
tags: ['getting-started']
---

# Get started with OpenAI GPT-4.5

With the [release of OpenAI's GPT-4.5 model](https://openai.com/index/introducing-gpt-4-5), there has never been a better time to start building AI applications, particularly those that require a deeper understanding of the world.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like OpenAI GPT-4.5 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## OpenAI GPT-4.5

OpenAI recently released GPT-4.5, their largest and best model for chat yet. GPT‑4.5 is a step forward in scaling up pretraining and post-training. By scaling unsupervised learning, GPT‑4.5 improves its ability to recognize patterns, draw connections, and generate creative insights without reasoning.

Based on early testing, developers may find GPT‑4.5 particularly useful for applications that benefit from its higher emotional intelligence and creativity such as writing help, communication, learning, coaching, and brainstorming. It also shows strong capabilities in agentic planning and execution, including multi-step coding workflows and complex task automation.

### Benchmarks

GPT-4.5 demonstrates impressive performance across various benchmarks:

- **SimpleQA Accuracy**: 62.5% (higher is better)
- **SimpleQA Hallucination Rate**: 37.1% (lower is better)

[Source](https://openai.com/index/introducing-gpt-4-5)

### Prompt Engineering for GPT-4.5

GPT-4.5 performs best with the following approach:

1. **Be clear and specific**: GPT-4.5 responds well to direct, well-structured prompts.
2. **Use delimiters for clarity**: Use delimiters like triple quotation marks, XML tags, or section titles to clearly indicate distinct parts of the input.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call OpenAI GPT-4.5 with the AI SDK:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('gpt-4.5-preview'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

### Generating Structured Data

While text generation can be useful, you might want to generate structured JSON data. For example, you might want to extract information from text, classify data, or generate synthetic data. AI SDK Core provides two functions ([`generateObject`](/docs/reference/ai-sdk-core/generate-object) and [`streamObject`](/docs/reference/ai-sdk-core/stream-object)) to generate structured data, allowing you to constrain model outputs to a specific schema.

```ts
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { object } = await generateObject({
  model: openai('gpt-4.5-preview'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This code snippet will generate a type-safe recipe that conforms to the specified zod schema.

### Using Tools with the AI SDK

GPT-4.5 supports tool calling out of the box, allowing it to interact with external systems and perform discrete tasks. Here's an example of using tool calling with the AI SDK:

```ts
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { text } = await generateText({
  model: openai('gpt-4.5-preview'),
  prompt: 'What is the weather like today in San Francisco?',
  tools: {
    getWeather: tool({
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
});
```

In this example, the `getWeather` tool allows the model to fetch real-time weather data (simulated for simplicity), enhancing its ability to provide accurate and up-to-date information.

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and OpenAI GPT-4.5:

In a new Next.js application, first install the AI SDK and the OpenAI provider:

<Snippet text="pnpm install ai @ai-sdk/openai @ai-sdk/react" />

Then, create a route handler for the chat endpoint:

```tsx filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

// Allow responses up to 30 seconds
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai('gpt-4.5-preview'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

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

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Get Started

Ready to get started? Here's how you can dive in:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the full capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action and get inspired for your own projects.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) and multi-modal chat at [ai-sdk.dev/docs/guides](/docs/guides).
4. Check out ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Get started with OpenAI o1
description: Get started with OpenAI o1 using the AI SDK.
tags: ['getting-started', 'reasoning']
---

# Get started with OpenAI o1

With the [release of OpenAI's o1 series models](https://openai.com/index/introducing-openai-o1-preview/), there has never been a better time to start building AI applications, particularly those that require complex reasoning capabilities.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like OpenAI o1 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## OpenAI o1

OpenAI released a series of AI models designed to spend more time thinking before responding. They can reason through complex tasks and solve harder problems than previous models in science, coding, and math. These models, named the o1 series, are trained with reinforcement learning and can "think before they answer". As a result, they are able to produce a long internal chain of thought before responding to a prompt.

There are three reasoning models available in the API:

1. [**o1**](https://platform.openai.com/docs/models#o1): Designed to reason about hard problems using broad general knowledge about the world.
1. [**o1-preview**](https://platform.openai.com/docs/models#o1): The original preview version of o1 - slower than o1 but supports streaming.
1. [**o1-mini**](https://platform.openai.com/docs/models#o1): A faster and cheaper version of o1, particularly adept at coding, math, and science tasks where extensive general knowledge isn't required. o1-mini supports streaming.

| Model      | Streaming           | Tools               | Object Generation   | Reasoning Effort    |
| ---------- | ------------------- | ------------------- | ------------------- | ------------------- |
| o1         | <Cross size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> |
| o1-preview | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |
| o1-mini    | <Check size={18} /> | <Cross size={18} /> | <Cross size={18} /> | <Cross size={18} /> |

### Benchmarks

OpenAI o1 models excel in scientific reasoning, with impressive performance across various domains:

- Ranking in the 89th percentile on competitive programming questions (Codeforces)
- Placing among the top 500 students in the US in a qualifier for the USA Math Olympiad (AIME)
- Exceeding human PhD-level accuracy on a benchmark of physics, biology, and chemistry problems (GPQA)

[Source](https://openai.com/index/learning-to-reason-with-llms/)

### Prompt Engineering for o1 Models

The o1 models perform best with straightforward prompts. Some prompt engineering techniques, like few-shot prompting or instructing the model to "think step by step," may not enhance performance and can sometimes hinder it. Here are some best practices:

1. Keep prompts simple and direct: The models excel at understanding and responding to brief, clear instructions without the need for extensive guidance.
2. Avoid chain-of-thought prompts: Since these models perform reasoning internally, prompting them to "think step by step" or "explain your reasoning" is unnecessary.
3. Use delimiters for clarity: Use delimiters like triple quotation marks, XML tags, or section titles to clearly indicate distinct parts of the input, helping the model interpret different sections appropriately.
4. Limit additional context in retrieval-augmented generation (RAG): When providing additional context or documents, include only the most relevant information to prevent the model from overcomplicating its response.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call OpenAI o1-mini with the AI SDK:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('o1-mini'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

<Note>
  To use the o1 series of models, you must either be using @ai-sdk/openai
  version 0.0.59 or greater, or set `temperature: 1`.
</Note>

AI SDK Core abstracts away the differences between model providers, allowing you to focus on building great applications. The unified interface also means that you can easily switch between models by changing just one line of code.

```ts highlight="5"
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('o1'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

<Note>
  System messages are automatically converted to OpenAI developer messages.
</Note>

### Refining Reasoning Effort

You can control the amount of reasoning effort expended by o1 through the `reasoningEffort` parameter.
This parameter can be set to `'low'`, `'medium'`, or `'high'` to adjust how much time and computation the model spends on internal reasoning before producing a response.

```ts highlight="9"
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Reduce reasoning effort for faster responses
const { text } = await generateText({
  model: openai('o1'),
  prompt: 'Explain quantum entanglement briefly.',
  providerOptions: {
    openai: { reasoningEffort: 'low' },
  },
});
```

<Note>
  The `reasoningEffort` parameter is only supported by o1 and has no effect on
  other models.
</Note>

### Generating Structured Data

While text generation can be useful, you might want to generate structured JSON data. For example, you might want to extract information from text, classify data, or generate synthetic data. AI SDK Core provides two functions ([`generateObject`](/docs/reference/ai-sdk-core/generate-object) and [`streamObject`](/docs/reference/ai-sdk-core/stream-object)) to generate structured data, allowing you to constrain model outputs to a specific schema.

```ts
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { object } = await generateObject({
  model: openai('o1'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This code snippet will generate a type-safe recipe that conforms to the specified zod schema.

<Note>
  Structured object generation is only supported with o1, not o1-preview or
  o1-mini.
</Note>

### Tools

While LLMs have incredible generation capabilities, they struggle with discrete tasks (e.g. mathematics) and interacting with the outside world (e.g. getting the weather). The solution: [tools](/docs/foundations/tools), which are like programs that you provide to the model, which it can choose to call as necessary.

### Using Tools with the AI SDK

The AI SDK supports tool usage across several of its functions, like [`generateText`](/docs/reference/ai-sdk-core/generate-text) and [`streamText`](/docs/reference/ai-sdk-core/stream-text). By passing one or more tools to the `tools` parameter, you can extend the capabilities of LLMs, allowing them to perform discrete tasks and interact with external systems.

Here's an example of how you can use a tool with the AI SDK and o1:

```ts
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { text } = await generateText({
  model: openai('o1'),
  prompt: 'What is the weather like today?',
  tools: {
    getWeather: tool({
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
});
```

In this example, the `getWeather` tool allows the model to fetch real-time weather data (simulated for simplicity), enhancing its ability to provide accurate and up-to-date information.

<Note>Tools are only compatible with o1, not o1-preview or o1-mini.</Note>

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and OpenAI o1:

```tsx filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

// Allow responses up to 5 minutes
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai('o1-mini'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

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

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Get Started

Ready to get started? Here's how you can dive in:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the full capabilities of the AI SDK.
1. Check out our support for the o1 series of reasoning models in the [OpenAI Provider](/providers/ai-sdk-providers/openai#reasoning-models).
1. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action and get inspired for your own projects.
1. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) and multi-modal chat at [ai-sdk.dev/docs/guides](/docs/guides).
1. Check out ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Get started with OpenAI o3-mini
description: Get started with OpenAI o3-mini using the AI SDK.
tags: ['getting-started', 'reasoning']
---

# Get started with OpenAI o3-mini

With the [release of OpenAI's o3-mini model](https://openai.com/index/openai-o3-mini/), there has never been a better time to start building AI applications, particularly those that require complex STEM reasoning capabilities.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like OpenAI o3-mini alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## OpenAI o3-mini

OpenAI recently released a new AI model optimized for STEM reasoning that excels in science, math, and coding tasks. o3-mini matches o1's performance in these domains while delivering faster responses and lower costs. The model supports tool calling, structured outputs, and system messages, making it a great option for a wide range of applications.

o3-mini offers three reasoning effort levels:

1. [**Low**]: Optimized for speed while maintaining solid reasoning capabilities
2. [**Medium**]: Balanced approach matching o1's performance levels
3. [**High**]: Enhanced reasoning power exceeding o1 in many STEM domains

| Model   | Streaming           | Tool Calling        | Structured Output   | Reasoning Effort    | Image Input         |
| ------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| o3-mini | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Check size={18} /> | <Cross size={18} /> |

### Benchmarks

OpenAI o3-mini demonstrates impressive performance across technical domains:

- 87.3% accuracy on AIME competition math questions
- 79.7% accuracy on PhD-level science questions (GPQA Diamond)
- 2130 Elo rating on competitive programming (Codeforces)
- 49.3% accuracy on verified software engineering tasks (SWE-bench)

<Note>These benchmark results are using high reasoning effort setting.</Note>

[Source](https://openai.com/index/openai-o3-mini/)

### Prompt Engineering for o3-mini

The o3-mini model performs best with straightforward prompts. Some prompt engineering techniques, like few-shot prompting or instructing the model to "think step by step," may not enhance performance and can sometimes hinder it. Here are some best practices:

1. Keep prompts simple and direct: The model excels at understanding and responding to brief, clear instructions without the need for extensive guidance.
2. Avoid chain-of-thought prompts: Since the model performs reasoning internally, prompting it to "think step by step" or "explain your reasoning" is unnecessary.
3. Use delimiters for clarity: Use delimiters like triple quotation marks, XML tags, or section titles to clearly indicate distinct parts of the input.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call OpenAI o3-mini with the AI SDK:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('o3-mini'),
  prompt: 'Explain the concept of quantum entanglement.',
});
```

<Note>
  To use o3-mini, you must be using @ai-sdk/openai version 1.1.9 or greater.
</Note>

<Note>
  System messages are automatically converted to OpenAI developer messages.
</Note>

### Refining Reasoning Effort

You can control the amount of reasoning effort expended by o3-mini through the `reasoningEffort` parameter.
This parameter can be set to `low`, `medium`, or `high` to adjust how much time and computation the model spends on internal reasoning before producing a response.

```ts highlight="9"
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Reduce reasoning effort for faster responses
const { text } = await generateText({
  model: openai('o3-mini'),
  prompt: 'Explain quantum entanglement briefly.',
  providerOptions: {
    openai: { reasoningEffort: 'low' },
  },
});
```

### Generating Structured Data

While text generation can be useful, you might want to generate structured JSON data. For example, you might want to extract information from text, classify data, or generate synthetic data. AI SDK Core provides two functions ([`generateObject`](/docs/reference/ai-sdk-core/generate-object) and [`streamObject`](/docs/reference/ai-sdk-core/stream-object)) to generate structured data, allowing you to constrain model outputs to a specific schema.

```ts
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { object } = await generateObject({
  model: openai('o3-mini'),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

This code snippet will generate a type-safe recipe that conforms to the specified zod schema.

### Using Tools with the AI SDK

o3-mini supports tool calling out of the box, allowing it to interact with external systems and perform discrete tasks. Here's an example of using tool calling with the AI SDK:

```ts
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const { text } = await generateText({
  model: openai('o3-mini'),
  prompt: 'What is the weather like today in San Francisco?',
  tools: {
    getWeather: tool({
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
});
```

In this example, the `getWeather` tool allows the model to fetch real-time weather data (simulated for simplicity), enhancing its ability to provide accurate and up-to-date information.

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and OpenAI o3-mini:

In a new Next.js application, first install the AI SDK and the DeepSeek provider:

<Snippet text="pnpm install ai @ai-sdk/openai @ai-sdk/react" />

Then, create a route handler for the chat endpoint:

```tsx filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

// Allow responses up to 5 minutes
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai('o3-mini'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

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

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Get Started

Ready to get started? Here's how you can dive in:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the full capabilities of the AI SDK.
2. Check out our support for o3-mini in the [OpenAI Provider](/providers/ai-sdk-providers/openai#reasoning-models).
3. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action and get inspired for your own projects.
4. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) and multi-modal chat at [ai-sdk.dev/docs/guides](/docs/guides).
5. Check out ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

---
title: Get started with DeepSeek R1
description: Get started with DeepSeek R1 using the AI SDK.
tags: ['getting-started', 'reasoning']
---

# Get started with DeepSeek R1

With the [release of DeepSeek R1](https://api-docs.deepseek.com/news/news250528), there has never been a better time to start building AI applications, particularly those that require complex reasoning capabilities.

The [AI SDK](/) is a powerful TypeScript toolkit for building AI applications with large language models (LLMs) like DeepSeek R1 alongside popular frameworks like React, Next.js, Vue, Svelte, Node.js, and more.

## DeepSeek R1

DeepSeek R1 is a series of advanced AI models designed to tackle complex reasoning tasks in science, coding, and mathematics. These models are optimized to "think before they answer," producing detailed internal chains of thought that aid in solving challenging problems.

The series includes two primary variants:

- **DeepSeek R1-Zero**: Trained exclusively with reinforcement learning (RL) without any supervised fine-tuning. It exhibits advanced reasoning capabilities but may struggle with readability and formatting.
- **DeepSeek R1**: Combines reinforcement learning with cold-start data and supervised fine-tuning to improve both reasoning performance and the readability of outputs.

### Benchmarks

DeepSeek R1 models excel in reasoning tasks, delivering competitive performance across key benchmarks:

- **AIME 2024 (Pass\@1)**: 79.8%
- **MATH-500 (Pass\@1)**: 97.3%
- **Codeforces (Percentile)**: Top 4% (96.3%)
- **GPQA Diamond (Pass\@1)**: 71.5%

[Source](https://github.com/deepseek-ai/DeepSeek-R1?tab=readme-ov-file#4-evaluation-results)

### Prompt Engineering for DeepSeek R1 Models

DeepSeek R1 models excel with structured and straightforward prompts. The following best practices can help achieve optimal performance:

1. **Use a structured format**: Leverage the model’s preferred output structure with `<think>` tags for reasoning and `<answer>` tags for the final result.
2. **Prefer zero-shot prompts**: Avoid few-shot prompting as it can degrade performance; instead, directly state the problem clearly.
3. **Specify output expectations**: Guide the model by defining desired formats, such as markdown for readability or XML-like tags for clarity.

## Getting Started with the AI SDK

The AI SDK is the TypeScript toolkit designed to help developers build AI-powered applications with React, Next.js, Vue, Svelte, Node.js, and more. Integrating LLMs into applications is complicated and heavily dependent on the specific model provider you use.

The AI SDK abstracts away the differences between model providers, eliminates boilerplate code for building chatbots, and allows you to go beyond text output to generate rich, interactive components.

At the center of the AI SDK is [AI SDK Core](/docs/ai-sdk-core/overview), which provides a unified API to call any LLM. The code snippet below is all you need to call DeepSeek R1 with the AI SDK:

```ts
import { deepseek } from '@ai-sdk/deepseek';
import { generateText } from 'ai';

const { reasoning, text } = await generateText({
  model: deepseek('deepseek-reasoner'),
  prompt: 'Explain quantum entanglement.',
});
```

The unified interface also means that you can easily switch between providers by changing just two lines of code. For example, to use DeepSeek R1 via Fireworks:

```ts
import { fireworks } from '@ai-sdk/fireworks';
import {
  generateText,
  wrapLanguageModel,
  extractReasoningMiddleware,
} from 'ai';

// middleware to extract reasoning tokens
const enhancedModel = wrapLanguageModel({
  model: fireworks('accounts/fireworks/models/deepseek-r1'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});

const { reasoning, text } = await generateText({
  model: enhancedModel,
  prompt: 'Explain quantum entanglement.',
});
```

Or to use Groq's `deepseek-r1-distill-llama-70b` model:

```ts
import { groq } from '@ai-sdk/groq';
import {
  generateText,
  wrapLanguageModel,
  extractReasoningMiddleware,
} from 'ai';

// middleware to extract reasoning tokens
const enhancedModel = wrapLanguageModel({
  model: groq('deepseek-r1-distill-llama-70b'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});

const { reasoning, text } = await generateText({
  model: enhancedModel,
  prompt: 'Explain quantum entanglement.',
});
```

<Note id="deepseek-r1-middleware">
The AI SDK provides a [middleware](/docs/ai-sdk-core/middleware)
(`extractReasoningMiddleware`) that can be used to extract the reasoning
tokens from the model's output.

When using DeepSeek-R1 series models with third-party providers like Together AI, we recommend using the `startWithReasoning`
option in the `extractReasoningMiddleware` function, as they tend to bypass thinking patterns.

</Note>

### Model Provider Comparison

You can use DeepSeek R1 with the AI SDK through various providers. Here's a comparison of the providers that support DeepSeek R1:

| Provider                                                | Model ID                                                                                                          | Reasoning Tokens    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| [DeepSeek](/providers/ai-sdk-providers/deepseek)        | [`deepseek-reasoner`](https://api-docs.deepseek.com/guides/reasoning_model)                                       | <Check size={18} /> |
| [Fireworks](/providers/ai-sdk-providers/fireworks)      | [`accounts/fireworks/models/deepseek-r1`](https://fireworks.ai/models/fireworks/deepseek-r1)                      | Requires Middleware |
| [Groq](/providers/ai-sdk-providers/groq)                | [`deepseek-r1-distill-llama-70b`](https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-70B)               | Requires Middleware |
| [Azure](/providers/ai-sdk-providers/azure)              | [`DeepSeek-R1`](https://ai.azure.com/explore/models/DeepSeek-R1/version/1/registry/azureml-deepseek#code-samples) | Requires Middleware |
| [Together AI](/providers/ai-sdk-providers/togetherai)   | [`deepseek-ai/DeepSeek-R1`](https://www.together.ai/models/deepseek-r1)                                           | Requires Middleware |
| [FriendliAI](/providers/community-providers/friendliai) | [`deepseek-r1`](https://huggingface.co/deepseek-ai/DeepSeek-R1)                                                   | Requires Middleware |
| [LangDB](/providers/community-providers/langdb)         | [`deepseek/deepseek-reasoner`](https://docs.langdb.ai/guides/deepseek)                                            | Requires Middleware |

### Building Interactive Interfaces

AI SDK Core can be paired with [AI SDK UI](/docs/ai-sdk-ui/overview), another powerful component of the AI SDK, to streamline the process of building chat, completion, and assistant interfaces with popular frameworks like Next.js, Nuxt, and SvelteKit.

AI SDK UI provides robust abstractions that simplify the complex tasks of managing chat streams and UI updates on the frontend, enabling you to develop dynamic AI-driven interfaces more efficiently.

With four main hooks — [`useChat`](/docs/reference/ai-sdk-ui/use-chat), [`useCompletion`](/docs/reference/ai-sdk-ui/use-completion), and [`useObject`](/docs/reference/ai-sdk-ui/use-object) — you can incorporate real-time chat capabilities, text completions, streamed JSON, and interactive assistant features into your app.

Let's explore building a chatbot with [Next.js](https://nextjs.org), the AI SDK, and DeepSeek R1:

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
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
```

<Note>
  You can forward the model's reasoning tokens to the client with
  `sendReasoning: true` in the `toDataStreamResponse` method.
</Note>

Finally, update the root page (`app/page.tsx`) to use the `useChat` hook:

```tsx filename="app/page.tsx"
'use client';

import { useChat } from '@ai-sdk/react';

export default function Page() {
  const { messages, input, handleInputChange, handleSubmit, error } = useChat();

  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.reasoning && <pre>{message.reasoning}</pre>}
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

<Note>
  You can access the model's reasoning tokens with the `reasoning` property on
  the `message` object.
</Note>

The useChat hook on your root page (`app/page.tsx`) will make a request to your AI provider endpoint (`app/api/chat/route.ts`) whenever the user submits a message. The messages are then displayed in the chat UI.

## Limitations

While DeepSeek R1 models are powerful, they have certain limitations:

- No tool-calling support: DeepSeek R1 cannot directly interact with APIs or external tools.
- No object generation support: DeepSeek R1 does not support structured object generation. However, you can combine it with models that support structured object generation (like gpt-4o-mini) to generate objects. See the [structured object generation with a reasoning model recipe](/cookbook/node/generate-object-reasoning) for more information.

## Get Started

Ready to dive in? Here's how you can begin:

1. Explore the documentation at [ai-sdk.dev/docs](/docs) to understand the capabilities of the AI SDK.
2. Check out practical examples at [ai-sdk.dev/examples](/examples) to see the SDK in action.
3. Dive deeper with advanced guides on topics like Retrieval-Augmented Generation (RAG) at [ai-sdk.dev/docs/guides](/docs/guides).
4. Use ready-to-deploy AI templates at [vercel.com/templates?type=ai](https://vercel.com/templates?type=ai).

DeepSeek R1 opens new opportunities for reasoning-intensive AI applications. Start building today and leverage the power of advanced reasoning in your AI projects.

---
title: Guides
description: Learn how to build AI applications with the AI SDK
---

# Guides

These use-case specific guides are intended to help you build real applications with the AI SDK.

<IndexCards
  cards={[
    {
      title: 'RAG Chatbot',
      description:
        'Learn how to build a retrieval-augmented generation chatbot with the AI SDK.',
      href: '/docs/guides/rag-chatbot',
    },
    {
      title: 'Multimodal Chatbot',
      description: 'Learn how to build a multimodal chatbot with the AI SDK.',
      href: '/docs/guides/multi-modal-chatbot',
    },
    {
      title: 'Get started with Llama 3.1',
      description: 'Get started with Llama 3.1 using the AI SDK.',
      href: '/docs/guides/llama-3_1',
    },
    {
      title: 'Get started with OpenAI o1',
      description: 'Get started with OpenAI o1 using the AI SDK.',
      href: '/docs/guides/o1',
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
  The examples use the OpenAI `gpt-4o` model. Ensure that the OpenAI API key is
  set in the `OPENAI_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/node-http-server](https://github.com/vercel/ai/tree/main/examples/node-http-server)

### Data Stream

You can use the `pipeDataStreamToResponse` method to pipe the stream data to the server response.

```ts filename='index.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeDataStreamToResponse(res);
}).listen(8080);
```

### Sending Custom Data

`pipeDataStreamToResponse` can be used to send custom data to the client.

```ts filename='index.ts' highlight="6-9,16"
import { openai } from '@ai-sdk/openai';
import { pipeDataStreamToResponse, streamText } from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  // immediately start streaming the response
  pipeDataStreamToResponse(res, {
    execute: async dataStreamWriter => {
      dataStreamWriter.writeData('initialized call');

      const result = streamText({
        model: openai('gpt-4o'),
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      result.mergeIntoDataStream(dataStreamWriter);
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });
}).listen(8080);
```

### Text Stream

You can send a text stream to the client using `pipeTextStreamToResponse`.

```ts filename='index.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { createServer } from 'http';

createServer(async (req, res) => {
  const result = streamText({
    model: openai('gpt-4o'),
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
  The examples use the OpenAI `gpt-4o` model. Ensure that the OpenAI API key is
  set in the `OPENAI_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/express](https://github.com/vercel/ai/tree/main/examples/express)

### Data Stream

You can use the `pipeDataStreamToResponse` method to pipe the stream data to the server response.

```ts filename='index.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/', async (req: Request, res: Response) => {
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  result.pipeDataStreamToResponse(res);
});

app.listen(8080, () => {
  console.log(`Example app listening on port ${8080}`);
});
```

### Sending Custom Data

`pipeDataStreamToResponse` can be used to send custom data to the client.

```ts filename='index.ts' highlight="8-11,18"
import { openai } from '@ai-sdk/openai';
import { pipeDataStreamToResponse, streamText } from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/stream-data', async (req: Request, res: Response) => {
  // immediately start streaming the response
  pipeDataStreamToResponse(res, {
    execute: async dataStreamWriter => {
      dataStreamWriter.writeData('initialized call');

      const result = streamText({
        model: openai('gpt-4o'),
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      result.mergeIntoDataStream(dataStreamWriter);
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });
});

app.listen(8080, () => {
  console.log(`Example app listening on port ${8080}`);
});
```

### Text Stream

You can send a text stream to the client using `pipeTextStreamToResponse`.

```ts filename='index.ts' highlight="13"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import express, { Request, Response } from 'express';

const app = express();

app.post('/', async (req: Request, res: Response) => {
  const result = streamText({
    model: openai('gpt-4o'),
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
  The examples use the OpenAI `gpt-4o` model. Ensure that the OpenAI API key is
  set in the `OPENAI_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/hono](https://github.com/vercel/ai/tree/main/examples/hono)

### Data Stream

You can use the `toDataStream` method to get a data stream from the result and then pipe it to the response.

```ts filename='index.ts'
import { openai } from '@ai-sdk/openai';
import { serve } from '@hono/node-server';
import { streamText } from 'ai';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

const app = new Hono();

app.post('/', async c => {
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  // Mark the response as a v1 data stream:
  c.header('X-Vercel-AI-Data-Stream', 'v1');
  c.header('Content-Type', 'text/plain; charset=utf-8');

  return stream(c, stream => stream.pipe(result.toDataStream()));
});

serve({ fetch: app.fetch, port: 8080 });
```

### Sending Custom Data

`createDataStream` can be used to send custom data to the client.

```ts filename='index.ts' highlight="10-13,20"
import { openai } from '@ai-sdk/openai';
import { serve } from '@hono/node-server';
import { createDataStream, streamText } from 'ai';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

const app = new Hono();

app.post('/stream-data', async c => {
  // immediately start streaming the response
  const dataStream = createDataStream({
    execute: async dataStreamWriter => {
      dataStreamWriter.writeData('initialized call');

      const result = streamText({
        model: openai('gpt-4o'),
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      result.mergeIntoDataStream(dataStreamWriter);
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });

  // Mark the response as a v1 data stream:
  c.header('X-Vercel-AI-Data-Stream', 'v1');
  c.header('Content-Type', 'text/plain; charset=utf-8');

  return stream(c, stream =>
    stream.pipe(dataStream.pipeThrough(new TextEncoderStream())),
  );
});

serve({ fetch: app.fetch, port: 8080 });
```

### Text Stream

You can use the `textStream` property to get a text stream from the result and then pipe it to the response.

```ts filename='index.ts' highlight="17"
import { openai } from '@ai-sdk/openai';
import { serve } from '@hono/node-server';
import { streamText } from 'ai';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

const app = new Hono();

app.post('/', async c => {
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  c.header('Content-Type', 'text/plain; charset=utf-8');

  return stream(c, stream => stream.pipe(result.textStream));
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
  The examples use the OpenAI `gpt-4o` model. Ensure that the OpenAI API key is
  set in the `OPENAI_API_KEY` environment variable.
</Note>

**Full example**: [github.com/vercel/ai/examples/fastify](https://github.com/vercel/ai/tree/main/examples/fastify)

### Data Stream

You can use the `toDataStream` method to get a data stream from the result and then pipe it to the response.

```ts filename='index.ts'
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/', async function (request, reply) {
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  // Mark the response as a v1 data stream:
  reply.header('X-Vercel-AI-Data-Stream', 'v1');
  reply.header('Content-Type', 'text/plain; charset=utf-8');

  return reply.send(result.toDataStream({ data }));
});

fastify.listen({ port: 8080 });
```

### Sending Custom Data

`createDataStream` can be used to send custom data to the client.

```ts filename='index.ts' highlight="8-11,18"
import { openai } from '@ai-sdk/openai';
import { createDataStream, streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/stream-data', async function (request, reply) {
  // immediately start streaming the response
  const dataStream = createDataStream({
    execute: async dataStreamWriter => {
      dataStreamWriter.writeData('initialized call');

      const result = streamText({
        model: openai('gpt-4o'),
        prompt: 'Invent a new holiday and describe its traditions.',
      });

      result.mergeIntoDataStream(dataStreamWriter);
    },
    onError: error => {
      // Error messages are masked by default for security reasons.
      // If you want to expose the error message to the client, you can do so here:
      return error instanceof Error ? error.message : String(error);
    },
  });

  // Mark the response as a v1 data stream:
  reply.header('X-Vercel-AI-Data-Stream', 'v1');
  reply.header('Content-Type', 'text/plain; charset=utf-8');

  return reply.send(dataStream);
});

fastify.listen({ port: 8080 });
```

### Text Stream

You can use the `textStream` property to get a text stream from the result and then pipe it to the response.

```ts filename='index.ts' highlight="15"
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

fastify.post('/', async function (request, reply) {
  const result = streamText({
    model: openai('gpt-4o'),
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

### Data Stream

You can use the `pipeDataStreamToResponse` method to get a data stream from the result and then pipe it to the response.

```ts filename='app.controller.ts'
import { Controller, Post, Res } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post()
  async example(@Res() res: Response) {
    const result = streamText({
      model: openai('gpt-4o'),
      prompt: 'Invent a new holiday and describe its traditions.',
    });

    result.pipeDataStreamToResponse(res);
  }
}
```

### Sending Custom Data

`pipeDataStreamToResponse` can be used to send custom data to the client.

```ts filename='app.controller.ts' highlight="10-12,19"
import { Controller, Post, Res } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { pipeDataStreamToResponse, streamText } from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post('/stream-data')
  async streamData(@Res() res: Response) {
    pipeDataStreamToResponse(res, {
      execute: async dataStreamWriter => {
        dataStreamWriter.writeData('initialized call');

        const result = streamText({
          model: openai('gpt-4o'),
          prompt: 'Invent a new holiday and describe its traditions.',
        });

        result.mergeIntoDataStream(dataStreamWriter);
      },
      onError: error => {
        // Error messages are masked by default for security reasons.
        // If you want to expose the error message to the client, you can do so here:
        return error instanceof Error ? error.message : String(error);
      },
    });
  }
}
```

### Text Stream

You can use the `pipeTextStreamToResponse` method to get a text stream from the result and then pipe it to the response.

```ts filename='app.controller.ts' highlight="15"
import { Controller, Post, Res } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { Response } from 'express';

@Controller()
export class AppController {
  @Post()
  async example(@Res() res: Response) {
    const result = streamText({
      model: openai('gpt-4o'),
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

If you have questions about anything related to the AI SDK, you're always welcome to ask our community on [GitHub Discussions](https://github.com/vercel/ai/discussions).

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
title: AI SDK 5 Beta
description: Get started with the Beta version of AI SDK 5.
---

# Announcing AI SDK 5 Beta

<Note type="warning">
  AI SDK 5 is in beta — while more stable than alpha, APIs may still change. Pin
  to specific versions as breaking changes may occur in minor releases.
</Note>

## Beta Version Guidance

The AI SDK 5 Beta is intended for:

- **New projects** where you can adopt the latest patterns from the start
- **Trying out new features** and giving us feedback on the developer experience
- **Experimenting with migrations** from v4 to understand the upgrade path
- **Development and testing environments** where you can iterate quickly

**Short on time?** Wait for the stable release. We're focusing on polish and migration tooling improvements.

**For production applications**: Experiment with migrations in development, but avoid fully migrating production systems. Use this beta period to understand the changes and prepare your migration strategy.

## What to Expect in Beta

- **No major breaking changes** - the architecture is stable
- **Minor breaking changes possible** - we may refine APIs for critical bugfixes
- **Bug fixes and DX improvements** - active development continues

Your feedback during this beta phase directly shapes the final stable release. Share your experiences through [GitHub issues](https://github.com/vercel/ai/issues/new/choose).

<Note type="warning">
  While more stable than alpha, you may still encounter bugs in this Beta
  release. To help us improve the SDK, [file bug reports on
  GitHub](https://github.com/vercel/ai/issues/new/choose). Your reports directly
  contribute to making the final release more stable and reliable.
</Note>

## Installation

To install the AI SDK 5 Beta, run the following command:

```bash
# replace with your provider and framework
npm install ai@beta @ai-sdk/openai@beta @ai-sdk/react@beta
```

<Note type="warning">
  APIs may still change during beta. Pin to specific versions as breaking
  changes may occur in minor releases.
</Note>

## What's new in AI SDK 5?

AI SDK 5 is a redesign of the AI SDK's protocol and architecture based on everything we learned over the last two years of real-world usage. We also modernized the UI and protocols that have remained largely unchanged since AI SDK v2/3, to create a strong foundation for the future.

### Why a new specification (LanguageModelV2)?

When we originally designed the v1 protocol over a year ago, the standard interaction pattern with language models was text in, text or tool call out. Today's LLMs go beyond text and tool calls, generating reasoning, sources, images and more. New use cases like computer-using agents introduce a fundamentally different approach to interacting with language models that made it impossible to support in a unified approach with our original architecture.

We needed a protocol designed for this new reality. While this is a breaking change that we take seriously, it provided an opportunity to rebuild the foundation and add new features.

## New Features

- [**`LanguageModelV2`**](#languagemodelv2) - new redesigned architecture
- [**Message Overhaul**](#message-overhaul) - new `UIMessage` and `ModelMessage` types
- [**Server-Sent Events (SSE)**](#server-sent-events-sse) - new standardised protocol for sending UI messages to the client
- [**Agentic Control**](#agentic-control) - new primitives for building agentic systems
- [**Enhanced useChat Architecture**](#enhanced-usechat-architecture) - improved state management with transport system

## `LanguageModelV2`

`LanguageModelV2` represents a complete redesign of how the AI SDK communicates with language models, adapting to the increasingly complex outputs modern AI systems generate. The new `LanguageModelV2` treats all LLM outputs as content parts, enabling consistent handling of text, images, reasoning, sources, and other response types. It has:

- **Content-First Design** - Rather than separating text, reasoning, and tool calls, everything is represented as ordered content parts in a unified array
- **Improved Type Safety** - The new `LanguageModelV2` provides better TypeScript type guarantees, making it easier to work with different content types
- **Extensibility** - Adding support for new model capabilities requires no changes to the core structure

## Message Overhaul

AI SDK 5 introduces a completely redesigned message system with two message types that address the dual needs of what you render in your UI and what you send to the model. Context is crucial for effective language model generations, and these message types serve distinct purposes:

- **UIMessage** represents the complete conversation history for your interface, preserving all message parts (text, images, data), metadata (creation timestamps, generation times), and UI state.

- **ModelMessage** is optimized for sending to language models, considering token input constraints. It strips away UI-specific metadata and irrelevant content.

With this change, you must explicitly convert your `UIMessage`s to `ModelMessage`s before sending them to the model.

```ts highlight="9"
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

<Note>
  This separation is essential as you can't use a single message format for both
  purposes. Always save state in the `UIMessage` format to prevent information
  loss, with explicit conversion to `ModelMessage` when communicating with
  language models.
</Note>

The new message system makes several highly requested features possible:

- **Type-safe Message Metadata** - Add structured information per message
- **Type-safe Tool Calls** - Improved type safety when defining and using tools in your messages
- **New Stream Writer** - Stream any part type (reasoning, sources, etc.) retaining proper order
- **Data Parts** - Stream type-safe arbitrary data parts for dynamic UI components

### Type-safe Tool Calls

AI SDK 5 introduces type-safe tool calls in UI messages. Instead of generic `tool-invocation` types, tool parts use specific naming: `tool-${toolName}`. This provides better type safety and makes it easier to handle many tools in your UI.

```tsx filename="AI SDK 4.0"
// Generic tool-invocation type
{
  message.parts.map(part => {
    if (part.type === 'tool-invocation') {
      return <div>{part.toolInvocation.toolName}</div>;
    }
  });
}
```

```tsx filename="AI SDK 5.0"
// Type-safe tool parts with specific names
{
  message.parts.map(part => {
    switch (part.type) {
      case 'tool-getWeatherInformation':
        return <div>Getting weather...</div>;
      case 'tool-askForConfirmation':
        return <div>Asking for confirmation...</div>;
    }
  });
}
```

### Message metadata

Metadata allows you to attach structured information to individual messages, making it easier to track details like response time, token usage, or model specifications. This information can enhance your UI with contextual data without embedding it in the message content itself.

To add metadata to a message, first define the metadata schema:

```ts filename="app/api/chat/example-metadata-schema.ts"
export const exampleMetadataSchema = z.object({
  duration: z.number().optional(),
  model: z.string().optional(),
  totalTokens: z.number().optional(),
});

export type ExampleMetadata = z.infer<typeof exampleMetadataSchema>;
```

Then add the metadata using the `message.metadata` property on the `toUIMessageStreamResponse()` utility:

```ts filename="app/api/chat/route.ts"
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { ExampleMetadata } from './example-metadata-schema';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const startTime = Date.now();
  const result = streamText({
    model: openai('gpt-4o'),
    prompt: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }): ExampleMetadata | undefined => {
      // send custom information to the client on start:
      if (part.type === 'start') {
        return {
          model: 'gpt-4o', // initial model id
        };
      }

      // send additional model information on finish-step:
      if (part.type === 'finish-step') {
        return {
          model: part.response.modelId, // update with the actual model id
          duration: Date.now() - startTime,
        };
      }

      // when the message is finished, send additional information:
      if (part.type === 'finish') {
        return {
          totalTokens: part.totalUsage.totalTokens,
        };
      }
    },
  });
}
```

Finally, use the metadata type with useChat and render the (type-safe) metadata in your UI:

```tsx filename="app/page.tsx"
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { ExampleMetadata } from './api/chat/example-metadata-schema';

type MyMessage = UIMessage<ExampleMetadata>;

export default function Chat() {
  const { messages } = useChat<MyMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div>
      {messages.map(message => (
        <div key={message.id} className="whitespace-pre-wrap">
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.metadata?.duration && (
            <div>Duration: {message.metadata.duration}ms</div>
          )}
          {message.metadata?.model && (
            <div>Model: {message.metadata.model}</div>
          )}
          {message.metadata?.totalTokens && (
            <div>Total tokens: {message.metadata.totalTokens}</div>
          )}
        </div>
      ))}
    </div>
  );
}
```

### UIMessageStream

The UI Message Stream enables streaming any content parts from the server to the client. With this stream, you can send structured data like custom sources from your RAG pipeline directly to your UI. The stream writer is a utility that makes it easy to write to this message stream.

```ts
const stream = createUIMessageStream({
  execute: writer => {
    // stream custom sources
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
  },
});
```

On the client, these will be added to the ordered `message.parts` array.

### Data Parts

The new stream writer enables a type-safe way to stream arbitrary data from the server to the client and display it in your UI.

You can create and stream custom data parts on the server:

```tsx
// On the server
const stream = createUIMessageStream({
  execute: writer => {
    // Initial update
    writer.write({
      type: 'data-weather', // Custom type
      id: toolCallId, // ID for updates
      data: { city, status: 'loading' }, // Your data
    });

    // Later, update the same part
    writer.write({
      type: 'data-weather',
      id: toolCallId,
      data: { city, weather, status: 'success' },
    });
  },
});
```

On the client, you can render these parts with full type safety:

```tsx
{
  message.parts
    .filter(part => part.type === 'data-weather') // type-safe
    .map((part, index) => (
      <Weather
        key={index}
        city={part.data.city} // type-safe
        weather={part.data.weather} // type-safe
        status={part.data.status} // type-safe
      />
    ));
}
```

Data parts appear in the `message.parts` array along with other content, maintaining the proper ordering of the conversation. You can update parts by referencing the same ID, enabling dynamic experiences like collaborative artifacts.

## Enhanced useChat Architecture

AI SDK 5 introduces a new `useChat` architecture with transport-based configuration. This design makes state management and API integration flexible, allowing you to configure backend protocols without rewriting application logic.

The new `useChat` hook uses a transport system for better modularity:

- **Transport Configuration** – configure API endpoints and request handling through transport objects
- **Enhanced State Management** – improved message handling with the new UIMessage format
- **Type Safety** – stronger TypeScript support throughout the chat lifecycle

Configure useChat with the transport system:

```ts
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/chat', // your chat endpoint
    headers: { 'Custom-Header': 'value' },
  }),
  maxSteps: 5,
});
```

## Server-Sent Events (SSE)

AI SDK 5 uses Server-Sent Events (SSE) instead of a custom streaming protocol. SSE is a common web standard for sending data from servers to browsers. This switch has several advantages:

- **Works everywhere** - Uses technology that works in all major browsers and platforms
- **Easier to troubleshoot** - See the data stream in browser developer tools
- **Simpler to build upon** - Adding new features is more straightforward
- **More stable** - Built on proven technology that many developers already use

## Agentic Control

AI SDK 5 introduces new features for building agents that help you control model behavior more precisely.

### prepareStep

The `prepareStep` function gives you fine-grained control over each step in a multi-step agent. It's called before a step starts and allows you to:

- Dynamically change the model used for specific steps
- Force specific tool selections for particular steps
- Limit which tools are available during specific steps
- Examine the context of previous steps before proceeding

```ts
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

This makes it easier to build AI systems that adapt their capabilities based on context and task requirements.

### `stopWhen`

The `stopWhen` parameter lets you define stopping conditions for your agent. Instead of running indefinitely, you can specify exactly when the agent should terminate based on various conditions:

- Reaching a maximum number of steps
- Calling a specific tool
- Satisfying any custom condition you define

```ts
const result = generateText({
  // ...
  // stop loop at 5 steps
  stopWhen: stepCountIs(5),
});

const result = generateText({
  // ...
  // stop loop when weather tool called
  stopWhen: hasToolCall('weather'),
});

const result = generateText({
  // ...
  // stop loop at your own custom condition
  stopWhen: maxTotalTokens(20000),
});
```

These agentic controls form the foundation for building reliable, controllable AI systems that tackle complex problems while remaining within well-defined constraints.

## Additional New Features

### Tool Output Schema

Tools can now optionally specify an output schema for better type inference and validation:

```tsx filename="AI SDK 5.0"
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get weather information',
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ city }) => ({
    temperature: 72,
    conditions: 'sunny',
  }),
});
```

### Tool Type Inference Helpers

New utility types simplify working with tool types:

```tsx filename="AI SDK 5.0"
import { InferToolInput, InferToolOutput, InferUITool } from 'ai';
import { weatherTool } from './weatherTool';

// Infer input and output types from tool definitions
type WeatherInput = InferToolInput<typeof weatherTool>;
type WeatherOutput = InferToolOutput<typeof weatherTool>;
type WeatherUITool = InferUITool<typeof weatherTool>;

// Use in UI message type definitions
type MyUIMessage = UIMessage<
  never, // metadata type
  UIDataTypes, // data parts type
  {
    weather: WeatherUITool;
  }
>;
```

### OpenAI Provider-Executed Tools

New built-in tools for OpenAI:

```tsx filename="AI SDK 5.0"
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: openai('gpt-4.1'),
  tools: {
    file_search: openai.tools.fileSearch(),
    web_search_preview: openai.tools.webSearchPreview({
      searchContextSize: 'high',
    }),
  },
  messages,
});
```

Available tools:

- **`fileSearch`**: Search through uploaded documents using OpenAI's file search
- **`webSearchPreview`**: Web search capabilities (preview feature)

When using provider-defined tools like `fileSearch` and `webSearchPreview`, the tool execution results are automatically added to the message history, providing context for subsequent interactions.

This automatic message history inclusion ensures that:

- Tool execution context is preserved across conversation turns
- Follow-up questions can reference previously searched information
- The full conversation flow is maintained for debugging and logging

### Enhanced Tool Streaming

Tools now support fine-grained streaming callbacks:

```tsx filename="AI SDK 5.0"
const weatherTool = tool({
  inputSchema: z.object({ city: z.string() }),
  onInputStart: ({ toolCallId }) => {
    console.log('Tool input streaming started:', toolCallId);
  },
  onInputDelta: ({ inputTextDelta, toolCallId }) => {
    console.log('Tool input delta:', inputTextDelta);
  },
  onInputAvailable: ({ input, toolCallId }) => {
    console.log('Tool input ready:', input);
  },
  execute: async ({ city }) => {
    return `Weather in ${city}: sunny, 72°F`;
  },
});
```

## Migration from AI SDK 4.x

Ready to upgrade from AI SDK 4.x to 5.0 Beta? We created a comprehensive migration guide to help you through the process.

The migration involves several key changes:

- Updated message format with `UIMessage` and `ModelMessage` types
- New `useChat` architecture with transport system
- New streaming protocol with Server-Sent Events
- Improved type safety and developer experience

**[View the complete Migration Guide →](/docs/migration-guides/migration-guide-5-0)**

The migration guide includes:

- Step-by-step upgrade instructions
- Detailed examples for each breaking change
- Best practices for adopting new features

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
- [`generateObject`](/docs/ai-sdk-core/generating-structured-data): Generates a typed, structured object that matches a [Zod](https://zod.dev/) schema.
  You can use this function to force the language model to return structured data, e.g. for information extraction, synthetic data generation, or classification tasks.
- [`streamObject`](/docs/ai-sdk-core/generating-structured-data): Stream a structured object that matches a Zod schema.
  You can use this function to [stream generated UIs](/docs/ai-sdk-ui/object-generation).

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

const { text } = await generateText({
  model: yourModel,
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
```

You can use more [advanced prompts](./prompts) to generate text with more complex instructions and content:

```tsx
import { generateText } from 'ai';

const { text } = await generateText({
  model: yourModel,
  system:
    'You are a professional writer. ' +
    'You write simple, clear, and concise content.',
  prompt: `Summarize the following article in 3-5 sentences: ${article}`,
});
```

The result object of `generateText` contains several promises that resolve when all required data is available:

- `result.text`: The generated text.
- `result.reasoning`: The reasoning text of the model (only available for some models).
- `result.sources`: Sources that have been used as input to generate the response (only available for some models).
- `result.finishReason`: The reason the model finished generating text.
- `result.usage`: The usage of the model during text generation.

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

## `streamText`

Depending on your model and prompt, it can take a large language model (LLM) up to a minute to finish generating its response. This delay can be unacceptable for interactive use cases such as chatbots or real-time applications, where users expect immediate responses.

AI SDK Core provides the [`streamText`](/docs/reference/ai-sdk-core/stream-text) function which simplifies streaming text from LLMs:

```ts
import { streamText } from 'ai';

const result = streamText({
  model: yourModel,
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

- `result.toDataStreamResponse()`: Creates a data stream HTTP response (with tool calls etc.) that can be used in a Next.js App Router API route.
- `result.pipeDataStreamToResponse()`: Writes data stream delta output to a Node.js response-like object.
- `result.toTextStreamResponse()`: Creates a simple text stream HTTP response.
- `result.pipeTextStreamToResponse()`: Writes text delta output to a Node.js response-like object.

<Note>
  `streamText` is using backpressure and only generates tokens as they are
  requested. You need to consume the stream in order for it to finish.
</Note>

It also provides several promises that resolve when the stream is finished:

- `result.text`: The generated text.
- `result.reasoning`: The reasoning text of the model (only available for some models).
- `result.sources`: Sources that have been used as input to generate the response (only available for some models).
- `result.finishReason`: The reason the model finished generating text.
- `result.usage`: The usage of the model during text generation.

### `onError` callback

`streamText` immediately starts streaming to enable sending data without waiting for the model.
Errors become part of the stream and are not thrown to prevent e.g. servers from crashing.

To log errors, you can provide an `onError` callback that is triggered when an error occurs.

```tsx highlight="6-8"
import { streamText } from 'ai';

const result = streamText({
  model: yourModel,
  prompt: 'Invent a new holiday and describe its traditions.',
  onError({ error }) {
    console.error(error); // your error logging logic here
  },
});
```

### `onChunk` callback

When using `streamText`, you can provide an `onChunk` callback that is triggered for each chunk of the stream.

It receives the following chunk types:

- `text-delta`
- `reasoning`
- `source`
- `tool-call`
- `tool-result`
- `tool-call-streaming-start` (when `toolCallStreaming` is enabled)
- `tool-call-delta` (when `toolCallStreaming` is enabled)

```tsx highlight="6-11"
import { streamText } from 'ai';

const result = streamText({
  model: yourModel,
  prompt: 'Invent a new holiday and describe its traditions.',
  onChunk({ chunk }) {
    // implement your own logic here, e.g.:
    if (chunk.type === 'text-delta') {
      console.log(chunk.text);
    }
  },
});
```

### `onFinish` callback

When using `streamText`, you can provide an `onFinish` callback that is triggered when the stream is finished (
[API Reference](/docs/reference/ai-sdk-core/stream-text#on-finish)
).
It contains the text, usage information, finish reason, messages, and more:

```tsx highlight="6-8"
import { streamText } from 'ai';

const result = streamText({
  model: yourModel,
  prompt: 'Invent a new holiday and describe its traditions.',
  onFinish({ text, finishReason, usage, response }) {
    // your own logic, e.g. for saving the chat history or recording usage

    const messages = response.messages; // messages that were generated
  },
});
```

### `fullStream` property

You can read a stream with all events using the `fullStream` property.
This can be useful if you want to implement your own UI or handle the stream in a different way.
Here is an example of how to use the `fullStream` property:

```tsx
import { streamText } from 'ai';
import { z } from 'zod';

const result = streamText({
  model: yourModel,
  tools: {
    cityAttractions: {
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({
        attractions: ['attraction1', 'attraction2', 'attraction3'],
      }),
    },
  },
  prompt: 'What are some San Francisco tourist attractions?',
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta': {
      // handle text delta here
      break;
    }
    case 'reasoning': {
      // handle reasoning here
      break;
    }
    case 'source': {
      // handle source here
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
    case 'tool-result': {
      switch (part.toolName) {
        case 'cityAttractions': {
          // handle tool result here
          break;
        }
      }
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
can be used to smooth out text streaming.

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
const upperCaseTransform =
  <TOOLS extends ToolSet>() =>
  (options: { tools: TOOLS; stopStream: () => void }) =>
    new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        controller.enqueue(
          // for text-delta chunks, convert the text to uppercase:
          chunk.type === 'text-delta'
            ? { ...chunk, textDelta: chunk.textDelta.toUpperCase() }
            : chunk,
        );
      },
    });
```

You can also stop the stream using the `stopStream` function.
This is e.g. useful if you want to stop the stream when model guardrails are violated, e.g. by generating inappropriate content.

When you invoke `stopStream`, it is important to simulate the `step-finish` and `finish` events to guarantee that a well-formed stream is returned
and all callbacks are invoked.

```ts
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

        if (chunk.textDelta.includes('STOP')) {
          // stop the stream
          stopStream();

          // simulate the step-finish event
          controller.enqueue({
            type: 'step-finish',
            finishReason: 'stop',
            logprobs: undefined,
            usage: {
              completionTokens: NaN,
              promptTokens: NaN,
              totalTokens: NaN,
            },
            request: {},
            response: {
              id: 'response-id',
              modelId: 'mock-model-id',
              timestamp: new Date(0),
            },
            warnings: [],
            isContinued: false,
          });

          // simulate the finish event
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            logprobs: undefined,
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
  model: google('gemini-2.0-flash-exp', { useSearchGrounding: true }),
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
  model: google('gemini-2.0-flash-exp', { useSearchGrounding: true }),
  prompt: 'List the top 5 San Francisco news from the past week.',
});

for await (const part of result.fullStream) {
  if (part.type === 'source' && part.source.sourceType === 'url') {
    console.log('ID:', part.source.id);
    console.log('Title:', part.source.title);
    console.log('URL:', part.source.url);
    console.log('Provider metadata:', part.source.providerMetadata);
    console.log();
  }
}
```

The sources are also available in the `result.sources` promise.

## Generating Long Text

Most language models have an output limit that is much shorter than their context window.
This means that you cannot generate long text in one go,
but it is possible to add responses back to the input and continue generating
to create longer text.

`generateText` and `streamText` support such continuations for long text generation using the experimental `continueSteps` setting:

```tsx highlight="5-6,9-10"
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const {
  text, // combined text
  usage, // combined usage of all steps
} = await generateText({
  model: openai('gpt-4o'), // 4096 output tokens
  maxSteps: 5, // enable multi-step calls
  experimental_continueSteps: true,
  prompt:
    'Write a book about Roman history, ' +
    'from the founding of the city of Rome ' +
    'to the fall of the Western Roman Empire. ' +
    'Each chapter MUST HAVE at least 1000 words.',
});
```

<Note>
  When `experimental_continueSteps` is enabled, only full words are streamed in
  `streamText`, and both `generateText` and `streamText` might drop the trailing
  tokens of some calls to prevent whitespace issues.
</Note>

<Note type="warning">
  Some models might not always stop correctly on their own and keep generating
  until `maxSteps` is reached. You can hint the model to stop by e.g. using a
  system message such as "Stop when sufficient information was provided."
</Note>

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
with the [`generateObject`](/docs/reference/ai-sdk-core/generate-object)
and [`streamObject`](/docs/reference/ai-sdk-core/stream-object) functions.
You can use both functions with different output strategies, e.g. `array`, `object`, or `no-schema`,
and with different generation modes, e.g. `auto`, `tool`, or `json`.
You can use [Zod schemas](/docs/reference/ai-sdk-core/zod-schema), [Valibot](/docs/reference/ai-sdk-core/valibot-schema), or [JSON schemas](/docs/reference/ai-sdk-core/json-schema) to specify the shape of the data that you want,
and the AI model will generate data that conforms to that structure.

<Note>
  You can pass Zod objects directly to the AI SDK functions or use the
  `zodSchema` helper function.
</Note>

<Note type="warning">
  **Zod v4 Compatibility**: AI SDK v4 requires Zod v3. If you're using Zod v4,
  you'll encounter schema validation errors. [See troubleshooting
  guide](/docs/troubleshooting/zod-v4-json-schema-type-error).
</Note>

## Generate Object

The `generateObject` generates structured data from a prompt.
The schema is also used to validate the generated data, ensuring type safety and correctness.

```ts
import { generateObject } from 'ai';
import { z } from 'zod';

const { object } = await generateObject({
  model: yourModel,
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

<Note>
  See `generateObject` in action with [these examples](#more-examples)
</Note>

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

## Stream Object

Given the added complexity of returning structured data, model response time can be unacceptable for your interactive use case.
With the [`streamObject`](/docs/reference/ai-sdk-core/stream-object) function, you can stream the model's response as it is generated.

```ts
import { streamObject } from 'ai';

const { partialObjectStream } = streamObject({
  // ...
});

// use partialObjectStream as an async iterable
for await (const partialObject of partialObjectStream) {
  console.log(partialObject);
}
```

You can use `streamObject` to stream generated UIs in combination with React Server Components (see [Generative UI](../ai-sdk-rsc))) or the [`useObject`](/docs/reference/ai-sdk-ui/use-object) hook.

<Note>See `streamObject` in action with [these examples](#more-examples)</Note>

### `onError` callback

`streamObject` immediately starts streaming.
Errors become part of the stream and are not thrown to prevent e.g. servers from crashing.

To log errors, you can provide an `onError` callback that is triggered when an error occurs.

```tsx highlight="5-7"
import { streamObject } from 'ai';

const result = streamObject({
  // ...
  onError({ error }) {
    console.error(error); // your error logging logic here
  },
});
```

## Output Strategy

You can use both functions with different output strategies, e.g. `array`, `object`, or `no-schema`.

### Object

The default output strategy is `object`, which returns the generated data as an object.
You don't need to specify the output strategy if you want to use the default.

### Array

If you want to generate an array of objects, you can set the output strategy to `array`.
When you use the `array` output strategy, the schema specifies the shape of an array element.
With `streamObject`, you can also stream the generated array elements using `elementStream`.

```ts highlight="7,18"
import { openai } from '@ai-sdk/openai';
import { streamObject } from 'ai';
import { z } from 'zod';

const { elementStream } = streamObject({
  model: openai('gpt-4-turbo'),
  output: 'array',
  schema: z.object({
    name: z.string(),
    class: z
      .string()
      .describe('Character class, e.g. warrior, mage, or thief.'),
    description: z.string(),
  }),
  prompt: 'Generate 3 hero descriptions for a fantasy role playing game.',
});

for await (const hero of elementStream) {
  console.log(hero);
}
```

### Enum

If you want to generate a specific enum value, e.g. for classification tasks,
you can set the output strategy to `enum`
and provide a list of possible values in the `enum` parameter.

<Note>Enum output is only available with `generateObject`.</Note>

```ts highlight="5-6"
import { generateObject } from 'ai';

const { object } = await generateObject({
  model: yourModel,
  output: 'enum',
  enum: ['action', 'comedy', 'drama', 'horror', 'sci-fi'],
  prompt:
    'Classify the genre of this movie plot: ' +
    '"A group of astronauts travel through a wormhole in search of a ' +
    'new habitable planet for humanity."',
});
```

### No Schema

In some cases, you might not want to use a schema,
for example when the data is a dynamic user request.
You can use the `output` setting to set the output format to `no-schema` in those cases
and omit the schema parameter.

```ts highlight="6"
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';

const { object } = await generateObject({
  model: openai('gpt-4-turbo'),
  output: 'no-schema',
  prompt: 'Generate a lasagna recipe.',
});
```

## Generation Mode

While some models (like OpenAI) natively support object generation, others require alternative methods, like modified [tool calling](/docs/ai-sdk-core/tools-and-tool-calling). The `generateObject` function allows you to specify the method it will use to return structured data.

- `auto`: The provider will choose the best mode for the model. This recommended mode is used by default.
- `tool`: A tool with the JSON schema as parameters is provided and the provider is instructed to use it.
- `json`: The response format is set to JSON when supported by the provider, e.g. via json modes or grammar-guided generation. If grammar-guided generation is not supported, the JSON schema and instructions to generate JSON that conforms to the schema are injected into the system prompt.

<Note>
  Please note that not every provider supports all generation modes. Some
  providers do not support object generation at all.
</Note>

## Schema Name and Description

You can optionally specify a name and description for the schema. These are used by some providers for additional LLM guidance, e.g. via tool or schema name.

```ts highlight="6-7"
import { generateObject } from 'ai';
import { z } from 'zod';

const { object } = await generateObject({
  model: yourModel,
  schemaName: 'Recipe',
  schemaDescription: 'A recipe for a dish.',
  schema: z.object({
    name: z.string(),
    ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
    steps: z.array(z.string()),
  }),
  prompt: 'Generate a lasagna recipe.',
});
```

## Error Handling

When `generateObject` cannot generate a valid object, it throws a [`AI_NoObjectGeneratedError`](/docs/reference/ai-sdk-errors/ai-no-object-generated-error).

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
  }
}
```

## Repairing Invalid or Malformed JSON

<Note type="warning">
  The `repairText` function is experimental and may change in the future.
</Note>

Sometimes the model will generate invalid or malformed JSON.
You can use the `repairText` function to attempt to repair the JSON.

It receives the error, either a `JSONParseError` or a `TypeValidationError`,
and the text that was generated by the model.
You can then attempt to repair the text and return the repaired text.

```ts highlight="7-10"
import { generateObject } from 'ai';

const { object } = await generateObject({
  model,
  schema,
  prompt,
  experimental_repairText: async ({ text, error }) => {
    // example: add a closing brace to the text
    return text + '}';
  },
});
```

## Structured outputs with `generateText` and `streamText`

You can generate structured data with `generateText` and `streamText` by using the `experimental_output` setting.

<Note>
  Some models, e.g. those by OpenAI, support structured outputs and tool calling
  at the same time. This is only possible with `generateText` and `streamText`.
</Note>

<Note type="warning">
  Structured output generation with `generateText` and `streamText` is
  experimental and may change in the future.
</Note>

### `generateText`

```ts highlight="2,4-18"
// experimental_output is a structured object that matches the schema:
const { experimental_output } = await generateText({
  // ...
  experimental_output: Output.object({
    schema: z.object({
      name: z.string(),
      age: z.number().nullable().describe('Age of the person.'),
      contact: z.object({
        type: z.literal('email'),
        value: z.string(),
      }),
      occupation: z.object({
        type: z.literal('employed'),
        company: z.string(),
        position: z.string(),
      }),
    }),
  }),
  prompt: 'Generate an example person for testing.',
});
```

### `streamText`

```ts highlight="2,4-18"
// experimental_partialOutputStream contains generated partial objects:
const { experimental_partialOutputStream } = await streamText({
  // ...
  experimental_output: Output.object({
    schema: z.object({
      name: z.string(),
      age: z.number().nullable().describe('Age of the person.'),
      contact: z.object({
        type: z.literal('email'),
        value: z.string(),
      }),
      occupation: z.object({
        type: z.literal('employed'),
        company: z.string(),
        position: z.string(),
      }),
    }),
  }),
  prompt: 'Generate an example person for testing.',
});
```

## More Examples

You can see `generateObject` and `streamObject` in action using various frameworks in the following examples:

### `generateObject`

<ExampleLinks
  examples={[
    {
      title: 'Learn to generate objects in Node.js',
      link: '/examples/node/generating-structured-data/generate-object',
    },
    {
      title:
        'Learn to generate objects in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/generating-object',
    },
    {
      title:
        'Learn to generate objects in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/generating-object',
    },
  ]}
/>

### `streamObject`

<ExampleLinks
  examples={[
    {
      title: 'Learn to stream objects in Node.js',
      link: '/examples/node/streaming-structured-data/stream-object',
    },
    {
      title:
        'Learn to stream objects in Next.js with Route Handlers (AI SDK UI)',
      link: '/examples/next-pages/basics/streaming-object-generation',
    },
    {
      title:
        'Learn to stream objects in Next.js with Server Actions (AI SDK RSC)',
      link: '/examples/next-app/basics/streaming-object-generation',
    },
  ]}
/>

---
title: Tool Calling
description: Learn about tool calling and multi-step calls (using maxSteps) with AI SDK Core.
---

