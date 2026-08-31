FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @meme/web --include-workspace-root=false \
  --registry=https://registry.npmjs.org/ --replace-registry-host=always \
  --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w @meme/web

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
