# @developerz.ai/ai-claude-compat

> Claude-Code-style agent primitives for the [Vercel AI SDK](https://ai-sdk.dev).

Build coding agents on the AI SDK with the tool surface and conventions you
already know from Claude Code — **cwd-scoped filesystem / edit / search / bash
tools**, an **`<env>` system-context block**, a **subagent-as-tool factory**,
and **`.claude/` skills + agents loading** — all provider-agnostic (works with
any AI SDK model: OpenAI, OpenRouter, Anthropic, local, …).

```sh
npm install @developerz.ai/ai-claude-compat ai
```

## Why

The AI SDK gives you `tool()` and agents, but not the *opinionated tool surface*
that makes a coding agent useful: a `Read` with a line window, an `Edit` that
does exact-string replacement, a `Bash` that streams, a `Grep`/`Glob` pair, and
a way to keep every path safely inside a working directory. This package ships
those, shaped like Claude Code's, so you can stand up an agent in minutes.

Everything is **scoped to a `cwd`** and path-guarded (`resolveInside`) — a tool
can't read or write outside the root you give it.

## Tools

```ts
import {
  readFileTool, writeFileTool,   // Read (offset/limit window) + Write
  editFileTool, multiEditTool,   // exact-string Edit + batched MultiEdit
  bashTool,                       // streaming shell, scoped to cwd
  globTool, grepTool,             // file glob + content search
} from '@developerz.ai/ai-claude-compat';

const cwd = process.cwd();
const tools = {
  read:  readFileTool({ cwd }),
  write: writeFileTool({ cwd }),
  edit:  editFileTool({ cwd }),
  bash:  bashTool({ cwd }),
  grep:  grepTool({ cwd }),
  glob:  globTool({ cwd }),
};
```

Pass `tools` straight into a `generateText` / `streamText` call or an
`Agent`/`ToolLoopAgent`.

## Subagents (subagent-as-tool)

`createSubagent` wraps the boilerplate of a `ToolLoopAgent` (model + tools +
instructions + a step-count stop condition); `composeSystemPrompt` assembles the
instructions as **your coding style + a role prefix + an `<env>` block** (cwd,
platform, OS, runtime, date).

```ts
import { openai } from '@ai-sdk/openai';
import { Output } from 'ai';
import { z } from 'zod';
import { composeSystemPrompt, createSubagent } from '@developerz.ai/ai-claude-compat';

const worker = createSubagent(
  {
    model: openai('gpt-5'),
    tools,
    systemPrompt: composeSystemPrompt(
      claudeMd,                         // coding-style signal from the target repo
      'You implement one task and report the diff.',
      process.cwd(),                    // → <env> block
    ),
    output: Output.object({ schema: z.object({ summary: z.string() }) }),
    maxSteps: 40,
  },
  /* defaultMaxSteps */ 25,
);
```

Expose `worker` to a parent agent as a tool to get the isolated-context,
focused-prompt subagent pattern: <https://ai-sdk.dev/docs/agents/subagents>.

## `.claude/` skills & agents

Discover and parse the Claude-Code `.claude/` directories of a project (markdown
+ YAML frontmatter):

```ts
import { claudeDirs, loadSkills, loadAgents } from '@developerz.ai/ai-claude-compat';

for (const dir of claudeDirs(process.cwd())) {
  const skills = await loadSkills(dir);   // SkillDefinition[]
  const agents = await loadAgents(dir);   // AgentDefinition[]
}
```

## API

| Export | What it is |
| --- | --- |
| `readFileTool`, `writeFileTool` | Read (offset/limit window) + Write, cwd-scoped |
| `editFileTool`, `multiEditTool`, `applyEdit` | Exact-string Edit, batched MultiEdit, pure edit helper |
| `bashTool` | Streaming shell tool, scoped to cwd |
| `globTool`, `grepTool`, `globToRegExp` | File glob + content search |
| `composeSystemPrompt`, `createSubagent` | System-prompt composer + subagent-as-tool factory |
| `envBlock` | Render the `<env>` system-context block from `EnvInfo` |
| `loadSkills`, `loadAgents`, `claudeDirs` | `.claude/` discovery + parsing |
| `parseFrontmatter`, `asString`, `asStringArray` | YAML-frontmatter helpers |
| `resolveInside` | Path guard — resolve a path and assert it stays inside a root |

Types are exported alongside each value (`ReadFileInput`, `BashOutput`,
`SubagentConfig`, `EnvInfo`, `SkillDefinition`, …).

## Runtime

ESM only. Runs unchanged on **Node ≥ 20, Bun, and Deno ≥ 1.40**. Peer dep: `ai`
(AI SDK v6). No Anthropic SDK — "Claude-compat" refers to the *conventions*, not
the provider.

## License

MIT · part of [`developerz-ai/ai-task-master`](https://github.com/developerz-ai/ai-task-master)
