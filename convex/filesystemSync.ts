import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { createToken, sha256 } from "./lib/crypto";
import { adjustGalleryStats } from "./lib/galleryStats";
import {
  adjustFolderStats,
  createFolderStats,
  deleteFolderStats,
  settleReadyEntry,
} from "./lib/folderStats";
import {
  getFilesystemFolderSegments,
  getFilesystemStorageKey,
} from "./lib/filesystem";
import {
  replaceMediaProcessingJob,
  STORAGE_JOB_LEASE_MS,
  STORAGE_JOB_MAX_ATTEMPTS,
  storageJobRetryDelay,
} from "./lib/storageJobs";
import {
  entryNameKey,
  fileExtensionFromName,
  filesystemSlug,
  validateFilesystemSegment,
} from "./lib/normalize";
import { mediaKind } from "./lib/validators";
import { ensureUnknownUploaderProfile } from "./lib/profiles";

const SYNC_LEASE_MS = STORAGE_JOB_LEASE_MS;
const SYNC_LEASE_RENEW_THRESHOLD_MS = SYNC_LEASE_MS / 2;
// Batch sizes keep each mutation's reads and writes bounded; directories of
// any size are handled by continuing across calls instead of failing.
const SYNC_SWEEP_PAGE = 200;
const CHILD_FOLDER_PAGE = 500;

async function requireUserDirectory(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
  folderId: Id<"folders">,
) {
  const [gallery, folder] = await Promise.all([
    ctx.db.get("galleries", galleryId),
    ctx.db.get("folders", folderId),
  ]);
  if (
    gallery === null ||
    gallery.deletedAt !== undefined ||
    gallery.kind !== "image" ||
    gallery.storageKind !== "user" ||
    folder === null ||
    folder.galleryId !== gallery._id ||
    folder.filesystemMissingAt !== undefined
  ) {
    throw new Error("User-backed directory is unavailable");
  }
  if (gallery.pendingMigrationId !== undefined) {
    throw new Error("Filesystem checks are paused during storage migration");
  }
  return { gallery, folder };
}

async function requireActiveSync(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
  folderId: Id<"folders">,
  syncId: string,
) {
  const { gallery, folder } = await requireUserDirectory(
    ctx,
    galleryId,
    folderId,
  );
  const state = await ctx.db
    .query("filesystemSyncStates")
    .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
    .unique();
  const now = Date.now();
  if (
    state === null ||
    state.activeSyncId !== syncId ||
    (state.leaseExpiresAt ?? 0) < now
  ) {
    throw new Error("Filesystem sync lease is no longer active");
  }
  if ((state.leaseExpiresAt ?? 0) < now + SYNC_LEASE_RENEW_THRESHOLD_MS) {
    await ctx.db.patch("filesystemSyncStates", state._id, {
      leaseExpiresAt: now + SYNC_LEASE_MS,
    });
  }
  return { gallery, folder, state };
}

function validateFileMetadata(input: {
  name: string;
  size: number;
  modifiedAt: number;
  identity: string;
  storageKey: string;
}) {
  validateFilesystemSegment(input.name);
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !Number.isFinite(input.modifiedAt) ||
    input.modifiedAt < 0 ||
    input.identity.length < 1 ||
    input.identity.length > 200 ||
    input.storageKey.length < 1 ||
    input.storageKey.length > 1000
  ) {
    throw new Error("Invalid filesystem metadata");
  }
}

export const claimFilesystemSync = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
  },
  handler: async (ctx, args) => {
    const { gallery, folder } = await requireUserDirectory(
      ctx,
      args.galleryId,
      args.folderId,
    );
    const now = Date.now();
    const state = await ctx.db
      .query("filesystemSyncStates")
      .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
      .unique();
    if (
      state?.activeSyncId !== undefined &&
      (state.leaseExpiresAt ?? 0) >= now
    ) {
      return {
        kind: "busy" as const,
        retryAfterMs: Math.max(1, (state.leaseExpiresAt ?? now) - now),
      };
    }
    const syncId = createToken();
    if (state === null) {
      await ctx.db.insert("filesystemSyncStates", {
        galleryId: gallery._id,
        folderId: folder._id,
        activeSyncId: syncId,
        leaseExpiresAt: now + SYNC_LEASE_MS,
      });
    } else {
      await ctx.db.patch("filesystemSyncStates", state._id, {
        activeSyncId: syncId,
        leaseExpiresAt: now + SYNC_LEASE_MS,
        error: undefined,
      });
    }
    return {
      kind: "ready" as const,
      syncId,
      storageRoot: gallery.storageRoot,
      folderSegments: await getFilesystemFolderSegments(ctx, gallery, folder),
      knownModifiedAt: state?.knownModifiedAt,
      maxFileSize: gallery.maxFileSize,
    };
  },
});

