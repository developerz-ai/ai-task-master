# Agent config detection

`AgentConfigDetector` decides which coding-style convention `aitm` follows for the target repo. It picks a **style source**, not a provider — the provider is always OpenRouter.

## Search order

Discovery is **layered**, general → specific (issue #117). The user-global and project layers are concatenated up front; nested files are discovered but **delivered on touch** (issue #192). Either way a more-specific convention arrives later and wins on conflict (deepest-wins):

1. **User-global** `~/.claude/CLAUDE.md` — operator-wide house conventions. **Additive only**: it never satisfies detection on its own.
2. **Project-level pick** (the gate) at the target repo root:
   - `--style <path>` CLI flag — if supplied, used verbatim (skips the root search).
   - `./CLAUDE.md` → flavor `claude`; `./AGENTS.md` → flavor `agents`; both present → prefer `CLAUDE.md`, override with `--prefer agents`.
   - Neither present and no `--style` → **exit 1** with instructions (unchanged — the user-global layer does not rescue this).
3. **Nested** per-directory `CLAUDE.md`/`AGENTS.md` (same per-directory preference), discovered across the subtree. Skips `.git`, `node_modules`, hidden directories, and `.ai-task-master/`. Sorted **depth then path**, deterministically.

A total **byte budget** (64 KiB across nested files) guards monorepo blowup: once exceeded, remaining nested files are skipped and a warning is logged to stderr.

### Nested files are delivered on touch (issue #192)

Nested files are **not** folded into `contents`. #117 shipped them eagerly — every nested file in the repo concatenated into the digest before the run started — which in a monorepo spends the budget on subtrees the run never opens and drops the ones it does.

Instead they ride the system-reminder channel (issue #106) that the file tools already carry: the first time a run reads, writes, edits or multi-edits a file under `packages/core/`, that call's result carries `packages/core/CLAUDE.md`, framed as instructions for that directory. After that it is not repeated — it is repo instructions, not a per-call warning.

- **Announced once per tool record.** The state lives with the decorated record, so an agent built on its own record is told again: it has its own context and never saw the first announcement. Agents that *share* a record share the announcement — see the limitation below.
- **`grep`/`glob` do not count.** They surface paths without reading them; a directory listing is not a visit, and treating it as one would load every nested file on the Planner's first survey.
- **Nesting is preserved.** A file under `packages/core/api/` announces `packages/core/CLAUDE.md` then `packages/core/api/CLAUDE.md`, deepest last, the same precedence the eager concatenation had.
- **A repo with no nested files is byte-identical to before** — the tool records are not even decorated.

**Editor leaves re-decorate.** The Worker's parallel editor leaves are built from their Coordinator's record (`editorToolSet(init.tools)`), so without their own state the first agent into a subtree would consume the announcement and the leaf that actually writes the code there would never see its conventions. `WorkerInput.nested` carries the set down, and each leaf re-decorates — a leaf is its own conversation, so it gets its own announcement.

**Not covered: the scout survey and the review team.** Both share one tool record across their lead and every member, so an on-touch announcement would reach whichever member won the race rather than each of them. They keep hooks-only decoration until the subagent runners build their own record per agent, tracked in #333 alongside the other roles.

Each `@`-import is expanded per file with a **per-file containment root**: repo files stay confined to the repo root (as before); the user-global file expands within `~/.claude` only — its imports can never read the target repo, and vice versa.

The **project-level** file path and flavor are persisted to `state.json.agentConfigFile` so resumed runs use the same source; the layered detail is exposed via `AgentConfig.sources`.

## Output contract

```
type AgentConfig = {
  flavor: "claude" | "agents" | "custom";  // describes the PROJECT-level pick
  path: string;                            // the PROJECT-level pick's path
  contents: string;                        // user + project layers, @-imports expanded per file
  sources: Array<{ path: string; scope: "user" | "project" | "nested" }>;  // every layer FOUND
  nested: Array<{ dir: string; path: string; contents: string }>;          // delivered on touch
};
```

**Labeling** — with more than one *concatenated* layer, each block is prefixed `Contents of <path>:` (repo-relative for repo files, absolute for the user-global file). With **exactly one**, `contents` is byte-identical to the un-layered single file (no label), so existing callers and the cached `.ai-task-master/coding-style.md` digest are unaffected. `sources` still lists every layer discovery found, nested included — it is the record of what was found, not of what was concatenated.

`Orchestrator` prepends `contents` to every subagent system prompt, then layers the role-specific prefix (`planner-system.md`, `worker-system.md`, `reviewer-system.md`) on top.

## `@`-import expansion

The chosen file's contents are passed through `expandImports` before being returned, so Claude Code's `@path` import syntax is honored. A line like `@core/AGENTS.md` is replaced with the referenced file's contents inline — otherwise governance that lives in an `@`-imported file would reach the model as an inert `@core/AGENTS.md` string and its rules would never be seen.

- **Resolution** — `@path` is expanded when `@` starts a line or follows whitespace. Paths resolve relative to the **importing file's** directory.
- **Recursion** — imported files may themselves import, up to a depth cap (default 5). Cycles are detected and stop (the repeated reference is left as literal text).
- **Not expanded** — `@` inside fenced code blocks or inline code spans, email-like `me@host`, escaped `@@`, and any import that does not resolve to a readable file (left as literal text).
- **Containment (hardening)** — imports are confined to a **per-source root**: repo files (project + nested) to the target repo root, and the user-global `~/.claude/CLAUDE.md` to its own directory (`~/.claude`). Absolute paths, `..` escapes, and `~`-home imports are refused (left literal). `aitm` runs against untrusted target repos, so a repo-side `@`-import must never pull a file from outside the repo into the prompt — and, conversely, the user-global file's imports can never reach the target repo.

## SRP

| Module | Owns | Does NOT |
| --- | --- | --- |
| `AgentConfigDetector` | Filesystem search + return typed `AgentConfig`. | Interpret contents beyond `@`-import expansion. Choose a model. Touch credentials. |
| `expandImports` | Expand `@path` imports within the caller-supplied containment root (repo root for repo files, `~/.claude` for the user-global file). | Filesystem search. Know about flavors or `--style`. Choose the root. |
| `Orchestrator` | Compose the final system prompt per subagent. | Re-read the file. |

## Why `CLAUDE.md` does not imply Anthropic

`aitm` decouples "whose conventions does the project follow" from "which LLM API answers our requests". The project might be a Claude-conventioned codebase but `aitm` will still route the call through OpenRouter — possibly to an Anthropic model, possibly to a different one, depending on `models.*` in config. Detection is style-only.

## Custom style

`--style <path>` accepts any markdown file. Useful for monorepos where conventions live in `docs/style.md`, or for testing alternate prompts. Recorded as `flavor: "custom"`.

## Cross-links

- `./coding-style.md`
- `./config.md`
- `./subagents.md`
- `./architecture.md`
