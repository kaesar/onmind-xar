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
  if (String(url).includes("/-/")) {
    const body = `payload-for:${url}`;
    return new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  if (String(url).includes("/express-meta")) {
    const meta = {
      name: "express-meta",
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/express-meta/-/express-meta-1.0.0.tgz", shasum: "abc" } },
        "2.0.0": { dist: { tarball: "https://registry.npmjs.org/express-meta/-/express-meta-2.0.0.tgz", shasum: "def" } },
      },
    };
    return new Response(JSON.stringify(meta), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).startsWith("https://pypi.org/simple/six")) {
    const html = `<html><body>
<a href="https://files.pythonhosted.org/packages/aa/bb/six-1.16.0.tar.gz#sha256=abc">six-1.16.0.tar.gz</a>
<a href="sister/">sister</a>
</body></html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }
  if (String(url).startsWith("https://files.pythonhosted.org/")) {
    const body = `payload-for:${url}`;
    return new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  if (String(url).startsWith("https://proxy.golang.org/rsc.io/quote/@v/list")) {
    return new Response("v1.5.1\nv1.5.2\n", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (String(url).startsWith("https://proxy.golang.org/rsc.io/quote/@v/") && url.endsWith(".info")) {
    return new Response(JSON.stringify({ Version: "v1.5.2", Time: "2018-02-14T16:00:00Z" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (String(url).startsWith("https://proxy.golang.org/rsc.io/quote/@v/") && url.endsWith(".mod")) {
    return new Response("module rsc.io/quote\n\ngo 1.12\n", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (String(url).startsWith("https://proxy.golang.org/rsc.io/quote/@v/") && url.endsWith(".zip")) {
    return new Response(`zip-payload:${url}`, { status: 200, headers: { "Content-Type": "application/zip" } });
  }
  if (String(url) === "https://api.nuget.org/v3/index.json") {
    const index = {
      version: "3.0.0",
      resources: [
        { "@id": "https://api.nuget.org/v3-flatcontainer/", "@type": "PackageBaseAddress/3.0.0" },
        { "@id": "https://api.nuget.org/v3/registration5-gz-semver2/", "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": "https://api.nuget.org/v3-index/repository-signatures/5.0.0/index.json", "@type": "RepositorySignatures/5.0.0" },
        { "@id": "https://azuresearch-usnc.nuget.org/query", "@type": "SearchQueryService" },
      ],
    };
    return new Response(JSON.stringify(index), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).startsWith("https://api.nuget.org/v3-flatcontainer/")) {
    if (url.endsWith("/index.json")) {
      return new Response(JSON.stringify({ versions: ["13.0.3"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith(".nuspec")) {
      return new Response("<package><metadata><id>Newtonsoft.Json</id></metadata></package>", {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    return new Response(`nupkg-payload:${url}`, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
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

// 9b HEAD fills cache then HIT, empty path 404
{
  const h1 = await req("/npm/npmjs/head-pkg", { method: "HEAD" });
  const h1body = await h1.text();
  check(
    "HEAD miss fills cache (empty body + MISS + ETag)",
    h1.status === 200 && h1.headers.get("x-xar-cache") === "MISS" && h1body === "" && (h1.headers.get("etag") || "").length > 10,
    `${h1.status} ${h1.headers.get("x-xar-cache")}`
  );
  const h2 = await req("/npm/npmjs/head-pkg", { method: "HEAD" });
  check("HEAD hit", h2.status === 200 && h2.headers.get("x-xar-cache") === "HIT");
  const g = await req("/npm/npmjs/head-pkg");
  check("GET after HEAD is HIT", g.status === 200 && g.headers.get("x-xar-cache") === "HIT");
  const empty = await req("/npm/npmjs");
  check("proxy empty path 404", empty.status === 404);
}

// 9c npm dist.tarball rewrite (install must stay inside XAR, not bypass to upstream)
{
  const r1 = await req("/npm/npmjs/express-meta");
  const j1 = await r1.json();
  const tars1 = Object.values(j1.versions).map((v) => v.dist.tarball);
  check(
    "npm metadata MISS rewrites tarballs to self",
    r1.status === 200 &&
      r1.headers.get("x-xar-cache") === "MISS" &&
      tars1.length === 2 &&
      tars1.every((t) => t.includes("/npm/npmjs/express-meta/-/") && !t.includes("registry.npmjs.org")),
    JSON.stringify(tars1)
  );
  const etag1 = r1.headers.get("etag") || "";
  const r2 = await req("/npm/npmjs/express-meta");
  const j2 = await r2.json();
  const tars2 = Object.values(j2.versions).map((v) => v.dist.tarball);
  check(
    "npm metadata HIT keeps rewrite + stable ETag",
    r2.status === 200 &&
      r2.headers.get("x-xar-cache") === "HIT" &&
      r2.headers.get("etag") === etag1 &&
      JSON.stringify(tars2) === JSON.stringify(tars1),
    `etag1=${etag1} etag2=${r2.headers.get("etag")}`
  );
  // shasum/integrity untouched by the rewrite
  check("npm dist.shasum preserved", j2.versions["1.0.0"].dist.shasum === "abc");
  // tarball itself passes through byte-identical
  const t1 = await req("/npm/npmjs/express-meta/-/express-meta-1.0.0.tgz");
  const b1 = await t1.text();
  check("npm tarball MISS passthrough", t1.status === 200 && t1.headers.get("x-xar-cache") === "MISS" && b1.startsWith("payload-for:"));
  const t2 = await req("/npm/npmjs/express-meta/-/express-meta-1.0.0.tgz");
  check("npm tarball HIT", t2.status === 200 && t2.headers.get("x-xar-cache") === "HIT");
}

// 9d pypi simple index href rewrite (pip must stay inside XAR)
{
  const mk = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "pypiorg", format: "pypi", upstream: "https://pypi.org/simple" }),
  });
  check("POST pypi repo 201", mk.status === 201);
  const r1 = await req("/pypi/pypiorg/six/");
  const h1 = await r1.text();
  check(
    "pypi index MISS rewrites hrefs to self",
    r1.status === 200 &&
      r1.headers.get("x-xar-cache") === "MISS" &&
      h1.includes("/pypi/pypiorg/files/packages/aa/bb/six-1.16.0.tar.gz#sha256=abc") &&
      h1.includes("/pypi/pypiorg/six/sister/") &&
      !h1.includes("files.pythonhosted.org") &&
      !h1.includes("pypi.org"),
    h1.slice(0, 300)
  );
  const etag1 = r1.headers.get("etag") || "";
  const r2 = await req("/pypi/pypiorg/six/");
  check("pypi index HIT stable ETag", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && r2.headers.get("etag") === etag1);
  const f1 = await req("/pypi/pypiorg/files/packages/aa/bb/six-1.16.0.tar.gz");
  const fb1 = await f1.text();
  check("pypi file MISS passthrough", f1.status === 200 && f1.headers.get("x-xar-cache") === "MISS" && fb1.startsWith("payload-for:https://files.pythonhosted.org/"));
  const f2 = await req("/pypi/pypiorg/files/packages/aa/bb/six-1.16.0.tar.gz");
  check("pypi file HIT", f2.status === 200 && f2.headers.get("x-xar-cache") === "HIT");
}

// 9e go module proxy (GOPROXY protocol, escaped paths pass through)
{
  const mk = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "goproxy", format: "go", upstream: "https://proxy.golang.org" }),
  });
  check("POST go repo 201", mk.status === 201);
  const l1 = await req("/go/goproxy/rsc.io/quote/@v/list");
  const lt = await l1.text();
  check(
    "go list MISS + text/plain",
    l1.status === 200 && l1.headers.get("x-xar-cache") === "MISS" && lt.includes("v1.5.2") && (l1.headers.get("content-type") || "").includes("text/plain"),
    `status=${l1.status} ct=${l1.headers.get("content-type")}`
  );
  const l2 = await req("/go/goproxy/rsc.io/quote/@v/list");
  check("go list HIT", l2.status === 200 && l2.headers.get("x-xar-cache") === "HIT");
  const info = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.info");
  const ij = await info.json();
  check("go .info MISS + json", info.status === 200 && info.headers.get("x-xar-cache") === "MISS" && ij.Version === "v1.5.2", JSON.stringify(ij));
  const mod = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.mod");
  const mt = await mod.text();
  check("go .mod MISS + plain", mod.status === 200 && mt.startsWith("module rsc.io/quote") && (mod.headers.get("content-type") || "").includes("text/plain"));
  const z1 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.zip");
  const zb1 = await z1.text();
  check("go .zip MISS + zip type", z1.status === 200 && z1.headers.get("x-xar-cache") === "MISS" && zb1.startsWith("zip-payload:") && (z1.headers.get("content-type") || "").includes("application/zip"));
  const z2 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.zip");
  check("go .zip HIT", z2.status === 200 && z2.headers.get("x-xar-cache") === "HIT");
}

// 9f nuget v3 service index rewrite (dotnet restore must stay inside XAR)
{
  const mk = await req("/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "nugetorg", format: "nuget", upstream: "https://api.nuget.org/v3/index.json" }),
  });
  check("POST nuget repo 201", mk.status === 201);
  const s1 = await req("/nuget/nugetorg/index.json");
  const sj = await s1.json();
  const flat = sj.resources.find((r) => r["@type"] === "PackageBaseAddress/3.0.0")?.["@id"] || "";
  const search = sj.resources.find((r) => r["@type"] === "SearchQueryService")?.["@id"] || "";
  const sig = sj.resources.find((r) => String(r["@type"]).startsWith("RepositorySignatures"))?.["@id"] || "";
  check(
    "nuget service index MISS + origin rewritten",
    s1.status === 200 &&
      s1.headers.get("x-xar-cache") === "MISS" &&
      flat === "http://localhost/nuget/nugetorg/v3-flatcontainer/",
    `flat=${flat}`
  );
  check(
    "nuget repository-signatures stays HTTPS (NU1301)",
    sig === "https://api.nuget.org/v3-index/repository-signatures/5.0.0/index.json",
    sig
  );
  check("nuget search host untouched (not cached in v1)", search === "https://azuresearch-usnc.nuget.org/query", search);
  const root = await req("/nuget/nugetorg");
  const rootJ = await root.json();
  check("nuget repo root serves service index", root.status === 200 && Array.isArray(rootJ.resources));
  const etag1 = s1.headers.get("etag") || "";
  const s2 = await req("/nuget/nugetorg/index.json");
  check("nuget service index HIT stable ETag", s2.status === 200 && s2.headers.get("x-xar-cache") === "HIT" && s2.headers.get("etag") === etag1);
  const fi = await req("/nuget/nugetorg/v3-flatcontainer/newtonsoft.json/index.json");
  const fj = await fi.json();
  check("nuget flat index MISS + versions", fi.status === 200 && fi.headers.get("x-xar-cache") === "MISS" && fj.versions.includes("13.0.3"), JSON.stringify(fj));
  const p1 = await req("/nuget/nugetorg/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg");
  const pb1 = await p1.text();
  check("nuget nupkg MISS passthrough", p1.status === 200 && p1.headers.get("x-xar-cache") === "MISS" && pb1.startsWith("nupkg-payload:"));
  const p2 = await req("/nuget/nugetorg/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg");
  check("nuget nupkg HIT", p2.status === 200 && p2.headers.get("x-xar-cache") === "HIT");
  const ns = await req("/nuget/nugetorg/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.nuspec");
  const nst = await ns.text();
  check("nuget nuspec passthrough", ns.status === 200 && nst.includes("<package>"));
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

// 13 delete (runs before the docker block below: that app reuses this store)
{
  const r = await req("/repositories/npmjs", { method: "DELETE" });
  check("DELETE repo 204", r.status === 204);
  const g = await req("/repositories/npmjs");
  check("GET deleted 404", g.status === 404);
}

// 14 docker/OCI: XCR mounted as a dependency at /v2 (stub; live check is
// scripts/live-docker.js against the real ../xcr).
{
  const seen = [];
  const xcrStub = {
    mode: "stub",
    async fetch(request) {
      const p = new URL(request.url).pathname;
      seen.push(`${request.method} ${p}`);
      if (p === "/v2/") {
        return new Response(JSON.stringify({ ok: "xcr" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Docker-Distribution-Api-Version": "registry/2.0" },
        });
      }
      return new Response(JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }), { status: 404 });
    },
  };
  const app = createApp({ XAR_ENV: "dev" }, { repos, blobs, docker: xcrStub });
  const h = await app.request("/health");
  const hj = await h.json();
  check("health reports docker mode", hj.docker === "stub", JSON.stringify(hj));
  const v2 = await app.request("/v2/");
  check(
    "docker /v2/ delegated to XCR",
    v2.status === 200 && v2.headers.get("docker-distribution-api-version") === "registry/2.0",
    `status=${v2.status}`
  );

  // PUT goes through untouched (pushes are not limited to GET/HEAD).
  const put = await app.request("/v2/demo/hello/manifests/v1", {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
    body: "{}",
  });
  check("docker PUT reaches XCR", put.status === 404 && seen.includes("PUT /v2/demo/hello/manifests/v1"), seen.join(","));

  // Disabled: 404 with hint, no dependency loaded.
  const off = createApp({ XAR_ENV: "dev", XAR_DOCKER: "off" }, { repos, blobs, docker: null });
  const offV2 = await off.request("/v2/");
  const offJ = await offV2.json();
  check(
    "docker off → 404 hint",
    offV2.status === 404 && String(offJ.errors?.[0]?.message || "").includes("XAR_DOCKER=off"),
    JSON.stringify(offJ)
  );

  // Docker login: Basic password = XAR_API_KEY; unauthenticated /v2 → 401 + challenge.
  const authed = createApp({ XAR_ENV: "dev", XAR_API_KEY: "k" }, { repos, blobs, docker: xcrStub });
  const noAuth = await authed.request("/v2/");
  const basic = await authed.request("/v2/", { headers: { Authorization: `Basic ${btoa("docker:k")}` } });
  check(
    "docker auth 401 + Basic login",
    noAuth.status === 401 &&
      (noAuth.headers.get("www-authenticate") || "").startsWith("Basic ") &&
      basic.status === 200,
    `noAuth=${noAuth.status} basic=${basic.status}`
  );
  const wrong = await authed.request("/v2/", { headers: { Authorization: `Basic ${btoa("docker:nope")}` } });
  check("docker auth wrong password 401", wrong.status === 401, `status=${wrong.status}`);
}

await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