// Pages through a directory's tracked subfolders so the worker can recurse
// into them without any single call loading the whole set.
export const listKnownChildFolders = internalQuery({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const folder = await ctx.db.get("folders", args.folderId);
    if (folder === null || folder.galleryId !== args.galleryId) {
      throw new Error("User-backed directory is unavailable");
    }
    const page = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", args.galleryId).eq("parentId", folder._id),
      )
      .paginate({ numItems: CHILD_FOLDER_PAGE, cursor: args.cursor ?? null });
    return {
      folderIds: page.page
        .filter((child) => child.filesystemMissingAt === undefined)
        .map((child) => child._id),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const compareFilesystemDirectory = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
    modifiedAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.modifiedAt) || args.modifiedAt < 0) {
      throw new Error("Invalid directory modification time");
    }
    const { state } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    if (state.knownModifiedAt === args.modifiedAt) {
      await ctx.db.patch("filesystemSyncStates", state._id, {
        activeSyncId: undefined,
        leaseExpiresAt: undefined,
        lastCheckedAt: Date.now(),
        error: undefined,
      });
      return { shouldScan: false };
    }
    return { shouldScan: true };
  },
});

export const renewFilesystemSyncLease = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
  },
  handler: async (ctx, args) => {
    const { state } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    await ctx.db.patch("filesystemSyncStates", state._id, {
      leaseExpiresAt: Date.now() + SYNC_LEASE_MS,
    });
    return null;
  },
});

export const reconcileFilesystemDirectory = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    parentId: v.id("folders"),
    syncId: v.string(),
    name: v.string(),
    identity: v.string(),
  },
  handler: async (ctx, args) => {
    const { gallery, folder: parent } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.parentId,
      args.syncId,
    );
    const name = validateFilesystemSegment(args.name);
    if (args.identity.length < 1 || args.identity.length > 200) {
      throw new Error("Invalid filesystem identity");
    }
    const existing =
      (await ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId_and_name", (q) =>
          q
            .eq("galleryId", gallery._id)
            .eq("parentId", parent._id)
            .eq("name", name),
        )
        .first()) ??
      (await ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId_and_filesystemIdentity", (q) =>
          q
            .eq("galleryId", gallery._id)
            .eq("parentId", parent._id)
            .eq("filesystemIdentity", args.identity),
        )
        .first()) ??
      undefined;
    if (existing !== undefined) {
      await ctx.db.patch("folders", existing._id, {
        name,
        slug: filesystemSlug(name),
        filesystemIdentity: args.identity,
        filesystemSyncId: args.syncId,
        filesystemMissingAt: undefined,
      });
      return existing._id;
    }
    const folderId = await ctx.db.insert("folders", {
      galleryId: gallery._id,
      parentId: parent._id,
      ancestorIds: [...parent.ancestorIds, parent._id],
      name,
      slug: filesystemSlug(name),
      accessPolicy: "inherit",
      discoverability: "listed",
      filesystemIdentity: args.identity,
      filesystemSyncId: args.syncId,
    });
    await createFolderStats(ctx, folderId, gallery._id);
    return folderId;
  },
});

