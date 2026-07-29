FROM node:24-alpine AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS web-build
ARG VITE_CONVEX_URL
ARG VITE_CONVEX_SITE_URL
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_STORAGE_API_URL=
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ENV VITE_CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_STORAGE_API_URL=$VITE_STORAGE_API_URL
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY src ./src
COPY convex ./convex
RUN pnpm exec vite build

FROM dependencies AS storage-build
COPY storage ./storage
RUN pnpm exec tsc -p storage/tsconfig.json

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM node:24-alpine AS storage
WORKDIR /app
RUN apk add --no-cache ffmpeg tini \
  && mkdir -p /data/media/.tmp \
  && chown -R node:node /data
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=storage-build /app/storage-dist ./storage-dist
USER node
EXPOSE 8787 8788
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "storage-dist/server.js"]
