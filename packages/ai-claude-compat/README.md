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
  bashTool, multiBashTool,        // one shell command / an ordered sequence, scoped to cwd
  globTool, grepTool,             // file glob + content search
} from '@developerz.ai/ai-claude-compat';

const cwd = process.cwd();
const tools = {
  read:      readFileTool({ cwd }),
  write:     writeFileTool({ cwd }),
  edit:      editFileTool({ cwd }),
  bash:      bashTool({ cwd }),
  multiBash: multiBashTool({ cwd }),
  grep:      grepTool({ cwd }),
  glob:      globTool({ cwd }),
};
```

Pass `tools` straight into a `generateText` / `streamText` call or an
`Agent`/`ToolLoopAgent`.

## Background processes

`bashTool`/`multiBashTool` block until the command exits, so they can't hold a
dev server open. `backgroundProcessTools` does: it spawns `bash -c …` without
awaiting, returns a process id immediately, and lets the agent tail output, kill
one process, or kill them all on teardown. **The caller owns lifecycle** — keep
the returned `manager` and call `killAll()` when the run ends, or processes leak.

```ts
import { backgroundProcessTools } from '@developerz.ai/ai-claude-compat';

const { manager, backgroundBash, bashOutput, killBash, listBackground } =
  backgroundProcessTools({ cwd });

const agentTools = { ...tools, backgroundBash, bashOutput, killBash, listBackground };
// agent: backgroundBash("npm run dev") -> { id }
//        bashOutput(id) -> new stdout/stderr since last poll, running, exitCode
//        killBash(id)
try {
  await agent.generate({ prompt: 'start the dev server and check it serves /health' });
} finally {
  manager.killAll(); // teardown — nothing else guarantees the server is stopped
}
```

`bashOutput` is **incremental** (like Claude Code's BashOutput): each call returns
only the bytes produced since the last call. Buffers are capped (256 KiB/stream by
default); past the cap the oldest bytes are dropped and `truncated` is set.
Browser/CDP automation is intentionally **out of scope** — drive a browser with a
dedicated MCP server (e.g. Playwright MCP), not from this library.

## Subagents (subagent-as-tool)

`createSubagent` wraps the boilerplate of a `ToolLoopAgent` (model + tools +
instructions + a step-count stop condition); `composeSystemPrompt` assembles the
instructions as **your coding style + a role prefix + an `<env>` block** (cwd,
platform, OS, runtime, date).

Structured output is delivered by a terminal **`submit` tool** (function calling),
not `response_format: json_schema` — some OpenAI-compatible providers ignore the
latter. Build the `submit` tool with a concrete Zod schema; the agent stops when it
calls `submit`. Read the validated result back with `submittedOutput`, or drive the
whole run through `runWithSchemaRetry`, which corrects a botched `submit` in-conversation
before giving up.

```ts
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import {
  composeSystemPrompt,
  createSubagent,
  runWithSchemaRetry,
} from '@developerz.ai/ai-claude-compat';

const OutputSchema = z.object({ summary: z.string() });

const worker = createSubagent(
  {
    model: openai('gpt-5'),
    tools,
    systemPrompt: composeSystemPrompt(
      claudeMd,                         // coding-style signal from the target repo
      'You implement one task and report the diff, then call submit.',
      process.cwd(),                    // → <env> block
    ),
    // A concrete schema so the AI SDK infers the tool's param type.
    submit: tool({
      description: 'Submit the finished result (the OutputSchema).',
      inputSchema: OutputSchema,
      execute: async (out) => out,
    }),
    maxSteps: 40,
  },
  /* defaultMaxSteps */ 25,
);

// Typed, never throws: { ok: true, value } | { ok: false, reason: 'no-submission' | 'invalid', … }.
// runWithSchemaRetry re-prompts the same agent (default 2 retries) if the model botches the schema.
const result = await runWithSchemaRetry(worker, OutputSchema, 'Implement the task.');
if (result.ok) console.log(result.value.summary);
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
| `bashTool` | Run one shell command, cwd as initial dir; returns stdout/stderr/exitCode |
| `multiBashTool` | Run an ordered sequence of commands; stops at the first non-zero exit |
| `backgroundProcessTools`, `ProcessManager` | Non-blocking background commands (dev servers): start / tail output / kill / killAll |
| `globTool`, `grepTool`, `globToRegExp` | File glob + content search |
| `composeSystemPrompt`, `createSubagent` | System-prompt composer + subagent-as-tool factory |
| `submittedOutput`, `runWithSchemaRetry`, `formatSubmitIssues` | Typed `submit`-tool extraction + schema-mismatch retry kernel |
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

## Platform: Linux only

The shell tools (`bashTool`, `multiBashTool`) target **Linux**. They spawn
`bash -c …`, so they need a POSIX `bash` on `PATH` — they are **not** supported
on native Windows (use WSL) and are only best-effort on macOS. The pure
filesystem/edit/search tools are platform-neutral, but the package as a whole is
developed and tested on Linux; treat anything else as unsupported.

### Shell environment (rbenv / nvm / asdf, `~/.bashrc`)

Commands run via a **non-login, non-interactive** `bash -c` with `BASH_ENV`
scrubbed. That is deliberate: a login/interactive shell would source
`/etc/profile` and `~/.bashrc`, which often `cd` away and would defeat the
cwd lock. The consequence:

- **PATH-based tools work** — `rbenv`/`asdf` shims, and any binary already on the
  `PATH` of the process that launched the agent, are inherited (the child gets
  `process.env`). If you can run `ruby`/`node` from the shell you start the agent
  in, the agent can too.
- **Shell-function tools do not** — `nvm`, and anything that exists only as a
  function defined in `~/.bashrc`, is **not** loaded. Source it yourself inside
  the command (`source ~/.nvm/nvm.sh && nvm use && …`) or put the resolved
  binary on `PATH` before launching.

## License

MIT · part of [`developerz-ai/ai-task-master`](https://github.com/developerz-ai/ai-task-master)
