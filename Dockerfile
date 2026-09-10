FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

FROM node:24-alpine AS runtime
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=/data/app.db
ENV FILES_DIR=/data/files
ENV TMP_DIR=/data/tmp
RUN addgroup -S sharebin && adduser -S sharebin -G sharebin && mkdir -p /data/files /data/tmp && chown -R sharebin:sharebin /data /app
COPY --from=build --chown=sharebin:sharebin /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=sharebin:sharebin /app/node_modules ./node_modules
COPY --from=build --chown=sharebin:sharebin /app/dist ./dist
USER sharebin
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
