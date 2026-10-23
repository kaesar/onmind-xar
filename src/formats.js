export const FORMATS = ["npm", "pypi", "maven", "nuget", "go"];

export function defaultTtl(format) {
  // Immutable-ish ecosystems keep longer defaults.
  if (format === "maven" || format === "nuget") return 86400;
  return 3600;
}

/**
 * Map an incoming proxy path to an upstream URL + cache key.
 * Returns { key, url, contentType } or throws {status,message}.
 * key = "<repo>:<subpath>" (stable artifact identity for storage).
 */
export function mapUpstream(repo, subpath) {
  const base = repo.upstream.replace(/\/+$/, "");
  const sub = String(subpath || "").replace(/^\/+/, "");
  if (sub.includes("..")) fail(400, "Invalid path");
  const key = `${repo.name}:${sub || "/"}`;
  let url = `${base}/${sub}`;
  let contentType = "application/octet-stream";
  switch (repo.format) {
    case "npm":
      contentType = sub.endsWith(".tgz") ? "application/octet-stream" : "application/json";
      break;
    case "pypi":
      // files.pythonhosted.org is fetched through the reserved "files/packages/…"
      // subpath (see rewritePypiHrefs); anything else goes to the index upstream.
      if (sub.startsWith("files/packages/")) {
        url = `https://files.pythonhosted.org/${sub.slice("files/".length)}`;
        contentType = "application/octet-stream";
      } else {
        contentType = "text/html";
      }
      break;
    case "maven":
      if (sub.endsWith(".xml") || sub.endsWith(".pom")) contentType = "application/xml";
      else if (
        sub.endsWith(".sha1") ||
        sub.endsWith(".md5") ||
        sub.endsWith(".sha256") ||
        sub.endsWith(".sha512") ||
        sub.endsWith(".asc")
      )
        contentType = "text/plain";
      else if (sub.endsWith(".module")) contentType = "application/json";
      else contentType = "application/octet-stream";
      break;
    case "nuget": {
      // upstream is the v3 service index; index.json → upstream, other paths
      // (flat container, registration…) → same origin.
      const origin = new URL(repo.upstream).origin;
      if (!sub || sub === "index.json") {
        url = /\.json$/i.test(repo.upstream) ? repo.upstream : `${base}/index.json`;
        contentType = "application/json";
      } else {
        url = `${origin}/${sub}`;
        contentType = sub.endsWith(".json") ? "application/json" : "application/octet-stream";
      }
      break;
    }
    case "go":
      if (sub.endsWith("/@v/list") || sub === "@v/list") contentType = "text/plain";
      else if (sub.endsWith(".info") || sub.endsWith("@latest")) contentType = "application/json";
      else if (sub.endsWith(".mod")) contentType = "text/plain";
      else if (sub.endsWith(".zip")) contentType = "application/zip";
      else contentType = "application/octet-stream";
      break;
    default:
      fail(400, `Unsupported format: ${repo.format}`);
  }
  return { key, url, contentType };
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

/** External base of this XAR instance from request headers (proxy-aware). */
export function selfBaseUrl(c) {
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("host") || "localhost";
  return `${proto}://${host}`;
}

/**
 * Rewrite PyPI simple-index hrefs to point at this XAR repo so
 * `pip install --index-url <xar>/pypi/<repo>` downloads files through
 * the cache instead of bypassing it straight to files.pythonhosted.org.
 * - hrefs under the index upstream (e.g. /simple/<pkg>/) → self repo path
 * - hrefs to files.pythonhosted.org → self "files/…" reserved subpath
 *   (served by mapUpstream from files.pythonhosted.org; cache keeps origin bytes)
 * Fragments (#sha256=…) and query strings are preserved for pip verification.
 * Returns {bytes, count}.
 */
export function rewritePypiHrefs(repo, self, upstreamUrl, bodyBytes) {
  const selfRoot = `${String(self).replace(/\/+$/, "")}/pypi/${repo.name}/`;
  let text;
  try {
    text = new TextDecoder().decode(bodyBytes);
  } catch {
    return { bytes: bodyBytes, count: 0 };
  }
  if (!text.includes("href=")) return { bytes: bodyBytes, count: 0 };
  let count = 0;
  const out = text.replace(/href="([^"]*)"/g, (m, href) => {
    let abs;
    try {
      abs = new URL(href, upstreamUrl);
    } catch {
      return m;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return m;
    const upstream = repo.upstream.replace(/\/+$/, "");
    if ((abs.origin + abs.pathname).startsWith(upstream + "/") || abs.origin + abs.pathname === upstream) {
      const rel = (abs.origin + abs.pathname).slice(upstream.length).replace(/^\/+/, "");
      count++;
      return `href="${selfRoot}${rel}${abs.search}${abs.hash}"`;
    }
    if (abs.hostname === "files.pythonhosted.org") {
      count++;
      return `href="${selfRoot}files${abs.pathname}${abs.search}${abs.hash}"`;
    }
    return m;
  });
  if (!count) return { bytes: bodyBytes, count: 0 };
  return { bytes: new TextEncoder().encode(out), count };
}

/**
 * Rewrite NuGet v3 URLs (service index, registration) from the upstream origin
 * to this XAR repo, so `dotnet restore` downloads through the cache. Other hosts
 * are untouched; RepositorySignatures stays HTTPS (NuGet rejects HTTP, NU1301).
 * Cache keeps original bytes; rewrite happens on serve. Returns {bytes, count}.
 */
export function rewriteNugetUrls(repo, self, bodyBytes) {
  const origin = new URL(repo.upstream).origin;
  const selfRoot = `${String(self).replace(/\/+$/, "")}/nuget/${repo.name}/`;
  const skip = /\/repository-signatures\//i;
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { bytes: bodyBytes, count: 0 };
  }
  let count = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.startsWith(`${origin}/`) && !skip.test(v)) {
        count++;
        return selfRoot + v.slice(origin.length + 1);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) v[k] = walk(v[k]);
      return v;
    }
    return v;
  };
  const out = walk(doc);
  if (!count) return { bytes: bodyBytes, count: 0 };
  return { bytes: new TextEncoder().encode(JSON.stringify(out)), count };
}

/**
 * Rewrite npm `versions[].dist.tarball` to point at this XAR repo so
 * `npm install --registry <xar>/npm/<repo>` downloads tarballs through
 * the cache instead of bypassing it straight to the upstream.
 * Cache stays pristine (original bytes stored); rewrite happens on serve,
 * so the same cache works behind any hostname. Returns {bytes, count}.
 */
export function rewriteNpmTarballs(repo, self, bodyBytes) {
  const upstream = repo.upstream.replace(/\/+$/, "");
  const prefix = `${String(self).replace(/\/+$/, "")}/npm/${repo.name}/`;
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { bytes: bodyBytes, count: 0 };
  }
  const versions = doc?.versions;
  if (!versions || typeof versions !== "object") return { bytes: bodyBytes, count: 0 };
  let count = 0;
  for (const v of Object.values(versions)) {
    const dist = v?.dist;
    if (dist && typeof dist.tarball === "string" && dist.tarball.startsWith(upstream + "/")) {
      dist.tarball = prefix + dist.tarball.slice(upstream.length + 1);
      count++;
    }
  }
  if (!count) return { bytes: bodyBytes, count: 0 };
  return { bytes: new TextEncoder().encode(JSON.stringify(doc)), count };
}
