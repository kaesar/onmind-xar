# OnMind-XAR — Architecture (CDK)

`cdk/` deploys: Lambda (Hono) + DynamoDB (`xrepos`, `xartifacts` with TTL
on `expiresAt`) + S3 (blobs) + HTTP API Gateway v2.

Docker/OCI: the same Lambda mounts OnMind-XCR at `/v2/*` (dependency, see
`src/docker.js`). On Lambda that needs XCR's S3 backend, so set
`XAR_DOCKER=on`, `XCR_STORAGE=s3` and `XCR_S3_BUCKET` (the stack ships XCR
inside the asset; point `XCR_S3_PREFIX` to a separate prefix). With
`XAR_DOCKER=off` the function is packages-only and needs nothing extra.

```
clients (npm/pip/mvn/nuget/go)
  → HTTP API (ANY /{proxy+})
    → Lambda src/lambda.handler (XAR_STORAGE=dynamodb, XAR_BLOB=s3)
      → DynamoDB xrepos (pk name) + xartifacts (pk key=repo:path)
      → S3 xar-artifacts (artifacts/sha256/aa/<hex>)
      → upstream registries (fetch on MISS)
```

Auth in app (`XAR_API_KEY`, except `/health`). No usage plan on HTTP API v2.
