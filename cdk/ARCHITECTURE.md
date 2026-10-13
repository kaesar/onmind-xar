# OnMind-XAR — Architecture (CDK)

`cdk/` deploys: Lambda (Hono) + DynamoDB (`xrepos`, `xartifacts` with TTL
on `expiresAt`) + S3 (blobs) + HTTP API Gateway v2.

```
clients (npm/pip/mvn/nuget/go)
  → HTTP API (ANY /{proxy+})
    → Lambda src/lambda.handler (XAR_STORAGE=dynamodb, XAR_BLOB=s3)
      → DynamoDB xrepos (pk name) + xartifacts (pk key=repo:path)
      → S3 xar-artifacts (artifacts/sha256/aa/<hex>)
      → upstream registries (fetch on MISS)
```

Auth in app (`XAR_API_KEY`, except `/health`). No usage plan on HTTP API v2.
