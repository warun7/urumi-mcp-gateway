# Dashboard: a static Vite build served by unprivileged nginx (UID 101, port 8080).
#   docker build -f images/dashboard/Dockerfile -t urumi/dashboard:dev .
# Build stage on the build machine's own architecture: its output (JS bundle / static files) runs anywhere,
# so cross-building for another server architecture emulates only the runtime layers.
FROM --platform=$BUILDPLATFORM node:24.18-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --offline --frozen-lockfile --filter "@urumi/dashboard..." \
 && pnpm --filter "@urumi/dashboard" run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY images/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
