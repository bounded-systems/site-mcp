/**
 * The site's resource catalog VALUES (mirrors openapi.json): one stable MCP
 * resource URI per api/v1 file, plus the templated post family. These are the
 * site-specific descriptors the generic core projects to MCP resources.
 */

/** The fixed api/v1 files exposed as `site://…` resources. */
export const STATIC_FILES: {
  uri: string;
  name: string;
  file: string;
  description: string;
}[] = [
  {
    uri: "site://profile",
    name: "profile",
    file: "profile.json",
    description: "Identity / copy tokens: headline, intro, label, links.",
  },
  {
    uri: "site://posts",
    name: "posts",
    file: "posts.json",
    description: "JSON Feed of writing (list of posts with slugs + summaries).",
  },
  {
    uri: "site://corpus",
    name: "corpus",
    file: "corpus.json",
    description: "Curated GitHub corpus, unfolded: stats, highlights, and every ranked topic (71.7 KB).",
  },
  // The folded entry points, alongside the unfolded documents rather than in
  // place of them. A resource row costs a URI, a name and a line of prose in
  // `resources/list` — an order of magnitude less than a tool descriptor — and
  // saves 6–8x on every read that only needed the aggregate.
  {
    uri: "site://corpus/index",
    name: "corpus-index",
    file: "corpus/index.json",
    description: "Corpus index: stats, highlights, and the top ranked topics and languages, with a link to each full list (9.2 KB).",
  },
  {
    uri: "site://conformance",
    name: "conformance",
    file: "conformance.json",
    description: "Web-build conformance report, unfolded: every criterion (19.7 KB).",
  },
  {
    uri: "site://conformance/index",
    name: "conformance-index",
    file: "conformance/index.json",
    description: "Conformance index: totals and one row per area, with a link to each area's criteria (3.2 KB).",
  },
  {
    uri: "site://resume-vc",
    name: "resume-vc",
    file: "resume.vc.json",
    description: "Résumé as a Verifiable Credential (JSON Resume schema).",
  },
  {
    uri: "site://openapi",
    name: "openapi",
    file: "openapi.json",
    description: "The OpenAPI 3.2 document describing this static API.",
  },
];

/** Template URI for individual posts: site://post/{slug} */
export const POST_URI_PREFIX = "site://post/";

/** api/v1 filename for a post slug. */
export function postFile(slug: string): string {
  return `posts/${slug}.json`;
}

/** Extract a slug from a site://post/<slug> URI, or undefined. */
export function slugFromPostUri(uri: string): string | undefined {
  if (!uri.startsWith(POST_URI_PREFIX)) return undefined;
  const slug = uri.slice(POST_URI_PREFIX.length);
  return slug.length ? slug : undefined;
}
