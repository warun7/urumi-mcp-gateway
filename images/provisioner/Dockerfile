# The store provisioner: the Node controller, a pinned Helm CLI, and the store chart it installs.
# The chart ships IN the image, so a store's chart version moves with the provisioner's version.
#   docker build -f images/provisioner/Dockerfile -t urumi/provisioner:dev .
# Build stage on the build machine's own architecture: its output (JS bundle / static files) runs anywhere,
# so cross-building for another server architecture emulates only the runtime layers.
FROM --platform=$BUILDPLATFORM node:24.18-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --offline --frozen-lockfile --filter "@urumi/provisioner..." \
 && pnpm --filter "@urumi/provisioner" run build

# Helm, verified against checksums pinned here (not fetched alongside the download).
# Runs on the build machine too: it only downloads and verifies the TARGETARCH binary.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS helm
ARG HELM_VERSION=v4.3.0
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      arm64) SUM=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
      amd64) SUM=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac \
 && wget -qO /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && echo "${SUM}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp \
 && install -m 0755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm

FROM node:24.18-alpine
ENV NODE_ENV=production CHART_DIR=/app/charts/store HELM_BIN=/usr/local/bin/helm
WORKDIR /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=build /repo/apps/provisioner/dist/ ./
COPY charts/store ./charts/store
USER 1000:1000
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
