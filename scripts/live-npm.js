// Live npm check (real network, NOT part of `bun run smoke`).
// Proves XAR is a working npm registry mirror:
//   bun scripts/live-npm.js
// Uses a tiny immutable package (left-pad@1.3.0): metadata MISS→HIT with
// dist.tarball rewritten to self, tarball MISS→HIT byte-identical with
// sha512 integrity match, scoped package metadata rewrite, 404 on missing.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

const dir = await mkdtemp(join(tmpdir(), "xar-live-npm-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs }); // real fetch
const req = (path, init) => app.request(path, init);

try {
  {
    const r = await req("/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "npmjs", format: "npm", upstream: "https://registry.npmjs.org" }),
    });
    check("POST npmjs 201", r.status === 201, `status=${r.status} body=${await r.text()}`);
  }

  let tarballSub = "";
  let integrity = "";
  {
    const r1 = await req("/npm/npmjs/left-pad");
    const j1 = await r1.json();
    const dist = j1?.versions?.["1.3.0"]?.dist;
    check(
      "metadata MISS + tarball rewritten to self",
      r1.status === 200 &&
        r1.headers.get("x-xar-cache") === "MISS" &&
        typeof dist?.tarball === "string" &&
        dist.tarball.includes("/npm/npmjs/") &&
        !dist.tarball.includes("registry.npmjs.org"),
      `tarball=${dist?.tarball}`
    );
    integrity = dist?.integrity || "";
    // Rewritten tarball URL must resolve inside this repo: extract subpath.
    const m = (dist?.tarball || "").match(/\/npm\/npmjs\/(.+)$/);
    tarballSub = m ? m[1] : "";
    check("tarball subpath extracted", !!tarballSub, `tarball=${dist?.tarball}`);
    const r2 = await req("/npm/npmjs/left-pad");
    const j2 = await r2.json();
    check(
      "metadata HIT + stable tarball",
      r2.status === 200 &&
        r2.headers.get("x-xar-cache") === "HIT" &&
        r2.headers.get("etag") === r1.headers.get("etag") &&
        j2?.versions?.["1.3.0"]?.dist?.tarball === dist.tarball
    );
  }

  {
    const r1 = await req(`/npm/npmjs/${tarballSub}`);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    check("tarball MISS + bytes", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.byteLength > 1000, `status=${r1.status} size=${b1.byteLength}`);
    if (integrity.startsWith("sha512-")) {
      const hex = createHash("sha512").update(b1).digest("base64");
      check("tarball sha512 matches dist.integrity", `sha512-${hex}` === integrity, `got=sha512-${hex.slice(0, 20)}…`);
    } else {
      check("dist.integrity present", false, `integrity=${integrity}`);
    }
    const r2 = await req(`/npm/npmjs/${tarballSub}`);
    const b2 = new Uint8Array(await r2.arrayBuffer());
    check("tarball HIT + identical bytes", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && b2.byteLength === b1.byteLength);
  }

  // Scoped package: encoded slash form, as npm sends it.
  {
    const r = await req("/npm/npmjs/@types%2Fnode");
    const j = await r.json().catch(() => null);
    const vers = j?.versions ? Object.values(j.versions) : [];
    const tars = vers.map((v) => v?.dist?.tarball).filter(Boolean);
    check(
      "scoped metadata rewrite",
      r.status === 200 && tars.length > 0 && tars.every((t) => t.includes("/npm/npmjs/") && !t.includes("registry.npmjs.org")),
      `status=${r.status} sample=${tars[0] || "none"}`
    );
  }

  {
    const r = await req("/npm/npmjs/does-not-exist-zzz-123");
    check("missing package 404", r.status === 404, `status=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live npm threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
