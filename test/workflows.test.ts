// Fixture tests over the release workflows.
//
// Nothing here runs a workflow — these read the YAML as text and assert the
// couplings that are invisible until a release goes wrong. Both failures they
// cover are silent: the run goes green and the release is simply absent or
// wrong, which is the shape of defect a green check cannot report on itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const TAG_EXPR = "${{ inputs.tag || github.ref_name }}";

test("cut.yml chains publish and provenance, and hands both the cut tag", () => {
  const cut = wf("cut.yml");

  // The cut itself must call mint's reusable release-cut, not reimplement it.
  assert.match(
    cut,
    /uses:\s+bounded-systems\/mint\/\.github\/workflows\/release-cut\.yml@[0-9a-f]{40}/,
    "cut job must call mint's release-cut, pinned to a full commit SHA",
  );

  // Both downstream jobs exist, gate on a real cut, and receive the tag.
  const blocks = jobBlocks(cut);
  for (const job of ["publish", "provenance"]) {
    const block = blocks[job];
    assert.ok(block, `cut.yml is missing the ${job} job`);
    assert.match(block, /needs:\s+cut/, `${job} must depend on cut`);
    assert.match(
      block,
      /if:\s+needs\.cut\.outputs\.cut == 'true'/,
      `${job} must not run when the cut was a dry run`,
    );
    // The whole point. A tag pushed by GITHUB_TOKEN triggers nothing, so these
    // are chained — and a chained run's ref is a BRANCH. Drop this and the job
    // publishes main under a version tag's name.
    assert.match(
      block,
      /tag:\s+\$\{\{ needs\.cut\.outputs\.tag \}\}/,
      `${job} must be passed the tag release-cut just made`,
    );
  }
});

test("publish.yml is callable, and every checkout is pinned to the tag", () => {
  const publish = wf("publish.yml");

  assert.match(publish, /^\s{2}workflow_call:/m, "publish.yml must be callable");
  assert.match(
    publish,
    /workflow_call:[\s\S]*?inputs:[\s\S]*?tag:/,
    "publish.yml must accept a tag input",
  );

  // Every checkout — not most of them. An unpinned one silently builds, tests
  // or publishes the default branch in the chained path.
  const checkouts = publish
    .split(/uses: actions\/checkout@/)
    .slice(1)
    // Only the step's own lines: the next `- name:` starts a new step, and
    // anything after it belongs to a different checkout's assertion.
    .map((rest) => rest.split(/\n\s+- /)[0]);
  assert.ok(checkouts.length >= 4, `expected a checkout per job, found ${checkouts.length}`);
  for (const c of checkouts) {
    assert.ok(
      c.includes(`ref: ${TAG_EXPR}`),
      `every checkout must pin ref to \`${TAG_EXPR}\`; found:\n${c}`,
    );
  }

  // The version gate has to compare against the tag in scope, not the raw ref —
  // under workflow_call the ref is a branch name.
  assert.match(
    publish,
    /TAG:\s+\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/,
    "the verify job must resolve one TAG for both entry paths",
  );
});

test("every mint call site is pinned to the same mint commit", () => {
  const sites = ["cut.yml", "release.yml", "version.yml"].flatMap((name) =>
    [...wf(name).matchAll(/bounded-systems\/mint\/[^@]+@([0-9a-f]{40})/g)].map((m) => ({
      name,
      sha: m[1],
    })),
  );
  assert.ok(sites.length >= 4, `expected at least 4 mint call sites, found ${sites.length}`);
  const shas = new Set(sites.map((s) => s.sha));
  assert.equal(
    shas.size,
    1,
    `mint call sites disagree: ${sites.map((s) => `${s.name}=${s.sha.slice(0, 8)}`).join(", ")}`,
  );
});

test("each chained caller grants what the called workflow's permissions block asks for", () => {
  // GitHub validates a called reusable workflow's permission requests as the
  // UNION of its `permissions:` block, AT LOAD TIME — before any `if:`, and
  // regardless of which steps would run. Withholding one produces a
  // `startup_failure`: no job starts, so there is no job log to read and no
  // failing step to point at. The first dispatch of cut.yml did exactly that,
  // because release-provenance.yml asks for `actions: read` (for
  // `gh run download`) and the provenance job granted only two of the three.
  const blocks = jobBlocks(wf("cut.yml"));
  const required: Record<string, string[]> = {
    // release-cut.yml
    cut: ["contents: write"],
    // publish.yml, union over its four jobs
    publish: ["contents: read", "id-token: write"],
    // release-provenance.yml — all three, actions: read included
    provenance: ["contents: write", "id-token: write", "actions: read"],
  };
  for (const [job, perms] of Object.entries(required)) {
    const block = blocks[job];
    assert.ok(block, `cut.yml is missing the ${job} job`);
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

// --- the release path must not install an unreviewed npm, and must be re-runnable
//
// v0.3.0 shipped to JSR and the GitHub release, and never reached npm or the MCP
// Registry, because `npm install -g npm@latest` pulled an npm whose new default
// refuses remote-tarball dependencies:
//
//   npm error code EALLOWREMOTE
//   npm error Refusing to fetch "@bounded-systems/verbspec@https://npm.jsr.io/...tgz"
//
// The lockfile resolves the JSR npm-compat deps to exactly those URLs, so `npm ci`
// died before the publish step. Nothing was published — and nothing pinned the
// tool that broke it.
test("publish.yml does not globally install npm into the release path", () => {
  const publish = code(wf("publish.yml"));
  assert.doesNotMatch(
    publish,
    /npm install -g npm@/,
    "an unpinned global npm upgrade is what broke v0.3.0 — assert the floor instead",
  );
  assert.match(publish, /npm --version/, "the version floor must still be checked");
});

// A partial release has to be recoverable by re-dispatching this workflow. Both
// registries refuse a duplicate version — and JSR's are immutable — so on a
// recovery run an already-published registry must SKIP, not fail the job.
test("publish.yml skips a registry that already has this version", () => {
  const blocks = jobBlocks(wf("publish.yml"));
  for (const [job, guard] of [["npm", "onnpm"], ["jsr", "onjsr"]] as const) {
    const block = blocks[job];
    assert.ok(block, `publish.yml is missing the ${job} job`);
    assert.match(
      block,
      new RegExp(`id: ${guard}`),
      `${job} needs an idempotence check before publishing`,
    );
    assert.match(
      block,
      new RegExp(`if: steps\\.${guard}\\.outputs\\.skip != 'true'`),
      `${job}'s publish step must be gated on that check, or a recovery dispatch ` +
        `reports failure for a registry that already succeeded`,
    );
  }
});

// The standalone dispatch is the recovery door for a half-shipped release, and
// a dispatch runs on a BRANCH. Without a tag input every job checks out main and
// publishes whatever has landed there since, under the version tag's name — the
// same defect every checkout in this file is pinned against, arriving through
// the one trigger that was left without a way to say which tag it means.
test("publish.yml's workflow_dispatch can target a tag", () => {
  const publish = code(wf("publish.yml"));
  const dispatch = publish.slice(
    publish.indexOf("workflow_dispatch:"),
    publish.indexOf("workflow_call:"),
  );
  assert.match(dispatch, /inputs:/, "workflow_dispatch must accept inputs");
  assert.match(dispatch, /tag:/, "workflow_dispatch must accept a tag to publish");
});
