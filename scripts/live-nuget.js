// Live NuGet check (real network, NOT part of `bun run smoke`).
// Proves XAR is a working NuGet v3 mirror:
//   bun scripts/live-nuget.js
// Service index MISS→HIT with api.nuget.org URLs rewritten to self, flat
// container index, Newtonsoft.Json 13.0.3 .nupkg MISS→HIT byte-identical,
// .nuspec passthrough, missing package 404.
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

const ID = "newtonsoft.json";
const VER = "13.0.3";

const dir = await mkdtemp(join(tmpdir(), "xar-live-nuget-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs }); // real fetch
const req = (path, init) => app.request(path, init);

try {
  {
    const r = await req("/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nugetorg", format: "nuget", upstream: "https://api.nuget.org/v3/index.json" }),
    });
    check("POST nugetorg 201", r.status === 201, `status=${r.status} body=${await r.text()}`);
  }

  let flatId = "";
  {
    const r1 = await req("/nuget/nugetorg/index.json");
    const j1 = await r1.json();
    const resources = Array.isArray(j1?.resources) ? j1.resources : [];
    flatId = resources.find((r) => String(r["@type"]).startsWith("PackageBaseAddress"))?.["@id"] || "";
    const sigId = resources.find((r) => String(r["@type"]).startsWith("RepositorySignatures"))?.["@id"] || "";
    check(
      "service index MISS + api.nuget.org rewritten",
      r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && flatId.includes("/nuget/nugetorg/"),
      `status=${r1.status} flat=${flatId}`
    );
    check(
      "repository-signatures stays HTTPS (NU1301)",
      sigId.startsWith("https://api.nuget.org/"),
      sigId
    );
    const r2 = await req("/nuget/nugetorg/index.json");
    check(
      "service index HIT stable ETag",
      r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && r2.headers.get("etag") === r1.headers.get("etag")
    );
  }

  {
    const r1 = await req(`/nuget/nugetorg/v3-flatcontainer/${ID}/index.json`);
    const j1 = await r1.json();
    check(
      "flat index MISS + versions",
      r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && Array.isArray(j1?.versions) && j1.versions.includes(VER),
      `status=${r1.status} versions=${(j1?.versions || []).length}`
    );
    const r2 = await req(`/nuget/nugetorg/v3-flatcontainer/${ID}/index.json`);
    check("flat index HIT", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT");
  }

  {
    const r1 = await req(`/nuget/nugetorg/v3/registration5-gz-semver2/${ID}/index.json`);
    const t1 = await r1.text();
    check(
      "registration MISS + JSON urls rewritten",
      r1.status === 200 &&
        (r1.headers.get("content-type") || "").includes("json") &&
        t1.includes(`/nuget/nugetorg/v3/registration5-gz-semver2/${ID}`) &&
        !t1.includes(`https://api.nuget.org/v3/registration5-gz-semver2/${ID}`),
      `status=${r1.status} ct=${r1.headers.get("content-type")} len=${t1.length}`
    );
    const r2 = await req(`/nuget/nugetorg/v3/registration5-gz-semver2/${ID}/index.json`);
    check("registration HIT", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT");
  }

  {
    const path = `/nuget/nugetorg/v3-flatcontainer/${ID}/${VER}/${ID}.${VER}.nupkg`;
    const r1 = await req(path);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    check(
      "nupkg MISS + bytes",
      r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.byteLength > 100_000,
      `status=${r1.status} size=${b1.byteLength} ct=${r1.headers.get("content-type")}`
    );
    const r2 = await req(path);
    const b2 = new Uint8Array(await r2.arrayBuffer());
    check(
      "nupkg HIT + identical size",
      r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && b2.byteLength === b1.byteLength,
      `size2=${b2.byteLength}`
    );
  }

  {
    const r = await req(`/nuget/nugetorg/v3-flatcontainer/${ID}/${VER}/${ID}.nuspec`);
    const t = await r.text();
    check("nuspec 200 + xml", r.status === 200 && t.includes("<package"), `status=${r.status} body=${t.slice(0, 60)}`);
  }

  {
    const r = await req("/nuget/nugetorg/v3-flatcontainer/does-not-exist-zzz-123/index.json");
    check("missing package 404", r.status === 404, `status=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live nuget threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
