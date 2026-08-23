// Fixture tests over the release workflows.
//
// Nothing here runs a workflow — these read the YAML as text and assert the
// couplings that are invisible until a release goes wrong. Both failures they
// cover are silent: the run goes green and the release is simply absent or
// wrong, which is the shape of defect a green check cannot report on itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const wf = (name: string) => readFileSync(`.github/workflows/${name}`, "utf8");

// Split a workflow's `jobs:` section into one block per job. Slicing from a job
// name to end-of-file instead is what let a dropped `tag:` in one job pass on
// the strength of the NEXT job still having one — a fixture test that reads
// green against the defect it names is worse than no test.
// Executable lines only — YAML comments stripped. Assertions about what a
// workflow DOES must not read what it SAYS: this file has now had three
// fixtures agree with their own prose instead of the code, in both directions
// (an `assert.match` satisfied by a comment, and an `assert.doesNotMatch`
// tripped by a comment naming the very defect it forbids).
function code(yaml: string): string {
  return yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

function jobBlocks(yaml: string): Record<string, string> {
  const section = yaml.slice(yaml.indexOf("\njobs:") + 1);
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of section.split("\n").slice(1)) {
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = "";
      continue;
    }
    if (cur) out[cur] += line + "\n";
  }
  return out;
}

const MINT_LANE = "npm-publish.yml";

// THE PRESCRIBED CALLER FILENAME (mint#48).
//
// npm's trusted publishing validates the ENTRY workflow's filename, not the file
// containing `npm publish`, and a package may have exactly ONE trusted publisher
// configured. This repo had three registerable entry points — `cut.yml`
// (dispatch), `publish.yml` (tag push AND dispatch) — so npm validated a
// different name depending on how the release started, and only one of the three
// could ever be configured. The breakage is invisible until a release dies with
// ENEEDAUTH after the tag is already pushed.
//
// This is not a property any single file can state about itself: it belongs to
// the DIRECTORY, so the whole directory is the fixture.
const NPM_ENTRY = "release.yml";

test("exactly one workflow is an npm entry point, and it is the prescribed name", () => {
  const reaches = readdirSync(".github/workflows")
    .filter((f) => f.endsWith(".yml"))
    .filter((f) => {
      const src = code(wf(f));
      return /\bnpm publish\b/.test(src) || src.includes(MINT_LANE);
    });

  assert.deepEqual(
    reaches,
    [NPM_ENTRY],
    `npm validates the entry workflow's filename and a package gets ONE trusted ` +
      `publisher, so exactly one file may reach npm: ${NPM_ENTRY}. Found: ${reaches.join(", ")}`,
  );
});

// #33/#34/#38/mint#48 in one file. Each property below is a defect that reached
// a real release, and each is the kind a later edit undoes by accident.
test("release.yml: three doors, a chained cut, and one resolved tag", () => {
  const src = code(wf(NPM_ENTRY));
  const blocks = jobBlocks(src);

  assert.match(src, /^\s{2}push:\n\s{4}tags: \["v\*"\]$/m, "the tag-push door is gone — a laptop cut would do nothing");
  assert.match(src, /^\s{2}workflow_dispatch:$/m, "the dispatch door is gone — the release needs a laptop again");

  // 1. The cut must call mint's reusable release-cut, not reimplement it, and
  //    must be dispatch-only: on a tag push the tag already exists.
  assert.match(
    blocks.cut,
    /uses:\s+bounded-systems\/mint\/\.github\/workflows\/release-cut\.yml@[0-9a-f]{40}/,
    "the cut job must call mint's release-cut, pinned to a full commit SHA",
  );
  assert.match(
    blocks.cut,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.recover-tag == ''/,
    "the cut must be dispatch-only and skipped on the recovery path",
  );

  // 2. The chain must be gated on an ACTUAL cut. `cut` reports cut: 'false' for
  //    a dry run, so gating `resolve` on that one output is what makes dry-run
  //    mean "publish nothing".
  assert.match(
    blocks.resolve,
    /needs\.cut\.outputs\.cut == 'true'/,
    "nothing gates the chain on a real cut — a dry run would publish",
  );
  //    ...and `resolve` must survive `cut` being SKIPPED, which it is on both the
  //    push and recovery doors. A plain `needs:` would skip it with them.
  assert.match(blocks.resolve, /!cancelled\(\)/, "resolve must run when the cut job is skipped");

  // 3. Every checkout names the resolved tag. On a dispatch the run's ref is a
  //    BRANCH, so one unpinned checkout publishes main under a version tag's
  //    name (#34) — and that is silent, not red.
  const checkouts = src.split("\n").filter((l) => l.includes("actions/checkout@")).length;
  const pinned = (src.match(/ref: \$\{\{ needs\.resolve\.outputs\.tag \}\}/g) || []).length;
  assert.ok(checkouts > 0, "no checkouts found — did the job structure change?");
  assert.equal(
    pinned,
    checkouts,
    `${checkouts} checkout(s) but ${pinned} pinned to the resolved tag — an unpinned one releases the dispatch branch`,
  );

  // 4. Nothing may read the raw ref afterwards; one leftover expansion is enough
  //    to send a dispatched release back to the branch.
  assert.deepEqual(
    src.split("\n").filter((l) => l.includes("$GITHUB_REF_NAME")),
    [],
    "a $GITHUB_REF_NAME expansion survives — on a dispatched run that is the branch",
  );
});

