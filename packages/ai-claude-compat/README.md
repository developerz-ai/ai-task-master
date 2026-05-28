# @developerz.ai/ai-claude-compat

Claude-Code-style agent primitives for the [Vercel AI SDK](https://ai-sdk.dev):
FS/edit/search/bash tools, an `<env>` system-context block, a subagent-as-tool
factory, and `.claude/` skills/agents loading.

## Install

```sh
npm install @developerz.ai/ai-claude-compat ai
```

## What's inside

- **Tools** — filesystem, edit, search, and bash tools scoped to a working
  directory, shaped like Claude Code's tool surface.
- **`composeSystemPrompt` / `envBlock`** — assemble a system prompt with an
  `<env>` block (cwd, platform, OS, runtime, date).
- **`createSubagent`** — wrap an `experimental_Agent` as a callable tool
  (the subagents-as-tools pattern).
- **`.claude/` loading** — discover and parse local skills and agents.

## License

MIT
