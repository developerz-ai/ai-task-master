// Public API for @developerz.ai/ai-claude-compat. Claude-Code-style agent primitives for the
// Vercel AI SDK: cwd-scoped FS/edit/search/shell tools, an <env> system-context block, and
// .claude/ skills + agents loading.

export {
  AGENT_TOOL_DEPTH_EXCEEDED_PREFIX,
  AGENT_TOOL_ERROR_PREFIX,
  AGENT_TOOL_NO_CONCLUSION,
  AGENT_TOOL_TRUNCATION_MARKER,
  AgentToolConstructionError,
  type AgentToolInput,
  type AgentToolOptions,
  type AgentToolSpec,
  DEFAULT_AGENT_TOOL_MAX_DEPTH,
  DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS,
  DEFAULT_AGENT_TOOL_MAX_STEPS,
  makeAgentTool,
} from './agent-spawn.ts';
export { type AgentDefinition, claudeDirs, loadAgents } from './agents-loader.ts';
export {
  type BackgroundBashInput,
  type BackgroundBashOutput,
  type BackgroundProcessInit,
  type BackgroundProcessTools,
  type BashOutputInput,
  backgroundProcessTools,
  type KillBashInput,
  type KillBashOutput,
  type ListBackgroundOutput,
  ProcessManager,
  type ProcessOutput,
  type ProcessStatus,
  type SpawnFn,
} from './background-process.ts';
export {
  type BashInput,
  type BashOutput,
  type BashToolInit,
  bashTool,
  MAX_BASH_OUTPUT_CHARS,
  type MultiBashInput,
  type MultiBashOutput,
  multiBashTool,
} from './bash-tool.ts';
export {
  type CommandDecision,
  type CommandRule,
  evaluateCommand,
} from './command-rules.ts';
export {
  blockAnchorMatch,
  findFuzzyMatch,
  isDisproportionateMatch,
  lineTrimmedMatch,
  type SpanMatch,
  type SpanMatcher,
  spanMatchers,
  whitespaceNormalizedMatch,
} from './edit-replacers.ts';
export {
  applyEdit,
  type EditFileInput,
  type EditFileOutput,
  type EditSpec,
  editFileTool,
  type MultiEditInput,
  type MultiEditOutput,
  multiEditTool,
} from './edit-tools.ts';
export { detectGitRepo, type EnvInfo, envBlock } from './env-block.ts';
export { type FileOp, FileStateTracker, hashContent, hashFile } from './file-state.ts';
export {
  asRecord,
  asString,
  asStringArray,
  type Frontmatter,
  type FrontmatterValue,
  parseFrontmatter,
} from './frontmatter.ts';
export {
  DEFAULT_READ_LINES,
  type FileToolInit,
  type ReadFileInput,
  type ReadFileOutput,
  readFileTool,
  type ToolInit,
  type WriteFileInput,
  type WriteFileOutput,
  writeFileTool,
} from './fs-tools.ts';
export {
  loadMemoryIndex,
  MEMORY_INDEX_FILE,
  MEMORY_TYPES,
  type Memory,
  type MemoryIndexEntry,
  type MemoryType,
  MemoryValidationError,
  memoryFileStem,
  readMemory,
  removeMemory,
  upsertMemory,
} from './memory-loader.ts';
export { type PoolOptions, type PoolWorker, runPool } from './pool.ts';
export {
  AUTONOMY_CONTRACT_TEXT,
  autonomyBlock,
  COMMUNICATION_CONTRACT_TEXT,
  CONTEXT_MANAGEMENT_TEXT,
  communicationContractBlock,
  contextManagementBlock,
  defaultContractBlocks,
  HARNESS_CONTRACT_TEXT,
  harnessContractBlock,
  identityBlock,
  MEMORY_INDEX_PREAMBLE,
  memoryIndexBlock,
  PROMPT_BLOCK_ORDER,
  type PromptBlock,
  type PromptBlockKind,
  renderPromptBlocks,
  selfIdBlock,
  stepBudgetLine,
  TOOL_RESULT_TRUST_TEXT,
  toolResultTrustBlock,
} from './prompt-blocks.ts';
export { resolveInside } from './safe-path.ts';
export {
  type GlobInput,
  type GlobOutput,
  type GrepInput,
  type GrepOutput,
  globTool,
  globToRegExp,
  grepTool,
  type SearchToolInit,
} from './search-tools.ts';
export {
  SKILL_INVOCATION_CONTRACT,
  type SkillToolInput,
  type SkillToolOutput,
  skillIndexBlock,
  skillTool,
} from './skill-tool.ts';
export { loadSkills, type SkillDefinition } from './skills-loader.ts';
export {
  DEFAULT_STEP_OUTPUT_BUDGET_CHARS,
  type StepBudgetedTools,
  type StepOutputBudgetInit,
  withStepOutputBudget,
} from './step-output-budget.ts';
export {
  callWithRetry,
  callWithStepTimeout,
  composeSystemPrompt,
  continueSubagent,
  correctiveMessage,
  createSubagent,
  DEFAULT_LLM_MAX_RETRIES,
  defaultRetryDelayMs,
  formatSubmitIssues,
  isRetryableProviderError,
  parseRetryAfterMs,
  type RetryInfo,
  type RetryOptions,
  runSubagent,
  runWithSchemaRetry,
  type SchemaRetryOptions,
  StepTimeoutError,
  StreamStallError,
  type StreamTimer,
  type StreamTimerFactory,
  type StreamWatchdog,
  type StreamWatchdogConfig,
  SUBMIT_TOOL_NAME,
  type SubagentConfig,
  type SubagentHandle,
  type SubagentRun,
  type SubagentRunOptions,
  type SubagentStreamEvent,
  type SubagentStreamSink,
  type SubmittedOutput,
  submittedOutput,
} from './subagent.ts';
export {
  type ContextSection,
  contextReminder,
  type ReminderProvider,
  SYSTEM_REMINDER_CONTRACT,
  withReminders,
  wrapReminder,
} from './system-reminder.ts';
export {
  DEFAULT_LOOP_BLOCK_AT,
  DEFAULT_LOOP_REMIND_AT,
  type GuardedTools,
  type LoopGuardInit,
  type LoopGuardVerdict,
  makeToolCallRepairer,
  resolveToolName,
  ToolCallLoopTracker,
  type ToolCallRepairInit,
  type ToolNameResolution,
  unknownToolMessage,
  withLoopGuard,
} from './tool-guards.ts';
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookBlockedResult,
  type HookExec,
  type HookSpec,
  hookMatches,
  MAX_HOOK_FEEDBACK_CHARS,
  type ToolHooks,
  type WithHooksInit,
  withHooks,
} from './tool-hooks.ts';
export { type SpilledOutput, ToolOutputStore } from './tool-output-store.ts';
