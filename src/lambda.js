import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { storageFromEnv } from "./storage.js";
import { blobsFromEnv } from "./blobs.js";
import { dockerAppFromEnv } from "./docker.js";

// AWS Lambda (Node.js 24): handler `src/lambda.handler`.
// Env: XAR_STORAGE=dynamodb, XAR_TABLE_REPOS=xrepos, XAR_TABLE_ARTIFACTS=xartifacts,
// XAR_BLOB=s3, XAR_S3_BUCKET (required), XAR_API_KEY (behind API Gateway), AWS_REGION.
// No local state on Lambda (json/files modes unsupported).
const repos = storageFromEnv(process.env);
const blobs = blobsFromEnv(process.env);
const docker = await dockerAppFromEnv(process.env); // XCR as a dependency (/v2/* via OCI routes)
const app = createApp(process.env, { repos, blobs, docker });
export const handler = handle(app);
