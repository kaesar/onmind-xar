import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { storageFromEnv } from "../src/storage.js";
import { blobsFromEnv } from "../src/blobs.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

const dir = await mkdtemp(join(tmpdir(), "xar-smoke-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });

// Stub upstream: deterministic bytes per URL (no network in smoke).
// Must mimic fetch Response (fetchUpstream expects .ok/.headers/.arrayBuffer).
const fetchFn = async (url) => {
  if (String(url).includes("/missing")) {
    return new Response("nope", { status: 404 });
  }
  const body = `payload-for:${url}`;
  return new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
};
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs, fetchFn });
const req = (path, init) => app.request(path, init);

// 1 health
{
  const r = await req("/health");
  const j = await r.json();
  check("health 200 + storage json blob files", r.status === 200 && j.ok && j.storage === "json" && j.blob === "files", JSON.stringify(j));
}

// 2 admin create npm repo
{
  const r = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "npmjs", format: "npm", upstream: "https://registry.npmjs.org" }),
  });
  const j = await r.json();
  check("POST /repositories npm 201", r.status === 201 && j.name === "npmjs", JSON.stringify(j));
}

// 3 duplicate 409
{
  const r = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "npmjs", format: "npm", upstream: "https://registry.npmjs.org" }),
  });
  check("POST duplicate 409", r.status === 409);
}

// 4 invalid format 400
{
  const r = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bad", format: "docker", upstream: "https://x.example" }),
  });
  check("POST invalid format 400 (no container repos, use xcr)", r.status === 400);
}

// 5 invalid upstream 400
{
  const r = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bad2", format: "npm", upstream: "not-a-url" }),
  });
  check("POST invalid upstream 400", r.status === 400);
}

// 6 list + get
{
  const r = await req("/repositories");
  const j = await r.json();
  check("GET /repositories contains npmjs", r.status === 200 && j.repositories?.some((x) => x.name === "npmjs"), JSON.stringify(j));
  const g = await req("/repositories/npmjs");
  check("GET /repositories/npmjs 200", g.status === 200);
}

// 7 proxy MISS then HIT
{
  const r1 = await req("/npm/npmjs/express");
  const b1 = await r1.text();
  check("proxy npm MISS", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.includes("payload-for:"), `${r1.status} ${r1.headers.get("x-xar-cache")}`);
  const r2 = await req("/npm/npmjs/express");
  check("proxy npm HIT + ETag", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && (r2.headers.get("etag") || "").length > 10);
}

// 8 upstream 404 -> 404
{
  const r = await req("/npm/npmjs/missing-pkg");
  check("proxy upstream missing 404", r.status === 404);
}

// 9 wrong format mount 400
{
  const r = await req("/pypi/npmjs/express");
  check("proxy wrong format 400", r.status === 400);
}

// 10 auth guard
{
  const app2 = createApp({ XAR_ENV: "dev", XAR_API_KEY: "k" }, { repos, blobs, fetchFn });
  const open = await app2.request("/health");
  check("auth /health open", open.status === 200);
  const denied = await app2.request("/repositories");
  check("auth without key 403", denied.status === 403);
  const allowed = await app2.request("/repositories", { headers: { "x-api-key": "k" } });
  check("auth with key 200", allowed.status === 200);
}

// 11 storage fail loud
{
  let threw = false;
  try {
    storageFromEnv({ XAR_STORAGE: "bogus" });
  } catch {
    threw = true;
  }
  check("unknown XAR_STORAGE throws", threw);
  let threw2 = false;
  try {
    blobsFromEnv({ XAR_BLOB: "bogus" });
  } catch {
    threw2 = true;
  }
  check("unknown XAR_BLOB throws", threw2);
  let threw3 = false;
  try {
    storageFromEnv({ XAR_STORAGE: "dynamodb" });
  } catch {
    threw3 = true;
  }
  check("dynamodb without tables throws", threw3);
}

// 12 json persistence roundtrip
{
  const repos2 = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
  const got = await repos2.getRepo("npmjs");
  check("json file persists repo", !!got && got.format === "npm");
}

// 13 delete
{
  const r = await req("/repositories/npmjs", { method: "DELETE" });
  check("DELETE repo 204", r.status === 204);
  const g = await req("/repositories/npmjs");
  check("GET deleted 404", g.status === 404);
}

await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
