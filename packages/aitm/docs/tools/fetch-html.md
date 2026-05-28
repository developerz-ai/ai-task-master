# `fetch_html` — TLS-fingerprint web fetch

A heavier-stealth sibling of [`web-fetch`](../../src/tools/web-fetch.ts). Use it for pages that
`web-fetch` can't reach because the site fingerprints the **TLS handshake (JA3/JA4)** or
**HTTP/2 frame ordering** — Cloudflare's JS challenge, Akamai Bot Manager, etc.

## Why a separate tool

`web-fetch` does header-level stealth (Chrome-like `User-Agent`, `Sec-Ch-Ua`, `Accept-*`) over
Node's stock `fetch`. That clears ~70% of public docs. But Node/Bun/Deno can't fake a browser's
**TLS signature** — the handshake still looks like OpenSSL, so JA3-fingerprinting gateways block
it regardless of headers. `fetch_html` shells out to
[`curl-impersonate`](https://github.com/lwthiker/curl-impersonate), a patched curl that speaks a
real Chrome/Firefox/Safari handshake.

The model should reach for `fetch_html` **only when `web-fetch` returns a 403 or a challenge** —
it's slower and depends on an external binary.

## Tool surface

Same output shape as `web-fetch` (`WebFetchOutput`: `url`, `finalUrl`, `status`, `contentType`,
`body`, `truncated`, `retrievedAt`), so a subagent can swap tools without prompt changes.

| Input | Meaning |
| --- | --- |
| `url` | http/https URL (passes the same SSRF guard as `web-fetch`) |
| `timeoutMs?` | request timeout (default 15s) |
| `maxChars?` | body truncation cap (default 200_000) |
| `impersonate?` | `chrome` (default) \| `firefox` \| `safari` |

## Requirements — `curl-impersonate` (optional binary)

`fetch_html` is **gated on a `curl-impersonate` binary being installed**. It is *not* a hard
dependency:

- If the binary is absent, a call returns a `status: 0` result whose `body` explains how to
  install it — it never throws or crashes the run.
- Wiring code can call `isFetchHtmlAvailable()` to skip registering the tool entirely when the
  binary isn't on `PATH`.

Install (see the project's releases for prebuilt binaries per OS):

```sh
# example — adjust for your platform/package manager
# https://github.com/lwthiker/curl-impersonate/releases
```

### Binary + target are install-specific

`curl-impersonate` ships per-browser builds (`curl-impersonate-chrome`, `curl-impersonate-ff`, …)
and the `--impersonate <target>` value is a versioned string (`chrome116`, `firefox117`,
`safari15_5`). The defaults here target a recent build; override them to match your install via
`fetchHtmlTool({ binary, targets })`:

```ts
fetchHtmlTool({
  binary: 'curl-impersonate-chrome',
  targets: { chrome: 'chrome124', firefox: 'firefox123', safari: 'safari17_0' },
});
```

## Portability

Pure shell-out via `execa` — no native npm dependency, runs on Bun / Node ≥ 20 / Deno. The TLS
work lives entirely in the external binary, keeping `aitm` itself dependency-light.
