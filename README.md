# upgallery

Upgallery is a compact, multi-tenant image gallery and anonymous file uploader.
One deployment can serve many galleries on different domains and path roots.

The implementation is split deliberately:

- Convex stores gallery metadata, users, roles, folder privacy, counters,
  upload intents, download tickets, and storage jobs.
- The Node storage API streams shared/protected files to hash-sharded mounts
  and serves protected uploader downloads. A separate process from the same
  image claims durable Convex jobs for user-backed reconciliation,
  image/video thumbnails, bounded EXIF extraction, deletion, and migration.
- Nginx serves the React application and image-gallery originals directly from
  the public mounts. Protected uploader storage is never mounted into an Nginx
  location.
- Google OIDC supplies authenticated sessions without a separate auth library.
  Refresh tokens stay server-side in Convex, while a browser claim cookie
  safely carries anonymous upload ownership into the Google account after
  login.

No Tailwind is used. The CSS is organized into modules and controlled by
gallery-level CSS variables plus an owner-supplied scoped CSS override.

## Local development

Requirements: Node.js 24+, pnpm 11+, and `ffmpeg` if video thumbnails are
required locally.

Provision or select a Convex deployment first. Upgallery's development and
Compose commands expect it to exist; they do not start or manage a Convex
instance. Configure the Convex CLI for that deployment, then install packages:

```bash
pnpm install
```

Put the selected deployment values in `.env.local`, with exactly one copy of
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

Create the ignored `.env.storage.local` file from `.env.storage.example`:

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

Set the server-only values on the selected local Convex deployment. Use the
same Google client ID as `VITE_GOOGLE_CLIENT_ID`, and paste the same storage
secret used in `.env.storage.local`. Omitting a secret value makes the CLI
prompt for it so it does not enter shell history:

```bash
pnpm exec convex env set AUTH_GOOGLE_ID '<Google OAuth web client ID>'
pnpm exec convex env set AUTH_GOOGLE_SECRET
pnpm exec convex env set SITE_URL 'http://localhost:5173'
pnpm exec convex env set STORAGE_INTERNAL_SECRET
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

Then start the web, storage API, and storage worker:

```bash
pnpm dev
```

The web UI is at `http://localhost:5173`; the local storage API is proxied
automatically. The worker waits and retries when the configured Convex HTTP
Actions service is temporarily unavailable.

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
