import { Hono } from "hono";
import { cors } from "hono/cors";
import { storageFromEnv, validateRepoInput } from "./storage.js";
import { blobsFromEnv } from "./blobs.js";
import { mapUpstream } from "./formats.js";
import { fetchUpstream } from "./upstream.js";
import { nowIso, ttlSec, parseN } from "./ids.js";

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

  // ---- Proxy-cache per format ----
  for (const prefix of ["npm", "pypi", "maven", "nuget", "go"]) {
    app.get(`/${prefix}/:repo/*`, (c) => handleProxy(c, prefix));
    app.get(`/${prefix}/:repo`, (c) => handleProxy(c, prefix));
  }

  async function handleProxy(c, expectedFormat) {
    const repoName = c.req.param("repo") || "";
    // Wildcard remainder: Hono exposes it as index 0 param in some versions;
    // fall back to path slicing for portability.
    const full = c.req.path; // e.g. /npm/myrepo/express/1.0.0
    const base = `/${expectedFormat}/${repoName}`;
    const subpath = full.startsWith(base) ? full.slice(base.length).replace(/^\/+/, "") : "";
    try {
      const repo = await repos.getRepo(repoName);
      if (!repo) return c.json({ message: "Repository not found" }, 404);
      if (repo.format !== expectedFormat) {
        return c.json({ message: `Repository is format ${repo.format}, not ${expectedFormat}` }, 400);
      }
      const { key, url, contentType } = mapUpstream(repo, subpath);
      const cached = await repos.getArtifact(key);
      if (cached?.etag) {
        const blob = await blobs.get(cached.etag);
        if (blob) return serveBytes(c, blob.bytes, cached.contentType || contentType, cached.etag, true);
      }
      const up = await fetchUpstream(url, fetchFn);
      if (up.status === 404 || !up.bytes) return c.json({ message: "Not found upstream" }, 404);
      if (up.status !== 200) return c.json({ message: `Upstream error (${up.status})` }, 502);
      const { etag, size } = await blobs.put(up.bytes);
      const entry = {
        key,
        repo: repoName,
        path: subpath,
        etag,
        size,
        contentType: up.contentType || contentType,
        upstream: url,
        createdAt: nowIso(),
        expiresAt: ttlSec(repo.cacheTtl || 3600),
      };
      await repos.putArtifact(key, entry);
      return serveBytes(c, up.bytes, entry.contentType, etag, false);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
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
