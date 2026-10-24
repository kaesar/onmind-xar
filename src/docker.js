/**
 * OnMind-XCR as a dependency: XAR does not reimplement OCI.
 *
 * When XCR is installed (node_modules/onmind-xcr) and enabled (`XAR_DOCKER`),
 * `GET|HEAD|PUT|... /v2/*` is served by XCR's own Hono app (Docker Registry V2
 * + ECR subset) mounted as a sub-app. XCR keeps its own storage choice
 * (`XCR_STORAGE` filesystem|s3, `XCR_DATA_DIR`, `XCR_S3_*`); auth stays XAR's
 * (x-api-key / Basic password = XAR_API_KEY).
 *
 * Disabled (XAR_DOCKER=off) or not installed → /v2/* answers 404 with a hint.
 * Any other install failure throws loudly (no silent half-registry).
 */
export const XCR_PKG = "onmind-xcr/src/app.js";

export function dockerEnabled(env = process.env) {
  const v = String(env.XAR_DOCKER ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

export async function dockerAppFromEnv(env = process.env) {
  if (!dockerEnabled(env)) return null;
  let createXcrApp;
  try {
    ({ createApp: createXcrApp } = await import(XCR_PKG));
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") {
      console.warn(`[xar] docker disabled: ${XCR_PKG} not installed (bun install) — set XAR_DOCKER=off to silence`);
      return null;
    }
    throw e;
  }
  const store = await createXcrStorage(env);
  const app = createXcrApp(env, store);
  app.mode = store.mode;
  return app;
}

// `onmind-xcr/src/store.js` is not exported (installed via `bun add file:../xcr`,
// which drops `bun exports`), so prefer the package entry and fall back to the
// top-level export or the package subpath.
async function createXcrStorage(env) {
  let storageFromEnv;
  try {
    ({ storageFromEnv } = await import("onmind-xcr"));
  } catch {
    ({ storageFromEnv } = await import("onmind-xcr/src/store.js"));
  }
  if (typeof storageFromEnv !== "function") {
    throw new Error("xar: onmind-xcr does not export storageFromEnv (unsupported XCR version)");
  }
  return storageFromEnv(env);
}

