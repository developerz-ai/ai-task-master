// Skill discovery for the subagent tool sets (issue #181).
//
// `@developerz.ai/ai-claude-compat` ships the whole mechanism (#120): `loadSkills` reads
// `<dir>/skills/*/SKILL.md`, `skillIndexBlock` renders the always-visible tier, `skillTool` pulls a
// body on demand. None of it was reachable from aitm. This module decides WHICH skills a run may
// see, which is the part compat deliberately left to the product.
//
// Three sources, three trust levels:
//
//   built-in    package-embedded, always on. Procedures aitm itself knows are useful and whose text
//               ships with the binary, so they cannot be tampered with by a repo under work.
//   user-global `~/.claude/skills` — the operator's own machine. Same trust as their CLAUDE.md:
//               they wrote it, it is on by default.
//   repo        `<cwd>/.claude/skills` — THIRD-PARTY INPUT. aitm runs against repos the operator
//               chose but did not necessarily write, and a SKILL.md body lands verbatim in a
//               subagent's context when invoked. Off unless `skills: true`.
//
// A name collision resolves built-in > user-global > repo: a repo cannot shadow a procedure the
// operator or the product relies on by naming a skill after it.

import { join } from 'node:path';
import { loadSkills, type SkillDefinition } from '@developerz.ai/ai-claude-compat';

export type SkillSources = {
  // The checkout under work. Its `.claude/skills` are untrusted (see `repoSkillsEnabled`).
  cwd: string;
  // The operator's home. Omitted → no user-global skills (tests, and any run without a home).
  homeDir?: string;
  // `resolved.skills`. False (the default) drops repo-provided skills entirely — they are not
  // loaded, not indexed, not invocable.
  repoSkillsEnabled: boolean;
};

// A repo SKILL.md body reaches a subagent's context verbatim once invoked, so the index line — the
// part the model always sees — states its provenance. The body itself is fenced by `skillTool`'s
// result shape; this marks the entry so a description cannot pass itself off as first-party
// guidance ("ignore previous instructions" reads differently under an explicit untrusted label).
const UNTRUSTED_PREFIX = '[repo-provided, untrusted] ';

function markUntrusted(skill: SkillDefinition): SkillDefinition {
  return { ...skill, description: `${UNTRUSTED_PREFIX}${skill.description}` };
}

/**
 * Every skill a run may use, most-trusted first. Built-ins and user-global skills always load; repo
 * skills only when enabled, and they are marked untrusted. Later duplicates of a name are dropped,
 * so the trust order above is what wins.
 */
export async function discoverSkills(sources: SkillSources): Promise<SkillDefinition[]> {
  const userGlobal = sources.homeDir
    ? await loadSkills(join(sources.homeDir, '.claude'))
    : /* no home → nothing to read */ [];
  const repo = sources.repoSkillsEnabled
    ? (await loadSkills(join(sources.cwd, '.claude'))).map(markUntrusted)
    : [];

  const seen = new Set<string>();
  const out: SkillDefinition[] = [];
  for (const skill of [...builtInSkills(), ...userGlobal, ...repo]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

// Built-ins are `SkillDefinition`s built in code rather than files on disk: they ship with the
// package, so there is no directory to read and no `path` for a sibling `references/` read. The
// empty `path` is honest about that — these are self-contained.
function builtIn(name: string, description: string, body: string): SkillDefinition {
  return { name, description, body, path: '', extra: {} };
}

export function builtInSkills(): SkillDefinition[] {
  return [
    builtIn(
      'ci-log-triage',
      'Read a failed PR check by pulling its persisted CI log, before guessing at the cause from the check name.',
      [
        '# CI log triage',
        '',
        'A failing check name ("test", "build") says almost nothing. The log says what broke. aitm',
        'persists the logs it fetched under `.ai-task-master/debugging/pr/<pr>/`, so read them from',
        'disk rather than re-fetching or inferring.',
        '',
        '1. `glob` `.ai-task-master/debugging/pr/*/**` to see which runs were captured.',
        '2. `readFile` the log for the failing check. They are large — read the tail first; the',
        '   failure summary is almost always at the end.',
        '3. `grep` the log for the first `error`/`FAIL`/`✗` line. The FIRST failure is the cause; the',
        '   ones after it are usually consequences of the same break.',
        '4. Only then decide what to change. If the log contradicts the check name, trust the log.',
        '',
        'If no log was persisted, say so instead of speculating — a guess presented as a diagnosis',
        'costs more than an admission.',
      ].join('\n'),
    ),
    builtIn(
      'repo-recon',
      'Orient in an unfamiliar repository quickly — find the build, test and entry points before editing anything.',
      [
        '# Repo recon',
        '',
        'Before the first edit in a repo you have not seen, spend a few reads establishing where',
        'things are. Editing blind produces changes that do not match the surrounding code.',
        '',
        '1. `readFile` `package.json` (or the language equivalent) — the scripts tell you how the',
        '   project is built, tested and linted. Those are the commands to run, not ones you invent.',
        '2. `readFile` `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` if present. House style is not',
        '   negotiable and is rarely inferable from the code alone.',
        '3. `glob` the source root to learn the layout — one directory per responsibility, or one',
        '   big folder? Where do tests live, beside the source or in a parallel tree?',
        '4. `grep` for a symbol you must touch to find its definition AND its callers. The callers',
        '   tell you what the change will break.',
        '',
        'Match what you find. A change that is correct but written in a foreign style still costs',
        'the maintainer a review round.',
      ].join('\n'),
    ),
  ];
}