export const checkFilesystemFile = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
    name: v.string(),
    storageKey: v.string(),
    size: v.number(),
    modifiedAt: v.number(),
    identity: v.string(),
  },
  handler: async (ctx, args) => {
    const { gallery, folder } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    validateFileMetadata(args);
    const expectedPrefix = `public/users/${gallery.storageRoot}/`;
    if (!args.storageKey.startsWith(expectedPrefix)) {
      throw new Error("Filesystem key is outside this gallery");
    }
    const exact = await ctx.db
      .query("entries")
      .withIndex("by_storageKey", (q) => q.eq("storageKey", args.storageKey))
      .unique();
    const existing =
      exact ??
      (await ctx.db
        .query("entries")
        .withIndex("by_folderId_and_filesystemIdentity", (q) =>
          q
            .eq("folderId", folder._id)
            .eq("filesystemIdentity", args.identity),
        )
        .filter((q) => q.eq(q.field("state"), "ready"))
        .first());
    if (
      existing !== null &&
      existing.galleryId === gallery._id &&
      existing.folderId === folder._id &&
      existing.state === "ready" &&
      existing.name === args.name &&
      existing.size === args.size &&
      existing.filesystemModifiedAt === args.modifiedAt &&
      existing.filesystemIdentity === args.identity
    ) {
      await ctx.db.patch("entries", existing._id, {
        filesystemSyncId: args.syncId,
      });
      return { kind: "unchanged" as const };
    }
    return {
      kind: "metadata" as const,
      entryId:
        existing !== null &&
        existing.galleryId === gallery._id &&
        existing.folderId === folder._id
          ? existing._id
          : undefined,
    };
  },
});

