# OnMind-XAR — eXpress ARtifacts

Private artifact proxy-cache (MVP): `npm`, `PyPI`, `Maven`, `NuGet`, `Go`.
Same stack/philosophy as **XCR/XIN**: **Bun 1.4 + Hono 4** locally,
**Lambda Node 24** in cloud. Runs on **`:8791`**.

- Local: **xpacks.json** (metadata, zero deps, XAR schema) + `files/` blobs.
- Cloud: **DynamoDB** (`xrepos` + `xartifacts`, TTL `expiresAt`) + **S3** blobs.
- No PostgreSQL. No ORM. No container-image repos (use **XCR** for OCI).

> Honest warning: v1 is read-through cache only, single-writer on json,
> no background GC, no presigned direct upload, Lambda responses ~6 MB max.
> Suitable for labs/CI and low-risk registries.

## Quickstart

```bash
cp .env.example .env
bun install
bun run dev
curl -s http://localhost:8791/health
bun run smoke
```

Docker:

```bash
docker build -t onmind-xar . && docker run -p 8791:8791 -v /srv/xar:/data onmind-xar
```

## Repos + proxy

```bash
curl -s -X POST http://localhost:8791/repositories \
  -H 'Content-Type: application/json' \
  -d '{"name":"npmjs","format":"npm","upstream":"https://registry.npmjs.org"}'
curl -s http://localhost:8791/repositories
curl -s http://localhost:8791/npm/npmjs/express -o /tmp/express.json
curl -s -D - http://localhost:8791/npm/npmjs/express -o /dev/null # X-XAR-Cache: HIT
npm install express --registry http://localhost:8791/npm/npmjs
pip install --index-url http://localhost:8791/pypi/pypi-simple/ requests
export GOPROXY=http://localhost:8791/go/goproxy
```

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/health` | `{ok, env, storage, blob}` — always open |
| `POST` | `/repositories` | `{name, format, upstream, cacheTtl?}` → `201`, dup `409` |
| `GET` | `/repositories?n=&last=` | list |
| `GET` | `/repositories/:name` | detail |
| `DELETE` | `/repositories/:name` | `204` |
| `GET` | `/npm/:repo/*`, `/pypi/:repo/*`, `/maven/:repo/*`, `/nuget/:repo/*`, `/go/:repo/*` | pull-through cache, `X-XAR-Cache: HIT\|MISS`, `ETag` |

Auth: `x-api-key` header if `XAR_API_KEY` set (except `/health`).

## Configuration

See `.env.example`. Local defaults: `XAR_STORAGE=json`, `XAR_JSON_PATH=./xpacks.json`,
`XAR_BLOB=files`, `XAR_DATA_DIR=./files`. Cloud: `XAR_STORAGE=dynamodb` +
`XAR_TABLE_REPOS/XAR_TABLE_ARTIFACTS`, `XAR_BLOB=s3` + `XAR_S3_BUCKET`.

## Deploy

Lambda + DynamoDB + S3 + HTTP API via CDK. See `cdk/ARCHITECTURE.md`. Summary:

```bash
export XAR_API_KEY=$(openssl rand -hex 32)
cd cdk && npm install && npx cdk bootstrap
npx cdk deploy
```

## Tests

```bash
bun run smoke
```
