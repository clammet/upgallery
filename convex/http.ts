import { httpRouter } from "convex/server";
import { httpAction, env, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createGoogleOAuthState,
  isValidGoogleOAuthState,
  verifyGoogleOAuthState,
} from "./lib/googleOAuthState";
import { googleOAuthCallbackUrl } from "./lib/googleOAuthUrls";

const http = httpRouter();

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const encoder = new TextEncoder();

async function getSessionSigningKey(): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.AUTH_GOOGLE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    baseKey,
    encoder.encode("upgallery-google-session-signing-v1"),
  );
  return await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signSessionToken(
  sessionToken: string,
  googleSubject: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getSessionSigningKey(),
    encoder.encode(`${sessionToken}|${googleSubject}`),
  );
  return `${sessionToken}.${base64UrlEncode(signature)}`;
}

async function verifySessionToken(
  signedToken: string,
  googleSubject: string,
): Promise<string | null> {
  const separator = signedToken.indexOf(".");
  if (separator < 1) return null;
  const sessionToken = signedToken.slice(0, separator);
  const signature = base64UrlDecode(signedToken.slice(separator + 1));
  if (signature === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await getSessionSigningKey(),
    signature.buffer as ArrayBuffer,
    encoder.encode(`${sessionToken}|${googleSubject}`),
  );
  return valid ? sessionToken : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded = base64UrlDecode(parts[1]);
    if (decoded === null) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function googleSubjectFromToken(
  token: string,
  expectedNonce?: string,
): string | null {
  const payload = decodeJwtPayload(token);
  if (
    payload === null ||
    payload.aud !== env.AUTH_GOOGLE_ID ||
    (payload.iss !== "https://accounts.google.com" &&
      payload.iss !== "accounts.google.com") ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= Date.now() ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    (expectedNonce !== undefined && payload.nonce !== expectedNonce)
  ) {
    return null;
  }
  return payload.sub;
}

async function isAllowedWebOrigin(
  ctx: ActionCtx,
  origin: string,
): Promise<boolean> {
  return await ctx.runQuery(internal.googleAuthSessions.isAllowedWebOrigin, {
    origin,
  });
}

async function corsHeaders(
  ctx: ActionCtx,
  request: Request,
): Promise<Record<string, string> | null> {
  const origin = request.headers.get("origin");
  if (origin === null || !(await isAllowedWebOrigin(ctx, origin))) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function authJson(
  value: unknown,
  status: number,
  headers: Record<string, string>,
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

http.route({
  path: "/auth/google/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const stateInput = {
      nonce: url.searchParams.get("nonce") ?? "",
      origin: url.searchParams.get("origin") ?? "",
      redirect: url.searchParams.get("redirect") ?? "",
    };
    if (!isValidGoogleOAuthState(stateInput)) {
      return new Response("Invalid OAuth request", { status: 400 });
    }
    if (!(await isAllowedWebOrigin(ctx, stateInput.origin))) {
      return new Response("OAuth return origin is not configured", {
        status: 403,
      });
    }

    const authorizationUrl = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorizationUrl.searchParams.set("client_id", env.AUTH_GOOGLE_ID);
    authorizationUrl.searchParams.set(
      "redirect_uri",
      googleOAuthCallbackUrl(request.url),
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid profile email");
    authorizationUrl.searchParams.set(
      "state",
      await createGoogleOAuthState(env.AUTH_GOOGLE_SECRET, stateInput),
    );
    authorizationUrl.searchParams.set("nonce", stateInput.nonce);
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");

    return new Response(null, {
      status: 302,
      headers: { Location: authorizationUrl.toString() },
    });
  }),
});

http.route({
  path: "/auth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const verifiedState = await verifyGoogleOAuthState(
      env.AUTH_GOOGLE_SECRET,
      state,
    );
    if (
      verifiedState === null ||
      !(await isAllowedWebOrigin(ctx, verifiedState.origin))
    ) {
      return new Response("Invalid or expired OAuth state", { status: 400 });
    }
    const destination = new URL("/auth/callback", verifiedState.origin);
    const oauthError = url.searchParams.get("error");
    if (oauthError !== null) {
      destination.hash = new URLSearchParams({
        error: oauthError,
        state,
      }).toString();
      return new Response(null, {
        status: 302,
        headers: { Location: destination.toString() },
      });
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      return new Response("Missing authorization code", { status: 400 });
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.AUTH_GOOGLE_ID,
        client_secret: env.AUTH_GOOGLE_SECRET,
        redirect_uri: googleOAuthCallbackUrl(request.url),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) {
      console.error("Google token exchange failed", tokenResponse.status);
      return new Response("Authentication failed", { status: 502 });
    }
    const tokenValue: unknown = await tokenResponse.json();
    if (!isRecord(tokenValue) || typeof tokenValue.id_token !== "string") {
      return new Response("Google did not return an ID token", { status: 502 });
    }
    const googleSubject = googleSubjectFromToken(
      tokenValue.id_token,
      verifiedState.nonce,
    );
    if (googleSubject === null) {
      return new Response("Google returned an invalid ID token", {
        status: 502,
      });
    }
    let refreshToken =
      typeof tokenValue.refresh_token === "string"
        ? tokenValue.refresh_token
        : null;
    if (refreshToken === null) {
      const existing = await ctx.runQuery(
        internal.googleAuthSessions.getRefreshTokenByGoogleSubject,
        { googleSubject },
      );
      refreshToken = existing?.refreshToken ?? null;
    }
    const fragment = new URLSearchParams({
      token: tokenValue.id_token,
      state,
    });
    if (refreshToken !== null) {
      const sessionToken = crypto.randomUUID();
      await ctx.runMutation(internal.googleAuthSessions.create, {
        sessionToken,
        refreshToken,
        googleSubject,
      });
      fragment.set(
        "session",
        await signSessionToken(sessionToken, googleSubject),
      );
    }
    destination.hash = fragment.toString();
    return new Response(null, {
      status: 302,
      headers: { Location: destination.toString() },
    });
  }),
});

