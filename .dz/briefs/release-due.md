# Brief: is a release due?

Weekday checkup fired by `schedules: release-due`. This brief decides *when*; the steps below are the *how*.

## Decide

```bash
git fetch --tags --unshallow origin 2>/dev/null || git fetch --tags origin
last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)
git log --format='%h %cI %s' "$last"..origin/main -- packages/aitm/src packages/ai-claude-compat/src packages/aitm/package.json packages/ai-claude-compat/package.json bun.lock
jq -r .version packages/*/package.json
```

The pathspec names what reaches users. Prose, tests, CI and docs ship nothing.

| Window | Do |
|---|---|
| a command above failed | no verdict: surface it, file nothing |
| empty | nothing |
| the stamped version is already ahead of `$last` | nothing: a release is in flight, watch `release.yml` |
| the oldest shipping commit is under 24 h old | nothing: its author may still release it |
| `main`'s latest `ci.yml` push run is not `success` | nothing: `health` owns a red `main` |
| a breaking change in the window | no release ask. If no open issue titled `Major release pending` exists, file one for a maintainer, with no release steps |
| otherwise | one ask, **Release `<next>`**, listing the commits |

`<next>`: a `feat` subject in the window is a minor, anything else a patch.

## The ask

File nothing if an open issue title is exactly `Release <next>`, or an open PR is already that release. Body, for the box that takes it:

1. Re-run Decide on fresh `main`; still due, or stop.
2. Bump the three version lines: both package `version` fields and aitm's exact `@developerz.ai/ai-claude-compat` pin. Run `bun install`. Never regenerate `bun.lock` for a release (`CLAUDE.md`).
3. Run the gate, then one PR titled `chore(release): <next>`, nothing else in the diff. It merges on green like any PR.
4. After it merges: `gh release create v<next> --target <merge sha> --title "v<next>" --generate-notes`, only after `git show <merge sha>:packages/aitm/package.json` shows `<next>`. Publishing the Release is what runs `release.yml` (`PUBLISHING.md`).
5. Watch `release.yml` to the end. A failure is an issue for a maintainer.

Never re-tag, move or delete a tag, and never publish by hand. A failed publish is an issue for a maintainer; the fix ships as the next patch.
