// Public API for @developerz.ai/ai-claude-compat. Claude-Code-style agent primitives for the
// Vercel AI SDK: cwd-scoped FS/edit/search/shell tools, an <env> system-context block, and
// .claude/ skills + agents loading.

export {
  AGENT_TOOL_ERROR_PREFIX,
  AGENT_TOOL_NO_CONCLUSION,
  AGENT_TOOL_TRUNCATION_MARKER,
  AgentToolConstructionError,
  type AgentToolInput,
  type AgentToolOptions,
  type AgentToolSpec,
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
export {
  AUTONOMY_CONTRACT_TEXT,
  autonomyBlock,
  COMMUNICATION_CONTRACT_TEXT,
  communicationContractBlock,
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
} from './search-tools.ts';
export { loadSkills, type SkillDefinition } from './skills-loader.ts';
export {
  callWithStepTimeout,
  composeSystemPrompt,
  continueSubagent,
  correctiveMessage,
  createSubagent,
  formatSubmitIssues,
  runSubagent,
  runWithSchemaRetry,
  type SchemaRetryOptions,
  StepTimeoutError,
  SUBMIT_TOOL_NAME,
  type SubagentConfig,
  type SubagentHandle,
  type SubagentRun,
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