http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = await corsHeaders(ctx, request);
    if (headers === null) {
      return authJson({ error: "Origin not allowed" }, 403, {});
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.sessionToken !== "string") {
      return authJson({ error: "Missing session token" }, 400, headers);
    }
    const separator = body.sessionToken.indexOf(".");
    if (separator < 1) {
      return authJson({ error: "Invalid session" }, 401, headers);
    }
    const unsignedToken = body.sessionToken.slice(0, separator);
    const session = await ctx.runQuery(
      internal.googleAuthSessions.getBySessionToken,
      { sessionToken: unsignedToken },
    );
    if (
      session === null ||
      (await verifySessionToken(
        body.sessionToken,
        session.googleSubject,
      )) === null
    ) {
      return authJson({ error: "Invalid session" }, 401, headers);
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.AUTH_GOOGLE_ID,
        client_secret: env.AUTH_GOOGLE_SECRET,
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResponse.ok) {
      await ctx.runMutation(
        internal.googleAuthSessions.removeBySessionToken,
        { sessionToken: unsignedToken },
      );
      return authJson({ error: "Refresh failed" }, 401, headers);
    }
    const tokenValue: unknown = await tokenResponse.json();
    if (
      !isRecord(tokenValue) ||
      typeof tokenValue.id_token !== "string" ||
      googleSubjectFromToken(tokenValue.id_token) !== session.googleSubject
    ) {
      return authJson({ error: "Google returned an invalid ID token" }, 502, headers);
    }
    return authJson({ idToken: tokenValue.id_token }, 200, headers);
  }),
});

http.route({
  path: "/auth/sign-out",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = await corsHeaders(ctx, request);
    if (headers === null) {
      return new Response(null, { status: 403 });
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.sessionToken !== "string") {
      return new Response(null, { status: 204, headers });
    }
    const separator = body.sessionToken.indexOf(".");
    if (separator > 0) {
      const unsignedToken = body.sessionToken.slice(0, separator);
      const session = await ctx.runQuery(
        internal.googleAuthSessions.getBySessionToken,
        { sessionToken: unsignedToken },
      );
      if (
        session !== null &&
        (await verifySessionToken(
          body.sessionToken,
          session.googleSubject,
        )) !== null
      ) {
        await ctx.runMutation(
          internal.googleAuthSessions.removeBySessionToken,
          { sessionToken: unsignedToken },
        );
      }
    }
    return new Response(null, { status: 204, headers });
  }),
});

