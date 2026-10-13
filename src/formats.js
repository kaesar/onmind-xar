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
      contentType = sub ? "application/octet-stream" : "text/html";
      break;
    case "maven":
      if (sub.endsWith(".xml") || sub.endsWith(".pom")) contentType = "application/xml";
      else if (sub.endsWith(".sha1") || sub.endsWith(".md5")) contentType = "text/plain";
      else contentType = "application/octet-stream";
      break;
    case "nuget":
      contentType = sub.endsWith(".json") ? "application/json" : "application/octet-stream";
      break;
    case "go":
      if (sub.endsWith(".info") || sub === "list" || sub === "@latest" || sub.endsWith("@latest"))
        contentType = "application/json";
      else if (sub.endsWith(".mod")) contentType = "text/plain";
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