export const reconcileFilesystemFile = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
    entryId: v.optional(v.id("entries")),
    name: v.string(),
    storageKey: v.string(),
    size: v.number(),
    modifiedAt: v.number(),
    identity: v.string(),
    mimeType: v.string(),
    extension: v.string(),
    mediaKind,
    sha256: v.string(),
    thumbnailKey: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { gallery, folder } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    validateFileMetadata(args);
    if (
      args.size > gallery.maxFileSize ||
      args.mimeType.length > 200 ||
      args.extension.length > 16 ||
      args.sha256.length !== 64 ||
      args.thumbnailKey !== undefined && args.thumbnailKey.length > 1000 ||
      args.metadataJson !== undefined && args.metadataJson.length > 100_000
    ) {
      throw new Error("Filesystem file metadata is invalid");
    }
    let existing =
      args.entryId === undefined ? null : await ctx.db.get("entries", args.entryId);
    if (
      existing !== null &&
      (existing.galleryId !== gallery._id || existing.folderId !== folder._id)
    ) {
      existing = null;
    }
    if (existing === null) {
      existing = await ctx.db
        .query("entries")
        .withIndex("by_storageKey", (q) => q.eq("storageKey", args.storageKey))
        .unique();
    }
    const now = Date.now();
    if (existing !== null && existing.galleryId === gallery._id) {
      const wasReady = existing.state === "ready";
      const contentChanged = existing.sha256 !== args.sha256;
      const stalePreviewKey = contentChanged ? existing.previewKey : undefined;
      await ctx.db.patch("entries", existing._id, {
        folderId: folder._id,
        name: args.name,
        nameKey: entryNameKey(args.name),
        mimeType: args.mimeType,
        extension: args.extension,
        mediaKind: args.mediaKind,
        size: args.size,
        sha256: args.sha256,
        storageKind: "user",
        storageKey: args.storageKey,
        thumbnailKey: args.thumbnailKey,
        previewKey: contentChanged ? undefined : existing.previewKey,
        previewError: contentChanged ? undefined : existing.previewError,
        metadataJson: args.metadataJson,
        filesystemModifiedAt: args.modifiedAt,
        filesystemIdentity: args.identity,
        filesystemSyncId: args.syncId,
        state: "ready",
        deletedAt: undefined,
        updatedAt: now,
      });
      const deleteJobs = await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", existing!._id))
        .take(16);
      for (const job of deleteJobs) {
        await ctx.db.delete("storageDeleteJobs", job._id);
      }
      if (stalePreviewKey !== undefined) {
        await ctx.db.insert("storageDeleteJobs", {
          entryId: existing._id,
          storageKey: args.storageKey,
          previewKey: stalePreviewKey,
          deleteOriginal: false,
          deleteEntry: false,
          status: "queued",
          attempts: 0,
          availableAt: 0,
        });
      }
      let counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", existing._id))
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
        folderId: folder._id,
        galleryId: gallery._id,
        size: args.size,
        previous: wasReady ? existing : undefined,
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

    const unknownUploader = await ensureUnknownUploaderProfile(ctx);
    const entryId = await ctx.db.insert("entries", {
      galleryId: gallery._id,
      folderId: folder._id,
      ownerProfileId: unknownUploader._id,
      name: args.name,
      nameKey: entryNameKey(args.name),
      mimeType: args.mimeType,
      extension: args.extension,
      mediaKind: args.mediaKind,
      size: args.size,
      sha256: args.sha256,
      storageKind: "user",
      storageKey: args.storageKey,
      thumbnailKey: args.thumbnailKey,
      metadataJson: args.metadataJson,
      filesystemModifiedAt: args.modifiedAt,
      filesystemIdentity: args.identity,
      filesystemSyncId: args.syncId,
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
      { folderId: folder._id, galleryId: gallery._id },
      { items: 1, bytes: args.size },
    );
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

// Completion sweeps the folder for entries and subfolders the scan did not
// touch, in worker-driven batches: each call processes one page and returns a
// continuation cursor until it can finalize the sync state. The lease stays
// held between calls, so no competing scan can interleave with the sweep.
export const completeFilesystemSync = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
    modifiedAt: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { gallery, folder, state } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    let phase: "entries" | "folders" = "entries";
    let innerCursor: string | null = null;
    if (args.cursor !== undefined) {
      const separator = args.cursor.indexOf(":");
      const prefix = args.cursor.slice(0, separator);
      if (separator < 0 || (prefix !== "entries" && prefix !== "folders")) {
        throw new Error("Invalid filesystem sweep cursor");
      }
      phase = prefix;
      innerCursor = args.cursor.slice(separator + 1) || null;
    }
    if (phase === "entries") {
      const page = await ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", folder._id).eq("state", "ready"),
        )
        .paginate({ numItems: SYNC_SWEEP_PAGE, cursor: innerCursor });
      let removedItems = 0;
      let removedBytes = 0;
      for (const entry of page.page) {
        if (
          entry.storageKind === "user" &&
          entry.filesystemSyncId !== args.syncId
        ) {
          const counter = await ctx.db
            .query("entryCounters")
            .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
            .unique();
          if (counter !== null) {
            await ctx.db.delete("entryCounters", counter._id);
          }
          if (
            entry.thumbnailKey !== undefined ||
            entry.previewKey !== undefined
          ) {
            await ctx.db.insert("storageDeleteJobs", {
              entryId: entry._id,
              storageKey: entry.storageKey,
              thumbnailKey: entry.thumbnailKey,
              previewKey: entry.previewKey,
              deleteOriginal: false,
              deleteEntry: false,
              status: "queued",
              attempts: 0,
              availableAt: 0,
            });
          }
          await ctx.db.delete("entries", entry._id);
          removedItems += 1;
          removedBytes += entry.size;
        }
      }
      if (removedItems > 0) {
        await adjustGalleryStats(ctx, gallery, {
          items: -removedItems,
          bytes: -removedBytes,
        });
        await adjustFolderStats(
          ctx,
          { folderId: folder._id, galleryId: gallery._id },
          { items: -removedItems, bytes: -removedBytes },
        );
      }
      // Convex allows one .paginate() per function execution, so the folder
      // phase always starts in a fresh call.
      return {
        done: false as const,
        cursor: page.isDone ? "folders:" : `entries:${page.continueCursor}`,
      };
    }
    const children = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", folder._id),
      )
      .paginate({ numItems: SYNC_SWEEP_PAGE, cursor: innerCursor });
    for (const child of children.page) {
      if (child.filesystemSyncId !== args.syncId) {
        await ctx.db.patch("folders", child._id, {
          filesystemMissingAt: Date.now(),
        });
        await ctx.scheduler.runAfter(
          0,
          internal.filesystemSync.cleanupMissingFolder,
          { folderId: child._id },
        );
      }
    }
    if (!children.isDone) {
      return {
        done: false as const,
        cursor: `folders:${children.continueCursor}`,
      };
    }
    const now = Date.now();
    await ctx.db.patch("filesystemSyncStates", state._id, {
      knownModifiedAt: args.modifiedAt,
      activeSyncId: undefined,
      leaseExpiresAt: undefined,
      lastCheckedAt: now,
      lastCompletedAt: now,
      error: undefined,
    });
    return { done: true as const };
  },
});

