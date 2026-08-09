# upgallery

Upgallery is a compact, multi-tenant image gallery and anonymous file uploader.
One deployment can serve many galleries on different domains and path roots.

The implementation is split deliberately:

- Convex stores gallery metadata, users, roles, folder privacy, counters,
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
It never targets a Convex cloud deployment. Existing local Google OAuth and
default-administrator settings are preserved when possible; a new setup uses
non-working OAuth placeholders until real credentials are configured below.

After that, `pnpm dev` starts `convex dev` alongside Vite and both storage
processes, so the local Convex backend, function deployment, code generation,
and file watching are part of the normal development command.

`devsetup` writes the selected deployment values to `.env.local`. To enable
Google sign-in, replace its placeholder client ID, keeping exactly one copy of
each browser variable:

```dotenv
CONVEX_DEPLOYMENT=local:<generated deployment selector>
VITE_CONVEX_URL=http://localhost:3210
VITE_CONVEX_SITE_URL=http://localhost:3211
VITE_GOOGLE_CLIENT_ID=<Google OAuth web client ID>
VITE_STORAGE_API_URL=
```

`VITE_CONVEX_URL` is the Convex client API. `VITE_CONVEX_SITE_URL` is the
separate HTTP Actions origin used for OAuth and storage coordination. It is
not the Vite URL. A browser request to the bare `http://localhost:3211` root
returns 404 by design because only explicit HTTP Action paths are registered.

`devsetup` also creates `.env.storage.local` from `.env.storage.example` and
generates its storage secret. Its resulting shape is:

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

`devsetup` applies `SITE_URL` and the generated storage secret to the local
Convex deployment automatically. To enable Google sign-in, replace the
server-side OAuth placeholders as well. Use the same Google client ID as
`VITE_GOOGLE_CLIENT_ID`; omitting the client secret makes the CLI prompt for
it so it does not enter shell history:

```bash
pnpm exec convex env set AUTH_GOOGLE_ID '<Google OAuth web client ID>'
pnpm exec convex env set AUTH_GOOGLE_SECRET
```

Optionally set the first administrator before that Google user opens `/admin`:

```bash
pnpm exec convex env set DEFAULT_ADMIN_EMAIL admin@example.com
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

- `/g/:slug` – development/fallback image-gallery route
- `/up/:slug` – development/fallback uploader route
- `/admin` – system and gallery administration
- host/path routes configured in the admin UI – production public routes

Shared gallery files are content-addressed below `public/shared`. User-backed
galleries mirror their real filesystem hierarchy below `public/users`; opening
a folder enqueues a durable background modification-time check and, when
changed, a recursive reconciliation. The header shows shared reactive progress
for the folder currently being scanned.
Uploader files are stored below `protected/uploaders` and can only be read
through an expiring, password-aware download ticket.
Generated assets are stored separately below `derivatives/gallery` and
`derivatives/up`; no thumbnail or preview is placed beside an original.
