import { Hono } from "hono";
import { cors } from "hono/cors";
import { storageFromEnv, validateRepoInput } from "./storage.js";
import { blobsFromEnv } from "./blobs.js";
import { mapUpstream, rewriteNpmTarballs, rewriteNugetUrls, rewritePypiHrefs, selfBaseUrl } from "./formats.js";
import { fetchUpstream } from "./upstream.js";
import { nowIso, sha256hex, ttlSec, parseN } from "./ids.js";

export function createApp(env = process.env, deps = null) {
  const app = new Hono();
  const repos = deps?.repos ?? storageFromEnv(env);
  const blobs = deps?.blobs ?? blobsFromEnv(env);
  const fetchFn = deps?.fetchFn ?? fetch;
  const API_KEY = env.XAR_API_KEY || "";

  const origins = (env.XAR_CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({ origin: origins.includes("*") ? "*" : origins }));
  app.use("*", apiKeyGuard(API_KEY));

  app.onError((err, c) => {
    console.error("[OnMind-XAR] unhandled:", err);
    return c.json({ message: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, env: env.XAR_ENV || "dev", storage: repos.mode, blob: blobs.mode }));

  // ---- Admin: repositories ----
  app.get("/repositories", async (c) => {
    const n = parseN(c.req.query("n"), 100);
    const last = c.req.query("last") || "";
    const { items, next } = await repos.listRepos(n, last);
    return c.json({ repositories: items, ...(next ? { last: next } : {}) });
  });

  app.post("/repositories", async (c) => {
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON" }, 400);
    }
    try {
      const input = validateRepoInput(body);
      const repo = await repos.putRepo(input);
      return c.json(repo, 201);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.get("/repositories/:name", async (c) => {
    const repo = await repos.getRepo(c.req.param("name"));
    if (!repo) return c.json({ message: "Repository not found" }, 404);
    return c.json(repo);
  });

  app.delete("/repositories/:name", async (c) => {
    const ok = await repos.deleteRepo(c.req.param("name"));
    if (!ok) return c.json({ message: "Repository not found" }, 404);
    return c.body(null, 204);
  });

  // ---- Proxy-cache per format (GET downloads, HEAD metadata — Maven Wagon uses both) ----
  for (const prefix of ["npm", "pypi", "maven", "nuget", "go"]) {
    app.on(["GET", "HEAD"], `/${prefix}/:repo/*`, (c) => handleProxy(c, prefix));
    app.on(["GET", "HEAD"], `/${prefix}/:repo`, (c) => handleProxy(c, prefix));
  }

  async function handleProxy(c, expectedFormat) {
    const repoName = c.req.param("repo") || "";
    const headOnly = c.req.method === "HEAD";
    // Wildcard remainder: Hono exposes it as index 0 param in some versions;
    // fall back to path slicing for portability.
    const full = c.req.path; // e.g. /maven/mavencentral/junit/junit/4.13.2/junit-4.13.2.pom
    const base = `/${expectedFormat}/${repoName}`;
    let subpath = full.startsWith(base) ? full.slice(base.length).replace(/^\/+/, "") : "";
    if (!subpath) {
      // NuGet clients may use the repo root as the v3 source; serve the index.
      if (expectedFormat === "nuget") subpath = "index.json";
      else return c.json({ message: "Specify artifact path" }, 404);
    }
    try {
      const repo = await repos.getRepo(repoName);
      if (!repo) return c.json({ message: "Repository not found" }, 404);
      if (repo.format !== expectedFormat) {
        return c.json({ message: `Repository is format ${repo.format}, not ${expectedFormat}` }, 400);
      }
      const { key, url, contentType } = mapUpstream(repo, subpath);
      const self = selfBaseUrl(c);
      const cached = await repos.getArtifact(key);
      if (cached?.etag) {
        const blob = await blobs.get(cached.etag);
        if (blob) {
          const out = maybeRewriteServe(repo, expectedFormat, self, cached.contentType || contentType, blob.bytes, url);
          if (headOnly) return serveHead(c, out.contentType, out.etag, out.bytes.byteLength, true);
          return serveBytes(c, out.bytes, out.contentType, out.etag, true);
        }
      }
      if (headOnly) {
        // HEAD miss: fill cache via GET so the next GET is HIT (Maven checks HEAD first).
        const up = await fetchUpstream(url, fetchFn, "GET");
        if (up.status === 404 || up.status === 410 || !up.bytes) return c.json({ message: "Not found upstream" }, 404);
        if (up.status !== 200) return c.json({ message: `Upstream error (${up.status})` }, 502);
        const stored = await storeArtifact(repo, repoName, key, subpath, url, up);
        const out = maybeRewriteServe(repo, expectedFormat, self, stored.contentType, up.bytes, url);
        return serveHead(c, out.contentType, out.etag, out.bytes.byteLength, false);
      }
      const up = await fetchUpstream(url, fetchFn, "GET");
      if (up.status === 404 || up.status === 410 || !up.bytes) return c.json({ message: "Not found upstream" }, 404);
      if (up.status !== 200) return c.json({ message: `Upstream error (${up.status})` }, 502);
      const stored = await storeArtifact(repo, repoName, key, subpath, url, up);
      const out = maybeRewriteServe(repo, expectedFormat, self, stored.contentType, up.bytes, url);
      return serveBytes(c, out.bytes, out.contentType, out.etag, false);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  }

  async function storeArtifact(repo, repoName, key, subpath, url, up) {
    const { etag, size } = await blobs.put(up.bytes);
    const entry = {
      key,
      repo: repoName,
      path: subpath,
      etag,
      size,
      contentType: up.contentType || "application/octet-stream",
      upstream: url,
      createdAt: nowIso(),
      expiresAt: ttlSec(repo.cacheTtl || 3600),
    };
    await repos.putArtifact(key, entry);
    return entry;
  }

  // Serve-time rewrites (cache keeps the original upstream bytes, so the same
  // cache works behind any hostname; ETag then reflects the served bytes):
  // - npm metadata JSON: dist.tarball → this instance
  // - pypi simple HTML: file hrefs → this instance (files/ reserved subpath)
  // - nuget v3 JSON: service-index/registration URLs → this instance
  // Anything else passes through untouched.
  function maybeRewriteServe(repo, format, self, contentType, bytes, upstreamUrl) {
    const isJson = String(contentType || "").includes("json");
    if (format === "npm" && isJson) {
      const r = rewriteNpmTarballs(repo, self, bytes);
      if (r.count) return { bytes: r.bytes, contentType, etag: sha256hex(r.bytes) };
    }
    if (format === "pypi" && String(contentType || "").includes("html")) {
      const r = rewritePypiHrefs(repo, self, upstreamUrl, bytes);
      if (r.count) return { bytes: r.bytes, contentType, etag: sha256hex(r.bytes) };
    }
    if (format === "nuget" && isJson) {
      const r = rewriteNugetUrls(repo, self, bytes);
      if (r.count) return { bytes: r.bytes, contentType, etag: sha256hex(r.bytes) };
    }
    return { bytes, contentType, etag: sha256hex(bytes) };
  }

  function serveHead(c, contentType, etag, size, hit) {
    c.header("Content-Type", contentType);
    c.header("Content-Length", String(size ?? 0));
    c.header("ETag", `"${etag}"`);
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-XAR-Cache", hit ? "HIT" : "MISS");
    return c.body(null, 200);
  }

  function serveBytes(c, bytes, contentType, etag, hit) {
    c.header("Content-Type", contentType);
    c.header("Content-Length", String(bytes.byteLength));
    c.header("ETag", `"${etag}"`);
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-XAR-Cache", hit ? "HIT" : "MISS");
    return c.body(bytes, 200);
  }

  app.notFound((c) => c.json({ message: "Not found" }, 404));
  return app;
}

function apiKeyGuard(apiKey) {
  return async (c, next) => {
    if (!apiKey) return next();
    if (c.req.path === "/health") return next();
    const got = c.req.header("x-api-key") || "";
    if (got !== apiKey) return c.json({ message: "Forbidden" }, 403);
    return next();
  };
}