for (const path of ["/auth/refresh", "/auth/sign-out"]) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async (ctx, request) => {
      const headers = await corsHeaders(ctx, request);
      return new Response(null, {
        status: headers === null ? 403 : 204,
        headers: headers ?? {},
      });
    }),
  });
}

function storageAuthorized(request: Request): boolean {
  const secret = env.STORAGE_INTERNAL_SECRET;
  return (
    secret !== undefined &&
    secret.length >= 24 &&
    request.headers.get("x-upgallery-storage-secret") === secret
  );
}

http.route({
  path: "/internal/storage/health",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/claim-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.intentId !== "string" ||
      typeof body.token !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    try {
      const result = await ctx.runMutation(
        internal.storageGateway.claimUpload,
        {
          intentId: body.intentId as Id<"uploadIntents">,
          token: body.token,
        },
      );
      return json(result);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Upload rejected" },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/renew-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.intentId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.renewUpload, {
      intentId: body.intentId as Id<"uploadIntents">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.intentId !== "string" ||
      typeof body.actualMimeType !== "string" ||
      typeof body.extension !== "string" ||
      typeof body.mediaKind !== "string" ||
      typeof body.size !== "number" ||
      typeof body.sha256 !== "string" ||
      typeof body.storageKey !== "string" ||
      (body.thumbnailKey !== undefined &&
        typeof body.thumbnailKey !== "string") ||
      (body.exifJson !== undefined && typeof body.exifJson !== "string") ||
      (body.filesystemModifiedAt !== undefined &&
        typeof body.filesystemModifiedAt !== "number") ||
      (body.filesystemIdentity !== undefined &&
        typeof body.filesystemIdentity !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    const allowedKinds = new Set([
      "image",
      "video",
      "audio",
      "text",
      "archive",
      "document",
      "other",
    ]);
    if (!allowedKinds.has(body.mediaKind)) {
      return json({ error: "Invalid media kind" }, 400);
    }
    try {
      const entryId = await ctx.runMutation(
        internal.storageGateway.completeUpload,
        {
          intentId: body.intentId as Id<"uploadIntents">,
          actualMimeType: body.actualMimeType,
          extension: body.extension,
          mediaKind: body.mediaKind as
            | "image"
            | "video"
            | "audio"
            | "text"
            | "archive"
            | "document"
            | "other",
          size: body.size,
          sha256: body.sha256,
          storageKey: body.storageKey,
          thumbnailKey: body.thumbnailKey,
          exifJson: body.exifJson,
          filesystemModifiedAt: body.filesystemModifiedAt,
          filesystemIdentity: body.filesystemIdentity,
        },
      );
      return json({ entryId });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Upload failed" },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/fail-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.intentId !== "string" ||
      typeof body.error !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.failUpload, {
      intentId: body.intentId as Id<"uploadIntents">,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/claim-download",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.token !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    try {
      return json(
        await ctx.runMutation(internal.storageGateway.claimDownload, {
          token: body.token,
        }),
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Download rejected" },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/claim-maintenance",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json(
      await ctx.runMutation(internal.storageGateway.claimMaintenance, {}),
    );
  }),
});

http.route({
  path: "/internal/storage/renew-delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.jobId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.renewDelete, {
      jobId: body.jobId as Id<"storageDeleteJobs">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/renew-migration",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (
      !storageAuthorized(request)
    ) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.migrationId !== "string" ||
      typeof body.entryId !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.renewMigration, {
      migrationId: body.migrationId as Id<"storageMigrations">,
      entryId: body.entryId as Id<"entries">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.jobId !== "string" ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.completeDelete, {
      jobId: body.jobId as Id<"storageDeleteJobs">,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-migration",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.migrationId !== "string" ||
      typeof body.entryId !== "string" ||
      (body.storageKey !== undefined && typeof body.storageKey !== "string") ||
      (body.thumbnailKey !== undefined &&
        typeof body.thumbnailKey !== "string") ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.completeMigration, {
      migrationId: body.migrationId as Id<"storageMigrations">,
      entryId: body.entryId as Id<"entries">,
      storageKey: body.storageKey,
      thumbnailKey: body.thumbnailKey,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/claim-filesystem-sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    try {
      return json(
        await ctx.runMutation(internal.filesystemSync.claimFilesystemSync, {
          galleryId: body.galleryId as Id<"galleries">,
          folderId: body.folderId as Id<"folders">,
        }),
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Sync rejected" },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/compare-filesystem-directory",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string" ||
      typeof body.modifiedAt !== "number"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    return json(
      await ctx.runMutation(
        internal.filesystemSync.compareFilesystemDirectory,
        {
          galleryId: body.galleryId as Id<"galleries">,
          folderId: body.folderId as Id<"folders">,
          syncId: body.syncId,
          modifiedAt: body.modifiedAt,
        },
      ),
    );
  }),
});

http.route({
  path: "/internal/storage/renew-filesystem-sync-lease",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.filesystemSync.renewFilesystemSyncLease, {
      galleryId: body.galleryId as Id<"galleries">,
      folderId: body.folderId as Id<"folders">,
      syncId: body.syncId,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/reconcile-filesystem-directory",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.parentId !== "string" ||
      typeof body.syncId !== "string" ||
      typeof body.name !== "string" ||
      typeof body.identity !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    return json({
      folderId: await ctx.runMutation(
        internal.filesystemSync.reconcileFilesystemDirectory,
        {
          galleryId: body.galleryId as Id<"galleries">,
          parentId: body.parentId as Id<"folders">,
          syncId: body.syncId,
          name: body.name,
          identity: body.identity,
        },
      ),
    });
  }),
});

http.route({
  path: "/internal/storage/check-filesystem-file",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string" ||
      typeof body.name !== "string" ||
      typeof body.storageKey !== "string" ||
      typeof body.size !== "number" ||
      typeof body.modifiedAt !== "number" ||
      typeof body.identity !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    return json(
      await ctx.runMutation(internal.filesystemSync.checkFilesystemFile, {
        galleryId: body.galleryId as Id<"galleries">,
        folderId: body.folderId as Id<"folders">,
        syncId: body.syncId,
        name: body.name,
        storageKey: body.storageKey,
        size: body.size,
        modifiedAt: body.modifiedAt,
        identity: body.identity,
      }),
    );
  }),
});

http.route({
  path: "/internal/storage/reconcile-filesystem-file",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string" ||
      (body.entryId !== undefined && typeof body.entryId !== "string") ||
      typeof body.name !== "string" ||
      typeof body.storageKey !== "string" ||
      typeof body.size !== "number" ||
      typeof body.modifiedAt !== "number" ||
      typeof body.identity !== "string" ||
      typeof body.mimeType !== "string" ||
      typeof body.extension !== "string" ||
      typeof body.mediaKind !== "string" ||
      typeof body.sha256 !== "string" ||
      (body.thumbnailKey !== undefined &&
        typeof body.thumbnailKey !== "string") ||
      (body.exifJson !== undefined && typeof body.exifJson !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    const allowedKinds = new Set([
      "image",
      "video",
      "audio",
      "text",
      "archive",
      "document",
      "other",
    ]);
    if (!allowedKinds.has(body.mediaKind)) {
      return json({ error: "Invalid media kind" }, 400);
    }
    return json({
      entryId: await ctx.runMutation(
        internal.filesystemSync.reconcileFilesystemFile,
        {
          galleryId: body.galleryId as Id<"galleries">,
          folderId: body.folderId as Id<"folders">,
          syncId: body.syncId,
          entryId: body.entryId as Id<"entries"> | undefined,
          name: body.name,
          storageKey: body.storageKey,
          size: body.size,
          modifiedAt: body.modifiedAt,
          identity: body.identity,
          mimeType: body.mimeType,
          extension: body.extension,
          mediaKind: body.mediaKind as
            | "image"
            | "video"
            | "audio"
            | "text"
            | "archive"
            | "document"
            | "other",
          sha256: body.sha256,
          thumbnailKey: body.thumbnailKey,
          exifJson: body.exifJson,
        },
      ),
    });
  }),
});

http.route({
  path: "/internal/storage/complete-filesystem-sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string" ||
      typeof body.modifiedAt !== "number"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.filesystemSync.completeFilesystemSync, {
      galleryId: body.galleryId as Id<"galleries">,
      folderId: body.folderId as Id<"folders">,
      syncId: body.syncId,
      modifiedAt: body.modifiedAt,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/fail-filesystem-sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.folderId !== "string" ||
      typeof body.syncId !== "string" ||
      typeof body.error !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.filesystemSync.failFilesystemSync, {
      folderId: body.folderId as Id<"folders">,
      syncId: body.syncId,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/claim-filesystem-operation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.operationId !== "string" ||
      typeof body.token !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    try {
      return json(
        await ctx.runMutation(
          internal.filesystemSync.claimFilesystemOperation,
          {
            operationId: body.operationId as Id<"filesystemOperations">,
            token: body.token,
          },
        ),
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Operation rejected",
        },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/claim-recoverable-filesystem-operation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json(
      await ctx.runMutation(
        internal.filesystemSync.claimRecoverableFilesystemOperation,
        {},
      ),
    );
  }),
});

http.route({
  path: "/internal/storage/renew-filesystem-operation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.operationId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.filesystemSync.renewFilesystemOperation, {
      operationId: body.operationId as Id<"filesystemOperations">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-filesystem-operation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.operationId !== "string" ||
      typeof body.identity !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    return json(
      await ctx.runMutation(
        internal.filesystemSync.completeFilesystemOperation,
        {
          operationId: body.operationId as Id<"filesystemOperations">,
          identity: body.identity,
        },
      ),
    );
  }),
});

