# Build context is the REPO ROOT, so index.html can be copied in:
#   docker build -f server/Dockerfile -t tableplanner .
#
# Node 20 reached end of life in April 2026; 22 is the current LTS.
FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
# npm ci, not npm install: installs exactly the committed lockfile, so the
# image cannot drift from what was tested.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DIR=/app/public
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, so shutdown stays graceful.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/migrations ./migrations
COPY server/scripts ./scripts
COPY index.html ./public/index.html
COPY favicon.ico ./public/favicon.ico

# node:alpine ships an unprivileged `node` user; never run as root.
USER node

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
