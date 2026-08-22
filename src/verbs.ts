/**
 * The site's read-only verbs, authored once as `@bounded-systems/verbspec`
 * VerbSpecs (via the core's {@link verifiedVerb} helper). Each one resolves its
 * input to a manifest-relative artifact path; the core fetches + verifies it and
 * projects the verb to an MCP tool. There is no per-tool handler boilerplate and
 * no drift between the verb and its MCP surface.
 *
 * ── THE TOOL LIST IS ITSELF A FOLD ───────────────────────────────────────────
 *
 * A client loads every tool's name, description and input schema into its
 * context BEFORE any call is made. That cost is paid on every session whether or
 * not a tool is used, and choosing among the tools is itself a fan-out. So the
 * tool list is F, a call is one application of the generator rule u, and a
 * response that terminates is p(e).
 *
 * Which makes a verb per drill-down the wrong shape: it grows the part paid
 * always in order to shrink the part paid sometimes. `get_conformance_index` +
 * `get_conformance_area` + `get_corpus_index` + `get_corpus_list` would take
 * this server from 3 tools to 8.
 *
 * The right shape is one verb per SUBJECT, where the parameter IS the generator
 * rule: no argument returns the index — the aggregate, the seed — and an
 * argument unfolds one branch of it. Four tools, and the drill-downs cost
 * nothing until someone asks for one.
 *
 * The site serves the folds these verbs read (site#254): conformance/index.json
 * is 3.2 KB against the full report's 19.7 KB, corpus/index.json 9.2 KB against
 * 71.7 KB. Both unfolded documents stay exactly where they were, and `full: true`
 * still returns them.
 */
import { z } from "zod";
import { verifiedVerb, type Registry } from "@bounded-systems/static-mcp";
import { postFile } from "./catalog.js";

/** The corpus lists that can be unfolded one at a time. */
export const CORPUS_LISTS = ["topics", "languages", "repos"] as const;

/** The robertdelanghe.dev verb registry → MCP tools. */
export const siteVerbs: Registry = {
  list_posts: verifiedVerb({
    id: "list_posts",
    summary:
      "List published blog posts (slug, title, summary, tags) from the signed posts feed.",
    input: z.object({}),
    resolve: (_input, deps) => deps.apiPath("posts.json"),
  }),

  get_post: verifiedVerb({
    id: "get_post",
    summary: "Fetch a single blog post by slug, verified against the signed manifest.",
    input: z.object({
      slug: z.string().min(1).describe("Post slug, e.g. agent-authored-code-drift"),
    }),
    // `slug` is a CLI positional (`site-mcp get_post <slug>`) and the MCP tool's
    // sole input — the same Zod field, both surfaces.
    positionals: ["slug"],
    resolve: ({ slug }, deps) => deps.apiPath(postFile(slug)),
  }),

  get_conformance: verifiedVerb({
    id: "get_conformance",
    summary:
      "The site's web-build conformance report. With no arguments returns the index — " +
      "totals plus one row per area — which is what most questions need. Pass `area` " +
      "for one area's criteria, or `full` for every criterion at once.",
    input: z.object({
      area: z.string().min(1).optional().describe(
        "One area, e.g. accessibility, semantic, integrity. Omit for the index.",
      ),
      full: z.boolean().optional().describe(
        "Return every criterion (19.7 KB) instead of the index (3.2 KB).",
      ),
    }),
    positionals: ["area"],
    resolve: ({ area, full }, deps) =>
      deps.apiPath(
        full ? "conformance.json" : area ? `conformance/areas/${area}.json` : "conformance/index.json",
      ),
  }),

  get_corpus: verifiedVerb({
    id: "get_corpus",
    summary:
      "The curated GitHub corpus. With no arguments returns the index — owner, stats, " +
      "highlights, and the top ranked topics and languages. Pass `list` for one full " +
      "ranked list, or `full` for the whole corpus.",
    input: z.object({
      list: z.enum(CORPUS_LISTS).optional().describe(
        "One full ranked list. Omit for the index.",
      ),
      full: z.boolean().optional().describe(
        "Return the whole corpus (71.7 KB) instead of the index (9.2 KB).",
      ),
    }),
    positionals: ["list"],
    resolve: ({ list, full }, deps) =>
      deps.apiPath(full ? "corpus.json" : list ? `corpus/${list}.json` : "corpus/index.json"),
  }),
};
