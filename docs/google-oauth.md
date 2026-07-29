# Google OAuth client setup

Upgallery uses Google's OAuth 2.0 authorization-code flow through a shared
redirect router. A browser on any configured gallery domain first visits the
Convex HTTP Action at `/auth/google/start`. That action validates the gallery
origin, signs it into the OAuth state, and redirects to Google. Google always
returns to the single Convex callback at `/auth/google/callback`; Convex
exchanges the code and routes the browser back to `/auth/callback` on the
origin where sign-in began.

Create separate development and production OAuth clients. Prefer separate
Google Cloud projects as well: Google recommends keeping test and production
credentials, consent settings, and user limits isolated.

## Values to register

Google's **Authorized redirect URI** points to the shared Convex HTTP Action.
Its path is always `/auth/google/callback`, and the entire URI must match
exactly. Individual gallery domains are return destinations carried in signed
OAuth state; they are not Google redirect URIs.

Use the following values for the standard environments:

| Environment | Authorized redirect URI |
| --- | --- |
| Development | `<VITE_CONVEX_SITE_URL>/auth/google/callback` |
| Production | `<PUBLIC_CONVEX_SITE_URL>/auth/google/callback`, for example `https://convex-actions.example.com/auth/google/callback` |

For development, get `VITE_CONVEX_SITE_URL` from `.env.local`. A hosted Convex
development deployment will normally produce a value resembling
`https://<deployment-name>.convex.site`.

For this repository's standard local `convex dev` setup, use:

```text
Authorized redirect URI:
http://localhost:3211/auth/google/callback
```

The local origins have separate jobs:

| Origin | Variable | Purpose |
| --- | --- | --- |
| `http://localhost:5173` | Convex `SITE_URL` | Vite UI and OAuth return destination |
| `http://localhost:3210` | `VITE_CONVEX_URL` | Convex client queries, mutations, and subscriptions |
| `http://localhost:3211` | `VITE_CONVEX_SITE_URL` and the storage services' `CONVEX_SITE_URL` | Convex HTTP Actions, including the Google OAuth router |
| `http://localhost:8787` | no browser variable in development | Storage gateway behind Vite's proxy |

Do not substitute `5173` or `3210` for `VITE_CONVEX_SITE_URL`. Sending
`/auth/google/start` to `5173` enters the React application instead of the
OAuth action; sending it to `3210` reaches the Convex client API instead of
HTTP Actions. Opening the bare `3211` origin in a browser returns 404 by design
because Upgallery registers explicit action paths rather than a root route.

Upgallery does not use Google's browser JavaScript SDK, so its tenant routing
does not depend on Google's Authorized JavaScript origins list. Every origin
that can receive credentials must instead be the canonical `SITE_URL` or have
its host configured in Upgallery's `galleryHosts` data. Production tenant
origins must use HTTPS; local `localhost` origins may use HTTP.
This allow-list prevents the router from becoming an open redirect.

Do **not** register any of these as Google's redirect URI:

```text
http://localhost:5173/auth/callback
https://gallery.example.com/auth/callback
<VITE_CONVEX_SITE_URL>/auth/callback
```

Those are either frontend destinations or omit the required `/google` path.
Google must return to the Convex HTTP Action at `/auth/google/callback`.

## Create the development client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and select
   the development project. Create a project first if one does not exist.
2. Open **Google Auth Platform**. If the project has not used Google Auth
   before, select **Get started**.
3. On **Branding**, set the app name (for example, `Upgallery Dev`), user
   support email, and developer contact email.
4. On **Audience**, choose:
   - **Internal** if every user belongs to the same Google Workspace
     organization; or
   - **External**, leave the publishing status as **Testing**, and add each
     developer under **Test users**.
5. On **Data Access**, configure only the scopes used by Upgallery:
   `openid`, `profile`, and `email`. No Google Drive or Google Photos API scope
   is required.
6. Open **Clients**, select **Create client**, choose **Web application**, and
   name it `upgallery-dev`.
7. Add the development redirect URI from the table above, then select
   **Create**.
8. Copy the client ID and client secret immediately. The client ID may be used
   by the browser; the client secret must remain server-side and uncommitted.

In Testing mode, only listed test users can authorize the app. Google also
expires test-user authorizations after seven days, so periodic re-consent during
development is expected.

## Create the production client

Create the production client in the production Google Cloud project:

1. Configure **Branding** with the public app name, support email, homepage,
   privacy policy, and optional terms-of-service URL.
2. Add the registrable domains used by the production homepage and Convex HTTP
   Action origin under **Authorized domains**. Verify domain ownership in
   Google Search Console when required.
3. Configure **Audience** as **Internal** for an organization-only deployment,
   or **External** for other users. Move an External app to **In production**
   when it is ready.
4. Configure only `openid`, `profile`, and `email` under **Data Access**.
5. Under **Clients**, create a **Web application** named `upgallery-prod`.
6. Add the single production redirect URI from the table above, then create
   the client.
7. Store the client secret in the production secret store or directly in the
   Convex deployment environment. Never put it in a browser, image, or
   committed environment file.

The current scopes are basic OpenID Connect scopes rather than sensitive Google
API scopes. Scope verification is normally not required for them, although
Google may still require production branding and domain verification.

## Connect a client to Upgallery

All client-ID settings within one environment must contain the same Google
client ID:

