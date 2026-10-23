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

## npm registry

Drop-in mirror (verified live, `bun run live:npm`, real network vs
`registry.npmjs.org`): metadata `MISS→HIT` with `dist.tarball` rewritten to
`/<repo>` so `npm install` downloads tarballs **through** XAR (cache stores
the original bytes; rewrite happens on serve, hostname-independent).
Tarball `sha512` matches `dist.integrity`, scoped packages (`@types/node`,
encoded `%2F`) rewritten, missing package 404. End-to-end CLI green:

```bash
npm view left-pad version --registry http://localhost:8791/npm/npmjs
npm install left-pad@1.3.0 --registry http://localhost:8791/npm/npmjs
```

## PyPI index

Drop-in mirror (verified live, `bun run live:pypi`, real network vs
`pypi.org`): index `MISS→HIT` with file hrefs rewritten to
`/pypi/<repo>/files/…` (reserved subpath served from
`files.pythonhosted.org`; `#sha256=` fragments preserved so pip verifies).
End-to-end CLI green (note `--trusted-host` for plain HTTP):

```bash
curl -s -X POST http://localhost:8791/repositories \
  -H 'Content-Type: application/json' \
  -d '{"name":"pypiproxy","format":"pypi","upstream":"https://pypi.org/simple"}'
pip download --no-deps --index-url http://localhost:8791/pypi/pypiproxy/ \
  --trusted-host localhost six==1.16.0 -d /tmp/xar-pip
```

## Go module proxy

```bash
curl -s -X POST http://localhost:8791/repositories \
  -H 'Content-Type: application/json' \
  -d '{"name":"goproxy","format":"go","upstream":"https://proxy.golang.org"}'
GOPROXY=http://localhost:8791/go/goproxy GOSUMDB=off go get rsc.io/quote@v1.5.2
```

Verified live (`bun run live:go`, real network vs `proxy.golang.org`):
`list`/`@latest`/`.info`/`.mod`/`.zip` MISS→HIT, escaped uppercase module
paths (`github.com/!burnt!sushi/toml`) pass through unchanged, missing
module 404; `go get` e2e green (transitive deps included). `GOSUMDB=off`
in the example avoids checksum-db egress; `/sumdb/…` paths are proxied
too if used.

## NuGet v3 feed

```bash
curl -s -X POST http://localhost:8791/repositories \
  -H 'Content-Type: application/json' \
  -d '{"name":"nugetorg","format":"nuget","upstream":"https://api.nuget.org/v3/index.json"}'
```

`NuGet.Config` in the project (HTTP sources need `allowInsecureConnections`
since NuGet 6.8):

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="xar" value="http://localhost:8791/nuget/nugetorg/index.json" allowInsecureConnections="true" />
  </packageSources>
</configuration>
```

```bash
dotnet add package Newtonsoft.Json --version 13.0.3
dotnet build
```

Verified live (`bun run live:nuget`): service index MISS→HIT with
`api.nuget.org` URLs rewritten to XAR, flat-container index, registration
index, `.nupkg` MISS→HIT byte-identical, `.nuspec` passthrough, missing
package 404; `dotnet add package` + `dotnet build` e2e green with a clean
`NUGET_PACKAGES` cache. Repository-signature endpoints stay HTTPS (NuGet
rejects HTTP signature URLs, NU1301); search endpoints hit nuget.org
directly and are not cached in v1.

## Maven mirror (`~/.m2/settings.xml`)

```xml
<settings>
  <mirrors>
    <mirror>
      <id>xar</id>
      <mirrorOf>central</mirrorOf>
      <url>http://localhost:8791/maven/mavencentral</url>
    </mirror>
  </mirrors>
</settings>
```

Create the repo first (`upstream` must be the Maven2 layout root):

```bash
curl -s -X POST http://localhost:8791/repositories \
  -H 'Content-Type: application/json' \
  -d '{"name":"mavencentral","format":"maven","upstream":"https://repo1.maven.org/maven2"}'
```

Verified live (`bun run live:maven`, real network vs Maven Central):
`junit:junit:4.13.2` pom+jar MISS→HIT with stable `ETag`, `HEAD` HIT with
empty body, `.sha1` passthrough, missing path 404. Plain `curl` flow above
is green; full `mvn dependency:get` pending a machine with Maven installed.

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/health` | `{ok, env, storage, blob}` — always open |
| `POST` | `/repositories` | `{name, format, upstream, cacheTtl?}` → `201`, dup `409` |
| `GET` | `/repositories?n=&last=` | list |
| `GET` | `/repositories/:name` | detail |
| `DELETE` | `/repositories/:name` | `204` |
| `GET` | `/npm/:repo/*`, `/pypi/:repo/*`, `/maven/:repo/*`, `/nuget/:repo/*`, `/go/:repo/*` | pull-through cache, `X-XAR-Cache: HIT\|MISS`, `ETag` |
| `HEAD` | same proxy paths | metadata only (empty body), fills cache on MISS — Maven Wagon uses it |

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
