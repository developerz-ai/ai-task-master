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
  logs/
    run-{timestamp}.log
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
| `context.md` | `Orchestrator` | Rolling summary fed back into prompts across sessions. |
| `config.snapshot.json` | `ConfigLoader` | Frozen `ResolvedConfig` for this run, so resume reproduces exact behavior. |
| `logs/run-{timestamp}.log` | `Logger` | Per-run structured log. |
| `downloads/` | `GitHubClient`, `Worker` | Files pulled from outside the repo — CI log archives, review-comment JSON, any fixtures Worker fetches. Never committed. |
| `scratch/` | `Worker` | Free-form working area for the active subagent — diffs in progress, intermediate output. Wiped between groups. |

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
| `success` | Delete everything except `logs/`. |
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
