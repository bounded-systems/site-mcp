# @bounded-systems/site-mcp

A **local, read-only [MCP](https://modelcontextprotocol.io) server** (and a
matching CLI) over [robertdelanghe.dev](https://robertdelanghe.dev)'s **signed
static API**.

It exposes the site's identity data — profile, writing, the GitHub corpus, the
résumé credential, the OpenAPI doc — to any MCP client (Claude Desktop, Claude
Code, etc.), and **verifies every response byte-for-byte against the site's
Sigstore-signed `sha256` manifest** before handing it back. If the bytes a
client would receive don't match the signed manifest, it refuses to return them.

It runs **locally over stdio** — the client spawns it as a subprocess. There is
no hosted server and no network listener, which preserves the site's
static / no-attack-surface posture.

## A thin implementation of a generic core

This package is now **thin**. All of the reusable machinery — the verifying
fetch client, the `sha256` manifest + Sigstore checks, and the
`VerbSpec → MCP (tools + resources)` / `VerbSpec → CLI` projection — lives in
[`@bounded-systems/static-mcp`](https://github.com/bounded-systems/static-mcp).
site-mcp supplies only:

- **the verbs** ([`src/verbs.ts`](./src/verbs.ts)) — `list_posts`, `get_post`,
  `get_conformance`, `get_corpus`, each authored once as a [`@bounded-systems/verbspec`](https://jsr.io/@bounded-systems/verbspec)
  `VerbSpec`;
- **the resource catalog** ([`src/catalog.ts`](./src/catalog.ts)) — the
  `site://…` resources;
- **the config values** ([`src/config.ts`](./src/config.ts)) — the origin and
  expected signer identity; and
- **the entry** ([`src/index.ts`](./src/index.ts)) — which picks a surface and
  hands the spec to the core.

```
src/verbs.ts ─┐
src/catalog.ts ├─▶ buildSiteSpec(config) ─▶ @bounded-systems/static-mcp
src/config.ts ─┘        serveVerifiedStaticMcp(spec, config)   (MCP, stdio)
                        runStaticCli(spec, config, argv)        (CLI)
```

> **Two surfaces, one definition.** verbspec projects each verb to **both** an
> MCP tool and a CLI subcommand. The exact same verb set backs `site-mcp`'s MCP
> tools and its CLI commands — no second definition, no drift.

## Install / run

Requires Node ≥ 18.17. site-mcp's verbspec dependency is published to JSR, so
installs resolve it through JSR's npm bridge — the included [`.npmrc`](./.npmrc)
sets `@jsr:registry=https://npm.jsr.io`. (Consuming from a fresh environment, add
that one line to your npm config.)

```bash
# MCP server over stdio (what an MCP client launches):
npx -y @bounded-systems/site-mcp

# CLI — the SAME verbs, printing the verified JSON:
npx -y @bounded-systems/site-mcp list_posts
npx -y @bounded-systems/site-mcp get_conformance                 # the index
npx -y @bounded-systems/site-mcp get_conformance accessibility   # one area
npx -y @bounded-systems/site-mcp get_conformance --full          # every criterion
npx -y @bounded-systems/site-mcp get_corpus                      # the index
npx -y @bounded-systems/site-mcp get_corpus topics               # one full list
npx -y @bounded-systems/site-mcp get_post agent-authored-code-drift
```

The MCP server logs a readiness line to **stderr** (stdout is the MCP channel):

```
site-mcp ready (stdio) → https://robertdelanghe.dev; signature mode=off
```

## MCP client configuration

```json
{
  "mcpServers": {
    "robertdelanghe": {
      "command": "npx",
      "args": ["-y", "@bounded-systems/site-mcp"],
      "env": { "SITE_MCP_SIGNATURE_MODE": "warn" }
    }
  }
}
```

## Resources

| Resource URI            | Endpoint                  | Contents |
| ----------------------- | ------------------------- | -------- |
| `site://profile`        | `profile.json`            | Headline, intro, label, links |
| `site://posts`          | `posts.json`              | JSON Feed of writing (post list) |
| `site://post/{slug}`    | `posts/{slug}.json`       | A single post (templated; `list` enumerates from the feed) |
| `site://corpus`         | `corpus.json`             | GitHub corpus: stats + highlights |
| `site://conformance`    | `conformance.json`        | Per-page DOM conformance report |
| `site://resume-vc`      | `resume.vc.json`          | Résumé as a Verifiable Credential |
| `site://openapi`        | `openapi.json`            | The OpenAPI 3.2 document for the API |

## Tools / CLI commands (read-only)

The same four verbs, on both surfaces:

| Tool / command    | Args                     | Returns |
| ----------------- | ------------------------ | ------- |
| `list_posts`      | —                        | The posts feed (slug, title, summary, tags) |
| `get_post`        | `slug`                   | A single post by slug |
| `get_conformance` | — \| `area` \| `--full`  | The conformance **index** (3.2 KB) \| one area \| every criterion (19.7 KB) |
| `get_corpus`      | — \| `list` \| `--full`  | The corpus **index** (9.2 KB) \| one ranked list \| the whole corpus (71.7 KB) |

### One verb per subject, not one per drill-down

A client loads every tool's name, description and input schema into its context
**before any call is made** — a cost paid on every session whether or not the
tool is used — and choosing among the tools is itself a fan-out. So the tool list
is a fold: `F` is the list, a call is one step of the generator rule, and a
terminal response is where expansion stops.

Which makes a verb per drill-down the wrong shape: it grows the part paid
*always* in order to shrink the part paid *sometimes*. `get_conformance_index` +
`get_conformance_area` + `get_corpus_index` + `get_corpus_list` would take this
server from three tools to eight.

Instead there is one verb per subject, and **the parameter is the generator
rule**: no argument returns the index, an argument unfolds one branch of it, and
`--full` still reaches the unfolded document at its own path. Nothing was removed
from the API — `site://conformance` and `site://corpus` still serve the complete
documents, and `site://conformance/index` and `site://corpus/index` are new
entry points alongside them.

> **Changed default.** `get_conformance` with no arguments used to return the
> whole 19.7 KB report; it now returns the 3.2 KB index. Pass `--full` (CLI) or
> `{"full": true}` (MCP) for the previous behaviour.

Resource reads and tool results carry a `_meta.verification` block (the
manifest-relative path, source URL, the verified `sha256`, and the manifest
signature status). The CLI prints the verified JSON; a verification failure exits
non-zero with nothing on stdout.

## Verification / trust model

The site publishes a single signed manifest, `https://robertdelanghe.dev/site.sha256`
(`sha256sum` format), and a Sigstore bundle over it, `site.sha256.sigstore.json`.
The core enforces:

1. **Per-file hash check (always on).** Fetch the manifest once per process; for
   every resource, fetch it, SHA-256 the received bytes, and require that digest
   to equal the manifest entry. A tampered file, a stale CDN edge, or a MITM →
   mismatch → `VerificationError` instead of a response. A path absent from the
   manifest is likewise refused.
2. **Manifest signature check (optional).** `SITE_MCP_SIGNATURE_MODE=warn|require`
   verifies the Sigstore bundle against the deploy workflow identity
   (`…/bdelanghe/site/.github/workflows/deploy.yml@refs/heads/main`).

> **Sigstore backend / `@bounded-systems/verify`.** The optional manifest-signature
> step is intended to delegate to [`@bounded-systems/verify`](https://jsr.io/@bounded-systems/verify),
> the canonical in-process bundle verifier. As of `verify@0.1.0` that package
> ships as a self-executing CLI with no exported function (importing it runs and
> exits the process), so the core keeps a minimal, behaviorally-identical copy of
> the check and the gap is filed upstream. See static-mcp's README.

## Configuration

| Variable                     | Default | Meaning |
| ---------------------------- | ------- | ------- |
| `SITE_MCP_BASE_URL`          | `https://robertdelanghe.dev` | Origin serving the site + API + manifest |
| `SITE_MCP_SIGNATURE_MODE`    | `off`   | `off` \| `warn` \| `require` |
| `SITE_MCP_SIGNER_IDENTITY`   | deploy workflow SAN | Expected Sigstore certificate identity |
| `SITE_MCP_SIGNER_ISSUER`     | GitHub Actions OIDC | Expected Sigstore OIDC issuer |
| `SITE_MCP_FETCH_TIMEOUT_MS`  | `15000` | Per-request fetch timeout |

## Development

```bash
npm install         # resolves @bounded-systems/static-mcp (npm) + verbspec (JSR bridge)
npm run build       # tsc → dist/
npm test            # node --test via tsx (server + CLI; no network)
npm run typecheck
```

## Publishing

**One tag publishes the same version to three registries, mirrored.** Pushing a
`v*` tag runs [`publish.yml`](./.github/workflows/publish.yml), which fans out to:

| # | Registry | Identifier | Auth |
| - | -------- | ---------- | ---- |
| 1 | **npm** | `@bounded-systems/site-mcp` | trusted publishing (OIDC) + [provenance](https://docs.npmjs.com/generating-provenance-statements) |
| 2 | **JSR** (mirror) | `@bounded-systems/site-mcp` | tokenless OIDC (`npx jsr publish`) |
| 3 | **MCP Registry** | `io.github.bounded-systems/site-mcp` | GitHub-OIDC namespace auth (`mcp-publisher`) |

There are **no long-lived secrets** — every registry authenticates with the
job's short-lived GitHub Actions OIDC token (`id-token: write`). npm needs
npm ≥ 11.5 (the workflow upgrades npm to guarantee this).

> [!IMPORTANT]
> **Versions must stay in sync.** The release version lives in **four** places
> that must all match: `package.json`, `deno.json`, `server.json`, and the
> `v<version>` git tag. The workflow's `verify` job hard-fails the whole release
> on any mismatch, so npm and JSR can never drift apart. The MCP Registry also
> requires `package.json` to carry `"mcpName": "io.github.bounded-systems/site-mcp"`
> (it reads that field off the published npm package to prove ownership).

The MCP Registry job runs **after** the npm job, because the registry verifies
ownership by reading `mcpName` from the freshly-published npm package.

### One-time setup (maintainer) — do these BEFORE the first tag

These three registry-side authorizations only need to happen once. Two of the
three (JSR, MCP Registry) are pure repo-link / OIDC — no tokens are minted.

**(a) npm — Trusted Publisher** (on [npmjs.com](https://www.npmjs.com/))

1. Sign in as an owner of the `@bounded-systems` scope.
2. Open the package page for **`@bounded-systems/site-mcp`** → **Settings** →
   **Trusted Publisher**. For a brand-new package you may need to publish `0.1.0`
   once manually (or create the package), then switch to trusted publishing.
3. Choose **GitHub Actions** and enter:
   - **Organization / user:** `bounded-systems`
   - **Repository:** `site-mcp`
   - **Workflow filename:** `publish.yml`  ← (was `publish-npm.yml`)
   - **Environment:** *(leave blank)*
4. Save. No token is generated or stored anywhere. Ensure the package's
   publishing-access policy allows automation/OIDC (trusted publishers satisfy 2FA).

**(b) JSR — create + link the package** (on [jsr.io](https://jsr.io/))

1. Sign in to jsr.io with GitHub and create the package **`@bounded-systems/site-mcp`**
   under the `@bounded-systems` scope.
2. Open the package's **Settings** tab → under **GitHub Repository** enter
   `bounded-systems/site-mcp` and click **Link**. Linking the repo is what enables
   **tokenless OIDC publishing** from this workflow (same idea as npm's trusted
   publisher). No token is created.

**(c) MCP Registry — nothing to pre-authorize**

The `io.github.bounded-systems/*` namespace is **auto-authorized via GitHub OIDC**:
because this repo lives under `github.com/bounded-systems`, `mcp-publisher login
github-oidc` proves ownership of the namespace from the Actions run itself.
There is **no** registry-side claim/consent/linking step to do in advance — the
first `publish.yml` run authenticates and registers the server on its own.
(Package-ownership of the npm entry is proven separately by the `mcpName` field;
see the note above.)

### Cut a release (the single command)

```bash
# 1. Bump the version in ALL of: package.json, deno.json, server.json
#    (and the package entry in server.json). Commit.
# 2. Tag with the SAME version and push — this is the only command:
git tag v0.1.0 && git push origin v0.1.0
```

That one `v*` tag triggers `publish.yml` → npm + JSR + MCP Registry, all at the
same version. You can also run it from the Actions tab via **workflow_dispatch**
(which reuses the `package.json` version in place of a tag).

### Local dry-runs (verify without publishing)

```bash
npm pack --dry-run                                   # npm tarball contents
npx --yes jsr publish --dry-run --allow-slow-types   # JSR (or: deno publish --dry-run --allow-slow-types)
mcp-publisher validate ./server.json                 # MCP Registry schema check
```

> site-mcp depends on `@bounded-systems/static-mcp`; **publish the core first**
> (its own `v*` tag → JSR + npm), then cut site-mcp's tag.

## License

MIT — see [LICENSE](./LICENSE). The site data itself is published under CC BY 4.0.
