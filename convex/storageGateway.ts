import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { sha256 } from "./lib/crypto";
import { adjustGalleryStats } from "./lib/galleryStats";
import {
  adjustFolderStats,
  settleReadyEntry,
} from "./lib/folderStats";
import { getFilesystemFolderSegments } from "./lib/filesystem";
import {
  entryExistsError,
  findReadyEntryByNameKey,
  pickAvailableName,
  reservedNameKeys,
  resolveLandingName,
} from "./lib/entryNames";
import { entryNameKey, fileExtensionFromName } from "./lib/normalize";
import {
  replaceMediaProcessingJob,
  STORAGE_JOB_LEASE_MS,
  STORAGE_JOB_MAX_ATTEMPTS,
  storageJobRetryDelay,
} from "./lib/storageJobs";
import { mediaKind } from "./lib/validators";
import { settleBulkMoveItem } from "./lib/bulkOperations";
import { entrySortTimestamp } from "./lib/entrySort";

// A user-backed replacement lands on the replaced file's own path (or a case
// variant of it, which the storage server reconciles on disk), so unlinking
// the replaced entry's original would remove the new file. Shared keys are
// content-addressed and reference-checked, so they are always safe to queue.
function keepsReplacedOriginal(
  storageKind: "shared" | "user",
  replacedKey: string,
  newKey: string,
): boolean {
  return (
    storageKind === "user" &&
    replacedKey.toLowerCase() === newKey.toLowerCase()
  );
}

export const claimUpload = internalMutation({
  args: {
    intentId: v.id("uploadIntents"),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("uploadIntents", args.intentId);
    if (
      intent === null ||
      intent.expiresAt < Date.now() ||
      intent.tokenHash !== (await sha256(args.token)) ||
      (intent.state !== "pending" &&
        !(
          intent.state === "uploading" &&
          (intent.leaseExpiresAt ?? 0) < Date.now()
        ))
    ) {
      throw new Error("Upload intent is invalid or expired");
    }
    const gallery = await ctx.db.get("galleries", intent.galleryId);
    const folder = await ctx.db.get("folders", intent.folderId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.pendingMigrationId !== undefined ||
      folder === null ||
      folder.galleryId !== gallery._id
    ) {
      throw new Error("Gallery is unavailable");
    }
    // The name is settled here, before any bytes arrive, so concurrent
    // uploads into the folder see it reserved; completeUpload re-checks.
    const landing = await resolveLandingName(ctx, {
      gallery,
      folderId: folder._id,
      name: intent.name,
      policy: intent.conflictPolicy,
      excludeIntentId: intent._id,
    });
    const now = Date.now();
    await ctx.db.patch("uploadIntents", intent._id, {
      state: "uploading",
      attempts: (intent.attempts ?? 0) + 1,
      claimedAt: now,
      leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
      resolvedName: landing.name,
      error: undefined,
    });
    return {
      intentId: intent._id,
      name: landing.name,
      // Lets the storage server reconcile a replaced file that sits on a
      // case variant of the new path; shared storage never needs this.
      replacesStorageKey:
        gallery.storageKind === "user"
          ? landing.replaces?.storageKey
          : undefined,
      declaredMimeType: intent.declaredMimeType,
      declaredSize: intent.declaredSize,
      galleryId: gallery._id,
      galleryKind: gallery.kind,
      storageKind: gallery.storageKind,
      storageRoot: gallery.storageRoot,
      folderSegments:
        gallery.storageKind === "user"
          ? await getFilesystemFolderSegments(ctx, gallery, folder)
          : [],
      maxFileSize: gallery.maxFileSize,
      removeLocationData: intent.removeLocationData === true,
    };
  },
});

