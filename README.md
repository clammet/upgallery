# upgallery

Upgallery is a compact, multi-tenant image gallery and anonymous file uploader.
One deployment can serve many galleries on different domains and path roots.

The implementation is split deliberately:

- Convex stores gallery metadata, users, roles, folder access policies, counters,
  upload intents, download tickets, and storage jobs.
- The Node storage API streams shared/protected files to hash-sharded mounts
  and stores every generated thumbnail and preview in a central derivative
  root. A separate process from the same image claims durable Convex jobs for
  user-backed reconciliation, media processing, deletion, and migration.
- Nginx serves the React application, image-gallery originals, and only the
  `derivatives/gallery` subtree directly. Protected uploader originals and the
  `derivatives/up` subtree are never mounted into an Nginx location.
- The `@clammet/convex-googly-auth` component supplies Google OIDC sessions and
  anonymous identities. Credentials and refresh tokens stay inside the
  component, while the app stores only opaque identity IDs on profiles.

No Tailwind is used. The CSS is organized into modules and controlled by
gallery-level CSS variables plus an owner-supplied scoped CSS override.

## Local development

Requirements: Node.js 24+, pnpm 11+, `ffmpeg` for video/BMP thumbnails, and a
libvips build with libheif support for HEIC/HEIF thumbnails and previews. On
macOS, Homebrew provides the required native libraries:

```bash
brew install vips libheif ffmpeg pkgconf
pnpm install
pnpm sharp:build-heic
pnpm sharp:check-heic
```

Run `pnpm sharp:build-heic` again after upgrading or reinstalling Sharp. The
build command sets `SHARP_FORCE_GLOBAL_LIBVIPS=1`, so the native Sharp addon
links to Homebrew's libvips rather than its bundled decoder. The check command
fails with an actionable message if `.heic` and `.heif` input support is not
available.

Create a blank local development environment with:

```bash
pnpm devsetup
```

`devsetup` installs packages, creates or selects a project-local Convex
deployment, writes the ignored `.env.local` and `.env.storage.local` files,
and deploys the backend. It clears the project-local Convex database and
`.storage`, so stop `pnpm dev` first and do not use it to preserve local data.
It never targets a Convex cloud deployment. When no Convex project details
exist, it creates an anonymous local deployment without requiring an account.
Existing local Google OAuth and default-administrator settings are preserved
when possible; a new setup uses non-working OAuth placeholders until real
credentials are configured below.

After that, `pnpm dev` starts `convex dev` alongside Vite and both storage
processes, so the local Convex backend, function deployment, code generation,
and file watching are part of the normal development command.

To exercise the production Docker images and filesystem boundaries instead,
stop `pnpm dev`, then run:

```bash
pnpm dev:docker
```

This builds the real `storage` and `web` Dockerfile targets, starts the storage
API and worker as the image's unprivileged user, and runs the same Nginx proxy
and read-only media mounts used by the standalone deployment. The project-local
Convex backend still runs on the host, using the values created by `devsetup`.
The app remains at the `SITE_URL` in `.env.local` (normally
`http://localhost:5173`). This image-based mode intentionally does not hot
reload; stop and rerun it to rebuild changed application code.

Press Ctrl+C once to stop it. The wrapper gracefully stops and removes its
three development containers before returning. If a terminal or package
manager is killed before cleanup completes, recover with:

```bash
pnpm dev:docker:stop
```

This only targets containers named `upgallery-dev-*`; it does not delete the
user mount, app-managed storage, Docker images, or the local Convex database.

The one example user-backed mount is `.user-storage/example`. It is separate
from app-managed `.storage`, so its files survive `devsetup` resets just like an
external user directory. In Admin, create an image gallery with **Storage** set
to **User mount** and **Internal storage path** set to `example`. Files added,
changed, or removed beneath `.user-storage/example` are then reconciled through
the Docker storage worker and served through the Docker Nginx container.

`devsetup` treats the ignored `.env.local` file as the source of truth for
local configuration. On every run it preserves these settings, applies the
server values to the local Convex deployment, and synchronizes the shared
storage secret to `.env.storage.local`. Vite only exposes `VITE_`-prefixed
values to browser code, so the unprefixed secrets remain server-only.

To enable Google sign-in, replace both OAuth placeholders:

```dotenv
CONVEX_DEPLOYMENT=<anonymous-or-local>:<generated deployment selector>
VITE_CONVEX_URL=http://localhost:3210
VITE_CONVEX_SITE_URL=http://localhost:3211
VITE_GOOGLE_CLIENT_ID=<Google OAuth web client ID>
VITE_STORAGE_API_URL=

AUTH_GOOGLE_SECRET=<Google OAuth client secret>
DEFAULT_ADMIN_EMAIL=admin@example.com
SITE_URL=http://localhost:5173
STORAGE_INTERNAL_SECRET=<generated by devsetup>
```

