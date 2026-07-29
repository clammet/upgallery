import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { sha256 } from "./lib/crypto";
import { getFilesystemFolderSegments } from "./lib/filesystem";
import {
  replaceMediaProcessingJob,
  STORAGE_JOB_LEASE_MS,
  STORAGE_JOB_MAX_ATTEMPTS,
  storageJobRetryDelay,
} from "./lib/storageJobs";
import { mediaKind } from "./lib/validators";

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
    const now = Date.now();
    await ctx.db.patch("uploadIntents", intent._id, {
      state: "uploading",
      attempts: (intent.attempts ?? 0) + 1,
      claimedAt: now,
      leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
      error: undefined,
    });
    return {
      intentId: intent._id,
      name: intent.name,
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
    exifJson: v.optional(v.string()),
    filesystemModifiedAt: v.optional(v.number()),
    filesystemIdentity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("uploadIntents", args.intentId);
    if (intent === null) {
      throw new Error("Upload intent not found");
    }
    let existing = await ctx.db
      .query("entries")
      .withIndex("by_uploadIntentId", (q) =>
        q.eq("uploadIntentId", intent._id),
      )
      .unique();
    if (existing !== null) {
      return existing._id;
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
      args.exifJson !== undefined && args.exifJson.length > 100_000
    ) {
      throw new Error("Storage metadata is too large");
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
      existing = await ctx.db
        .query("entries")
        .withIndex("by_storageKey", (q) => q.eq("storageKey", args.storageKey))
        .unique();
      if (existing !== null && existing.galleryId !== gallery._id) {
        throw new Error("Storage path is already owned by another gallery");
      }
    }
    const now = Date.now();
    if (existing !== null) {
      const wasReady = existing.state === "ready";
      await ctx.db.patch("entries", existing._id, {
        folderId: intent.folderId,
        ownerProfileId: intent.ownerProfileId,
        uploadIntentId: intent._id,
        name: intent.name,
        description: intent.description,
        mimeType: args.actualMimeType,
        extension: args.extension,
        mediaKind: args.mediaKind,
        size: args.size,
        sha256: args.sha256,
        storageKind: gallery.storageKind,
        storageKey: args.storageKey,
        thumbnailKey: args.thumbnailKey,
        exifJson: args.exifJson,
        filesystemModifiedAt: args.filesystemModifiedAt,
        filesystemIdentity: args.filesystemIdentity,
        passwordSalt: intent.passwordSalt,
        passwordHash: intent.passwordHash,
        passwordIterations: intent.passwordIterations,
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
      await ctx.db.patch("galleries", gallery._id, {
        itemCount: gallery.itemCount + (wasReady ? 0 : 1),
        totalBytes: Math.max(
          0,
          gallery.totalBytes + args.size - (wasReady ? existing.size : 0),
        ),
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
        alreadyProcessed: args.thumbnailKey !== undefined,
      });
      return existing._id;
    }
    const entryId = await ctx.db.insert("entries", {
      galleryId: gallery._id,
      folderId: intent.folderId,
      ownerProfileId: intent.ownerProfileId,
      uploadIntentId: intent._id,
      name: intent.name,
      description: intent.description,
      mimeType: args.actualMimeType,
      extension: args.extension,
      mediaKind: args.mediaKind,
      size: args.size,
      sha256: args.sha256,
      storageKind: gallery.storageKind,
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
      exifJson: args.exifJson,
      filesystemModifiedAt: args.filesystemModifiedAt,
      filesystemIdentity: args.filesystemIdentity,
      passwordSalt: intent.passwordSalt,
      passwordHash: intent.passwordHash,
      passwordIterations: intent.passwordIterations,
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
    await ctx.db.patch("galleries", gallery._id, {
      itemCount: gallery.itemCount + 1,
      totalBytes: gallery.totalBytes + args.size,
    });
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
    return entryId;
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
    const storageKey =
      ticket.disposition === "thumbnail"
        ? entry.thumbnailKey
        : entry.storageKey;
    if (storageKey === undefined) {
      throw new Error("Thumbnail is not available");
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
          views: counter.views + (ticket.disposition === "inline" ? 1 : 0),
          downloads:
            counter.downloads + (ticket.disposition === "attachment" ? 1 : 0),
        });
      }
    }
    return {
      entryId: entry._id,
      storageKey,
      mimeType:
        ticket.disposition === "thumbnail" ? "image/jpeg" : entry.mimeType,
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
        removePhysical: !references.some(
          (entry) =>
            entry._id !== deleteJob.entryId && entry.state === "ready",
        ),
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
    await ctx.db.patch("entries", entry._id, {
      storageKind: migration.targetStorageKind,
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
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
      deleteEntry: false,
      status: "queued",
      attempts: 0,
      availableAt: 0,
    });
    return null;
  },
});
