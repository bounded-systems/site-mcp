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