`VITE_GOOGLE_CLIENT_ID` is used by the browser and is also applied to Convex
as `AUTH_GOOGLE_ID`. `AUTH_GOOGLE_SECRET`, `DEFAULT_ADMIN_EMAIL`, and
`SITE_URL` are applied only to Convex. `STORAGE_INTERNAL_SECRET` is applied to
Convex and copied to `.env.storage.local` for the storage processes. Leave
`DEFAULT_ADMIN_EMAIL` blank if no initial administrator should be configured.

`VITE_CONVEX_URL` is the Convex client API. `VITE_CONVEX_SITE_URL` is the
separate HTTP Actions origin used for OAuth and storage coordination. It is
not the Vite URL. A browser request to the bare `http://localhost:3211` root
returns 404 by design because only explicit HTTP Action paths are registered.

`devsetup` also creates `.env.storage.local` from `.env.storage.example`,
generates its storage secret on first run, and preserves it thereafter. Its
resulting shape is:

```dotenv
PORT=8787
CONVEX_SITE_URL=http://localhost:3211
STORAGE_INTERNAL_SECRET=<a random value of at least 24 characters>
STORAGE_ROOT=.storage
STORAGE_POLL_INTERVAL_MS=1000
STORAGE_MEDIA_WORKER_CONCURRENCY=2
STORAGE_SYNC_WORKER_CONCURRENCY=2
MAX_ABSOLUTE_UPLOAD_BYTES=10737418240
```

After editing `.env.local`, rerun setup to apply its values to Convex:

```bash
pnpm devsetup
```

In Google Auth Platform, create a Web application OAuth client and register
this exact Authorized redirect URI:

```text
http://localhost:3211/auth/google/callback
```

Then start the local Convex development deployment, web server, storage API,
and storage worker:

```bash
pnpm dev
```

The web UI is at `http://localhost:5173`; the local storage API is proxied
automatically. The worker waits and retries when the local Convex HTTP Actions
service is temporarily unavailable.

Docker and Compose remain deployment-only concerns: they consume an externally
provisioned Convex deployment and do not create or manage Convex containers.

Production never shares the local selector or local data. Keep
`CONVEX_DEPLOYMENT` in `.env.local` for development, and use the separate
ignored `.env.convex.production.local` file (copied from
`.env.convex.production.example`) only with an explicit `--env-file`. See
[deployment and storage architecture](docs/deployment.md) for the production
target guard, secret ownership, and GitHub Actions setup.

Vite reads browser variables only at startup, so restart `pnpm dev` after
changing `.env.local`. The browser origin must also exactly match `SITE_URL`;
with the values above, open `http://localhost:5173`.

See [Google OAuth client setup](docs/google-oauth.md) for the complete flow and
[deployment and storage architecture](docs/deployment.md) for production.

## Validation

```bash
pnpm check
pnpm test
pnpm build
pnpm sharp:check-heic
```

## Main routes

- `/g/:slug` – development/fallback image-gallery route using the internal slug
- `/up/:slug` – development/fallback uploader route using the internal slug
- `/admin` – system and gallery administration
- domain/Public URL path routes configured in the admin UI – production public
  routes

The gallery creation form uses three distinct addressing fields:

- **Internal slug** (`slug` in code) is the globally unique application
  identifier used by the fallback routes above.
- **Internal storage path** (`storageRoot` in code) is the globally unique,
  relative path used to namespace that gallery inside its storage zone.
- **Public URL path** (`galleryHosts.rootPath` in code) is combined with the
  configured domain to form the gallery's public route.

For example, an internal slug and internal storage path of
`a7-family-photos`, with a public URL path of `/a7/family-photos`, can be
served publicly from `https://photos.example.com/a7/family-photos` while
remaining available through the fallback route `/g/a7-family-photos`.

Shared gallery files are content-addressed below `public/shared`. User-backed
galleries mirror their real filesystem hierarchy below `public/users`; opening
a folder enqueues a durable background modification-time check and, when
changed, a recursive reconciliation. The header shows shared reactive progress
for the folder currently being scanned. Direct item links in user-backed
galleries use the gallery's configured public host/path and preserve the real
folder and file names. The production edge must map that route to the gallery's
curated `public/users` root, serving regular files directly and falling back to
the SPA for directories and missing paths.
Uploader files are stored below `protected/uploaders` and can only be read
through an expiring, password-aware download ticket.
Generated assets are stored separately below `derivatives/gallery` and
`derivatives/up`; no thumbnail or preview is placed beside an original.
