# syntax=docker/dockerfile:1

# ---- Stufe 1: bauen ---------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
# Werkzeuge für better-sqlite3, falls kein vorgebautes Binary passt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Stufe 2: ausführen -----------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATABASE_PATH=/data/treibhaus.db \
    MATRIX_STATE_FILE=/data/matrix-bot.json \
    BACKUP_DIR=/data/backup \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/server.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrationen laufen beim Start automatisch, danach Server, Matrix-Bot und Jobs
CMD ["node", "server.mjs"]