// One-time repair after the verbatim-name fix: forget every directory's
// recorded modification time so its next open runs a full rescan, which
// re-reconciles children by inode identity and heals names that were stored
// NFKC-normalized. Safe to run repeatedly. Run with:
//   npx convex run filesystemSync:rescanAllDirectories
export const rescanAllDirectories = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("filesystemSyncStates")
      .paginate({ numItems: SYNC_SWEEP_PAGE, cursor: args.cursor ?? null });
    for (const state of page.page) {
      await ctx.db.patch("filesystemSyncStates", state._id, {
        knownModifiedAt: undefined,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.filesystemSync.rescanAllDirectories,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

export const failFilesystemSync = internalMutation({
  args: {
    folderId: v.id("folders"),
    syncId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("filesystemSyncStates")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .unique();
    if (state !== null && state.activeSyncId === args.syncId) {
      await ctx.db.patch("filesystemSyncStates", state._id, {
        activeSyncId: undefined,
        leaseExpiresAt: undefined,
        lastCheckedAt: Date.now(),
        error: args.error.slice(0, 1000),
      });
    }
    return null;
  },
});

export const cleanupMissingFolder = internalMutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const folder = await ctx.db.get("folders", args.folderId);
    if (folder === null || folder.filesystemMissingAt === undefined) {
      return null;
    }
    const gallery = await ctx.db.get("galleries", folder.galleryId);
    if (gallery === null || gallery.rootFolderId === folder._id) {
      return null;
    }
    const entries = await ctx.db
      .query("entries")
      .withIndex("by_folderId_and_state", (q) =>
        q.eq("folderId", folder._id).eq("state", "ready"),
      )
      .take(32);
    let removedBytes = 0;
    for (const entry of entries) {
      const counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique();
      if (counter !== null) {
        await ctx.db.delete("entryCounters", counter._id);
      }
      // User-backed originals disappear with the directory itself, so only
      // derived assets need deletion; shared originals must be deleted too.
      const deleteOriginal = entry.storageKind !== "user";
      if (
        deleteOriginal ||
        entry.thumbnailKey !== undefined ||
        entry.previewKey !== undefined
      ) {
        await ctx.db.insert("storageDeleteJobs", {
          entryId: entry._id,
          storageKey: entry.storageKey,
          thumbnailKey: entry.thumbnailKey,
          previewKey: entry.previewKey,
          deleteOriginal,
          deleteEntry: false,
          status: "queued",
          attempts: 0,
          availableAt: 0,
        });
      }
      await ctx.db.delete("entries", entry._id);
      removedBytes += entry.size;
    }
    if (entries.length > 0) {
      await adjustGalleryStats(ctx, gallery, {
        items: -entries.length,
        bytes: -removedBytes,
      });
      await adjustFolderStats(
        ctx,
        { folderId: folder._id, galleryId: gallery._id },
        { items: -entries.length, bytes: -removedBytes },
      );
      await ctx.scheduler.runAfter(
        0,
        internal.filesystemSync.cleanupMissingFolder,
        args,
      );
      return null;
    }
    const children = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", folder._id),
      )
      .take(32);
    if (children.length > 0) {
      for (const child of children) {
        if (child.filesystemMissingAt === undefined) {
          await ctx.db.patch("folders", child._id, {
            filesystemMissingAt: Date.now(),
          });
        }
        await ctx.scheduler.runAfter(
          0,
          internal.filesystemSync.cleanupMissingFolder,
          { folderId: child._id },
        );
      }
      await ctx.scheduler.runAfter(
        250,
        internal.filesystemSync.cleanupMissingFolder,
        args,
      );
      return null;
    }
    const grants = await ctx.db
      .query("galleryRoles")
      .withIndex("by_galleryId_and_folderId", (q) =>
        q.eq("galleryId", gallery._id).eq("folderId", folder._id),
      )
      .take(128);
    for (const grant of grants) {
      await ctx.db.delete("galleryRoles", grant._id);
    }
    if (grants.length === 128) {
      await ctx.scheduler.runAfter(
        0,
        internal.filesystemSync.cleanupMissingFolder,
        args,
      );
      return null;
    }
    const syncState = await ctx.db
      .query("filesystemSyncStates")
      .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
      .unique();
    if (syncState !== null) {
      await ctx.db.delete("filesystemSyncStates", syncState._id);
    }
    await deleteFolderStats(ctx, folder._id);
    await ctx.db.delete("folders", folder._id);
    return null;
  },
});

