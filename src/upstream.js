const TIMEOUT_MS = 15000;

/** GET upstream with timeout + single redirect. Returns {status, bytes, contentType}. */
export async function fetchUpstream(url, fetchFn = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res = await fetchFn(url, { signal: ctrl.signal, redirect: "manual" });
    // Follow one redirect manually (keeps behavior explicit on Lambda).
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, bytes: null, contentType: "" };
      res = await fetchFn(new URL(loc, url).toString(), { signal: ctrl.signal });
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    if (!res.ok) return { status: res.status, bytes: null, contentType };
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: 200, bytes: buf, contentType: contentType.split(";")[0].trim() };
  } catch (e) {
    const err = new Error(`Upstream fetch failed: ${e.message || e}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
}
