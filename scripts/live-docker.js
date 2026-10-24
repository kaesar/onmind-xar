// Live Docker/OCI check (NOT part of `bun run smoke`): proves XAR serves
// container images by delegating /v2/* to OnMind-XCR (`../xcr`) as a dependency.
//   bun scripts/live-docker.js
// Push a tiny image via the OCI API through XAR, pull it back, verify bytes,
// then the same with the real `docker` CLI (if installed): push, rm, pull.
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { storageFromEnv } from "../src/storage.js";
import { blobsFromEnv } from "../src/blobs.js";
import { dockerAppFromEnv } from "../src/docker.js";

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

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const gzipped = async (text) => new Uint8Array(gzipSync(new TextEncoder().encode(text)));

// Upload one config blob + one (fake) gzip layer and a manifest via the OCI API.
async function pushImage(req, name, tag, marker) {
  const config = enc({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] }, marker });
  const layer = await gzipped(`layer:${marker}`); // gzip-compressed layer payload
  const cfgDigest = sha256(config);
  const layDigest = sha256(layer);

  for (const [bytes, digest] of [
    [config, cfgDigest],
    [layer, layDigest],
  ]) {
    const r = await req(`/v2/${name}/blobs/uploads/?digest=${digest}`, { method: "POST", body: bytes });
    if (r.status !== 201) return { error: `blob upload ${digest} → ${r.status}` };
  }

  const manifest = enc({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: cfgDigest, size: config.byteLength },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layDigest, size: layer.byteLength }],
  });
  const r = await req(`/v2/${name}/manifests/${tag}`, {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
    body: manifest,
  });
  if (r.status !== 201) return { error: `manifest put → ${r.status}` };
  return { cfgDigest, layDigest, manifest, layer, config };
}

// ---- In-process OCI flow through the XAR app ----
const dir = await mkdtemp(join(tmpdir(), "xar-live-docker-"));
try {
  const repos = storageFromEnv({ XAR_STORAGE: "json", XAR_JSON_PATH: join(dir, "xpacks.json") });
  const blobs = blobsFromEnv({ XAR_BLOB: "files", XAR_DATA_DIR: join(dir, "files") });
  const docker = await dockerAppFromEnv({ ...process.env, XAR_DOCKER: "on", XCR_STORAGE: "filesystem", XCR_DATA_DIR: join(dir, "xcr") });
  check("XCR dependency loaded (src/docker.js)", !!docker && docker.mode === "filesystem", String(docker?.mode));

  const app = createApp({ XAR_ENV: "dev" }, { repos, blobs, docker });
  const req = (path, init) => app.request(path, init);

  {
    const r = await req("/v2/");
    check(
      "/v2/ version check",
      r.status === 200 && r.headers.get("docker-distribution-api-version") === "registry/2.0",
      `status=${r.status}`
    );
  }

  const pushed = await pushImage(req, "demo/hello", "v1", "abc");
  check("push image (blobs + manifest) 201", !pushed.error, pushed.error || "");

  {
    const r = await req("/v2/demo/hello/tags/list");
    const j = await r.json();
    check("tags list contains v1", r.status === 200 && (j.tags || []).includes("v1"), JSON.stringify(j));
  }

  {
    const r = await req("/v2/demo/hello/manifests/v1");
    const j = await r.json();
    check(
      "pull manifest by tag",
      r.status === 200 && j.schemaVersion === 2 && r.headers.get("docker-content-digest") === sha256(pushed.manifest),
      `status=${r.status} digest=${r.headers.get("docker-content-digest")}`
    );
  }

  {
    const r = await req(`/v2/demo/hello/blobs/${pushed.layDigest}`);
    const b = new Uint8Array(await r.arrayBuffer());
    check(
      "pull layer byte-identical",
      r.status === 200 && sha256(b) === pushed.layDigest && b.byteLength === pushed.layer.byteLength,
      `status=${r.status} size=${b.byteLength}`
    );
  }

  {
    const r = await req("/v2/_catalog");
    const j = await r.json();
    check("catalog contains demo/hello", r.status === 200 && (j.repositories || []).includes("demo/hello"), JSON.stringify(j));
  }

  {
    const r = await req("/v2/demo/missing/manifests/latest");
    check("missing image 404", r.status === 404, `status=${r.status}`);
  }

  // Auth: docker login (Basic password = XAR_API_KEY); unauthenticated /v2 → 401 + WWW-Authenticate.
  {
    const authed = createApp({ XAR_ENV: "dev", XAR_API_KEY: "s3cret" }, { repos, blobs, docker });
    const noAuth = await authed.request("/v2/");
    const basic = await authed.request("/v2/", {
      headers: { Authorization: `Basic ${btoa("docker:s3cret")}` },
    });
    check(
      "auth: 401 + WWW-Authenticate, then Basic login 200",
      noAuth.status === 401 && /^Basic /.test(noAuth.headers.get("www-authenticate") || "") && basic.status === 200,
      `noAuth=${noAuth.status} basic=${basic.status}`
    );
  }

  // ---- Real docker CLI on a live server (same app, stubbed to a port) ----
  const dockerBin = await hasDocker();
  if (!dockerBin) {
    console.log("skip - docker CLI e2e (docker not installed)");
  } else {
    const port = 8899;
    // eslint-disable-next-line no-undef
    const srv = Bun.serve({ port, fetch: app.fetch });
    try {
      const image = `localhost:${port}/cli/hello`;
      const p = await runPush(image);
      check("docker CLI push", p.code === 0, p.out.slice(-300));
      const d = await run(["docker", "rmi", image]);
      check("docker CLI rmi", d.code === 0, d.out.slice(-200));
      const pull = await run(["docker", "pull", image]);
      check("docker CLI pull", pull.code === 0, pull.out.slice(-300));
      const inspect = await run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]);
      check("docker CLI inspect pulled image", inspect.code === 0 && inspect.out.trim().startsWith("sha256:"), inspect.out.slice(-200));
    } finally {
      srv.stop(true);
    }
  }
} catch (e) {
  fail++;
  console.log(`FAIL - live docker threw ${e.message || e}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function hasDocker() {
  const r = await run(["docker", "version", "--format", "{{.Server.Version}}"]).catch(() => ({ code: 1 }));
  return r.code === 0;
}

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { ...opts, env: { ...process.env, ...(opts.env || {}) } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ code: 1, out: String(e.message) }));
  });
}

// Minimal image build: a Dockerfile + one file, pushed with `docker push`.
async function runPush(image) {
  const ctx = await mkdtemp(join(tmpdir(), "xar-docker-ctx-"));
  try {
    await Bun.write(join(ctx, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
    await Bun.write(join(ctx, "hello.txt"), "hello from xar\n");
    const build = await run(["docker", "buildx", "build", "--platform", "linux/arm64", "-t", image, "--push", ctx]);
    if (build.code === 0) return build;
    // Fallback: classic build + push (works on older builders).
    const b = await run(["docker", "build", "--platform", "linux/arm64", "-t", image, ctx]);
    if (b.code !== 0) return { code: b.code, out: build.out + b.out };
    return run(["docker", "push", image]);
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
