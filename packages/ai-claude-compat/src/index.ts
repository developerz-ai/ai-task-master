// @developerz-ai/ai-claude-compat — Claude-Code-style agent primitives for the Vercel AI SDK.
//
// Public API. v1 (issue #33) lands here incrementally: FS/bash tools (folds in #32), the <env>
// block, a subagent-as-tool factory, and .claude/ skills/agents loading. Provider-agnostic —
// works with any AI SDK model handle, not just OpenRouter.

export { type EnvInfo, envBlock } from './env-block.ts';
