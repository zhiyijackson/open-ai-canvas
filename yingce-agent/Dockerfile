# syntax=docker/dockerfile:1.7

ARG DOCKER_REGISTRY=docker.io
FROM ${DOCKER_REGISTRY}/library/node:22.19-alpine

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG ALPINE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine

RUN sed -i "s|https\?://dl-cdn[.]alpinelinux[.]org/alpine|${ALPINE_MIRROR%/}|g" /etc/apk/repositories \
    && apk add --no-cache ca-certificates wget \
    && addgroup -S app \
    && adduser -S app -G app

WORKDIR /app
COPY backend/agent-runtime/pi/package.json backend/agent-runtime/pi/package-lock.json /app/agent-runtime/
RUN --mount=type=cache,id=canvas-npm,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefix /app/agent-runtime --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY backend/agent-runtime/pi/agent-runtime.mjs /app/agent-runtime/agent-runtime.mjs
COPY yingce-agent/server.mjs /app/server.mjs

ENV NODE_ENV=production
USER app
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
