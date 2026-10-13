FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src ./src
ENV XAR_ENV=production PORT=8791 XAR_JSON_PATH=/data/xpacks.json XAR_DATA_DIR=/data/files
EXPOSE 8791
VOLUME ["/data"]
CMD ["bun", "src/dev.js"]
