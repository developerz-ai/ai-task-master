// Per-model sampling defaults. aitm's scope is "any provider, any model" (docs/providers.md), and a
// model family's usable sampling range is part of its contract just as much as its context window:
// several families behave materially worse at the generic provider default, and the symptom is not
// an error — it is degraded instruction-following. Observed on a real run against glm-5.2: tool
// arguments double-encoded as a JSON string, an editor narrating an edit instead of writing it, an
// eight-minute reasoning block before the first tool call.
//
// aitm previously sent NO sampling parameters at all, for any model, so every model ran at whatever
// its endpoint defaulted to. This table is the smallest fix: known-good values for the families that
// need them, nothing for the families that don't (an unset parameter stays unset, so a request for a
// model not listed here is byte-identical to before).
//
// Values mirror opencode's `provider/transform.ts` (temperature/topP/topK), which carries them for
// the same reason and is battle-tested across these families. Matching is on the resolved model id,
// substring and case-insensitive, because the same family arrives under many ids: `glm-5.2`,
// `z-ai/glm-5.2`, `zai-org/GLM-5.2`.
//
// SRP: this module only maps a model id to sampling values. Credentials composes them into the
// request (the single provider-wiring point per CLAUDE.md).

export type SamplingParams = {
  temperature?: number;
  topP?: number;
  topK?: number;
};

// First match wins, so order is significance: a more specific id sits above the family it belongs to.
// `temperature: undefined` is not the same as absent — a family that must NOT be pinned (Anthropic,
// which reasons worse with an explicit temperature) is simply not listed.
const FAMILY_PARAMS: ReadonlyArray<{ match: readonly string[]; params: SamplingParams }> = [
  // GLM degrades sharply below 1.0 — the family this table was written for.
  { match: ['glm-4.6', 'glm-4.7', 'glm-5'], params: { temperature: 1.0 } },
  // Qwen's published guidance is a low temperature with unrestricted nucleus sampling.
  { match: ['qwen'], params: { temperature: 0.55, topP: 1 } },
  { match: ['minimax-m2'], params: { temperature: 1.0, topP: 0.95, topK: 20 } },
  { match: ['gemini'], params: { temperature: 1.0, topP: 0.95, topK: 64 } },
  // Thinking/2.5-era Kimi wants 1.0; the earlier k2 line wants 0.6.
  {
    match: ['kimi-k2-thinking', 'kimi-k2.5', 'kimi-k2p5', 'kimi-k2-5'],
    params: { temperature: 1.0, topP: 0.95 },
  },
  { match: ['kimi-k2'], params: { temperature: 0.6 } },
];

// The sampling defaults for a model id, or `{}` when the family needs none (Anthropic, OpenAI, and
// anything unrecognized — those run at the endpoint default exactly as they always have).
export function samplingParamsFor(modelId: string): SamplingParams {
  const id = modelId.toLowerCase();
  for (const { match, params } of FAMILY_PARAMS) {
    // A copy, not the table entry: callers spread this into request settings, and handing out the
    // shared object would let one call's mutation leak into every later request for that family.
    if (match.some((needle) => id.includes(needle))) return { ...params };
  }
  return {};
}
