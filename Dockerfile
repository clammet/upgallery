ARG NODE_ALPINE_IMAGE=node:24-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_ALPINE_IMAGE} AS libvips-build
ARG VIPS_VERSION=8.18.4
ARG VIPS_SHA256=2677bad6c422617fd1172d359c16af34e736965d042c214203a87187d26ff037
RUN apk add --no-cache \
  build-base \
  cairo-dev \
  expat-dev \
  glib-dev \
  highway-dev \
  lcms2-dev \
  libarchive-dev \
  libexif-dev \
  libheif-dev \
  libjpeg-turbo-dev \
  libpng-dev \
  librsvg-dev \
  libwebp-dev \
  meson \
  ninja \
  pango-dev \
  pkgconf \
  tiff-dev \
  wget
RUN wget -q \
  "https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz" \
  -O /tmp/libvips.tar.xz \
  && echo "${VIPS_SHA256}  /tmp/libvips.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/libvips.tar.xz -C /tmp
RUN meson setup /tmp/libvips-build "/tmp/vips-${VIPS_VERSION}" \
  --prefix=/opt/vips \
  --libdir=lib \
  --buildtype=release \
  -Ddeprecated=false \
  -Dexamples=false \
  -Dcplusplus=true \
  -Dintrospection=disabled \
  -Dmodules=disabled \
  -Dheif=enabled \
  -Dheif-module=disabled \
  -Djpeg=enabled \
  -Dpng=enabled \
  -Dtiff=enabled \
  -Dwebp=enabled \
  -Drsvg=enabled \
  -Dlcms=enabled \
  -Dexif=enabled \
  -Darchive=enabled \
  -Dhighway=enabled \
  && meson compile -C /tmp/libvips-build \
  && meson install -C /tmp/libvips-build
RUN LD_LIBRARY_PATH=/opt/vips/lib /opt/vips/bin/vips --version \
  && LD_LIBRARY_PATH=/opt/vips/lib /opt/vips/bin/vips -l foreign \
    | grep -q VipsForeignLoadHeifFile

FROM libvips-build AS dependencies
WORKDIR /app
ENV LD_LIBRARY_PATH=/opt/vips/lib
ENV PKG_CONFIG_PATH=/opt/vips/lib/pkgconfig
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
  && pnpm --dir node_modules/sharp run build
COPY scripts/check-sharp-heic.mjs ./scripts/check-sharp-heic.mjs
RUN node scripts/check-sharp-heic.mjs

# Deployment-agnostic build: Convex and OAuth values are not baked in. The web
# stage renders /config.json from environment variables at container startup.
FROM dependencies AS web-build
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY src ./src
COPY convex ./convex
RUN pnpm exec vite build

FROM dependencies AS storage-build
COPY storage ./storage
RUN pnpm exec tsc -p storage/tsconfig.json

FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS web
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 deploy/render-config.sh /docker-entrypoint.d/40-render-config.sh
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80

# File-only artifact for deployments whose primary web server serves the site
# directly instead of running the nginx image above: the compiled SPA under
# /srv/www with no web server, entrypoint, or config.json. The deployment
# extracts the files (docker create + docker cp) and renders config.json next
# to them; keys must match src/config.ts. See docs/deployment.md.
FROM scratch AS web-dist
COPY --from=web-build /app/dist /srv/www

FROM ${NODE_ALPINE_IMAGE} AS storage-runtime
WORKDIR /app
RUN apk add --no-cache \
  cairo \
  expat \
  ffmpeg \
  glib \
  highway \
  lcms2 \
  libarchive \
  libexif \
  libheif \
  libheif-tools \
  libjpeg-turbo \
  libpng \
  librsvg \
  libwebp \
  libwebpdemux \
  pango \
  tiff \
  tini \
  && mkdir -p /data/media/.tmp \
  && chown -R node:node /data
ENV NODE_ENV=production
ENV LD_LIBRARY_PATH=/opt/vips/lib
ENV PATH=/opt/vips/bin:$PATH
COPY --from=libvips-build /opt/vips /opt/vips
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=dependencies /app/scripts/check-sharp-heic.mjs ./scripts/check-sharp-heic.mjs
COPY --from=storage-build /app/storage-dist ./storage-dist

FROM storage-runtime AS storage
RUN node scripts/check-sharp-heic.mjs --decode-smoke
USER node
EXPOSE 8787 8788
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "storage-dist/server.js"]