export const completeUpload = internalMutation({
  args: {
    intentId: v.id("uploadIntents"),
    actualMimeType: v.string(),
    extension: v.string(),
    mediaKind,
    size: v.number(),
    sha256: v.string(),
    storageKey: v.string(),
    thumbnailKey: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    filesystemModifiedAt: v.optional(v.number()),
    filesystemIdentity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("uploadIntents", args.intentId);
    if (intent === null) {
      throw new Error("Upload intent not found");
    }
    const claimed = await ctx.db
      .query("entries")
      .withIndex("by_uploadIntentId", (q) =>
        q.eq("uploadIntentId", intent._id),
      )
      .unique();
    if (claimed !== null) {
      return { entryId: claimed._id, name: claimed.name };
    }
    if (intent.state !== "uploading") {
      throw new Error("Upload intent is not being processed");
    }
    const gallery = await ctx.db.get("galleries", intent.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      args.size > gallery.maxFileSize
    ) {
      throw new Error("Gallery is unavailable or file is too large");
    }
    if (
      args.storageKey.length > 1000 ||
      args.thumbnailKey !== undefined && args.thumbnailKey.length > 1000 ||
      args.metadataJson !== undefined && args.metadataJson.length > 100_000
    ) {
      throw new Error("Storage metadata is too large");
    }
    const name = intent.resolvedName ?? intent.name;
    const nameKey = entryNameKey(name);
    // The entry this upload lands on: the folder's same-named file when the
    // policy is replace, or (user storage) the entry already at this path,
    // which may be a deleted one awaiting cleanup.
    let existing: Doc<"entries"> | null = null;
    if (gallery.kind === "image") {
      const occupant = await findReadyEntryByNameKey(
        ctx,
        intent.folderId,
        nameKey,
      );
      if (occupant !== null) {
        if (intent.conflictPolicy !== "replace") {
          throw entryExistsError(name);
        }
        existing = occupant;
      }
    }
    if (gallery.storageKind === "user") {
      if (
        args.filesystemModifiedAt === undefined ||
        !Number.isFinite(args.filesystemModifiedAt) ||
        args.filesystemIdentity === undefined ||
        args.filesystemIdentity.length < 1 ||
        args.filesystemIdentity.length > 200
      ) {
        throw new Error("User-backed upload is missing filesystem metadata");
      }
      const atPath = await ctx.db
        .query("entries")
        .withIndex("by_storageKey", (q) => q.eq("storageKey", args.storageKey))
        .unique();
      if (atPath !== null && atPath.galleryId !== gallery._id) {
        throw new Error("Storage path is already owned by another gallery");
      }
      existing ??= atPath;
    }
    const now = Date.now();
    if (existing !== null) {
      const wasReady = existing.state === "ready";
      const contentChanged = existing.sha256 !== args.sha256;
      // Derivative keys are content-addressed: unchanged content keeps them,
      // changed content leaves the old ones to clean up.
      const thumbnailKey =
        args.thumbnailKey ??
        (contentChanged ? undefined : existing.thumbnailKey);
      const staleStorageKey =
        existing.storageKey !== args.storageKey
          ? existing.storageKey
          : undefined;
      const staleThumbnailKey = contentChanged
        ? existing.thumbnailKey
        : undefined;
      const stalePreviewKey = contentChanged ? existing.previewKey : undefined;
      await ctx.db.patch("entries", existing._id, {
        folderId: intent.folderId,
        ownerProfileId: intent.ownerProfileId,
        uploadIntentId: intent._id,
        name,
        nameKey,
        description: intent.description,
        mimeType: args.actualMimeType,
        extension: args.extension,
        mediaKind: args.mediaKind,
        size: args.size,
        sha256: args.sha256,
        storageKind: gallery.storageKind,
        storageKey: args.storageKey,
        thumbnailKey,
        previewKey: contentChanged ? undefined : existing.previewKey,
        previewError: contentChanged ? undefined : existing.previewError,
        metadataJson: args.metadataJson,
        filesystemModifiedAt: args.filesystemModifiedAt,
        sortFallbackTimestamp: args.filesystemModifiedAt ?? now,
        sortTimestamp: entrySortTimestamp({
          metadataJson: args.metadataJson,
          filesystemModifiedAt: args.filesystemModifiedAt,
          sortFallbackTimestamp: args.filesystemModifiedAt ?? now,
          createdAt: existing.createdAt,
        }),
        filesystemIdentity: args.filesystemIdentity,
        passwordSalt: intent.passwordSalt,
        passwordHash: intent.passwordHash,
        passwordIterations: intent.passwordIterations,
        unlisted: intent.unlisted,
        state: "ready",
        deletedAt: undefined,
        updatedAt: now,
      });
      const pendingDeleteJobs = await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", existing!._id))
        .take(16);
      for (const job of pendingDeleteJobs) {
        await ctx.db.delete("storageDeleteJobs", job._id);
      }
      if (
        staleStorageKey !== undefined ||
        staleThumbnailKey !== undefined ||
        stalePreviewKey !== undefined
      ) {
        await ctx.db.insert("storageDeleteJobs", {
          entryId: existing._id,
          storageKey: staleStorageKey ?? args.storageKey,
          thumbnailKey: staleThumbnailKey,
          previewKey: stalePreviewKey,
          deleteOriginal:
            staleStorageKey !== undefined &&
            !keepsReplacedOriginal(
              gallery.storageKind,
              staleStorageKey,
              args.storageKey,
            ),
          deleteEntry: false,
          status: "queued",
          attempts: 0,
          availableAt: 0,
        });
      }
      const counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", existing!._id))
        .unique();
      if (counter === null) {
        await ctx.db.insert("entryCounters", {
          entryId: existing._id,
          galleryId: gallery._id,
          views: 0,
          downloads: 0,
        });
      }
      await adjustGalleryStats(ctx, gallery, {
        items: wasReady ? 0 : 1,
        bytes: args.size - (wasReady ? existing.size : 0),
      });
      await settleReadyEntry(ctx, {
        folderId: intent.folderId,
        galleryId: gallery._id,
        size: args.size,
        previous: wasReady ? existing : undefined,
      });
      await ctx.db.patch("uploadIntents", intent._id, {
        state: "complete",
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error: undefined,
      });
      await replaceMediaProcessingJob(ctx, {
        entryId: existing._id,
        storageKey: args.storageKey,
        sha256: args.sha256,
        mediaKind: args.mediaKind,
        alreadyProcessed: thumbnailKey !== undefined,
      });
      return { entryId: existing._id, name };
    }
    const entryId = await ctx.db.insert("entries", {
      galleryId: gallery._id,
      folderId: intent.folderId,
      ownerProfileId: intent.ownerProfileId,
      uploadIntentId: intent._id,
      name,
      nameKey,
      description: intent.description,
      mimeType: args.actualMimeType,
      extension: args.extension,
      mediaKind: args.mediaKind,
      size: args.size,
      sha256: args.sha256,
      storageKind: gallery.storageKind,
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
      metadataJson: args.metadataJson,
      filesystemModifiedAt: args.filesystemModifiedAt,
      sortFallbackTimestamp: args.filesystemModifiedAt ?? now,
      sortTimestamp: entrySortTimestamp({
        metadataJson: args.metadataJson,
        filesystemModifiedAt: args.filesystemModifiedAt,
        sortFallbackTimestamp: args.filesystemModifiedAt ?? now,
        createdAt: now,
      }),
      filesystemIdentity: args.filesystemIdentity,
      passwordSalt: intent.passwordSalt,
      passwordHash: intent.passwordHash,
      passwordIterations: intent.passwordIterations,
      unlisted: intent.unlisted,
      state: "ready",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("entryCounters", {
      entryId,
      galleryId: gallery._id,
      views: 0,
      downloads: 0,
    });
    await adjustGalleryStats(ctx, gallery, { items: 1, bytes: args.size });
    await adjustFolderStats(
      ctx,
      { folderId: intent.folderId, galleryId: gallery._id },
      { items: 1, bytes: args.size },
    );
    await ctx.db.patch("uploadIntents", intent._id, {
      state: "complete",
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      error: undefined,
    });
    await replaceMediaProcessingJob(ctx, {
      entryId,
      storageKey: args.storageKey,
      sha256: args.sha256,
      mediaKind: args.mediaKind,
      alreadyProcessed: args.thumbnailKey !== undefined,
    });
    return { entryId, name };
  },
});

export const failUpload = internalMutation({
  args: {
    intentId: v.id("uploadIntents"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("uploadIntents", args.intentId);
    if (intent !== null && intent.state !== "complete") {
      await ctx.db.patch("uploadIntents", intent._id, {
        state: "failed",
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error: args.error.slice(0, 1000),
      });
    }
    return null;
  },
});

export const renewUpload = internalMutation({
  args: { intentId: v.id("uploadIntents") },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("uploadIntents", args.intentId);
    if (intent === null || intent.state !== "uploading") {
      throw new Error("Upload intent is no longer active");
    }
    await ctx.db.patch("uploadIntents", intent._id, {
      leaseExpiresAt: Date.now() + STORAGE_JOB_LEASE_MS,
    });
    return null;
  },
});

export const claimDownload = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const tokenHash = await sha256(args.token);
    const ticket = await ctx.db
      .query("downloadTickets")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (
      ticket === null ||
      ticket.expiresAt < Date.now()
    ) {
      throw new Error("Download ticket is invalid or expired");
    }
    const entry = await ctx.db.get("entries", ticket.entryId);
    if (entry === null || entry.state !== "ready") {
      throw new Error("File not found");
    }
    const usesThumbnail = ticket.disposition === "thumbnail";
    const usesPreview = ticket.disposition === "preview";
    const storageKey = usesThumbnail
      ? entry.thumbnailKey
      : usesPreview
        ? entry.previewKey
        : entry.storageKey;
    if (storageKey === undefined) {
      throw new Error(
        usesPreview ? "Preview is not available" : "Thumbnail is not available",
      );
    }
    const firstClaim = ticket.claimedAt === undefined;
    if (firstClaim) {
      await ctx.db.patch("downloadTickets", ticket._id, {
        claimedAt: Date.now(),
      });
    }
    if (firstClaim && ticket.disposition !== "thumbnail") {
      const counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique();
      if (counter !== null) {
        await ctx.db.patch("entryCounters", counter._id, {
          // A file serve is both a view and a download. `downloads` remains in
          // the schema for backwards compatibility; `views` is the canonical
          // count for every non-thumbnail serve.
          views: counter.views + 1,
        });
      }
    }
    return {
      entryId: entry._id,
      storageKey,
      mimeType: usesThumbnail || usesPreview ? "image/jpeg" : entry.mimeType,
      fileName: entry.name,
      disposition: ticket.disposition,
    };
  },
});

