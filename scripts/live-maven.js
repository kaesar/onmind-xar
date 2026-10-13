// Live Maven check (real network, NOT part of `bun run smoke`).
// Proves XAR is a working Maven Central mirror for release artifacts:
//   bun scripts/live-maven.js
// Creates `mavencentral` repo in a temp json/files store, fetches a known
// immutable junit 4.13.2 pom+jar (+sha1) twice (MISS then HIT), plus HEAD,
// and a 404 for a nonexistent path. Fails loudly on no network.
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

const POM = "junit/junit/4.13.2/junit-4.13.2.pom";
const JAR = "junit/junit/4.13.2/junit-4.13.2.jar";

const dir = await mkdtemp(join(tmpdir(), "xar-live-maven-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs }); // real fetch
const req = (path, init) => app.request(path, init);

try {
  // 1 create mirror repo
  {
    const r = await req("/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mavencentral", format: "maven", upstream: "https://repo1.maven.org/maven2" }),
    });
    check("POST mavencentral 201", r.status === 201, `status=${r.status} body=${await r.text()}`);
  }

  // 2 pom MISS then HIT, ETag stable, content-type xml
  let etag1 = "";
  {
    const r1 = await req(`/maven/mavencentral/${POM}`);
    const b1 = await r1.text();
    etag1 = r1.headers.get("etag") || "";
    check("pom MISS + xml + body", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.includes("junit"), `status=${r1.status} cache=${r1.headers.get("x-xar-cache")} ct=${r1.headers.get("content-type")}`);
    const r2 = await req(`/maven/mavencentral/${POM}`);
    const b2 = await r2.text();
    check("pom HIT + ETag stable", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && r2.headers.get("etag") === etag1 && b1 === b2, `etag1=${etag1} etag2=${r2.headers.get("etag")}`);
  }

  // 3 HEAD on cached pom: headers only, HIT
  {
    const h = await req(`/maven/mavencentral/${POM}`, { method: "HEAD" });
    const body = await h.text();
    check("HEAD pom HIT, empty body", h.status === 200 && body === "" && h.headers.get("x-xar-cache") === "HIT" && h.headers.get("etag") === etag1, `status=${h.status} len=${h.headers.get("content-length")}`);
  }

  // 4 jar MISS then HIT (binary roundtrip, size > 200KB for junit 4.13.2)
  {
    const r1 = await req(`/maven/mavencentral/${JAR}`);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    check("jar MISS + size", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.byteLength > 200_000, `status=${r1.status} size=${b1.byteLength} ct=${r1.headers.get("content-type")}`);
    const r2 = await req(`/maven/mavencentral/${JAR}`);
    const b2 = new Uint8Array(await r2.arrayBuffer());
    check("jar HIT + bytes identical", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && b2.byteLength === b1.byteLength, `size2=${b2.byteLength}`);
  }

  // 5 checksum file passthrough
  {
    const r = await req(`/maven/mavencentral/${POM}.sha1`);
    const b = (await r.text()).trim();
    check("pom.sha1 200 + hex", r.status === 200 && /^[0-9a-f]{40}$/.test(b), `body=${b.slice(0, 60)}`);
  }

  // 6 missing path 404
  {
    const r = await req("/maven/mavencentral/does/not-exist-zzz-123.pom");
    check("missing path 404", r.status === 404, `status=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live maven threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
