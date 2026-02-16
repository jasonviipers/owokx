FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM nginx:1.27-alpine AS runtime
WORKDIR /usr/share/nginx/html

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

RUN addgroup -S owokx && adduser -S -D -H -G owokx owokx \
  && mkdir -p /var/cache/nginx /var/log/nginx /var/run /tmp/nginx \
  && chown -R owokx:owokx /usr/share/nginx/html /var/cache/nginx /var/log/nginx /var/run /tmp/nginx

USER owokx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["nginx", "-g", "pid /tmp/nginx/nginx.pid; daemon off;"]
