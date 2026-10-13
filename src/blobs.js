import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { sha256hex } from "./ids.js";

/**
 * Blob bytes (pattern from XCR store.js, simplified for artifacts).
 * - files: XAR_DATA_DIR/sha256/aa/<hex> (local only).
 * - s3: XAR_S3_BUCKET + XAR_S3_PREFIX + sha256/aa/<hex>.
 */
export function blobsFromEnv(env = process.env) {
  const raw = env.XAR_BLOB || "files";
  const mode = String(raw).toLowerCase();
  if (mode === "files" || mode === "fs") return filesBlobs(env.XAR_DATA_DIR || "./files");
  if (mode === "s3") return s3Blobs(env);
  throw new Error(`xar: unknown XAR_BLOB=${JSON.stringify(raw)} (use "files" or "s3")`);
}

function filesBlobs(root) {
  const pathFor = (hex) => join(root, "sha256", hex.slice(0, 2), hex);
  return {
    mode: "files",
    async put(bytes) {
      const hex = sha256hex(bytes);
      const p = pathFor(hex);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
      return { etag: hex, size: bytes.byteLength };
    },
    async get(hex) {
      try {
        const data = await readFile(pathFor(hex));
        return { bytes: new Uint8Array(data), size: data.byteLength };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
  };
}

function s3Blobs(env) {
  const bucket = env.XAR_S3_BUCKET;
  const prefix = env.XAR_S3_PREFIX || "artifacts/";
  const endpoint = env.XAR_S3_ENDPOINT || undefined;
  const region = env.XAR_S3_REGION || env.AWS_REGION || "us-east-1";
  if (!bucket) throw new Error("xar: s3 blob mode requires XAR_S3_BUCKET");
  const keyFor = (hex) => `${prefix}sha256/${hex.slice(0, 2)}/${hex}`;
  let clientPromise = null;
  async function client() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-s3").then(
        ({ S3Client }) =>
          new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) })
      );
    }
    return clientPromise;
  }
  return {
    mode: "s3",
    async put(bytes) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const db = await client();
      const hex = sha256hex(bytes);
      await db.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keyFor(hex),
          Body: bytes,
          ContentType: "application/octet-stream",
        })
      );
      return { etag: hex, size: bytes.byteLength };
    },
    async get(hex) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const db = await client();
      try {
        const out = await db.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(hex) }));
        const buf = new Uint8Array(await out.Body.transformToByteArray());
        return { bytes: buf, size: buf.byteLength };
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
  };
}
