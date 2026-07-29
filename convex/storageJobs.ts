import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  STORAGE_JOB_LEASE_MS,
  STORAGE_JOB_MAX_ATTEMPTS,
  storageJobRetryDelay,
} from "./lib/storageJobs";

export const queueFilesystemSync = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
  },
  handler: async (ctx, args) => {
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.folderId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image" ||
      gallery.storageKind !== "user" ||
      gallery.pendingMigrationId !== undefined ||
      folder === null ||
      folder.galleryId !== gallery._id ||
      folder.filesystemMissingAt !== undefined
    ) {
      throw new Error("User-backed directory is unavailable");
    }

    const existingJobs = await ctx.db
      .query("filesystemSyncJobs")
      .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
      .take(16);
    const active = existingJobs.find(
      (job) => job.status === "queued" || job.status === "processing",
    );
    if (active !== undefined) {
      return { queued: false, jobId: active._id };
    }
    const reusable = existingJobs.find((job) => job.status === "failed");
    if (reusable !== undefined) {
      await ctx.db.patch("filesystemSyncJobs", reusable._id, {
        status: "queued",
        attempts: 0,
        availableAt: 0,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error: undefined,
      });
      return { queued: true, jobId: reusable._id };
    }
    const jobId = await ctx.db.insert("filesystemSyncJobs", {
      galleryId: gallery._id,
      folderId: folder._id,
      status: "queued",
      attempts: 0,
      availableAt: 0,
    });
    return { queued: true, jobId };
  },
});

export const claimFilesystemSync = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("filesystemSyncJobs")
      .withIndex("by_status_and_leaseExpiresAt", (q) =>
        q.eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .first();
    const queued = await ctx.db
      .query("filesystemSyncJobs")
      .withIndex("by_status_and_availableAt", (q) =>
        q.eq("status", "queued").lte("availableAt", now),
      )
      .first();
    const job = stale ?? queued;
    if (job === null) {
      return { kind: "none" as const };
    }
    const attempts = job.attempts + 1;
    if (attempts > STORAGE_JOB_MAX_ATTEMPTS) {
      await ctx.db.patch("filesystemSyncJobs", job._id, {
        status: "failed",
        leaseExpiresAt: undefined,
        error: job.error ?? "Filesystem synchronization exhausted its retries",
      });
      return { kind: "none" as const };
    }
    await ctx.db.patch("filesystemSyncJobs", job._id, {
      status: "processing",
      attempts,
      claimedAt: now,
      leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
      error: undefined,
    });
    return {
      kind: "ready" as const,
      jobId: job._id,
      galleryId: job.galleryId,
      folderId: job.folderId,
    };
  },
});

export const renewFilesystemSync = internalMutation({
  args: { jobId: v.id("filesystemSyncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("filesystemSyncJobs", args.jobId);
    if (job === null || job.status !== "processing") {
      throw new Error("Filesystem synchronization job is no longer active");
    }
    await ctx.db.patch("filesystemSyncJobs", job._id, {
      leaseExpiresAt: Date.now() + STORAGE_JOB_LEASE_MS,
    });
    return null;
  },
});

export const completeFilesystemSync = internalMutation({
  args: {
    jobId: v.id("filesystemSyncJobs"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("filesystemSyncJobs", args.jobId);
    if (job === null) return null;
    if (args.error === undefined) {
      await ctx.db.delete("filesystemSyncJobs", job._id);
      return null;
    }
    const error = args.error.slice(0, 1000);
    if (job.attempts >= STORAGE_JOB_MAX_ATTEMPTS) {
      await ctx.db.patch("filesystemSyncJobs", job._id, {
        status: "failed",
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error,
      });
    } else {
      await ctx.db.patch("filesystemSyncJobs", job._id, {
        status: "queued",
        availableAt: Date.now() + storageJobRetryDelay(job.attempts),
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error,
      });
    }
    return null;
  },
});

export const claimMediaProcessing = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("mediaProcessingJobs")
      .withIndex("by_status_and_leaseExpiresAt", (q) =>
        q.eq("status", "processing").lte("leaseExpiresAt", now),
      )
      .first();
    const queued = await ctx.db
      .query("mediaProcessingJobs")
      .withIndex("by_status_and_availableAt", (q) =>
        q.eq("status", "queued").lte("availableAt", now),
      )
      .first();
    const job = stale ?? queued;
    if (job === null) {
      return { kind: "none" as const };
    }
    const entry = await ctx.db.get("entries", job.entryId);
    const gallery =
      entry === null ? null : await ctx.db.get("galleries", entry.galleryId);
    if (
      entry === null ||
      gallery === null ||
      entry.state !== "ready" ||
      entry.storageKey !== job.expectedStorageKey ||
      entry.sha256 !== job.expectedSha256 ||
      (entry.mediaKind !== "image" && entry.mediaKind !== "video")
    ) {
      await ctx.db.delete("mediaProcessingJobs", job._id);
      return { kind: "none" as const };
    }
    const attempts = job.attempts + 1;
    if (attempts > STORAGE_JOB_MAX_ATTEMPTS) {
      await ctx.db.patch("mediaProcessingJobs", job._id, {
        status: "failed",
        leaseExpiresAt: undefined,
        error: job.error ?? "Media processing exhausted its retries",
      });
      return { kind: "none" as const };
    }
    await ctx.db.patch("mediaProcessingJobs", job._id, {
      status: "processing",
      attempts,
      claimedAt: now,
      leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
      error: undefined,
    });
    return {
      kind: "ready" as const,
      jobId: job._id,
      entryId: entry._id,
      storageKey: entry.storageKey,
      sha256: entry.sha256,
      extension: entry.extension,
      mediaKind: entry.mediaKind as "image" | "video",
      galleryKind: gallery.kind,
      storageKind: entry.storageKind,
      storageRoot: gallery.storageRoot,
      size: entry.size,
      filesystemModifiedAt: entry.filesystemModifiedAt,
    };
  },
});

