// Route a Worker task/group to the target repo's own domain specialist. claude-task-master repos
// ship `.claude/agents/*.md` domain experts (e.g. android.md, backend.md, frontend.md); aitm loads
// them via the compat loader and picks the best match for a PR group, layering that specialist's
// guidance on top of the Worker's core role prompt + coding-style digest.
//
// Discovery is I/O over the compat `loadAgents`; selection, signal-building and guidance composition
// are pure so they are unit-testable without an LLM or a real repo. When the repo ships no agents, or
// none matches, selection returns null and composition returns the base guidance UNCHANGED — so a
// repo without specialists behaves byte-identically to before.

import { join } from 'node:path';
import { type AgentDefinition, loadAgents } from '@developerz.ai/ai-claude-compat';
import type { PrGroup, Task } from '../state/schema.ts';

// Discover the TARGET repo's domain specialists: `<repoRoot>/.claude/agents/*.md`. Only the project
// `.claude` is scanned (never the user-global `~/.claude`) — these are the repo's own experts, a
// coding-style signal, not the operator's personal agents. Missing dir → [].
export function discoverSpecialists(repoRoot: string): Promise<AgentDefinition[]> {
  return loadAgents(join(repoRoot, '.claude'));
}

// Words too generic to discriminate one specialist from another — they appear in most task text and
// most agent descriptions, so counting them would flatten every score. Kept small and hand-picked;
// the signal is short, so precision matters more than recall.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'use',
  'used',
  'uses',
  'using',
  'when',
  'this',
  'that',
  'into',
  'from',
  'your',
  'you',
  'are',
  'all',
  'any',
  'can',
  'who',
  'via',
  'across',
  'within',
  'should',
  'must',
  'only',
  'also',
  'specialist',
  'specialists',
  'agent',
  'agents',
  'expert',
  'engineer',
  'developer',
  'task',
  'tasks',
  'code',
  'codebase',
  'feature',
  'features',
  'implement',
  'implementing',
  'implementation',
  'add',
  'adds',
  'change',
  'changes',
  'work',
  'working',
  'handle',
  'handles',
  'related',
  'support',
  'proactively',
]);

// Lowercase alphanumeric tokens ≥ 3 chars, stopwords dropped. Shared by signal + agent tokenization
// so the two sides match on the same normalization.
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
}

// A name-token hit is far more discriminating than a description-token hit: an agent named `backend`
// matching the word "backend" in the task is a near-certain route, whereas a shared description word
// is weak evidence. Weight them accordingly.
const NAME_WEIGHT = 3;
const DESC_WEIGHT = 1;

// The text a specialist is matched against: the group title plus the focused task (and its subtasks),
// or every task in the group when planning the whole group. Pure — no repo access.
export function buildSpecialistSignal(group: PrGroup, task?: Task): string {
  const parts: string[] = [group.title];
  if (task) {
    parts.push(task.text);
    if (task.subtasks) parts.push(...task.subtasks);
  } else {
    parts.push(...group.tasks.map((t) => t.text));
  }
  return parts.join(' ');
}

// Pick the best-matching specialist for a task signal, or null when none matches. Score = weighted
// count of an agent's name/description tokens present in the signal; a name token already counted is
// not double-counted from the description. Strictly-greater comparison means ties go to the earlier
// agent, and `loadAgents` returns them name-sorted, so selection is deterministic. Zero score → null,
// which is the graceful-degradation path (fall back to the generic Worker).
export function selectSpecialist(
  specialists: readonly AgentDefinition[],
  signal: string,
): AgentDefinition | null {
  const signalTokens = new Set(tokenize(signal));
  if (signalTokens.size === 0) return null;
  let best: { agent: AgentDefinition; score: number } | null = null;
  for (const agent of specialists) {
    const nameTokens = new Set(tokenize(agent.name));
    const descTokens = new Set(tokenize(agent.description));
    let score = 0;
    for (const t of nameTokens) if (signalTokens.has(t)) score += NAME_WEIGHT;
    for (const t of descTokens) if (signalTokens.has(t) && !nameTokens.has(t)) score += DESC_WEIGHT;
    if (score > (best?.score ?? 0)) best = { agent, score };
  }
  return best !== null && best.score > 0 ? best.agent : null;
}

// Layer a chosen specialist's guidance on top of the Worker's base role guidance. The specialist
// refines HOW the Worker operates in this domain; it never replaces the manifest/editor flow, the
// coding-style digest, or the submit contract (those come from the surrounding role prompt). Null
// specialist → the base guidance is returned unchanged (byte-identical to a repo with no agents).
export function composeSpecialistGuidance(
  baseGuidance: string,
  specialist: AgentDefinition | null,
): string {
  if (specialist === null) return baseGuidance;
  return [
    baseGuidance,
    '',
    `Domain specialist: ${specialist.name}`,
    'This repo ships a specialist for this kind of work. Apply its guidance below as the domain',
    'expert for this PR — it refines how you work within the Worker contract above; it does not',
    'replace the manifest/editor flow, the coding-style rules, or the submit contract.',
    '',
    specialist.systemPrompt,
  ].join('\n');
}