async function filesystemOperationClaim(
  ctx: MutationCtx,
  operation: Doc<"filesystemOperations">,
) {
  const { gallery, folder: parent } = await requireUserDirectory(
    ctx,
    operation.galleryId,
    operation.parentId,
  );
  const parentSegments = await getFilesystemFolderSegments(ctx, gallery, parent);
  let sourceSegments: string[] | undefined;
  if (operation.kind === "fileRename") {
    if (operation.entryId === undefined) {
      throw new Error("File rename operation has no file");
    }
    const entry = await ctx.db.get("entries", operation.entryId);
    const claimedByThisOperation =
      entry?.migrationState === "moving" &&
      entry?.filesystemOperationId === operation._id;
    const available =
      entry?.migrationState === undefined &&
      entry?.filesystemOperationId === undefined;
    if (
      entry === null ||
      entry.galleryId !== gallery._id ||
      entry.folderId !== parent._id ||
      entry.storageKind !== "user" ||
      entry.state !== "ready" ||
      (!claimedByThisOperation && !available)
    ) {
      throw new Error("File is unavailable");
    }
    sourceSegments = [...parentSegments, validateFilesystemSegment(entry.name)];
    await ctx.db.patch("entries", entry._id, {
      filesystemOperationId: operation._id,
      migrationState: "moving",
      migrationClaimedAt: Date.now(),
      migrationAttempts: (operation.attempts ?? 0) + 1,
      migrationError: undefined,
      updatedAt: Date.now(),
    });
  } else if (operation.kind === "rename" || operation.kind === "rmdir") {
    if (operation.folderId === undefined) {
      throw new Error("Folder operation has no folder");
    }
    const folder = await ctx.db.get("folders", operation.folderId);
    if (
      folder === null ||
      folder.parentId !== parent._id ||
      gallery.rootFolderId === folder._id
    ) {
      throw new Error("Folder is unavailable");
    }
    sourceSegments = await getFilesystemFolderSegments(ctx, gallery, folder);
  } else if (operation.kind === "move") {
    // A move's parent is the destination folder, so the folder being moved
    // starts somewhere else and must not contain its destination.
    if (operation.folderId === undefined) {
      throw new Error("Folder operation has no folder");
    }
    const folder = await ctx.db.get("folders", operation.folderId);
    if (
      folder === null ||
      folder.galleryId !== gallery._id ||
      folder.filesystemMissingAt !== undefined ||
      folder.parentId === undefined ||
      gallery.rootFolderId === folder._id ||
      folder.name !== operation.name ||
      parent._id === folder._id ||
      parent.ancestorIds.includes(folder._id)
    ) {
      throw new Error("Folder is unavailable");
    }
    sourceSegments = await getFilesystemFolderSegments(ctx, gallery, folder);
  }
  const now = Date.now();
  await ctx.db.patch("filesystemOperations", operation._id, {
    state: "uploading",
    attempts: (operation.attempts ?? 0) + 1,
    claimedAt: now,
    leaseExpiresAt: now + STORAGE_JOB_LEASE_MS,
    error: undefined,
  });
  return {
    operationId: operation._id,
    kind: operation.kind,
    storageRoot: gallery.storageRoot,
    sourceSegments,
    destinationSegments: [...parentSegments, operation.name],
  };
}

export const claimFilesystemOperation = internalMutation({
  args: {
    operationId: v.id("filesystemOperations"),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("filesystemOperations", args.operationId);
    const now = Date.now();
    if (
      operation === null ||
      operation.tokenHash !== (await sha256(args.token)) ||
      !(
        (operation.state === "pending" && operation.expiresAt >= now) ||
        (operation.state === "uploading" &&
          (operation.leaseExpiresAt ?? 0) < now)
      )
    ) {
      throw new Error("Filesystem operation is invalid or expired");
    }
    return await filesystemOperationClaim(ctx, operation);
  },
});