// The recovery door exists because v0.3.0 reached JSR and the GitHub release and
// never reached npm or the MCP Registry (#38). Re-running the whole release for
// that is wrong twice over: the tag cannot be re-cut, and a published GitHub
// release is immutable, so the provenance job would go red for work that had in
// fact succeeded (mint#19).
test("release.yml: the recovery door names a tag and skips the cut and the provenance", () => {
  const src = code(wf(NPM_ENTRY));
  const dispatch = src.slice(src.indexOf("workflow_dispatch:"), src.indexOf("\npermissions:"));
  assert.match(dispatch, /recover-tag:/, "workflow_dispatch must accept a tag to re-publish");

  const blocks = jobBlocks(src);
  assert.match(
    blocks.resolve,
    /RECOVER: \$\{\{ inputs\.recover-tag \}\}/,
    "resolve must read the recovery tag, or the door leads to the branch",
  );
  assert.match(
    blocks.provenance,
    /if: \$\{\{ inputs\.recover-tag == '' \}\}/,
    "provenance must be skipped on the recovery path — the release it would create already exists",
  );
  for (const job of ["npm", "jsr", "mcp-registry"]) {
    assert.doesNotMatch(
      blocks[job],
      /recover-tag/,
      `${job} must still run on the recovery path — re-publishing the registries is what that door is for`,
    );
  }
});

test("every mint call site is pinned to the same mint commit", () => {
  const files = ["release.yml", "version.yml"];
  const sites = files.flatMap((name) => [
    // `uses: .../mint/...@<sha>` — the workflow being called.
    ...[...wf(name).matchAll(/bounded-systems\/mint\/[^@]+@([0-9a-f]{40})/g)].map((m) => ({
      name,
      where: "uses",
      sha: m[1],
    })),
    // `ref: <sha>` — the mint runtime those workflows check out. It drifts
    // independently of the `uses:` pin, and a run pinned to two different mints
    // is a run whose behaviour matches neither.
    ...[...code(wf(name)).matchAll(/^\s+ref: ([0-9a-f]{40})\s*$/gm)].map((m) => ({
      name,
      where: "ref",
      sha: m[1],
    })),
  ]);
  assert.ok(sites.length >= 6, `expected at least 6 mint pins, found ${sites.length}`);
  const shas = new Set(sites.map((s) => s.sha));
  assert.equal(
    shas.size,
    1,
    `mint pins disagree: ${sites.map((s) => `${s.name}:${s.where}=${s.sha.slice(0, 8)}`).join(", ")}`,
  );
});

