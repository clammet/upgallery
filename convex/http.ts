import { httpRouter } from "convex/server";
import { httpAction, env } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { googlyAuth } from "./lib/auth";

const http = httpRouter();

googlyAuth.registerRoutes(http, {
  isAllowedOrigin: async (ctx, origin) =>
    await ctx.runQuery(internal.authOrigins.isGalleryOrigin, { origin }),
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      (body.metadataJson !== undefined &&
        typeof body.metadataJson !== "string") ||
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
          metadataJson: body.metadataJson,
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
    if (!storageAuthorized(request)) {
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
  path: "/internal/storage/renew-entry-move",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.jobId !== "string") {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.renewEntryMove, {
      jobId: body.jobId as Id<"entryMoveJobs">,
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
  path: "/internal/storage/complete-entry-move",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!storageAuthorized(request)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.jobId !== "string" ||
      (body.storageKey !== undefined && typeof body.storageKey !== "string") ||
      (body.thumbnailKey !== undefined &&
        typeof body.thumbnailKey !== "string") ||
      (body.previewKey !== undefined && typeof body.previewKey !== "string") ||
      (body.filesystemModifiedAt !== undefined &&
        typeof body.filesystemModifiedAt !== "number") ||
      (body.filesystemIdentity !== undefined &&
        typeof body.filesystemIdentity !== "string") ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.completeEntryMove, {
      jobId: body.jobId as Id<"entryMoveJobs">,
      storageKey: body.storageKey,
      thumbnailKey: body.thumbnailKey,
      previewKey: body.previewKey,
      filesystemModifiedAt: body.filesystemModifiedAt,
      filesystemIdentity: body.filesystemIdentity,
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
      (body.previewKey !== undefined && typeof body.previewKey !== "string") ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageGateway.completeMigration, {
      migrationId: body.migrationId as Id<"storageMigrations">,
      entryId: body.entryId as Id<"entries">,
      storageKey: body.storageKey,
      thumbnailKey: body.thumbnailKey,
      previewKey: body.previewKey,
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
      (body.metadataJson !== undefined && typeof body.metadataJson !== "string")
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
          metadataJson: body.metadataJson,
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
          error: error instanceof Error ? error.message : "Operation rejected",
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
    await ctx.runMutation(internal.filesystemSync.failFilesystemOperation, {
      operationId: body.operationId as Id<"filesystemOperations">,
      error: body.error,
      retry: body.retry,
    });
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
      (body.previewKey !== undefined && typeof body.previewKey !== "string") ||
      (body.metadataJson !== undefined &&
        typeof body.metadataJson !== "string") ||
      (body.metadataProcessed !== undefined &&
        typeof body.metadataProcessed !== "boolean") ||
      (body.storageKey !== undefined && typeof body.storageKey !== "string") ||
      (body.sha256 !== undefined && typeof body.sha256 !== "string") ||
      (body.size !== undefined && typeof body.size !== "number") ||
      (body.filesystemModifiedAt !== undefined &&
        typeof body.filesystemModifiedAt !== "number") ||
      (body.filesystemIdentity !== undefined &&
        typeof body.filesystemIdentity !== "string") ||
      (body.error !== undefined && typeof body.error !== "string")
    ) {
      return json({ error: "Invalid request body" }, 400);
    }
    await ctx.runMutation(internal.storageJobs.completeMediaProcessing, {
      jobId: body.jobId as Id<"mediaProcessingJobs">,
      thumbnailKey: body.thumbnailKey,
      previewKey: body.previewKey,
      metadataJson: body.metadataJson,
      metadataProcessed: body.metadataProcessed,
      storageKey: body.storageKey,
      sha256: body.sha256,
      size: body.size,
      filesystemModifiedAt: body.filesystemModifiedAt,
      filesystemIdentity: body.filesystemIdentity,
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
