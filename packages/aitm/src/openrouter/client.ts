// Thin OpenRouter API client. Only the endpoints we actually need:
//   GET /api/v1/models — model catalog including context length / pricing.
// docs/auth.md §"LLM provider", docs/runtime.md (web fetch, not Bun.fetch).

import { z } from 'zod';

export const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    context_length: z.number().int().positive(),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

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
    return OpenRouterModelsResponseSchema.parse(json).data;
  }
}
