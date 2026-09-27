# syntax=docker/dockerfile:1.7
# Analytics Platform web frontend — multi-stage build producing a small, non-root Next.js standalone image.

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM node:${NODE_VERSION} AS build
WORKDIR /app
# NEXT_PUBLIC_* values are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
# Optional same-origin proxy (/api/* → backend), resolved at build time. Use with NEXT_PUBLIC_API_URL=/api.
ARG API_PROXY_TARGET=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    API_PROXY_TARGET=${API_PROXY_TARGET} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The node image ships an unprivileged "node" user (uid 1000).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "server.js"]
