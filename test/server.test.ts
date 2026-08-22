/**
 * The site's MCP server, end-to-end over an in-memory transport pair. Proves the
 * thin implementation still exposes the SAME tools + resources as before and that
 * the core's verified-response behavior (verification `_meta`, tamper rejection)
 * is intact — all offline, against a fake signed origin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, sha256Hex } from "@bounded-systems/static-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const enc = (s: string) => new TextEncoder().encode(s);

const config = resolveConfig({
  SITE_MCP_BASE_URL: "https://example.test",
  SITE_MCP_SIGNATURE_MODE: "off",
} as NodeJS.ProcessEnv);

function fakeFetch(files: Record<string, string>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    const body = files[url];
    if (body === undefined) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(enc(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function fixture(tamper = false) {
  const profile = '{"headline":"hello","label":"Engineer"}';
  const posts = '{"items":[{"slug":"hi","title":"Hi","summary":"s"}]}';
  const conformance = '{"pages":[]}';
  const conformanceIndex = '{"summary":{"met":1},"areas":[]}';
  const conformanceArea = '{"area":"accessibility","results":[]}';
  const corpus = '{"interests":{"topics":[]}}';
  const corpusIndex = '{"topics":{"count":0}}';
  const corpusTopics = '{"count":0,"items":[]}';
  const post = '{"slug":"hi","title":"Hi","body":"b"}';
  const at = (p: string) => `https://example.test/${p}`;
  const manifest =
    `${sha256Hex(enc(profile))}  api/v1/profile.json\n` +
    `${sha256Hex(enc(posts))}  api/v1/posts.json\n` +
    `${sha256Hex(enc(conformance))}  api/v1/conformance.json\n` +
    `${sha256Hex(enc(conformanceIndex))}  api/v1/conformance/index.json\n` +
    `${sha256Hex(enc(conformanceArea))}  api/v1/conformance/areas/accessibility.json\n` +
    `${sha256Hex(enc(corpus))}  api/v1/corpus.json\n` +
    `${sha256Hex(enc(corpusIndex))}  api/v1/corpus/index.json\n` +
    `${sha256Hex(enc(corpusTopics))}  api/v1/corpus/topics.json\n` +
    `${sha256Hex(enc(post))}  api/v1/posts/hi.json\n`;
  return {
    [at("site.sha256")]: manifest,
    [at("api/v1/profile.json")]: tamper ? '{"headline":"EVIL"}' : profile,
    [at("api/v1/posts.json")]: posts,
    [at("api/v1/conformance.json")]: conformance,
    [at("api/v1/conformance/index.json")]: conformanceIndex,
    [at("api/v1/conformance/areas/accessibility.json")]: conformanceArea,
    [at("api/v1/corpus.json")]: corpus,
    [at("api/v1/corpus/index.json")]: corpusIndex,
    [at("api/v1/corpus/topics.json")]: corpusTopics,
    [at("api/v1/posts/hi.json")]: post,
  } as Record<string, string>;
}

async function connect(files: Record<string, string>) {
  const server = buildServer(config, new ApiClient(config, fakeFetch(files)));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

test("exposes one tool per subject, not one per drill-down", async () => {
  const { client, server } = await connect(fixture());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_conformance", "get_corpus", "get_post", "list_posts"]);
  await server.close();
});

test("exposes the same static resources", async () => {
  const { client, server } = await connect(fixture());
  const uris = (await client.listResources()).resources.map((r) => r.uri);
  for (
    const u of [
      "site://profile",
      "site://posts",
      "site://corpus",
      "site://corpus/index",
      "site://conformance",
      "site://conformance/index",
      "site://resume-vc",
      "site://openapi",
    ]
  ) {
    assert.ok(uris.includes(u), `missing resource ${u}`);
  }
  await server.close();
});

test("get_post returns verified content + verification _meta", async () => {
  const { client, server } = await connect(fixture());
  const res: any = await client.callTool({ name: "get_post", arguments: { slug: "hi" } });
  assert.equal(JSON.parse(res.content[0].text).title, "Hi");
  assert.equal(res._meta.verification.matchedSignedManifest, true);
  assert.equal(res._meta.verification.path, "api/v1/posts/hi.json");
  await server.close();
});

test("get_conformance defaults to the index, and unfolds on request", async () => {
  const { client, server } = await connect(fixture());
  // No argument → the fold. This is the change: the default used to be the
  // whole report, which every caller paid for to read four numbers.
  const idx: any = await client.callTool({ name: "get_conformance", arguments: {} });
  assert.equal(idx._meta.verification.path, "api/v1/conformance/index.json");
  assert.equal(idx._meta.verification.matchedSignedManifest, true);
  // One step of u → one area.
  const area: any = await client.callTool({ name: "get_conformance", arguments: { area: "accessibility" } });
  assert.equal(area._meta.verification.path, "api/v1/conformance/areas/accessibility.json");
  // The unfolded document is still reachable, at its own path.
  const full: any = await client.callTool({ name: "get_conformance", arguments: { full: true } });
  assert.equal(full._meta.verification.path, "api/v1/conformance.json");
  await server.close();
});

test("get_corpus defaults to the index, and unfolds one list at a time", async () => {
  const { client, server } = await connect(fixture());
  const idx: any = await client.callTool({ name: "get_corpus", arguments: {} });
  assert.equal(idx._meta.verification.path, "api/v1/corpus/index.json");
  const topics: any = await client.callTool({ name: "get_corpus", arguments: { list: "topics" } });
  assert.equal(topics._meta.verification.path, "api/v1/corpus/topics.json");
  const full: any = await client.callTool({ name: "get_corpus", arguments: { full: true } });
  assert.equal(full._meta.verification.path, "api/v1/corpus.json");
  await server.close();
});

test("a tampered profile resource is rejected", async () => {
  const { client, server } = await connect(fixture(true));
  // readResource surfaces the verification failure as a protocol error (reject).
  await assert.rejects(
    () => client.readResource({ uri: "site://profile" }),
    /digest mismatch/,
  );
  await server.close();
});

test("the post template lists members from the signed feed", async () => {
  const { client, server } = await connect(fixture());
  const res = await client.listResources();
  // The templated `post` family resolves via list(); a concrete read is verified.
  const r: any = await client.readResource({ uri: "site://post/hi" });
  assert.equal(JSON.parse(r.contents[0].text).slug, "hi");
  assert.equal(r._meta.verification.matchedSignedManifest, true);
  assert.ok(res.resources.length >= 6);
  await server.close();
});
