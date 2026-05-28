// Public API for @developerz.ai/ai-claude-compat. Claude-Code-style agent primitives for the
// Vercel AI SDK: cwd-scoped FS/edit/search/shell tools, an <env> system-context block, and
// .claude/ skills + agents loading.

export { type AgentDefinition, claudeDirs, loadAgents } from './agents-loader.ts';
export { type BashInput, type BashOutput, type BashToolInit, bashTool } from './bash-tool.ts';
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
export { type EnvInfo, envBlock } from './env-block.ts';
export {
  asString,
  asStringArray,
  type Frontmatter,
  type FrontmatterValue,
  parseFrontmatter,
} from './frontmatter.ts';
export {
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
export { composeSystemPrompt, createSubagent, type SubagentConfig } from './subagent.ts';
