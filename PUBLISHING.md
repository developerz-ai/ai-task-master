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

1. **The bump is the first step of every release, in a pull request to `main`.**
   Set the same new version in **both** `package.json` files, set `aitm`'s pin on
   `@developerz.ai/ai-claude-compat` to that exact version, and run `bun install`
   so `bun.lock` records it. npm versions are immutable: a version that is already
   published can never ship again, so a release without a bump cannot work.
2. Once that is merged, publish a GitHub Release whose tag is `v<version>`, on a
   commit on `main` (or run the `release` workflow from `main` via
   **Actions → release → Run workflow**).
3. The workflow runs `bin/release-preflight` before it builds anything. It refuses
   packages out of lockstep, a pin that is not the version, a tag that is not
   `v<version>`, a commit that is not on `main`, or a version already on npm, and
   says which. Anything but a clear "not found" from the registry is a refusal too.
   You can run it locally first: `bin/release-preflight v<version>`.
4. The workflow then installs, builds, and runs `npm publish` for each package over
   OIDC. No token needed.

## Requirements baked into the workflow

- `permissions: id-token: write` — lets npm mint the OIDC token.
- npm CLI `>= 11.5.1` — the workflow upgrades npm because Node 22 ships an older one.
- `publishConfig.access: public` + `provenance: true` in each `package.json`.
