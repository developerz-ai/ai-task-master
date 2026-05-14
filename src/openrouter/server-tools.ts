// OpenRouter server tools — model-decides tools executed on OpenRouter's side.
// These are NOT Vercel AI SDK function tools; they ride in `providerOptions.openrouter`
// (or equivalent extraBody) so OpenRouter sees them in the request `tools[]` array verbatim.
//
// Refs:
//   https://openrouter.ai/docs/guides/features/server-tools/web-search
//   https://openrouter.ai/docs/guides/features/server-tools/web-fetch
//
// Web search → citations land as annotations[].url_citation on the assistant message,
// plus usage.server_tool_use.web_search_requests for cost accounting. No round-trip.
// Web fetch → standard tool_call round-trip with { url, title, content, status, retrieved_at }.

export type WebSearchEngine = 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel';

export type WebSearchOptions = {
  engine?: WebSearchEngine;
  max_results?: number;
  max_total_results?: number;
  search_context_size?: 'low' | 'medium' | 'high';
  allowed_domains?: string[];
  excluded_domains?: string[];
  user_location?: { type: 'approximate'; city?: string; country?: string };
};

export type WebFetchOptions = {
  engine?: 'auto' | 'openrouter' | 'exa' | 'firecrawl' | 'native';
  max_uses?: number;
  max_content_tokens?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

export type ServerToolPayload =
  | { type: 'openrouter:web_search'; parameters?: WebSearchOptions }
  | { type: 'openrouter:web_fetch'; parameters?: WebFetchOptions };

export function webSearchTool(options: WebSearchOptions = {}): ServerToolPayload {
  return { type: 'openrouter:web_search', parameters: options };
}

// Renamed from webFetchTool — the canonical webFetchTool is now the local variant in
// src/tools/web-fetch.ts. This one is the explicit "delegate to OpenRouter" opt-in.
export function webFetchServerTool(options: WebFetchOptions = {}): ServerToolPayload {
  return { type: 'openrouter:web_fetch', parameters: options };
}

// Build the providerOptions.openrouter fragment to be merged into an AI SDK call.
// Usage at the model handle layer (src/credentials/credentials.ts) — see Credentials.modelFor.
export function providerOptionsWithServerTools(tools: ReadonlyArray<ServerToolPayload>): {
  openrouter: { tools: ServerToolPayload[] };
} {
  return { openrouter: { tools: [...tools] } };
}
