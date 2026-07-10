// Public API for @developerz.ai/ai-claude-compat. Claude-Code-style agent primitives for the
// Vercel AI SDK: cwd-scoped FS/edit/search/shell tools, an <env> system-context block, and
// .claude/ skills + agents loading.

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
