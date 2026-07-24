// A keyless, read-only price book: OpenRouter's public model catalog, used ONLY to fill fields the
// active provider's own `/models` omitted.
//
// Why this exists. aitm points at any OpenAI-compatible `/models` (docs/providers.md), and a
// subscription gateway typically publishes an id and nothing else. Measured on the two profiles this
// was written against:
//   z.ai  (api.z.ai/api/coding/paas/v4)  → { id, object, created, owned_by } — no window, no pricing
//   kimi  (api.kimi.com/coding/v1)       → context_length only — no pricing
// A missing window is not cosmetic: the Compactor refuses to compact a model whose window it does not
// know (compactor.ts), so on such a profile autocompaction is silently inert for the whole run.
//
// openrouter.ai/api/v1/models answers both, needs no Authorization header, and lists the same model
// families under an org-qualified id (`glm-5.2` → `z-ai/glm-5.2`). Prices from here are LIST prices —
// the run was billed by the subscription, not by OpenRouter — so anything sourced from this book is
// marked estimated and rendered as such, never as what was actually charged.
//
// SRP: fetch + match only. ModelLimitsRegistry decides precedence and owns the merge.

import { catalogFetchSignal, type OpenRouterModel, parseModelCatalog } from './client.ts';

export const OPENROUTER_REFERENCE_URL = 'https://openrouter.ai/api/v1/models';

// Structural contract so a stub can stand in without touching the network.
export type ReferenceCatalogClient = {
  listModels(): Promise<OpenRouterModel[]>;
};

export class OpenRouterReferenceCatalog implements ReferenceCatalogClient {
  constructor(
    private readonly url: string = OPENROUTER_REFERENCE_URL,
    private readonly signal?: AbortSignal,
  ) {}

  // No Authorization header by design: the public catalog needs none, and sending the active
  // profile's key to a third-party host would leak it to a provider the user never configured.
  async listModels(): Promise<OpenRouterModel[]> {
    const fetchSignal = catalogFetchSignal(this.signal);
    try {
      const res = await fetch(this.url, {
        headers: { accept: 'application/json' },
        signal: fetchSignal.signal,
      });
      if (!res.ok) {
        const excerpt = (await res.text()).slice(0, 200);
        throw new Error(
          `OpenRouter reference catalog failed: ${res.status} ${res.statusText} — ${excerpt}`,
        );
      }
      return parseModelCatalog(await res.json());
    } finally {
      fetchSignal.release();
    }
  }
}

// The part of an id after the last `/` — `z-ai/glm-5.2` → `glm-5.2`, a bare id unchanged.
function suffix(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

// Find the reference entry for a locally-configured model id, or undefined when nothing matches
// unambiguously. Three tiers, most specific first; a tier with more than one candidate yields
// nothing rather than a guess, because mispricing a run is worse than not pricing it.
//
//   1. the id, verbatim              `z-ai/glm-5.2`         (already org-qualified)
//   2. the org-stripped id           `glm-5.2`  → `z-ai/glm-5.2`, `glm-5-turbo` → `z-ai/glm-5-turbo`
//   3. a hyphen-boundary suffix      `k3`       → `moonshotai/kimi-k3`
//
// Tier 3 is boundary-anchored on purpose: a bare `includes` would let `glm-5` claim `glm-5.2`'s
// window and price. Ids OpenRouter prefixes with `~` (aliases that redirect elsewhere) are skipped so
// they cannot win a tier over the real entry.
export function matchReferenceModel(
  modelId: string,
  reference: readonly OpenRouterModel[],
): OpenRouterModel | undefined {
  const local = modelId.trim().toLowerCase();
  if (local === '') return undefined;
  const tiers: OpenRouterModel[][] = [[], [], []];
  for (const model of reference) {
    const id = model.id.toLowerCase();
    if (id.startsWith('~')) continue;
    if (id === local) tiers[0]?.push(model);
    else if (suffix(id) === local) tiers[1]?.push(model);
    else if (suffix(id).endsWith(`-${local}`)) tiers[2]?.push(model);
  }
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    // An ambiguous tier stops the search: a lower tier is by definition a looser match, so falling
    // through to it would trade a known ambiguity for a worse guess.
    if (tier.length > 1) return undefined;
  }
  return undefined;
}
