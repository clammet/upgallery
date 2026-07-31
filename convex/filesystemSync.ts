import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { createToken, sha256 } from "./lib/crypto";
import { getFilesystemFolderSegments } from "./lib/filesystem";
import {
  replaceMediaProcessingJob,
  STORAGE_JOB_LEASE_MS,
  STORAGE_JOB_MAX_ATTEMPTS,
  storageJobRetryDelay,
} from "./lib/storageJobs";
import {
  cleanFilesystemSegment,
  filesystemSlug,
} from "./lib/normalize";
import { mediaKind } from "./lib/validators";

const SYNC_LEASE_MS = STORAGE_JOB_LEASE_MS;
const SYNC_LEASE_RENEW_THRESHOLD_MS = SYNC_LEASE_MS / 2;
const MAX_DIRECTORY_ITEMS = 500;

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
  cleanFilesystemSegment(input.name);
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
    const knownChildren = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", folder._id),
      )
      .take(MAX_DIRECTORY_ITEMS + 1);
    if (knownChildren.length > MAX_DIRECTORY_ITEMS) {
      throw new Error("Directory contains too many tracked folders");
    }
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
      knownChildFolderIds: knownChildren
        .filter((child) => child.filesystemMissingAt === undefined)
        .map((child) => child._id),
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
    const name = cleanFilesystemSegment(args.name);
    if (args.identity.length < 1 || args.identity.length > 200) {
      throw new Error("Invalid filesystem identity");
    }
    const children = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", parent._id),
      )
      .take(MAX_DIRECTORY_ITEMS + 1);
    if (children.length > MAX_DIRECTORY_ITEMS) {
      throw new Error("Directory contains too many tracked folders");
    }
    const existing =
      children.find((child) => child.name === name) ??
      children.find((child) => child.filesystemIdentity === args.identity);
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
    return await ctx.db.insert("folders", {
      galleryId: gallery._id,
      parentId: parent._id,
      ancestorIds: [...parent.ancestorIds, parent._id],
      name,
      slug: filesystemSlug(name),
      privacy: "public",
      filesystemIdentity: args.identity,
      filesystemSyncId: args.syncId,
    });
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
    const candidates =
      exact === null
        ? await ctx.db
            .query("entries")
            .withIndex("by_folderId_and_state", (q) =>
              q.eq("folderId", folder._id).eq("state", "ready"),
            )
            .take(MAX_DIRECTORY_ITEMS + 1)
        : [];
    if (candidates.length > MAX_DIRECTORY_ITEMS) {
      throw new Error("Directory contains too many tracked files");
    }
    const existing =
      exact ??
      candidates.find(
        (candidate) => candidate.filesystemIdentity === args.identity,
      ) ??
      null;
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
      await ctx.db.patch("galleries", gallery._id, {
        itemCount: gallery.itemCount + (wasReady ? 0 : 1),
        totalBytes: Math.max(
          0,
          gallery.totalBytes + args.size - (wasReady ? existing.size : 0),
        ),
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

    const ownerGrant = (
      await ctx.db
        .query("galleryRoles")
        .withIndex("by_galleryId_and_folderId", (q) =>
          q.eq("galleryId", gallery._id),
        )
        .take(256)
    ).find((grant) => grant.role === "owner");
    if (ownerGrant === undefined) {
      throw new Error("Gallery has no owner for imported filesystem entries");
    }
    const entryId = await ctx.db.insert("entries", {
      galleryId: gallery._id,
      folderId: folder._id,
      ownerProfileId: ownerGrant.profileId,
      name: args.name,
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
    await ctx.db.patch("galleries", gallery._id, {
      itemCount: gallery.itemCount + 1,
      totalBytes: gallery.totalBytes + args.size,
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

export const completeFilesystemSync = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    syncId: v.string(),
    modifiedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const { gallery, folder, state } = await requireActiveSync(
      ctx,
      args.galleryId,
      args.folderId,
      args.syncId,
    );
    const [entries, children] = await Promise.all([
      ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", folder._id).eq("state", "ready"),
        )
        .take(MAX_DIRECTORY_ITEMS + 1),
      ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId", (q) =>
          q.eq("galleryId", gallery._id).eq("parentId", folder._id),
        )
        .take(MAX_DIRECTORY_ITEMS + 1),
    ]);
    if (
      entries.length > MAX_DIRECTORY_ITEMS ||
      children.length > MAX_DIRECTORY_ITEMS
    ) {
      throw new Error("Directory contains too many tracked items");
    }
    let removedItems = 0;
    let removedBytes = 0;
    for (const entry of entries) {
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
    for (const child of children) {
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
    if (removedItems > 0) {
      await ctx.db.patch("galleries", gallery._id, {
        itemCount: Math.max(0, gallery.itemCount - removedItems),
        totalBytes: Math.max(0, gallery.totalBytes - removedBytes),
      });
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
      removedBytes += entry.size;
    }
    if (entries.length > 0) {
      await ctx.db.patch("galleries", gallery._id, {
        itemCount: Math.max(0, gallery.itemCount - entries.length),
        totalBytes: Math.max(0, gallery.totalBytes - removedBytes),
      });
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
  if (operation.kind === "rename") {
    if (operation.folderId === undefined) {
      throw new Error("Rename operation has no folder");
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
    identity: v.string(),
  },
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("filesystemOperations", args.operationId);
    if (operation === null || operation.state !== "uploading") {
      throw new Error("Filesystem operation is not active");
    }
    const [gallery, parent] = await Promise.all([
      ctx.db.get("galleries", operation.galleryId),
      ctx.db.get("folders", operation.parentId),
    ]);
    if (gallery === null || parent === null) {
      throw new Error("Filesystem operation target no longer exists");
    }
    let folderId = operation.folderId;
    if (operation.kind === "mkdir") {
      const siblings = await ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId", (q) =>
          q.eq("galleryId", gallery._id).eq("parentId", parent._id),
        )
        .take(256);
      const existing = siblings.find(
        (sibling) => sibling.name === operation.name,
      );
      if (existing !== undefined) {
        folderId = existing._id;
        await ctx.db.patch("folders", existing._id, {
          privacy: operation.privacy,
          previewMode: operation.previewMode,
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
          privacy: operation.privacy,
          previewMode: operation.previewMode,
          filesystemIdentity: args.identity,
        });
      }
    } else {
      if (folderId === undefined) {
        throw new Error("Rename operation has no folder");
      }
      await ctx.db.patch("folders", folderId, {
        name: operation.name,
        slug: filesystemSlug(operation.name),
        privacy: operation.privacy,
        previewMode: operation.previewMode,
        filesystemIdentity: args.identity,
        filesystemMissingAt: undefined,
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
          : "filesystem_folder.renamed",
      galleryId: gallery._id,
      detail: operation.name,
      createdAt: Date.now(),
    });
    return { folderId };
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
      }
    }
    return null;
  },
});
