// Thin OpenRouter API client. Only the endpoints we actually need:
//   GET /api/v1/models — model catalog including context length / pricing.
// docs/auth.md §"LLM provider", docs/runtime.md (web fetch, not Bun.fetch).
//
// The catalog is the ONLY source of a model's context window, and that window is what decides when
// the Compactor auto-compacts. OpenRouter always ships `context_length`, but aitm points at any
// OpenAI-compatible `/models` (profiles/baseURL), and those spell the window differently or omit it.
// So: every field is optional, three known spellings are accepted, and a single unparseable entry is
// dropped rather than failing the whole catalog — one odd model must not cost the run its
// autocompaction and its cost accounting.

import { z } from 'zod';

// Catalogs distinguish "absent" from "explicitly null", and both mean the same thing here: no value.
// Treating them differently is not academic — OpenRouter ships `top_provider.max_completion_tokens:
// null` for models that publish no output cap (moonshotai/kimi-k3 among them), and a plain
// `.optional()` rejects null, which fails the whole entry and makes parseModelCatalog DROP the model.
// A dropped model has no window and no price, so it silently loses both autocompaction and costing.
const positiveInt = z
  .number()
  .int()
  .positive()
  .nullish()
  .transform((v) => v ?? undefined);
const priceString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

export const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    // OpenRouter's spelling. Absent on plain OpenAI-compatible gateways — see contextLengthOf.
    context_length: positiveInt,
    // OpenRouter repeats the window per routed provider; used when the top-level field is missing.
    top_provider: z
      .object({
        context_length: positiveInt,
        max_completion_tokens: positiveInt,
      })
      .optional(),
    // The most the model may EMIT in one reply. Input and output share the context window, so this
    // is the part of the window that must stay free — see usableInputTokens in ../compaction.
    max_completion_tokens: positiveInt,
    // vLLM / llama.cpp-style gateways.
    max_model_len: positiveInt,
    // Some OpenAI-compatible gateways (and Azure-style catalogs).
    context_window: positiveInt,
    // Per-token USD as decimal strings. `input_cache_read`/`input_cache_write` price cached prompt
    // tokens (issue #114): a cached run's input bills at ~10% of `prompt`, so flat-rate math would
    // overstate cost ~10x and hide caching's dollar effect. Absent fields degrade to flat pricing.
    pricing: z
      .object({
        prompt: priceString,
        completion: priceString,
        input_cache_read: priceString,
        input_cache_write: priceString,
      })
      .optional(),
  })
  .passthrough();
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

// The model's context window under whichever key this catalog uses; undefined when it publishes
// none, which the Compactor reads as "window unknown — don't compact" rather than guessing.
export function contextLengthOf(model: OpenRouterModel): number | undefined {
  return (
    model.context_length ??
    model.top_provider?.context_length ??
    model.max_model_len ??
    model.context_window
  );
}

// The most this model may emit in one reply, under whichever key the catalog uses; undefined when it
// publishes none. Consumers fall back to a fixed reserve rather than assuming the whole window is
// available for input.
export function maxOutputTokensOf(model: OpenRouterModel): number | undefined {
  return model.max_completion_tokens ?? model.top_provider?.max_completion_tokens;
}

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(z.unknown()),
});

// Parse the catalog entry-by-entry, keeping what validates. A gateway that ships one malformed model
// (or one extra shape we don't model) must not take pricing and context windows down with it.
export function parseModelCatalog(json: unknown): OpenRouterModel[] {
  const entries = OpenRouterModelsResponseSchema.parse(json).data;
  const models: OpenRouterModel[] = [];
  for (const entry of entries) {
    const parsed = OpenRouterModelSchema.safeParse(entry);
    if (parsed.success) models.push(parsed.data);
  }
  return models;
}

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://openrouter.ai/api/v1',
  ) {}

  async listModels(): Promise<OpenRouterModel[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const excerpt = (await res.text()).slice(0, 500);
      throw new Error(`OpenRouter /models failed: ${res.status} ${res.statusText} — ${excerpt}`);
    }
    const json: unknown = await res.json();
    return parseModelCatalog(json);
  }
}
