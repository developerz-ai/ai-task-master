# Security policy

## Supported versions

`aitm` is pre-1.0 and is published to npm as `@developerz.ai/aitm`. Only the latest published
version is supported. Check yours with `aitm --version`, and upgrade before reporting against an
older one.

## Reporting a vulnerability

**Report privately. Do not open a public issue, pull request or discussion.**

Use [Report a vulnerability](https://github.com/developerz-ai/ai-task-master/security/advisories/new)
on this repository. It opens a private advisory that only the maintainers can see until a fix ships.

Please include:

- the output of `aitm --version`, the runtime and its version (Node or Deno), and your OS;
- the command you ran and the relevant part of your config, with keys and tokens removed;
- steps to reproduce, ideally against a throwaway repository;
- the impact: what an attacker gains, and what they have to control first (the target repository's
  contents, a pull request or review comment, an issue, a config file, the network).

## Response

- Acknowledgement within 3 business days.
- A triage decision and a severity within 7 days of the acknowledgement.
- Once it is triaged, we tell you the fix timeline, and we credit you in the advisory unless you ask
  us not to.

## Scope

`aitm` runs on your machine with your credentials: your model provider's API key and your `gh`
login. It reads the target repository, runs a model's tool calls in a git worktree, opens pull
requests and can merge them.

In scope, for example:

- a credential (your API key, a `gh` token) reaching a pull request, a commit, a comment or anything
  else `aitm` publishes, or reaching anyone other than the provider you configured;
- a file or search tool reading or writing outside the worktree it was given;
- content someone else controls (a pull request, a review comment, an issue, a file in the target
  repository) making `aitm` itself merge, push or open something the user did not ask for;
- `aitm` merging past branch protection without `--admin`, or `--admin` doing more than the README
  says it does;
- the same classes in `@developerz.ai/ai-claude-compat`, which provides the tool surface.

Out of scope:

- what `--admin` is documented to do: it bypasses the review requirement, on purpose, for a user
  with admin rights on the repository;
- prompt injection that steers the model's own tool calls inside the worktree. That is a known limit
  of every coding agent, and it is a vulnerability here only when it gets past a boundary `aitm`
  enforces: the worktree confinement of the file tools, the merge rules, or credential handling;
- a model writing wrong or insecure code into a pull request. Review and CI are there to catch that;
- vulnerabilities in OpenRouter, a model provider, the `gh` CLI or the AI SDK. Please report those
  upstream;
- anything that needs prior control of your machine or your accounts.
