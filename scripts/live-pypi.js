// Live PyPI check (real network, NOT part of `bun run smoke`).
// Proves XAR is a working PyPI mirror:
//   bun scripts/live-pypi.js
// Tiny immutable package (six): index MISS→HIT with hrefs rewritten to
// self (incl. #sha256 fragments), file MISS→HIT byte-identical through the
// files/ reserved subpath, 404 on missing.
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

const dir = await mkdtemp(join(tmpdir(), "xar-live-pypi-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs }); // real fetch
const req = (path, init) => app.request(path, init);

try {
  {
    const r = await req("/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "pypiproxy", format: "pypi", upstream: "https://pypi.org/simple" }),
    });
    check("POST pypiproxy 201", r.status === 201, `status=${r.status} body=${await r.text()}`);
  }

  let fileSub = "";
  {
    const r1 = await req("/pypi/pypiproxy/six/");
    const h1 = await r1.text();
    const hrefs = [...h1.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    const selfFiles = hrefs.filter((h) => h.includes("/pypi/pypiproxy/files/packages/"));
    check(
      "index MISS + file hrefs rewritten to self",
      r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && selfFiles.length > 0,
      `status=${r1.status} hrefs=${hrefs.length} selfFiles=${selfFiles.length} sample=${selfFiles[0] || hrefs[0] || "none"}`
    );
    check(
      "no bypass leaks (files.pythonhosted.org gone, sha256 fragments kept)",
      !h1.includes("files.pythonhosted.org") && h1.includes("#sha256="),
      h1.slice(0, 200)
    );
    const m = (selfFiles[0] || "").match(/\/pypi\/pypiproxy\/(files\/.+?)(#.*)?$/);
    fileSub = m ? m[1] : "";
    check("file subpath extracted", !!fileSub, `href=${selfFiles[0] || "none"}`);
    const r2 = await req("/pypi/pypiproxy/six/");
    check(
      "index HIT stable",
      r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && r2.headers.get("etag") === r1.headers.get("etag")
    );
  }

  {
    const r1 = await req(`/pypi/pypiproxy/${fileSub}`);
    const b1 = new Uint8Array(await r1.arrayBuffer());
    check("file MISS + bytes", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.byteLength > 1000, `status=${r1.status} size=${b1.byteLength} ct=${r1.headers.get("content-type")}`);
    const r2 = await req(`/pypi/pypiproxy/${fileSub}`);
    const b2 = new Uint8Array(await r2.arrayBuffer());
    check("file HIT + identical size", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && b2.byteLength === b1.byteLength, `size2=${b2.byteLength}`);
  }

  {
    const r = await req("/pypi/pypiproxy/does-not-exist-zzz-123/");
    check("missing package 404", r.status === 404, `status=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live pypi threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
