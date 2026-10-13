const TIMEOUT_MS = 15000;

/**
 * Fetch upstream with timeout + single redirect.
 * method GET returns {status, bytes, contentType, contentLength}.
 * method HEAD returns headers only ({status, bytes:null, contentType, contentLength}).
 */
export async function fetchUpstream(url, fetchFn = fetch, method = "GET") {
  const m = String(method || "GET").toUpperCase();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res = await fetchFn(url, { method: m, signal: ctrl.signal, redirect: "manual" });
    // Follow one redirect manually (keeps behavior explicit on Lambda).
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, bytes: null, contentType: "", contentLength: 0 };
      res = await fetchFn(new URL(loc, url).toString(), { method: m === "HEAD" ? "HEAD" : "GET", signal: ctrl.signal });
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10) || 0;
    if (!res.ok) return { status: res.status, bytes: null, contentType, contentLength };
    if (m === "HEAD") return { status: 200, bytes: null, contentType: contentType.split(";")[0].trim(), contentLength };
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: 200, bytes: buf, contentType: contentType.split(";")[0].trim(), contentLength: buf.byteLength };
  } catch (e) {
    const err = new Error(`Upstream fetch failed: ${e.message || e}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
}