export const claimMaintenance = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleDeleteJob = await ctx.db
      .query("storageDeleteJobs")
      .withIndex("by_status_and_leaseExpiresAt", (q) =>
        q.eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .first();
    const queuedDeleteJob = await ctx.db
      .query("storageDeleteJobs")
      .withIndex("by_status_and_availableAt", (q) =>
        q.eq("status", "queued").lte("availableAt", now),
      )
      .first();
    const deleteJob = staleDeleteJob ?? queuedDeleteJob;
    if (deleteJob !== null) {
      const attempts = (deleteJob.attempts ?? 0) + 1;
      if (attempts > STORAGE_JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("storageDeleteJobs", deleteJob._id, {
          status: "failed",
          leaseExpiresAt: undefined,
          error: deleteJob.error ?? "Deletion exhausted its retries",
        });
        return { kind: "none" as const };
      }
      const references = await ctx.db
        .query("entries")
        .withIndex("by_storageKey", (q) =>
          q.eq("storageKey", deleteJob.storageKey),
        )
        .take(16);
      const thumbnailReferences =
        deleteJob.thumbnailKey === undefined
          ? []
          : await ctx.db
              .query("entries")
              .withIndex("by_thumbnailKey", (q) =>
                q.eq("thumbnailKey", deleteJob.thumbnailKey),
              )
              .take(16);
      const previewReferences =
        deleteJob.previewKey === undefined
          ? []
          : await ctx.db
              .query("entries")
              .withIndex("by_previewKey", (q) =>
                q.eq("previewKey", deleteJob.previewKey),
              )
              .take(16);
      await ctx.db.patch("storageDeleteJobs", deleteJob._id, {
        status: "processing",
        attempts,
        claimedAt: now,
        leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
        error: undefined,
      });
      return {
        kind: "delete" as const,
        jobId: deleteJob._id,
        storageKey: deleteJob.storageKey,
        thumbnailKey: deleteJob.thumbnailKey,
        previewKey: deleteJob.previewKey,
        removePhysical:
          deleteJob.deleteOriginal !== false &&
          !references.some(
            (entry) =>
              entry._id !== deleteJob.entryId && entry.state === "ready",
          ),
        removeThumbnail: !thumbnailReferences.some(
          (entry) =>
            entry._id !== deleteJob.entryId && entry.state === "ready",
        ),
        removePreview: !previewReferences.some(
          (entry) =>
            entry._id !== deleteJob.entryId && entry.state === "ready",
        ),
      };
    }

    const staleMoveJob = await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_status_and_leaseExpiresAt", (q) =>
        q.eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .first();
    const queuedMoveJob = await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_status_and_availableAt", (q) =>
        q.eq("status", "queued").lte("availableAt", now),
      )
      .first();
    const moveJob = staleMoveJob ?? queuedMoveJob;
    if (moveJob !== null) {
      const attempts = moveJob.attempts + 1;
      const [entry, sourceGallery, destinationGallery, destinationFolder] =
        await Promise.all([
          ctx.db.get("entries", moveJob.entryId),
          ctx.db.get("galleries", moveJob.sourceGalleryId),
          ctx.db.get("galleries", moveJob.destinationGalleryId),
          ctx.db.get("folders", moveJob.destinationFolderId),
        ]);
      const failMove = async (moveError: string) => {
        await ctx.db.patch("entryMoveJobs", moveJob._id, {
          status: "failed",
          leaseExpiresAt: undefined,
          error: moveError,
        });
        if (
          entry !== null &&
          entry.migrationState === "moving" &&
          entry.moveJobId === moveJob._id &&
          entry.storageKey === moveJob.expectedSourceStorageKey
        ) {
          await ctx.db.patch("entries", entry._id, {
            moveJobId: undefined,
            migrationState: undefined,
            migrationClaimedAt: undefined,
            migrationAttempts: undefined,
            migrationRetryAt: undefined,
            migrationError: moveError,
          });
        }
        await settleBulkMoveItem(ctx, moveJob.bulkOperationId, {
          success: false,
          error: moveError,
        });
        return { kind: "none" as const };
      };
      if (
        attempts > STORAGE_JOB_MAX_ATTEMPTS ||
        entry === null ||
        entry.state !== "ready" ||
        entry.galleryId !== moveJob.sourceGalleryId ||
        entry.storageKey !== moveJob.expectedSourceStorageKey ||
        entry.migrationState !== "moving" ||
        entry.moveJobId !== moveJob._id ||
        sourceGallery === null ||
        sourceGallery.deletedAt !== undefined ||
        sourceGallery.pendingMigrationId !== undefined ||
        destinationGallery === null ||
        destinationGallery.deletedAt !== undefined ||
        destinationGallery.kind !== "image" ||
        destinationGallery.pendingMigrationId !== undefined ||
        destinationFolder === null ||
        destinationFolder.galleryId !== destinationGallery._id ||
        destinationFolder.filesystemMissingAt !== undefined
      ) {
        return await failMove(
          attempts > STORAGE_JOB_MAX_ATTEMPTS
            ? moveJob.error ?? "Move exhausted its retries"
            : "Move source or destination is no longer available",
        );
      }
      // The destination may have gained the name since the job was queued
      // (an upload, another move). Without a policy the item fails here,
      // before any copy; rename picks again; replace learns its target.
      let fileName = moveJob.targetName ?? entry.name;
      let replaces: Doc<"entries"> | null = null;
      const occupant = await findReadyEntryByNameKey(
        ctx,
        destinationFolder._id,
        entryNameKey(fileName),
        entry._id,
      );
      if (occupant !== null) {
        if (moveJob.conflictPolicy === "replace") {
          replaces = occupant;
        } else if (moveJob.conflictPolicy === "rename") {
          fileName = await pickAvailableName(
            ctx,
            destinationFolder._id,
            entry.name,
            await reservedNameKeys(ctx, destinationFolder._id, {
              jobId: moveJob._id,
            }),
            entry._id,
          );
          await ctx.db.patch("entryMoveJobs", moveJob._id, {
            targetName: fileName,
          });
        } else {
          return await failMove(
            `${fileName} already exists in the destination folder`,
          );
        }
      }
      await ctx.db.patch("entryMoveJobs", moveJob._id, {
        status: "processing",
        attempts,
        claimedAt: now,
        leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
        error: undefined,
      });
      await ctx.db.patch("entries", entry._id, {
        migrationClaimedAt: now,
        migrationAttempts: attempts,
        migrationError: undefined,
      });
      return {
        kind: "entryMove" as const,
        jobId: moveJob._id,
        entryId: entry._id,
        galleryKind: destinationGallery.kind,
        targetStorageKind: destinationGallery.storageKind,
        targetStorageRoot: destinationGallery.storageRoot,
        targetFolderSegments:
          destinationGallery.storageKind === "user"
            ? await getFilesystemFolderSegments(
                ctx,
                destinationGallery,
                destinationFolder,
              )
            : [],
        fileName,
        // Overwrite a same-named destination file; for user storage also
        // tells the worker which path the replaced entry occupied.
        replace: moveJob.conflictPolicy === "replace",
        replacesStorageKey:
          destinationGallery.storageKind === "user"
            ? replaces?.storageKey
            : undefined,
        sourceStorageKey: entry.storageKey,
        sourceThumbnailKey: entry.thumbnailKey,
        sourcePreviewKey: entry.previewKey,
        sha256: entry.sha256,
        extension: entry.extension,
      };
    }

    const queuedMigration = await ctx.db
      .query("storageMigrations")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .first();
    const processingMigration =
      queuedMigration ??
      (await ctx.db
        .query("storageMigrations")
        .withIndex("by_status", (q) => q.eq("status", "processing"))
        .first());
    if (processingMigration === null) {
      return { kind: "none" as const };
    }
    if (processingMigration.status === "queued") {
      await ctx.db.patch("storageMigrations", processingMigration._id, {
        status: "processing",
      });
    }
    const gallery = await ctx.db.get(
      "galleries",
      processingMigration.galleryId,
    );
    if (gallery === null || gallery.deletedAt !== undefined) {
      await ctx.db.patch("storageMigrations", processingMigration._id, {
        status: "failed",
        error: "Gallery no longer exists",
      });
      return { kind: "none" as const };
    }
    const candidates = await ctx.db
      .query("entries")
      .withIndex("by_galleryId_and_storageKind_and_state", (q) =>
        q
          .eq("galleryId", gallery._id)
          .eq("storageKind", processingMigration.sourceStorageKind)
          .eq("state", "ready"),
      )
      .take(64);
    const entry = candidates.find(
      (candidate) =>
        (candidate.migrationRetryAt ?? 0) <= now &&
        (candidate.migrationState !== "moving" ||
          (candidate.migrationClaimedAt ?? 0) < now - STORAGE_JOB_LEASE_MS),
    );
    if (entry === undefined) {
      if (candidates.length > 0) {
        return { kind: "none" as const };
      }
      await ctx.db.patch("storageMigrations", processingMigration._id, {
        status: "complete",
      });
      await ctx.db.patch("galleries", gallery._id, {
        storageKind: processingMigration.targetStorageKind,
        storageRoot: processingMigration.targetStorageRoot,
        pendingMigrationId: undefined,
      });
      return { kind: "none" as const };
    }
    await ctx.db.patch("entries", entry._id, {
      migrationState: "moving",
      migrationClaimedAt: now,
      migrationAttempts: (entry.migrationAttempts ?? 0) + 1,
      migrationRetryAt: undefined,
      migrationError: undefined,
    });
    const entryFolder = await ctx.db.get("folders", entry.folderId);
    if (entryFolder === null) {
      throw new Error("Entry folder no longer exists");
    }
    return {
      kind: "migration" as const,
      migrationId: processingMigration._id,
      entryId: entry._id,
      galleryKind: gallery.kind,
      targetStorageKind: processingMigration.targetStorageKind,
      targetStorageRoot: processingMigration.targetStorageRoot,
      targetFolderSegments:
        processingMigration.targetStorageKind === "user"
          ? await getFilesystemFolderSegments(ctx, gallery, entryFolder)
          : [],
      fileName: entry.name,
      sourceStorageKey: entry.storageKey,
      sourceThumbnailKey: entry.thumbnailKey,
      sourcePreviewKey: entry.previewKey,
      sha256: entry.sha256,
      extension: entry.extension,
    };
  },
});