export const claimRecoverableFilesystemOperation = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const operation = await ctx.db
      .query("filesystemOperations")
      .withIndex("by_state_and_leaseExpiresAt", (q) =>
        q.eq("state", "uploading").lte("leaseExpiresAt", now),
      )
      .first();
    if (operation === null) {
      return { kind: "none" as const };
    }
    if ((operation.attempts ?? 0) >= STORAGE_JOB_MAX_ATTEMPTS) {
      await ctx.db.patch("filesystemOperations", operation._id, {
        state: "failed",
        leaseExpiresAt: undefined,
        error: operation.error ?? "Filesystem operation exhausted its retries",
      });
      return { kind: "none" as const };
    }
    return {
      kind: "ready" as const,
      operation: await filesystemOperationClaim(ctx, operation),
    };
  },
});

export const renewFilesystemOperation = internalMutation({
  args: { operationId: v.id("filesystemOperations") },
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("filesystemOperations", args.operationId);
    if (operation === null || operation.state !== "uploading") {
      throw new Error("Filesystem operation is no longer active");
    }
    await ctx.db.patch("filesystemOperations", operation._id, {
      leaseExpiresAt: Date.now() + STORAGE_JOB_LEASE_MS,
    });
    return null;
  },
});

export const completeFilesystemOperation = internalMutation({
  args: {
    operationId: v.id("filesystemOperations"),
    identity: v.optional(v.string()),
    modifiedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("filesystemOperations", args.operationId);
    if (operation === null || operation.state !== "uploading") {
      throw new Error("Filesystem operation is not active");
    }
    if (operation.kind !== "rmdir" && args.identity === undefined) {
      throw new Error("Filesystem operation result has no identity");
    }
    const [gallery, parent] = await Promise.all([
      ctx.db.get("galleries", operation.galleryId),
      ctx.db.get("folders", operation.parentId),
    ]);
    if (gallery === null || parent === null) {
      throw new Error("Filesystem operation target no longer exists");
    }
    let folderId = operation.folderId;
    if (operation.kind === "fileRename") {
      if (operation.entryId === undefined || args.modifiedAt === undefined) {
        throw new Error("File rename operation is incomplete");
      }
      const entry = await ctx.db.get("entries", operation.entryId);
      if (
        entry === null ||
        entry.galleryId !== gallery._id ||
        entry.folderId !== parent._id ||
        entry.storageKind !== "user" ||
        entry.state !== "ready" ||
        entry.migrationState !== "moving" ||
        entry.filesystemOperationId !== operation._id
      ) {
        throw new Error("File is no longer available");
      }
      const folderSegments = await getFilesystemFolderSegments(
        ctx,
        gallery,
        parent,
      );
      const now = Date.now();
      await ctx.db.patch("entries", entry._id, {
        name: operation.name,
        nameKey: entryNameKey(operation.name),
        extension: fileExtensionFromName(operation.name, entry.extension),
        storageKey: getFilesystemStorageKey(
          gallery,
          folderSegments,
          operation.name,
        ),
        filesystemModifiedAt: args.modifiedAt,
        filesystemIdentity: args.identity,
        filesystemSyncId: undefined,
        filesystemOperationId: undefined,
        migrationState: undefined,
        migrationClaimedAt: undefined,
        migrationAttempts: undefined,
        migrationRetryAt: undefined,
        migrationError: undefined,
        updatedAt: now,
      });
    } else if (operation.kind === "mkdir") {
      const { accessPolicy, discoverability } = operation;
      if (accessPolicy === undefined || discoverability === undefined) {
        throw new Error("Folder create operation has no access settings");
      }
      const existing = await ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId_and_name", (q) =>
          q
            .eq("galleryId", gallery._id)
            .eq("parentId", parent._id)
            .eq("name", operation.name),
        )
        .first();
      if (existing !== null) {
        folderId = existing._id;
        await ctx.db.patch("folders", existing._id, {
          accessPolicy,
          discoverability,
          previewMode: operation.previewMode,
          previewSource: operation.previewSource,
          filesystemIdentity: args.identity,
          filesystemMissingAt: undefined,
        });
      } else {
        folderId = await ctx.db.insert("folders", {
          galleryId: gallery._id,
          parentId: parent._id,
          ancestorIds: [...parent.ancestorIds, parent._id],
          name: operation.name,
          slug: filesystemSlug(operation.name),
          accessPolicy,
          discoverability,
          previewMode: operation.previewMode,
          previewSource: operation.previewSource,
          filesystemIdentity: args.identity,
        });
        await createFolderStats(ctx, folderId, gallery._id);
      }
    } else if (operation.kind === "rmdir") {
      if (folderId === undefined) {
        throw new Error("Folder operation has no folder");
      }
      const folder = await ctx.db.get("folders", folderId);
      if (folder !== null && folder.galleryId === gallery._id) {
        if (folder.filesystemMissingAt === undefined) {
          await ctx.db.patch("folders", folder._id, {
            filesystemMissingAt: Date.now(),
          });
        }
        await ctx.scheduler.runAfter(
          0,
          internal.filesystemSync.cleanupMissingFolder,
          { folderId: folder._id },
        );
      }
    } else if (operation.kind === "move") {
      if (folderId === undefined) {
        throw new Error("Move operation has no folder");
      }
      const folder = await ctx.db.get("folders", folderId);
      if (
        folder === null ||
        folder.galleryId !== gallery._id ||
        parent._id === folder._id ||
        parent.ancestorIds.includes(folder._id)
      ) {
        throw new Error("Folder is no longer available");
      }
      await ctx.db.patch("folders", folder._id, {
        parentId: parent._id,
        ancestorIds: [...parent.ancestorIds, parent._id],
        filesystemIdentity: args.identity,
        filesystemMissingAt: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.folders.reparentSubtree, {
        folderId: folder._id,
      });
    } else {
      if (folderId === undefined) {
        throw new Error("Rename operation has no folder");
      }
      // The folder's settings are not touched here: they were applied when
      // the rename was requested, and may have been edited again since.
      await ctx.db.patch("folders", folderId, {
        name: operation.name,
        slug: filesystemSlug(operation.name),
        filesystemIdentity: args.identity,
        filesystemMissingAt: undefined,
      });
      // The rename changed every descendant path on disk; repair the
      // subtree's stored storage keys to match.
      await ctx.scheduler.runAfter(0, internal.folders.reparentSubtree, {
        folderId,
      });
    }
    await ctx.db.patch("filesystemOperations", operation._id, {
      state: "complete",
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      error: undefined,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: operation.actorProfileId,
      action:
        operation.kind === "mkdir"
          ? "filesystem_folder.created"
          : operation.kind === "rename"
            ? "filesystem_folder.renamed"
            : operation.kind === "rmdir"
              ? "filesystem_folder.deleted"
              : operation.kind === "move"
                ? "filesystem_folder.moved"
                : "filesystem_file.renamed",
      galleryId: gallery._id,
      detail: operation.name,
      createdAt: Date.now(),
    });
    return {
      folderId:
        operation.kind === "fileRename" || operation.kind === "rmdir"
          ? null
          : (folderId ?? null),
      entryId:
        operation.kind === "fileRename" ? (operation.entryId ?? null) : null,
    };
  },
});

