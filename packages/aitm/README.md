# @developerz.ai/aitm

Autonomous task orchestrator. Goal in, merged PRs out.

`aitm` drives a plan → work → review loop over a real git repo: an Orchestrator
agent decomposes a goal into PR-sized groups, a Worker opens PRs, and a Reviewer
turns review comments into follow-up commits. Inference runs through OpenRouter.

## Install

```sh
npm install -g @developerz.ai/aitm
```

This installs the `aitm` command.

## Usage

```sh
export OPENROUTER_API_KEY=...      # required
aitm start                          # plan + work the current repo toward a goal
aitm merge-pr                       # merge the current task's PR
```

See the [project README](https://github.com/developerz-ai/ai-task-master#readme)
for configuration (`mcpServers`, per-role models) and the full workflow.

## License

MIT
