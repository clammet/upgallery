# Deployment and storage architecture

This deployment keeps authorization and filesystem responsibilities separate.
Convex is authoritative for who may upload, view, edit, administer, or migrate.
The storage services receive short-lived capabilities or durable job leases
from Convex and are the only processes with write access to the file mounts.

## Filesystem layout

Inside the storage container, `STORAGE_ROOT=/data/media` has separate original
and derivative storage zones:

| Zone | Container path | Writer | Reader | URL behavior |
| --- | --- | --- | --- | --- |
| Shared image galleries | `/data/media/public/shared` | storage services | Nginx read-only mount | direct `/media/shared/...` |
| User-based image galleries | `/data/media/public/users` | storage services | Nginx read-only mount | direct `/media/users/...` |
| Uploader originals | `/data/media/protected/uploaders` | storage services | storage API only | expiring `/api/storage/files/...` ticket |
| Image-gallery derivatives | `/data/media/derivatives/gallery` | storage services | Nginx read-only mount | direct `/media/derivatives/gallery/...` |
| Uploader derivatives | `/data/media/derivatives/up` | storage services | storage API only | expiring `/api/storage/files/...` ticket |

Every gallery setting contains an **Internal storage path** (stored as
`storageRoot` in code) such as `customers/alice`. Shared galleries and
protected uploaders distribute originals below that path using the first four
hex characters of the SHA-256 digest. User-backed galleries preserve visible
directory names and original file names. All thumbnails and previews live in
the central derivative root, segmented first by `gallery` or `up`, and then by
storage kind and the gallery's Internal storage path:

```text
public/shared/family/9f/a2/9fa2…c1.jpg
public/users/alice/photos/2026/July/beach sunset.png
protected/uploaders/support/0c/44/0c44…aa.zip
derivatives/gallery/shared/family/thumbnails/9f/a2/9fa2…c1.thumb.jpg
derivatives/gallery/user/alice/photos/previews/31/7b/317b…20.preview.jpg
derivatives/up/support/thumbnails/0c/44/0c44…aa.thumb.jpg
```

The central derivative root contains generated, content-addressed thumbnails
and full-resolution compatibility previews. Its `gallery/shared`,
`gallery/user`, and `up` namespaces make each backing mode independently easy
to segment, snapshot, or inspect. User-backed originals remain ordinary files
with no application-generated directory beside them, so they can be managed
through SFTP, SCP, rsync, or the application. Deletion checks for other live
metadata references before unlinking shared bytes or derivatives.

Never mount `protected/uploaders` or `derivatives/up` into the Nginx container.
Uploader originals and derivatives must pass through the gateway so password
checks and view/download counters cannot be bypassed.

## User-based storage and SCP

The user-backed filesystem is authoritative for names, directories, additions,
edits, renames, and removals. Convex is a reactive metadata index over that
filesystem; it is not the source of the physical hierarchy.

When a user opens a folder, the browser immediately subscribes to the current
Convex listing and separately creates a durable background job through the
storage API. A storage worker claims that job with a renewable lease and:

1. Resolves the requested gallery and folder to a canonical path through
   Convex. Browser input is never used directly as a filesystem path.
2. Reads the directory modification time. If it matches the last successful
   check, the operation ends without reading the directory.
3. Otherwise, lists that directory, ignoring symlinks and in-progress
   application upload files, then walks its subdirectories.
4. Adds or updates child folders and files in small Convex mutations. New
   filesystem folders default to public privacy; an existing folder keeps its
   privacy and grants.
5. Compares each file's name, size, modification time, and filesystem identity
   with its indexed entry. Unchanged files are marked as seen without reading
   their contents. New or changed files are hashed and indexed, then a separate
   durable media job generates their thumbnail and EXIF metadata.
6. Removes metadata for files no longer present and retires missing folder
   subtrees in bounded background batches.
7. Records the directory modification time only after a consistent scan.

Each Convex mutation automatically updates active gallery subscriptions, so the
page fills in and changes while the check is running. A spinning refresh icon
is shown in the header to every viewer subscribed to a folder while that folder
is being scanned. Successful completion changes it to a tick for a moment.
Concurrent page loads for the same folder are coalesced by the durable job and
folder-level Convex leases. If a worker exits, the job and folder leases expire
and another worker can reclaim the work.

