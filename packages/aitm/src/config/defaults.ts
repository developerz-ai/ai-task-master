// Default constants for configuration values.
// This module is a leaf (no upward imports) so config-loader.ts can depend on it
// without creating import cycles with loop, mcp, subagents, or other modules.

// Cap on CI-fix passes per group per driveStages run, bounding the waiting-ci ⇄ ci-failed recovery
// loop on an unfixable red PR (flaky infra, missing secret, a failure unrelated to the diff) so an
// unattended run blocks for a human instead of burning coding-tier tokens forever. See issue #128.
export const DEFAULT_MAX_CI_FIX_ATTEMPTS = 3;

// Above this many role-visible MCP tools, the surplus is deferred (name-only stubs + a `tool_search`
// tool) instead of mounted directly, so their JSON schemas stay out of every request (issue #119).
// `0` = always defer. Overridable via the `mcpDeferToolsOver` config key.
export const DEFAULT_MCP_DEFER_TOOLS_OVER = 20;

// Default per-step LLM request deadline in milliseconds (issue #129). The bound covers one provider
// HTTP call plus that step's tool executions, and a single legitimate Worker step may run a bash call
// at the tool's own 600s ceiling (MAX_BASH_TIMEOUT_MS) plus a slow high-effort completion — so the
// default clears 600s comfortably. Config `llmStepTimeoutMs` overrides it; the schema floor is 1000ms.
export const DEFAULT_LLM_STEP_TIMEOUT_MS = 900_000;