| Setting | Location | Development value | Production value |
| --- | --- | --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | Browser build, normally `.env.local` | Development client ID | Not used by the Compose production build |
| `GOOGLE_CLIENT_ID` | Uncommitted production Compose `.env` | Not normally used | Production client ID |
| `AUTH_GOOGLE_ID` | Convex deployment environment | Development client ID | Production client ID |
| `AUTH_GOOGLE_SECRET` | Convex deployment environment | Development client secret | Production client secret |
| `SITE_URL` | Convex deployment environment | `http://localhost:5173` | Canonical production UI origin |

For local development, the two ignored files and the Convex deployment should
contain the following:

```dotenv
# .env.local (browser-visible; keep the generated CONVEX_DEPLOYMENT line)
VITE_CONVEX_URL=http://localhost:3210
VITE_CONVEX_SITE_URL=http://localhost:3211
VITE_GOOGLE_CLIENT_ID=<development-client-id>
VITE_STORAGE_API_URL=
```

```dotenv
# .env.storage.local (Node storage worker; never browser-visible)
CONVEX_SITE_URL=http://localhost:3211
STORAGE_INTERNAL_SECRET=<same secret set on the Convex deployment>
```

```text
# Selected Convex deployment environment (set with `convex env set`)
AUTH_GOOGLE_ID=<same development-client-id>
AUTH_GOOGLE_SECRET=<development-client-secret>
SITE_URL=http://localhost:5173
STORAGE_INTERNAL_SECRET=<same secret used by the storage worker>
```

Convex supplies a built-in `CONVEX_SITE_URL` inside functions, but Upgallery's
OAuth router derives its callback from the incoming HTTP Action URL so the
hostname exactly matches `VITE_CONVEX_SITE_URL`. The storage worker's
`CONVEX_SITE_URL` is a separate local process variable telling it where to
call those actions. Do not try to set Convex's built-in value with
`convex env set`.

For the currently selected Convex development deployment:

```bash
pnpm exec convex env set AUTH_GOOGLE_ID '<development-client-id>'
pnpm exec convex env set AUTH_GOOGLE_SECRET
pnpm exec convex env set SITE_URL 'http://localhost:5173'
```

Omitting the secret value from the command makes the Convex CLI prompt for it,
which keeps it out of shell history. Add the development client ID to the
uncommitted `.env.local` file:

```text
VITE_GOOGLE_CLIENT_ID=<development-client-id>
```

For a Convex Cloud production deployment, use the production client values:

```bash
pnpm exec convex env --prod set AUTH_GOOGLE_ID '<production-client-id>'
pnpm exec convex env --prod set AUTH_GOOGLE_SECRET
pnpm exec convex env --prod set SITE_URL 'https://gallery.example.com'
```

For the self-hosted deployment, set those values against the selected
self-hosted Convex deployment instead. Also put the same production client ID
in the uncommitted Compose `.env`:

```text
GOOGLE_CLIENT_ID=<production-client-id>
```

`CONVEX_SITE_URL` is a built-in supplied by Convex and identifies the public
HTTP Actions origin. Do not declare it in `convex/convex.config.ts` or try to
set it with `convex env`. For self-hosting, Convex derives it from the backend
container's `CONVEX_SITE_ORIGIN`; this repository maps
`PUBLIC_CONVEX_SITE_URL` to that setting. `VITE_CONVEX_SITE_URL` must resolve
to the same public router. The OAuth callback uses the origin of the incoming
HTTP Action request, preserving `localhost` in development and the configured
public hostname in production. The client secret never belongs in a `VITE_`
variable.

The browser begins authentication at:

```text
<VITE_CONVEX_SITE_URL>/auth/google/start
```

The start action validates the source origin against `SITE_URL` and
`galleryHosts`, then signs the origin, nonce, and relative return path into
Google's `state` parameter. The callback validates the signature and allow-list
again before returning credentials to the source domain.

Restart the Vite development server or rebuild the production web image after
changing a browser client ID because Vite embeds it at build time.

## Verify the setup

1. Open Upgallery using an origin registered on the client.
2. Select **Log in with Google** and confirm the browser first passes through
   `<VITE_CONVEX_SITE_URL>/auth/google/start`.
3. Complete consent using an allowed development test user or a production
   user.
4. Confirm that Google returns through
   `<VITE_CONVEX_SITE_URL>/auth/google/callback`, then Upgallery returns to the
   originating domain through `/auth/callback`.
5. Reload the page and confirm the session refreshes without another sign-in.

Common failures:

- `redirect_uri_mismatch`: the redirect URI in Google does not exactly equal
  `<VITE_CONVEX_SITE_URL>/auth/google/callback`. Check the scheme, hostname,
  port, path, case, and trailing slash.
- `OAuth return origin is not configured`: set `SITE_URL` for the canonical
  UI, or add the tenant hostname to a gallery's host routes.
- `access_denied` or “app is being tested”: add the Google account as a test
  user or correct the Audience publishing status.
- The callback succeeds but authentication is discarded: confirm that the
  browser client ID and Convex `AUTH_GOOGLE_ID` are identical for that
  environment.

Google can take several minutes to apply client changes.

## References

- [Google: Manage OAuth clients](https://support.google.com/cloud/answer/15549257)
- [Google: OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google: Manage app audience](https://support.google.com/cloud/answer/15549945)
- [Google: Production OAuth policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
- [Convex: Environment variables](https://docs.convex.dev/production/environment-variables)