If the requested folder's modification time is unchanged, the entire update is
aborted early. Otherwise the worker traverses the subtree depth-first. Each
descendant gets the same modification-time and per-file checks. An unchanged
descendant does not need to list or hash its files, but the worker continues
through its already-known child folders so changes deeper in the tree can still
be discovered.

A normal SFTP upload that creates, renames, or removes a directory entry updates
the containing directory modification time and will be discovered during the
next non-aborted traversal. If an integration edits an existing file strictly
in place without changing its containing directory time, it should `touch` that
directory after the transfer so its fast check does not abort.

Application uploads to a user-backed gallery write the original file name
directly into the current directory. Folder creation and renaming are executed
against the mounted filesystem first and only then committed to Convex.

Direct Nginx reads and remote SFTP/SCP writes need a common filesystem view.
Pick one of these host-side arrangements, then expose the resulting directory
as the single `UPGALLERY_USER_ROOT` bind mount:

1. **Local home directories.** Bind a curated parent such as
   `/srv/upgallery-users`, then bind-mount approved user subdirectories into it.
   Do not mount `/home` wholesale.
2. **Remote homes mounted on the Docker host.** Mount each remote directory
   with NFS, SSHFS, or another reconnecting filesystem at
   `/srv/upgallery-users/<account>`. Docker receives that parent as a bind
   mount. For SSHFS, use `_netdev,reconnect,ServerAliveInterval=15` and ensure
   the Docker daemon can traverse the FUSE mount.
3. **SFTP/SCP/rsync staging.** Make
   `/srv/upgallery-users/<account>` the canonical local mirror. Users may
   transfer directly into that tree through a restricted SFTP account, or a
   host-side `scp`/`rsync` job may update it. The app and Nginx always read the
   mirror; remote-copy orchestration remains outside the containers.

Recommended host tree:

```text
/srv/upgallery/
  shared/                 # UPGALLERY_SHARED_ROOT
  uploaders/              # UPGALLERY_UPLOADER_ROOT
  derivatives/            # UPGALLERY_DERIVATIVE_ROOT
    gallery/
      shared/
      user/
    up/
  users/
    alice/                # Internal storage path (`storageRoot`): alice
    studio/video-stills/  # Internal storage path (`storageRoot`): studio/video-stills
```

Use a dedicated Unix group, set directories to `02770`, and grant the storage
container UID write access. The web container gets the same public directories
read-only. Back up metadata and all four storage roots together; metadata
without matching bytes is not a complete backup.

Do not put an SCP private key in the application image or Convex environment.
Keep it on the Docker host or in the host's secret manager, restrict the remote
key with `from=`, a forced command, and a dedicated account, and sync only the
specific user root.

## Deployment

This repository does not create or manage Convex containers. The surrounding
infrastructure must provide an accessible Convex client API and HTTP Actions
origin, plus deployment credentials for publishing the functions in `convex/`.

The Compose application consists of:

- `web`: Nginx and the compiled React application.
- `storage-api`: streamed uploads, protected downloads, and user folder
  operations.
- `storage-worker`: durable filesystem reconciliation, thumbnail/EXIF work,
  deletions, migration copies, and interrupted-operation recovery.

Both storage services use the same image and mounted storage roots, but have
separate process lifecycles, health checks, concurrency limits, and resource
limits.

1. Provision the Convex deployment using the infrastructure's normal process.
2. Put its deployment URL and admin key in local, uncommitted Convex CLI
   configuration.
3. Set the application and Google OAuth values in that Convex deployment:

   ```text
   SITE_URL=https://gallery.example.com
   DEFAULT_ADMIN_EMAIL=admin@example.com
   STORAGE_INTERNAL_SECRET=<same value used by the storage container>
   AUTH_GOOGLE_ID=<Google OAuth client ID>
   AUTH_GOOGLE_SECRET=<Google OAuth client secret>
   ```

   `SITE_URL` is the canonical web origin. Configured gallery hosts are also
   accepted as OAuth return origins after they have been added by an
   administrator.

4. Copy `deploy/.env.docker.example` to an uncommitted deployment `.env`. Set:

   - `PUBLIC_CONVEX_URL` to the browser-reachable Convex client API.
   - `PUBLIC_CONVEX_SITE_URL` to the browser-reachable HTTP Actions origin.
   - `STORAGE_CONVEX_SITE_URL` to the route the containers should use for that
     same HTTP Actions service. It may be private.
   - The mount paths, `GOOGLE_CLIENT_ID`, and a long random
     `STORAGE_INTERNAL_SECRET`.