export const renewDelete = internalMutation({
  args: { jobId: v.id("storageDeleteJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("storageDeleteJobs", args.jobId);
    if (job === null || job.status !== "processing") {
      throw new Error("Deletion job is no longer active");
    }
    await ctx.db.patch("storageDeleteJobs", job._id, {
      leaseExpiresAt: Date.now() + STORAGE_JOB_LEASE_MS,
    });
    return null;
  },
});

export const renewMigration = internalMutation({
  args: {
    migrationId: v.id("storageMigrations"),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const [migration, entry] = await Promise.all([
      ctx.db.get("storageMigrations", args.migrationId),
      ctx.db.get("entries", args.entryId),
    ]);
    if (
      migration === null ||
      migration.status !== "processing" ||
      entry === null ||
      entry.migrationState !== "moving"
    ) {
      throw new Error("Migration item is no longer active");
    }
    await ctx.db.patch("entries", entry._id, {
      migrationClaimedAt: Date.now(),
    });
    return null;
  },
});

export const renewEntryMove = internalMutation({
  args: { jobId: v.id("entryMoveJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("entryMoveJobs", args.jobId);
    if (job === null || job.status !== "processing") {
      throw new Error("Move job is no longer active");
    }
    const entry = await ctx.db.get("entries", job.entryId);
    if (
      entry === null ||
      entry.migrationState !== "moving" ||
      entry.moveJobId !== job._id
    ) {
      throw new Error("Move entry is no longer active");
    }
    const now = Date.now();
    await ctx.db.patch("entryMoveJobs", job._id, {
      leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
    });
    await ctx.db.patch("entries", entry._id, {
      migrationClaimedAt: now,
    });
    return null;
  },
});

export const completeDelete = internalMutation({
  args: {
    jobId: v.id("storageDeleteJobs"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("storageDeleteJobs", args.jobId);
    if (job === null) {
      return null;
    }
    if (args.error !== undefined) {
      const error = args.error.slice(0, 1000);
      if ((job.attempts ?? 0) >= STORAGE_JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("storageDeleteJobs", job._id, {
          status: "failed",
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
      } else {
        await ctx.db.patch("storageDeleteJobs", job._id, {
          status: "queued",
          availableAt:
            Date.now() + storageJobRetryDelay(job.attempts ?? 1),
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
      }
      return null;
    }
    if (job.deleteEntry) {
      const counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", job.entryId))
        .unique();
      if (counter !== null) {
        await ctx.db.delete("entryCounters", counter._id);
      }
      await ctx.db.delete("entries", job.entryId);
    }
    await ctx.db.delete("storageDeleteJobs", job._id);
    return null;
  },
});

export const completeMigration = internalMutation({
  args: {
    migrationId: v.id("storageMigrations"),
    entryId: v.id("entries"),
    storageKey: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const [migration, entry] = await Promise.all([
      ctx.db.get("storageMigrations", args.migrationId),
      ctx.db.get("entries", args.entryId),
    ]);
    if (migration === null || entry === null) {
      return null;
    }
    if (args.error !== undefined || args.storageKey === undefined) {
      const error = args.error?.slice(0, 1000) ?? "Migration failed";
      const attempts = entry.migrationAttempts ?? 1;
      if (attempts < STORAGE_JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("entries", entry._id, {
          migrationState: undefined,
          migrationClaimedAt: undefined,
          migrationRetryAt: Date.now() + storageJobRetryDelay(attempts),
          migrationError: error,
        });
      } else {
        await ctx.db.patch("entries", entry._id, {
          migrationState: "failed",
          migrationClaimedAt: undefined,
          migrationRetryAt: undefined,
          migrationError: error,
        });
        await ctx.db.patch("storageMigrations", migration._id, {
          status: "failed",
          failedItems: migration.failedItems + 1,
          error,
        });
        const gallery = await ctx.db.get("galleries", migration.galleryId);
        if (gallery !== null) {
          await ctx.db.patch("galleries", gallery._id, {
            pendingMigrationId: undefined,
          });
        }
      }
      return null;
    }
    const sourceStorageKey = entry.storageKey;
    const sourceThumbnailKey = entry.thumbnailKey;
    const sourcePreviewKey = entry.previewKey;
    await ctx.db.patch("entries", entry._id, {
      storageKind: migration.targetStorageKind,
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
      previewKey: args.previewKey,
      filesystemModifiedAt: undefined,
      filesystemIdentity: undefined,
      filesystemSyncId: undefined,
      migrationState: undefined,
      migrationClaimedAt: undefined,
      migrationAttempts: undefined,
      migrationRetryAt: undefined,
      migrationError: undefined,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("storageMigrations", migration._id, {
      movedItems: migration.movedItems + 1,
    });
    await ctx.db.insert("storageDeleteJobs", {
      entryId: entry._id,
      storageKey: sourceStorageKey,
      thumbnailKey: sourceThumbnailKey,
      previewKey: sourcePreviewKey,
      deleteEntry: false,
      status: "queued",
      attempts: 0,
      availableAt: 0,
    });
    return null;
  },
});

export const completeEntryMove = internalMutation({
  args: {
    jobId: v.id("entryMoveJobs"),
    storageKey: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
    filesystemModifiedAt: v.optional(v.number()),
    filesystemIdentity: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("entryMoveJobs", args.jobId);
    if (job === null) {
      return null;
    }
    const entry = await ctx.db.get("entries", job.entryId);
    if (args.error !== undefined || args.storageKey === undefined) {
      const error = args.error?.slice(0, 1000) ?? "Move failed";
      if (job.attempts >= STORAGE_JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("entryMoveJobs", job._id, {
          status: "failed",
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
        if (
          entry !== null &&
          entry.migrationState === "moving" &&
          entry.moveJobId === job._id &&
          entry.storageKey === job.expectedSourceStorageKey
        ) {
          await ctx.db.patch("entries", entry._id, {
            moveJobId: undefined,
            migrationState: undefined,
            migrationClaimedAt: undefined,
            migrationAttempts: undefined,
            migrationRetryAt: undefined,
            migrationError: error,
          });
        }
        await settleBulkMoveItem(ctx, job.bulkOperationId, {
          success: false,
          error,
        });
      } else {
        await ctx.db.patch("entryMoveJobs", job._id, {
          status: "queued",
          availableAt: Date.now() + storageJobRetryDelay(job.attempts),
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
        if (
          entry !== null &&
          entry.migrationState === "moving" &&
          entry.moveJobId === job._id
        ) {
          await ctx.db.patch("entries", entry._id, {
            migrationClaimedAt: undefined,
            migrationError: error,
          });
        }
      }
      return null;
    }
    const failCompletion = async (message: string) => {
      await ctx.db.patch("entryMoveJobs", job._id, {
        status: "failed",
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error: message,
      });
      if (entry !== null && entry.moveJobId === job._id) {
        await ctx.db.patch("entries", entry._id, {
          moveJobId: undefined,
          migrationState: undefined,
          migrationClaimedAt: undefined,
          migrationAttempts: undefined,
          migrationRetryAt: undefined,
          migrationError: message,
        });
      }
      await settleBulkMoveItem(ctx, job.bulkOperationId, {
        success: false,
        error: message,
      });
      return null;
    };
    if (
      entry === null ||
      entry.state !== "ready" ||
      entry.galleryId !== job.sourceGalleryId ||
      entry.storageKey !== job.expectedSourceStorageKey ||
      entry.migrationState !== "moving" ||
      entry.moveJobId !== job._id
    ) {
      return await failCompletion("Move source changed before completion");
    }
    const [sourceGallery, destinationGallery, destinationFolder] =
      await Promise.all([
        ctx.db.get("galleries", job.sourceGalleryId),
        ctx.db.get("galleries", job.destinationGalleryId),
        ctx.db.get("folders", job.destinationFolderId),
      ]);
    if (
      sourceGallery === null ||
      destinationGallery === null ||
      destinationGallery.deletedAt !== undefined ||
      destinationFolder === null ||
      destinationFolder.galleryId !== destinationGallery._id
    ) {
      throw new Error("Move destination is no longer available");
    }
    const targetName = job.targetName ?? entry.name;
    const targetNameKey = entryNameKey(targetName);
    const occupant = await findReadyEntryByNameKey(
      ctx,
      destinationFolder._id,
      targetNameKey,
      entry._id,
    );
    if (occupant !== null && job.conflictPolicy !== "replace") {
      return await failCompletion(
        `${targetName} already exists in the destination folder`,
      );
    }
    const sourceStorageKey = entry.storageKey;
    const sourceThumbnailKey = entry.thumbnailKey;
    const sourcePreviewKey = entry.previewKey;
    const now = Date.now();
    if (occupant !== null) {
      await ctx.db.patch("entries", occupant._id, {
        state: "deleted",
        deletedAt: now,
        updatedAt: now,
      });
      await adjustGalleryStats(ctx, destinationGallery, {
        items: -1,
        bytes: -occupant.size,
      });
      await adjustFolderStats(ctx, occupant, {
        items: -1,
        bytes: -occupant.size,
      });
      await ctx.db.insert("storageDeleteJobs", {
        entryId: occupant._id,
        storageKey: occupant.storageKey,
        thumbnailKey: occupant.thumbnailKey,
        previewKey: occupant.previewKey,
        deleteOriginal: !keepsReplacedOriginal(
          destinationGallery.storageKind,
          occupant.storageKey,
          args.storageKey,
        ),
        deleteEntry: true,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
    }
    await ctx.db.patch("entries", entry._id, {
      galleryId: destinationGallery._id,
      folderId: destinationFolder._id,
      name: targetName,
      nameKey: targetNameKey,
      extension: fileExtensionFromName(targetName, entry.extension),
      storageKind: destinationGallery.storageKind,
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
      previewKey: args.previewKey,
      filesystemModifiedAt: args.filesystemModifiedAt,
      sortFallbackTimestamp:
        args.filesystemModifiedAt ??
        entry.sortFallbackTimestamp ??
        entry.filesystemModifiedAt ??
        entry.createdAt,
      sortTimestamp: entrySortTimestamp({
        metadataJson: entry.metadataJson,
        filesystemModifiedAt: args.filesystemModifiedAt,
        sortFallbackTimestamp:
          args.filesystemModifiedAt ??
          entry.sortFallbackTimestamp ??
          entry.filesystemModifiedAt,
        createdAt: entry.createdAt,
      }),
      filesystemIdentity: args.filesystemIdentity,
      filesystemSyncId: undefined,
      moveJobId: undefined,
      migrationState: undefined,
      migrationClaimedAt: undefined,
      migrationAttempts: undefined,
      migrationRetryAt: undefined,
      migrationError: undefined,
      updatedAt: now,
    });
    const counter = await ctx.db
      .query("entryCounters")
      .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
      .unique();
    if (counter !== null && counter.galleryId !== destinationGallery._id) {
      await ctx.db.patch("entryCounters", counter._id, {
        galleryId: destinationGallery._id,
      });
    }
    if (sourceGallery._id !== destinationGallery._id) {
      await adjustGalleryStats(ctx, sourceGallery, {
        items: -1,
        bytes: -entry.size,
      });
      await adjustGalleryStats(ctx, destinationGallery, {
        items: 1,
        bytes: entry.size,
      });
    }
    // `entry` still carries the source folder; the patch above moved it.
    await settleReadyEntry(ctx, {
      folderId: destinationFolder._id,
      galleryId: destinationGallery._id,
      size: entry.size,
      previous: entry,
    });
    if (sourceStorageKey !== args.storageKey) {
      await ctx.db.insert("storageDeleteJobs", {
        entryId: entry._id,
        storageKey: sourceStorageKey,
        thumbnailKey:
          sourceThumbnailKey !== args.thumbnailKey
            ? sourceThumbnailKey
            : undefined,
        previewKey:
          sourcePreviewKey !== args.previewKey
            ? sourcePreviewKey
            : undefined,
        deleteEntry: false,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: job.actorProfileId,
      action: "entry.moved",
      galleryId: destinationGallery._id,
      detail: `${targetName} from ${sourceGallery.name} to ${destinationFolder.name}`,
      createdAt: now,
    });
    await settleBulkMoveItem(ctx, job.bulkOperationId, { success: true });
    await ctx.db.delete("entryMoveJobs", job._id);
    return null;
  },
});
