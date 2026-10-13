import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso, ttlSec, clampTtl } from "./ids.js";
import { FORMATS, defaultTtl } from "./formats.js";

const NAME_RE = /^[a-z0-9]+([._/-][a-z0-9]+)*$/;

/**
 * Repos + artifacts metadata (pattern from XIN src/storage.js).
 * - json: xpacks.json file {format:"xar/v1", repos:{}, artifacts:{}} (local only).
 *   NOTE: intentionally named xpacks.json (not xrepos.json) to avoid confusion
 *   with XCR's file when both projects are open in the same workspace.
 * - dynamodb: `xrepos` table (pk name S) + `xartifacts` table (pk key S,
 *   TTL attribute `expiresAt` N in epoch, full item serialized in `data` S).
 */
export function storageFromEnv(env = process.env) {
  const raw = env.XAR_STORAGE || (env.XAR_TABLE_REPOS ? "dynamodb" : "json");
  const mode = String(raw).toLowerCase();
  if (mode === "dynamodb") return dynamoStorage(env);
  if (mode === "json") return jsonStorage(env.XAR_JSON_PATH || "./xpacks.json");
  throw new Error(`xar: unknown XAR_STORAGE=${JSON.stringify(raw)} (use "json" or "dynamodb")`);
}

export function validateRepoInput(body) {
  const name = String(body?.name || "").trim();
  const format = String(body?.format || "").trim().toLowerCase();
  const upstream = String(body?.upstream || "").trim();
  if (!NAME_RE.test(name)) {
    const e = new Error("Invalid name (lowercase, [a-z0-9._/-])");
    e.status = 400;
    throw e;
  }
  if (!FORMATS.includes(format)) {
    const e = new Error(`Invalid format (one of ${FORMATS.join("|")})`);
    e.status = 400;
    throw e;
  }
  if (!/^https?:\/\/.+\..+/.test(upstream)) {
    const e = new Error("Invalid upstream (must be http(s):// URL)");
    e.status = 400;
    throw e;
  }
  const cacheTtl = body?.cacheTtl == null ? defaultTtl(format) : clampTtl(body.cacheTtl, defaultTtl(format));
  return { name, format, upstream: upstream.replace(/\/+$/, ""), cacheTtl };
}

function buildRepo(input) {
  return { ...input, createdAt: nowIso() };
}

