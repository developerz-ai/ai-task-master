// Live run output, mirroring claude-task-master's console contract: a cyan `[aitm HH:MM:SS]`
// prefix for orchestrator/harness messages (stage transitions, PRs opened, fix passes) and an
// orange `[<agent> HH:MM:SS]` prefix for what each subagent is doing — its text and every tool
// call (`Using tool: bash → git status`). Streams to stderr so stdout stays reserved for plain
// status/results (Logger contract). Fixes the silent-run gap: `aitm start` printed nothing
// between the banner and the usage summary.
//
// The step handler reads ONLY the per-step fields of the AI SDK's StepResult (`text`,
// `toolCalls`) — never the cumulative `response.messages` — so one handler is safe to share
// across the Worker's parallel editor fanout, unlike the transcript recorder's delta slicing
// (issue #175).
//
// Split by responsibility: pure formatting (step-progress-format.ts), the output seam plus
// per-step/harness emitters (step-progress-sink.ts), and the live-stream renderer
// (step-progress-renderer.ts). This module is a barrel — it exists because the split above has
// many call sites across the codebase that all import from `step-progress.ts` today.

export type {
  AgentLabel,
  RunStep,
  StepProgressEvent,
  StreamLabel,
} from './step-progress-format.ts';
export {
  agentLabel,
  formatDuration,
  formatStepTag,
  labelText,
  renderStepLines,
  shortModelName,
  summarizeToolInput,
} from './step-progress-format.ts';
export type { LiveStreamEvent } from './step-progress-renderer.ts';
export { createLiveStreamRenderer } from './step-progress-renderer.ts';
export type { ProgressSink } from './step-progress-sink.ts';
export {
  agentStepProgress,
  composeStepFinish,
  defaultProgressSink,
  harnessProgress,
} from './step-progress-sink.ts';