5. Configure this callback in Google Auth Platform:

   ```text
   https://convex-actions.example.com/auth/google/callback
   ```

   Development and production should use separate Google OAuth clients.
   Convex verifies Google ID tokens through its
   [custom OIDC provider support](https://docs.convex.dev/auth/advanced/custom-auth).

6. Push the Convex functions to the provisioned deployment, then build the app:

   ```bash
   pnpm exec convex deploy
   docker compose up -d --build
   ```

   The storage image compiles the pinned libvips release during the image
   build, with Alpine's libheif decoder enabled, then compiles Sharp against
   that libvips. Both the builder and final storage stage run
   `scripts/check-sharp-heic.mjs`, so an image build fails instead of shipping
   without HEIC/HEIF support. This belongs at image-build time: Compose only
   starts immutable services and does not download compilers or mutate native
   libraries at deployment startup.

7. Put a TLS reverse proxy in front of the public gallery domains and use the
   infrastructure-provided Convex origins. Preserve the original Host header
   for gallery host/path resolution.

## Runtime web configuration

All published images are deployment-agnostic; no deployment values are baked
in at image build time. The compiled web application fetches `/config.json`
at startup and reads `CONVEX_URL`, `CONVEX_SITE_URL`, and `GOOGLE_CLIENT_ID`
from it (falling back to `VITE_*` env vars only during local development).

The web container renders that file when it starts. Provide either:

- The `PUBLIC_CONVEX_URL`, `PUBLIC_CONVEX_SITE_URL`, and `GOOGLE_CLIENT_ID`
  environment variables — the Compose file passes them through from the host
  `.env` (step 4 above), and an entrypoint script renders
  `/usr/share/nginx/html/config.json` from them. The container refuses to
  start if one is missing.
- A complete `config.json` bind-mounted at `/usr/share/nginx/html/config.json`,
  which takes precedence and skips rendering.

Changing the values only requires recreating the container, not rebuilding
the image.

### Serving the site without the web container (`web-dist`)

An infrastructure that already runs a primary web server in front of
everything should not run the `web` image behind it — that is a second nginx
whose only job is handing files to the first. For that case the `web-dist`
image is a file-only artifact (`FROM scratch`, no web server or entrypoint,
cannot be run) holding the same compiled site under `/srv/www`. Extract it
(`docker create` + `docker cp`) and have the primary server serve the files
directly, rendering `config.json` next to them with the keys from
`src/config.ts`.

`deploy/nginx.conf.template` is the reference for what that server must
replicate; the load-bearing behaviors are:

- SPA fallback: unknown paths serve `/index.html`, with `Cache-Control:
  no-cache`. Serve `/config.json` uncached as well.
- No request body size limit on `/api/storage/` (`client_max_body_size 0` —
  uploads up to `MAX_ABSOLUTE_UPLOAD_BYTES` stream through it).
- `/api/storage/` proxies to the storage API with request buffering disabled,
  hour-long read/send timeouts, and the original `Host` header preserved
  (required for gallery host resolution).
- `/media/` aliases: the `users` tree is served `must-revalidate` (editable
  in place), while `shared` and `derivatives/gallery` are content-addressed
  and served `immutable`. Never expose `protected/uploaders` or
  `derivatives/up`; those must pass through the storage API.

## GitHub Actions configuration

Configuration lives in three places, and the split matters:

- **Convex deployment environment** (dashboard): the server-side values from
  step 3 above (`SITE_URL`, `DEFAULT_ADMIN_EMAIL`, `STORAGE_INTERNAL_SECRET`,
  `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`). These never go in GitHub.
- **Docker host `.env`** (step 4 above): runtime values read by Compose when
  starting containers, including the web configuration above.
- **GitHub repository → Settings → Secrets and variables → Actions**: only
  the Convex deploy key below.

### Docker images (`.github/workflows/docker.yml`)

Runs on every push to `main` and publishes the `storage`, `web`, and
`web-dist` image targets to `ghcr.io/<owner>/<repo>/storage`,
`ghcr.io/<owner>/<repo>/web`, and `ghcr.io/<owner>/<repo>/web-dist`, tagged
`latest` and with the commit SHA. Registry authentication uses the workflow's
automatic `GITHUB_TOKEN`, and the images take all deployment values at
runtime, so this workflow needs no configured secrets or variables at all.
The Compose file as written builds images locally; to run the published
images instead, replace its `build:` sections with `image:` references.

Packages published by a workflow default to private; after the first run,
make each GHCR package public in its package settings if anonymous pulls are
wanted.

### Convex deploy (`.github/workflows/convex-deploy.yml`)

Run manually from the Actions tab; it pushes the functions, crons, and auth
config in `convex/` with `convex deploy`. Under the **Secrets** tab, define:

| Secret | Value |
| --- | --- |
| `CONVEX_DEPLOY_KEY` | Production deploy key, generated in the Convex dashboard on the production deployment's settings page (Deploy Keys) |

The deploy key selects the target deployment, so no URL needs configuring.
For a self-hosted Convex backend, the CLI instead reads
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`; add those as a
variable and secret respectively and pass them in the workflow's deploy step
in place of `CONVEX_DEPLOY_KEY`. Once the production deployment is live,
enable the commented-out `push` trigger in the workflow to deploy on every
`main` push.

## Worker recovery and concurrency

Storage work is claimed from Convex using renewable leases:

- User-directory scans and media processing use dedicated durable job tables.
- Deletion jobs reclaim abandoned `processing` records.
- Migration items renew their per-entry lease while copying and retry with
  bounded exponential backoff.
- Interrupted `mkdir` and `rename` operations are reclaimed by the worker.
  Both operations are executed idempotently before Convex metadata is committed.
- Incomplete streamed uploads cannot resume without the client bytes, so an
  expired upload lease is marked failed. Old temporary upload directories are
  removed when the storage API starts.

The storage API separately bounds active and queued uploads, downloads, and
filesystem operations. The worker separately bounds media and filesystem-sync
concurrency; maintenance and interrupted-operation recovery are serialized.
Worker loops drain available jobs immediately and only sleep when a queue is
empty.

The defaults are conservative. Adjust the `STORAGE_MAX_*`,
`STORAGE_*_WORKER_CONCURRENCY`, CPU, and memory settings only after observing
the deployment under representative media sizes.

## Mount and operational rules

- Each gallery's Internal storage path (`storageRoot` in code) is relative and
  cannot contain `..`, absolute paths, spaces, or shell syntax.
- A single user-backed directory is limited to 500 immediate visible items per
  reconciliation pass, and one requested tree walk is limited to 2,000
  directories. Split larger collections into separate Internal storage paths.
- Symlinks are ignored. Mount only the intended user root rather than using
  links to escape into other host paths.
- User-backed originals are served with revalidation headers because their
  content can change at a stable path. Shared content-addressed files retain
  immutable caching. All generated thumbnails and previews are stored beneath
  `UPGALLERY_DERIVATIVE_ROOT`; Nginx receives only its `gallery` subtree.
- Migration pauses new uploads, copies one item at a time, atomically switches
  metadata, then queues the old copy for reference-aware deletion.
- Storage workers reclaim expired leases after restarts. Permanently failed
  jobs retain their error in Convex for inspection.
- `MAX_ABSOLUTE_UPLOAD_BYTES` is a deployment-wide hard ceiling. Every gallery
  has a lower or equal configurable limit.
- Nginx request buffering is disabled for `/api/storage/` so uploads stream
  through the gateway instead of being duplicated in proxy temp storage.
- Thumbnail generation uses the custom libheif-enabled Sharp build for images,
  libheif's `heif-thumbnailer` as a defensive fallback, and ffmpeg for videos.
  Non-Safari HEIC/HEIF modal requests add a full-resolution JPEG derivative to
  the same durable media job. Safari continues to receive the original. The
  cached preview is reused by later viewers and follows the entry through
  moves, migrations, and deletion. Media work has bounded concurrency and
  retries without failing the original upload. A media processor version
  requeues jobs that permanently failed before a newly deployed decoder fix.
- The API and worker expose `/healthz` and `/readyz`; Compose uses readiness
  checks that include connectivity to the provisioned Convex HTTP Actions
  origin.
- The storage image initializes `/data/media/.tmp` for its non-root UID. The
  API removes stale `upload-*` directories at startup.
- Use immutable backups or snapshots for the content roots. Test a restore that
  includes both Convex state and mounted bytes.
