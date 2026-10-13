import { createApp } from "./app.js";
import { storageFromEnv } from "./storage.js";
import { blobsFromEnv } from "./blobs.js";

const PORT = parseInt(process.env.PORT || "8791", 10);

const repos = storageFromEnv(process.env);
const blobs = blobsFromEnv(process.env);
const app = createApp(process.env, { repos, blobs });

// eslint-disable-next-line no-undef
Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[xar] http :${PORT} (GET /health)`);
console.log(`[xar] storage ${repos.mode} blob ${blobs.mode}`);
