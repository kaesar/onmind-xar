import { createHash } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

/** TTL epoch seconds: now + secs (clamped by callers). */
export function ttlSec(secs, nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + secs;
}

export function clampTtl(v, def = 3600, min = 60, max = 86400) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseN(v, def = 100) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, 1000);
}