export const failFilesystemOperation = internalMutation({
  args: {
    operationId: v.id("filesystemOperations"),
    error: v.string(),
    retry: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("filesystemOperations", args.operationId);
    if (operation !== null && operation.state !== "complete") {
      const error = args.error.slice(0, 1000);
      if (
        args.retry === true &&
        (operation.attempts ?? 0) < STORAGE_JOB_MAX_ATTEMPTS
      ) {
        await ctx.db.patch("filesystemOperations", operation._id, {
          state: "uploading",
          leaseExpiresAt:
            Date.now() + storageJobRetryDelay(operation.attempts ?? 1),
          error,
        });
      } else {
        await ctx.db.patch("filesystemOperations", operation._id, {
          state: "failed",
          claimedAt: undefined,
          leaseExpiresAt: undefined,
          error,
        });
        if (
          operation.kind === "fileRename" &&
          operation.entryId !== undefined
        ) {
          const entry = await ctx.db.get("entries", operation.entryId);
          if (entry?.filesystemOperationId === operation._id) {
            await ctx.db.patch("entries", entry._id, {
              filesystemOperationId: undefined,
              migrationState: undefined,
              migrationClaimedAt: undefined,
              migrationAttempts: undefined,
              migrationRetryAt: undefined,
              migrationError: error,
              updatedAt: Date.now(),
            });
          }
        }
      }
    }
    return null;
  },
});
