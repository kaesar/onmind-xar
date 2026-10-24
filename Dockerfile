# OnMind-XAR container image. `onmind-xcr` is a `file:../xcr` dependency, so the
# build context must be the parent directory (which holds both xar/ and xcr/):
#   docker build -f xar/Dockerfile -t onmind-xar ..
#   docker run -p 8791:8791 -v /srv/xar:/data onmind-xar
FROM oven/bun:1.4 AS base
WORKDIR /app/xar
# Workspace layout: /app/xcr (dependency) + /app/xar (this project).
COPY xar/package.json ./
# `onmind-xcr: file:../xcr` is resolved from the build context parent.
RUN bun install --production
COPY xar/src ./src
ENV XAR_ENV=production PORT=8791 XAR_JSON_PATH=/data/xpacks.json XAR_DATA_DIR=/data/files XCR_DATA_DIR=/data/xcr
EXPOSE 8791
VOLUME ["/data"]
CMD ["bun", "src/dev.js"]
