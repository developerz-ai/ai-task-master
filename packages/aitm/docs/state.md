# State

All run state lives in `.ai-task-master/` at the target repo root (mirrors the original `.claude-task-master/` layout). One run per repo. Add `.ai-task-master/` to the project's `.gitignore`.

## Tree

```
.ai-task-master/
  goal.txt
  criteria.txt
  plan.md
  state.json
  progress.md
  context.md
  config.snapshot.json
  run.lock
  logs/
    run-{timestamp}.log
  memory/
    MEMORY.md
    {name}.md
  downloads/
    {pr-number}-ci-logs/
    {pr-number}-review-comments.json
    fixtures/
  scratch/
```

| Path | Owner | Purpose |
| --- | --- | --- |
| `goal.txt` | `CLI` (write once) | Verbatim goal from `aitm start`. |
| `criteria.txt` | `Planner` | Acceptance criteria derived from goal. |
| `plan.md` | `Planner` | Human-readable PR groups + tasks. |
| `state.json` | `StateStore` | Machine state. See schema. |
| `progress.md` | `Worker` | Per-task notes, what changed and why. |
| `context.md` | run-loop adapter | Rolling per-group digest fed back into later Workers' prompts (issue #123). After each PR opens, one deterministic block is appended — `PR #N — <title> (group <id>, branch <branch>)` then the group's change lines and progress entries. FIFO-capped at 8 KB: oldest whole blocks drop first, a block is never split (multi-line summary/progress text is flattened so a block can never contain the blank-line block separator). Appends are serialized, so the concurrent group batch (WorkLoop's `Promise.all`) cannot lose a digest to a read-modify-write race. Persisted failure-tolerantly (a write error is warned, never fails the PR-open path). |
| `config.snapshot.json` | `ConfigLoader` | Frozen `ResolvedConfig` for this run, so resume reproduces exact behavior. |
| `run.lock` | `StateStore` (via `run-lock.ts`) | Exclusive claim on this state dir, created with `wx` at run entry (`aitm start`/`resume`/`merge-pr`) and released when the command returns. A second invocation here refuses with the holder's pid instead of racing `state.json`. A lock left by a killed run is taken over automatically when its pid is gone **and** it was recorded on this host; a lock from another host is never stolen — delete it by hand. Survives `cleanupOnSuccess()` (the holder releases it), not `aitm clean`. |
| `logs/run-{timestamp}.log` | `Logger` | Per-run structured log. |
| `memory/` | `Worker` (via the `memory` tool), `Planner` (reads) | Durable per-repo memory (issue #118): one-fact-per-file markdown memories + a `MEMORY.md` index (one line each). Survives `cleanupOnSuccess()` alongside `logs/`, so cross-run knowledge (flaky checks, real verify commands, build quirks) persists. The index is injected into Planner + Worker prompts as an advisory, point-in-time block; the path is handed out by `StateStore.memoryDir()`, and nothing is scaffolded until the first write. Git-excluded (per-clone, never committed). |
| `downloads/` | `GitHubClient`, `Worker` | Files pulled from outside the repo — CI log archives, review-comment JSON, any fixtures Worker fetches. Never committed. |
| `scratch/` | `Worker` | Free-form working area for the active subagent — diffs in progress, intermediate output, and the **disposable verification code** a pass writes to try to prove its own change wrong (fuzz/property harnesses, differential oracles against a naive re-implementation, benchmarks, trace scripts). Structurally unmergeable: `stageAndCommit` runs `git add -A` then `git reset -q -- .ai-task-master`, so nothing under here can reach a commit — which is the point. Only what a future regression needs (a test for a bug a probe actually found) gets written into the repo proper. Wiped between groups. |

## `state.json` schema

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `planning \| working \| awaiting-pr \| reviewing \| blocked \| success \| failed` | Single source of truth for `WorkLoop`. |
| `prGroups` | `PrGroup[]` | Planner output. See sub-schema. |
| `currentGroupIndex` | `number` | Index into `prGroups`. |
| `currentTaskIndex` | `number` | Index into `prGroups[currentGroupIndex].tasks`. |
| `sessionCount` | `number` | Subagent sessions consumed this run. |
| `currentPr` | `number \| null` | GitHub PR number for the active group. |
| `runId` | `string` | ULID, also used in log filename. |
| `provider` | `"openrouter"` | Constant. Only provider supported. |
| `model` | `string` | OpenRouter model id (e.g., `anthropic/claude-opus-4`, `openai/gpt-5`). |
| `agentConfigFile` | `CLAUDE.md \| AGENTS.md \| custom` | Source of the coding-style payload. |
| `createdAt` | `string` | ISO-8601. |
| `updatedAt` | `string` | ISO-8601, bumped on every write. |
| `options.autoMerge` | `boolean` | **Default `true`.** Drive each PR to merge without prompting. |
| `options.maxPrs` | `number` | **Default 5.** Hard cap on PR groups Planner may emit. |
| `options.maxSessions` | `number \| null` | Cap before forcing `blocked`. `null` = unlimited. |
| `options.mergeMethod` | `"squash" \| "merge" \| "rebase"` | Default `"squash"`. |
| `options.stylePath` | `string \| null` | Override path supplied via `--style`. |

### `PrGroup` sub-schema

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable slug derived from the group title. |
| `title` | `string` | Short label, used as branch suffix and PR title prefix. |
| `tasks` | `string[]` | Ordered task descriptions. |
| `branch` | `string \| null` | Set when `Worker` checks out the branch. |
| `pr` | `number \| null` | Set when `Worker` opens the PR. |
| `status` | `pending \| in-progress \| awaiting-pr \| merged \| blocked` | Per-group status. |

## Lifecycle

| Terminal status | Action on `.ai-task-master/` |
| --- | --- |
| `success` | Delete everything except `logs/` and `memory/`. |
| `blocked` | Keep everything. Next `aitm start` resumes. |
| `failed` | Keep everything. Inspect, then re-run. |
| SIGINT (exit 2) | Keep everything. |

## Invariants

- `StateStore` is the only module that reads or writes `.ai-task-master/`. SRP — every other module receives parsed state objects and returns updates.
- Writes are atomic: write to a sibling temp file, `fsync`, then rename over the target.
- `runId` never changes within a run; new run = new id and new log file.
- `agentConfigFile` is set once at run start and never overwritten.

## Cross-links

- `./architecture.md`
- `./agent-config-detection.md`
- `./runtime.md`
