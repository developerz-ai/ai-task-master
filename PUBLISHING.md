# Publishing

Both packages publish to npm under the **`@developerz.ai`** scope:

- `@developerz.ai/ai-claude-compat`
- `@developerz.ai/aitm` (depends on the above, pinned to an exact version)

Releases use **OIDC trusted publishing** from GitHub Actions
(`.github/workflows/release.yml`) — no `NPM_TOKEN` secret. npm mints a
short-lived token from the run's OIDC identity and attaches a provenance
attestation automatically.

## One-time bootstrap (manual, requires npm auth)

A trusted publisher can only be attached to a package that **already exists**.
So the first version of each package must be published by hand by a member of
the `developerz.ai` npm org:

```sh
npm login                          # as a developerz.ai org member
bun install && bun run build

# dependency first
npm publish -w @developerz.ai/ai-claude-compat --access public
npm publish -w @developerz.ai/aitm --access public
```

## One-time: configure the trusted publisher (per package)

On npmjs.com, for **each** package:

`npmjs.com/package/<name>` → **Settings** → **Trusted Publisher** →
**GitHub Actions**, then enter:

| Field             | Value                |
| ----------------- | -------------------- |
| Organization/user | `developerz-ai`      |
| Repository        | `ai-task-master`     |
| Workflow filename | `release.yml`        |
| Environment       | *(leave blank)*      |

(The GitHub org is `developerz-ai` with a hyphen; the npm scope is
`@developerz.ai` with a dot — both are correct.)

## Ongoing releases (automated)

1. Bump the version in **both** `package.json` files (keep them in lockstep —
   `aitm` pins `ai-claude-compat` to an exact version).
2. Commit, then publish a GitHub Release (or run the `release` workflow via
   **Actions → release → Run workflow**).
3. The workflow installs, builds, and runs `npm publish` for each package over
   OIDC. No token needed.

## Requirements baked into the workflow

- `permissions: id-token: write` — lets npm mint the OIDC token.
- npm CLI `>= 11.5.1` — the workflow upgrades npm because Node 22 ships an older one.
- `publishConfig.access: public` + `provenance: true` in each `package.json`.
