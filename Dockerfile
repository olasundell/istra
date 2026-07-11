# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM dependencies AS build
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN pnpm build:app

FROM toolchain AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS runtime
ENV NODE_ENV=production \
    PORT=4317 \
    ISTRA_HOST=0.0.0.0 \
    ISTRA_LOG_LEVEL=info \
    ISTRA_DATA_DIR=/var/lib/istra \
    ISTRA_BACKUP_DIR=/var/backups/istra \
    ISTRA_STATIC_DIR=/app/dist-web
WORKDIR /app
RUN mkdir -p /var/lib/istra /var/backups/istra && chown -R node:node /var/lib/istra /var/backups/istra
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 4317
CMD ["node", "dist/server.js"]
