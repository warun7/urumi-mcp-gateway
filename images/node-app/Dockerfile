# One Dockerfile for the Node services (woo-mcp, gateway, agent, testkit); the provisioner has its own (it adds Helm).
#   docker build -f images/node-app/Dockerfile --build-arg APP=woo-mcp -t urumi/woo-mcp:dev .
# Build stage bundles the service into ONE file with esbuild; the runtime image has no node_modules.
# Build stage on the build machine's own architecture: its output (JS bundle / static files) runs anywhere,
# so cross-building for another server architecture emulates only the runtime layers.
FROM --platform=$BUILDPLATFORM node:24.18-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
# Dependency layer: only the lockfile, so it's cached until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps ./apps
ARG APP
RUN pnpm install --offline --frozen-lockfile --filter "@urumi/${APP}..." \
 && pnpm --filter "@urumi/${APP}" run build

FROM node:24.18-alpine
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/${APP}/dist/ ./
# Extra static files some apps ship next to the bundle (e.g. SQL migrations). Optional.
COPY --from=build /repo/apps/${APP}/assets* ./assets/
USER 1000:1000
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