test("each chained caller grants what the called workflow's permissions block asks for", () => {
  // GitHub validates a called reusable workflow's permission requests as the
  // UNION of its `permissions:` block, AT LOAD TIME — before any `if:`, and
  // regardless of which steps would run. Withholding one produces a
  // `startup_failure`: no job starts, so there is no job log to read and no
  // failing step to point at. The first dispatch of the old cut.yml did exactly
  // that, because release-provenance.yml asks for `actions: read` (for
  // `gh run download`) and the provenance job granted only two of the three.
  const blocks = jobBlocks(wf(NPM_ENTRY));
  const required: Record<string, string[]> = {
    // release-cut.yml
    cut: ["contents: write"],
    // release-provenance.yml — all three, actions: read included
    provenance: ["contents: write", "id-token: write", "actions: read"],
    // mint's npm-publish.yml
    npm: ["contents: read", "id-token: write"],
  };
  for (const [job, perms] of Object.entries(required)) {
    const block = blocks[job];
    assert.ok(block, `${NPM_ENTRY} is missing the ${job} job`);
    for (const p of perms) {
      const [scope, level] = p.split(": ");
      // A real `permissions:` entry on its own line — not the substring, which
      // the surrounding comments also contain. Matching prose instead of the
      // grant is how the first draft of this test passed while the permission
      // it names had been removed.
      const granted = new RegExp(`^\\s+${scope}: ${level}\\s*(#.*)?$`, "m").test(block);
      assert.ok(
        granted,
        `${job} must grant \`${p}\` — the workflow it calls asks for it, and a ` +
          `caller that withholds it fails the run before any job starts`,
      );
    }
  }
});

// --- the release path must not install an unreviewed npm ---------------------
//
// v0.3.0 shipped to JSR and the GitHub release, and never reached npm or the MCP
// Registry, because `npm install -g npm@latest` pulled an npm whose new default
// refuses remote-tarball dependencies:
//
//   npm error code EALLOWREMOTE
//   npm error Refusing to fetch "@bounded-systems/verbspec@https://npm.jsr.io/...tgz"
//
// The lockfile resolves the JSR npm-compat deps to exactly those URLs, so `npm ci`
// died before the publish step. The floor now lives in mint's lane, which asserts
// it rather than installing it — but the mutation this forbids would land HERE if
// it came back, so the assertion stays here and covers every workflow.
test("no workflow globally installs npm into the release path", () => {
  for (const f of readdirSync(".github/workflows").filter((f) => f.endsWith(".yml"))) {
    assert.doesNotMatch(
      code(wf(f)),
      /npm install -g npm@/,
      `${f}: an unpinned global npm upgrade is what broke v0.3.0 — assert the floor instead`,
    );
  }
  // And the floor is still checked, by delegating to the lane that owns it.
  assert.match(
    jobBlocks(code(wf(NPM_ENTRY))).npm,
    new RegExp(`uses: bounded-systems/mint/\\.github/workflows/${MINT_LANE.replace(".", "\\.")}@[0-9a-f]{40}`),
    "the npm publish must go through mint's lane, which owns the npm >= 11.5.1 floor",
  );
});

// A partial release has to be recoverable by re-running this workflow. JSR
// refuses a duplicate version and its versions are IMMUTABLE, so on a recovery
// run an already-published JSR must SKIP, not fail the job — v0.3.0 reached JSR
// while npm was failing, and re-attempting it would report failure for the one
// registry that had succeeded. (npm's half of this now lives in mint's lane.)
test("the JSR publish skips a version that already landed", () => {
  const block = jobBlocks(code(wf(NPM_ENTRY))).jsr;
  assert.ok(block, `${NPM_ENTRY} is missing the jsr job`);
  assert.match(block, /id: onjsr/, "jsr needs an idempotence check before publishing");
  assert.match(
    block,
    /if: steps\.onjsr\.outputs\.skip != 'true'/,
    "the jsr publish step must be gated on that check, or a recovery run reports " +
      "failure for a registry that already succeeded",
  );
});

// The npm-side configuration is uniform org-wide only if this repo actually
// passes the environment mint's lane defaults to — it is the `environment` claim
// in the OIDC token, and therefore what npm's trusted-publisher Environment field
// pins. A job with `uses:` cannot carry `environment:`, so it can only arrive as
// this input.
test("the npm lane is passed the npm-publish environment", () => {
  assert.match(
    jobBlocks(code(wf(NPM_ENTRY))).npm,
    /environment: npm-publish/,
    "npm's trusted-publisher Environment field pins this claim; without it the pin cannot be set",
  );
});
