// Live Go check (real network, NOT part of `bun run smoke`).
// Proves XAR is a working GOPROXY mirror:
//   bun scripts/live-go.js
// Uses rsc.io/quote@v1.5.2 (small, immutable): list/@latest/.info/.mod/.zip
// MISS→HIT, escaped uppercase module paths (github.com/!burnt!sushi/toml)
// pass through unchanged, missing module 404.
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

const dir = await mkdtemp(join(tmpdir(), "xar-live-go-"));
const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
const app = createApp({ XAR_ENV: "dev" }, { repos, blobs }); // real fetch
const req = (path, init) => app.request(path, init);

try {
  {
    const r = await req("/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "goproxy", format: "go", upstream: "https://proxy.golang.org" }),
    });
    check("POST goproxy 201", r.status === 201, `status=${r.status} body=${await r.text()}`);
  }

  {
    const r1 = await req("/go/goproxy/rsc.io/quote/@v/list");
    const t1 = await r1.text();
    check(
      "list MISS + text/plain + v1.5.2",
      r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && t1.includes("v1.5.2") && (r1.headers.get("content-type") || "").includes("text/plain"),
      `status=${r1.status} ct=${r1.headers.get("content-type")} body=${t1.slice(0, 60)}`
    );
    const r2 = await req("/go/goproxy/rsc.io/quote/@v/list");
    const t2 = await r2.text();
    check("list HIT + identical", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && t2 === t1);
  }

  {
    const r = await req("/go/goproxy/rsc.io/quote/@latest");
    const j = await r.json();
    check("latest MISS + json", r.status === 200 && r.headers.get("x-xar-cache") === "MISS" && typeof j.Version === "string", JSON.stringify(j));
  }

  {
    const r = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.info");
    const j = await r.json();
    check("info MISS + Version", r.status === 200 && r.headers.get("x-xar-cache") === "MISS" && j.Version === "v1.5.2", JSON.stringify(j));
  }

  {
    const r1 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.mod");
    const m1 = await r1.text();
    check("mod MISS + module line", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && m1.startsWith("module") && m1.includes("rsc.io/quote"), m1.slice(0, 80));
    const r2 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.mod");
    check("mod HIT", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT");
  }

  {
    const r1 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.zip");
    const b1 = new Uint8Array(await r1.arrayBuffer());
    check("zip MISS + bytes", r1.status === 200 && r1.headers.get("x-xar-cache") === "MISS" && b1.byteLength > 1000, `status=${r1.status} size=${b1.byteLength}`);
    const r2 = await req("/go/goproxy/rsc.io/quote/@v/v1.5.2.zip");
    const b2 = new Uint8Array(await r2.arrayBuffer());
    check("zip HIT + identical size", r2.status === 200 && r2.headers.get("x-xar-cache") === "HIT" && b2.byteLength === b1.byteLength, `size2=${b2.byteLength}`);
  }

  {
    // Go clients escape uppercase as !lowercase; the proxy must pass it through.
    const r = await req("/go/goproxy/github.com/!burnt!sushi/toml/@v/list");
    const t = await r.text();
    check("escaped uppercase module path", r.status === 200 && t.includes("v"), `status=${r.status} body=${t.slice(0, 60)}`);
  }

  {
    const r = await req("/go/goproxy/example.com/does/not/exist/zzz/@v/list");
    check("missing module 404", r.status === 404, `status=${r.status}`);
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live go threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