export const renewMediaProcessing = internalMutation({
  args: { jobId: v.id("mediaProcessingJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("mediaProcessingJobs", args.jobId);
    if (job === null || job.status !== "processing") {
      throw new Error("Media processing job is no longer active");
    }
    await ctx.db.patch("mediaProcessingJobs", job._id, {
      leaseExpiresAt: Date.now() + STORAGE_JOB_LEASE_MS,
    });
    return null;
  },
});

export const completeMediaProcessing = internalMutation({
  args: {
    jobId: v.id("mediaProcessingJobs"),
    thumbnailKey: v.optional(v.string()),
    exifJson: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get("mediaProcessingJobs", args.jobId);
    if (job === null) return null;
    if (args.error !== undefined) {
      const error = args.error.slice(0, 1000);
      if (job.attempts >= STORAGE_JOB_MAX_ATTEMPTS) {
        await ctx.db.patch("mediaProcessingJobs", job._id, {
          status: "failed",
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
      } else {
        await ctx.db.patch("mediaProcessingJobs", job._id, {
          status: "queued",
          availableAt: Date.now() + storageJobRetryDelay(job.attempts),
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
      }
      return null;
    }
    const entry = await ctx.db.get("entries", job.entryId);
    if (
      entry !== null &&
      entry.state === "ready" &&
      entry.storageKey === job.expectedStorageKey &&
      entry.sha256 === job.expectedSha256
    ) {
      await ctx.db.patch("entries", entry._id, {
        thumbnailKey: args.thumbnailKey,
        exifJson: args.exifJson,
        updatedAt: Date.now(),
      });
    }
    await ctx.db.delete("mediaProcessingJobs", job._id);
    return null;
  },
});

export const recoverStaleRequests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const uploads = await ctx.db
      .query("uploadIntents")
      .withIndex("by_state_and_leaseExpiresAt", (q) =>
        q.eq("state", "uploading").lte("leaseExpiresAt", now),
      )
      .take(32);
    let recovered = 0;
    for (const intent of uploads) {
      await ctx.db.patch("uploadIntents", intent._id, {
        state: "failed",
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        error: "Upload was interrupted before it completed",
      });
      recovered += 1;
    }
    const pendingUploads = await ctx.db
      .query("uploadIntents")
      .withIndex("by_state_and_expiresAt", (q) =>
        q.eq("state", "pending").lte("expiresAt", now),
      )
      .take(32);
    for (const intent of pendingUploads) {
      await ctx.db.patch("uploadIntents", intent._id, {
        state: "failed",
        error: "Upload intent expired before it was claimed",
      });
      recovered += 1;
    }
    const pendingOperations = await ctx.db
      .query("filesystemOperations")
      .withIndex("by_state_and_expiresAt", (q) =>
        q.eq("state", "pending").lte("expiresAt", now),
      )
      .take(32);
    for (const operation of pendingOperations) {
      await ctx.db.patch("filesystemOperations", operation._id, {
        state: "failed",
        error: "Filesystem operation expired before it was claimed",
      });
      recovered += 1;
    }
    return { recovered };
  },
});