http.route({
  path: "/internal/storage/fail-filesystem-operation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.operationId !== "string" ||
      typeof body.error !== "string" ||
      (body.retry !== undefined && typeof body.retry !== "boolean")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(
      internal.filesystemSync.failFilesystemOperation,
      {
        operationId: body.operationId as Id<"filesystemOperations">,
        error: body.error,
        retry: body.retry,
      },
    );
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/queue-filesystem-sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.galleryId !== "string" ||
      typeof body.folderId !== "string"
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    try {
      return json(
        await ctx.runMutation(internal.storageJobs.queueFilesystemSync, {
          galleryId: body.galleryId as Id<"galleries">,
          folderId: body.folderId as Id<"folders">,
        }),
      );
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Sync rejected" },
        400,
      );
    }
  }),
});

http.route({
  path: "/internal/storage/claim-filesystem-sync-job",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json(
      await ctx.runMutation(internal.storageJobs.claimFilesystemSync, {}),
    );
  }),
});

http.route({
  path: "/internal/storage/renew-filesystem-sync-job",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.jobId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageJobs.renewFilesystemSync, {
      jobId: body.jobId as Id<"filesystemSyncJobs">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-filesystem-sync-job",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.jobId !== "string" ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageJobs.completeFilesystemSync, {
      jobId: body.jobId as Id<"filesystemSyncJobs">,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/claim-media-processing",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json(
      await ctx.runMutation(internal.storageJobs.claimMediaProcessing, {}),
    );
  }),
});

http.route({
  path: "/internal/storage/renew-media-processing",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.jobId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageJobs.renewMediaProcessing, {
      jobId: body.jobId as Id<"mediaProcessingJobs">,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/complete-media-processing",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.jobId !== "string" ||
      (body.thumbnailKey !== undefined &&
        typeof body.thumbnailKey !== "string") ||
      (body.exifJson !== undefined && typeof body.exifJson !== "string") ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageJobs.completeMediaProcessing, {
      jobId: body.jobId as Id<"mediaProcessingJobs">,
      thumbnailKey: body.thumbnailKey,
      exifJson: body.exifJson,
      error: body.error,
    });
    return json({ ok: true });
  }),
});

http.route({
  path: "/internal/storage/recover-stale-requests",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json(
      await ctx.runMutation(internal.storageJobs.recoverStaleRequests, {}),
    );
  }),
});

export default http;