// ---- JSON backend ----
function jsonStorage(path) {
  let chain = Promise.resolve();
  function atomic(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }
  async function readAll() {
    try {
      const raw = await readFile(path, "utf8");
      const doc = JSON.parse(raw);
      if (doc && typeof doc === "object" && doc.repos) return normalize(doc);
      return empty();
    } catch (e) {
      if (e.code === "ENOENT") return empty();
      throw e;
    }
  }
  async function writeAll(doc) {
    await mkdir(dirname(path) === "" ? "." : dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }
  function empty() {
    return { format: "xar/v1", repos: {}, artifacts: {} };
  }
  function normalize(doc) {
    return { format: "xar/v1", repos: doc.repos || {}, artifacts: doc.artifacts || {} };
  }
  return {
    mode: "json",
    async listRepos(n = 100, last = "") {
      const doc = await readAll();
      const names = Object.keys(doc.repos).sort();
      const start = last ? names.findIndex((x) => x > last) : 0;
      const from = start < 0 ? names.length : start;
      const slice = names.slice(from, from + n);
      const items = slice.map((k) => doc.repos[k]);
      const next = from + slice.length < names.length ? slice[slice.length - 1] : "";
      return { items, next };
    },
    async getRepo(name) {
      const doc = await readAll();
      return doc.repos[name] ?? null;
    },
    async putRepo(input) {
      return atomic(async () => {
        const doc = await readAll();
        if (doc.repos[input.name]) {
          const e = new Error(`Repository already exists: ${input.name}`);
          e.status = 409;
          throw e;
        }
        doc.repos[input.name] = buildRepo(input);
        await writeAll(doc);
        return doc.repos[input.name];
      });
    },
    async deleteRepo(name) {
      return atomic(async () => {
        const doc = await readAll();
        if (!doc.repos[name]) return false;
        delete doc.repos[name];
        for (const k of Object.keys(doc.artifacts)) {
          if (k.startsWith(`${name}:`)) delete doc.artifacts[k];
        }
        await writeAll(doc);
        return true;
      });
    },
    async getArtifact(key) {
      const doc = await readAll();
      const a = doc.artifacts[key] ?? null;
      if (!a) return null;
      if (a.expiresAt && a.expiresAt < Math.floor(Date.now() / 1000)) return null;
      return a;
    },
    async putArtifact(key, entry) {
      return atomic(async () => {
        const doc = await readAll();
        doc.artifacts[key] = entry;
        await writeAll(doc);
        return entry;
      });
    },
  };
}

// ---- DynamoDB backend (lazy import: stays out of the local path) ----
function dynamoStorage(env) {
  const reposTable = env.XAR_TABLE_REPOS;
  const artifactsTable = env.XAR_TABLE_ARTIFACTS;
  if (!reposTable || !artifactsTable) {
    throw new Error("xar: dynamodb mode requires XAR_TABLE_REPOS + XAR_TABLE_ARTIFACTS");
  }
  const endpoint = env.XAR_DYNAMO_ENDPOINT || undefined;
  const region = env.AWS_REGION || "us-east-1";
  let clientPromise = null;
  async function client() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-dynamodb").then(
        ({ DynamoDBClient }) => new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) })
      );
    }
    return clientPromise;
  }
  return {
    mode: "dynamodb",
    async listRepos(n = 100, last = "") {
      const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const out = await db.send(new ScanCommand({ TableName: reposTable, Limit: Math.min(Math.max(n, 1), 100) }));
      let items = (out.Items ?? []).map((it) => {
        try {
          return JSON.parse(it.data?.S ?? "{}");
        } catch {
          return null;
        }
      }).filter(Boolean);
      items.sort((a, b) => (a.name < b.name ? -1 : 1));
      if (last) items = items.filter((r) => r.name > last);
      const slice = items.slice(0, n);
      return { items: slice, next: items.length > n ? slice[slice.length - 1].name : "" };
    },
    async getRepo(name) {
      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const out = await db.send(new GetItemCommand({ TableName: reposTable, Key: { name: { S: name } } }));
      if (!out.Item?.data?.S) return null;
      try {
        return JSON.parse(out.Item.data.S);
      } catch {
        return null;
      }
    },
    async putRepo(input) {
      const { PutItemCommand, GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const exists = await db.send(new GetItemCommand({ TableName: reposTable, Key: { name: { S: input.name } } }));
      if (exists.Item) {
        const e = new Error(`Repository already exists: ${input.name}`);
        e.status = 409;
        throw e;
      }
      const repo = buildRepo(input);
      await db.send(
        new PutItemCommand({
          TableName: reposTable,
          Item: { name: { S: repo.name }, format: { S: repo.format }, data: { S: JSON.stringify(repo) } },
        })
      );
      return repo;
    },
    async deleteRepo(name) {
      const { DeleteItemCommand, GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const exists = await db.send(new GetItemCommand({ TableName: reposTable, Key: { name: { S: name } } }));
      if (!exists.Item) return false;
      await db.send(new DeleteItemCommand({ TableName: reposTable, Key: { name: { S: name } } }));
      return true;
    },
    async getArtifact(key) {
      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      const out = await db.send(new GetItemCommand({ TableName: artifactsTable, Key: { key: { S: key } } }));
      if (!out.Item?.data?.S) return null;
      try {
        const a = JSON.parse(out.Item.data.S);
        if (a.expiresAt && a.expiresAt < Math.floor(Date.now() / 1000)) return null;
        return a;
      } catch {
        return null;
      }
    },
    async putArtifact(key, entry) {
      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const db = await client();
      await db.send(
        new PutItemCommand({
          TableName: artifactsTable,
          Item: {
            key: { S: key },
            repo: { S: String(entry.repo || "") },
            expiresAt: { N: String(entry.expiresAt || ttlSec(3600)) },
            data: { S: JSON.stringify(entry) },
          },
        })
      );
      return entry;
    },
  };
}
