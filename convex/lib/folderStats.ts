import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { MAX_FOLDER_DEPTH } from "./normalize";

export type FolderStats = { itemCount: number; totalBytes: number };

export async function markFolderModified(
  ctx: MutationCtx,
  folderId: Id<"folders">,
): Promise<void> {
  const folder = await ctx.db.get("folders", folderId);
  if (folder === null) return;
  const gallery = await ctx.db.get("galleries", folder.galleryId);
  if (gallery?.storageKind === "user") return;
  await ctx.db.patch("folders", folderId, { modifiedAt: Date.now() });
}

/** Direct ready-file counters; null means their bounded initialization is pending. */
export async function readFolderStats(
  ctx: QueryCtx,
  folderId: Id<"folders">,
): Promise<FolderStats | null> {
  const stats = await folderStatsRow(ctx, folderId);
  return stats === null || stats.directReady === false
    ? null
    : { itemCount: stats.itemCount, totalBytes: stats.totalBytes };
}

export async function readSubtreeBytes(
  ctx: QueryCtx,
  folderId: Id<"folders">,
): Promise<number | null> {
  const stats = await folderStatsRow(ctx, folderId);
  return stats?.subtreeBytes ?? null;
}

export async function createFolderStats(
  ctx: MutationCtx,
  folderId: Id<"folders">,
  galleryId: Id<"galleries">,
): Promise<void> {
  await ctx.db.insert("folderStats", {
    folderId, galleryId, itemCount: 0, totalBytes: 0,
    subtreeBytes: 0, directReady: true, revision: 0,
  });
}

/**
 * Apply direct counters and subtree deltas in the entry's transaction. Walk
 * actual parent pointers, not ancestorIds: reparent repair updates those later.
 * This is bounded by MAX_FOLDER_DEPTH and never reads a descendant collection.
 */
export async function adjustFolderStats(
  ctx: MutationCtx,
  input: { folderId: Id<"folders">; galleryId: Id<"galleries"> },
  delta: { items?: number; bytes?: number },
): Promise<void> {
  const items = delta.items ?? 0;
  const bytes = delta.bytes ?? 0;
  await markFolderModified(ctx, input.folderId);
  if (items === 0 && bytes === 0) return;
  const folder = await ctx.db.get("folders", input.folderId);
  if (folder === null) return;
  const stats = await folderStatsRow(ctx, folder._id);
  if (stats === null) {
    // A delta cannot establish the previous total of an old populated folder.
    await requestFolderStatsRebuild(ctx, folder._id);
    return;
  }
  const totalBytes = Math.max(0, stats.totalBytes + bytes);
  const appliedBytes = totalBytes - stats.totalBytes;
  await ctx.db.patch("folderStats", stats._id, {
    itemCount: Math.max(0, stats.itemCount + items),
    totalBytes,
    revision: (stats.revision ?? 0) + 1,
    ...(stats.subtreeBytes === undefined
      ? {}
      : { subtreeBytes: Math.max(0, stats.subtreeBytes + appliedBytes) }),
  });
  if (stats.subtreeBytes === undefined) {
    await requestFolderStatsRebuild(ctx, folder._id);
  } else if (folder.filesystemMissingAt === undefined && appliedBytes !== 0) {
    await updateAncestorBytes(ctx, folder.parentId, appliedBytes);
  }
}

/** Call before a parent/tombstone patch, in the same transaction. */
export async function reparentFolderStats(
  ctx: MutationCtx,
  before: Doc<"folders">,
  patch: { parentId?: Id<"folders">; filesystemMissingAt?: number },
): Promise<void> {
  const parentId = Object.hasOwn(patch, "parentId") ? patch.parentId : before.parentId;
  const missingAt = Object.hasOwn(patch, "filesystemMissingAt")
    ? patch.filesystemMissingAt : before.filesystemMissingAt;
  const wasVisible = before.filesystemMissingAt === undefined;
  const isVisible = missingAt === undefined;
  if (parentId === before.parentId && wasVisible === isVisible) return;
  const bytes = await readSubtreeBytes(ctx, before._id);
  if (wasVisible) await updateAncestorBytes(ctx, before.parentId, bytes === null ? null : -bytes);
  if (isVisible) await updateAncestorBytes(ctx, parentId, bytes);
}

async function updateAncestorBytes(
  ctx: MutationCtx,
  parentId: Id<"folders"> | undefined,
  delta: number | null,
): Promise<void> {
  const visited = new Set<Id<"folders">>();
  while (parentId !== undefined) {
    if (visited.has(parentId) || visited.size >= MAX_FOLDER_DEPTH) {
      throw new Error("Invalid folder ancestry");
    }
    visited.add(parentId);
    const folder = await ctx.db.get("folders", parentId);
    if (folder === null) return;
    const stats = await ensureStatsRow(ctx, folder);
    const pending = delta === null || stats.subtreeBytes === undefined;
    await ctx.db.patch("folderStats", stats._id, {
      revision: (stats.revision ?? 0) + 1,
      subtreeBytes: pending ? undefined : Math.max(0, stats.subtreeBytes! + delta!),
    });
    if (pending) await scheduleStatsRebuild(ctx, folder._id);
    if (folder.filesystemMissingAt !== undefined) return;
    parentId = folder.parentId;
  }
}

/** Initialize old records on demand. Repeated requests coalesce into one job. */
export async function requestFolderStatsRebuild(
  ctx: MutationCtx,
  folderId: Id<"folders">,
  recountDirect = false,
): Promise<void> {
  const folder = await ctx.db.get("folders", folderId);
  if (folder === null) return;
  const stats = await ensureStatsRow(ctx, folder);
  if (!recountDirect && stats.subtreeBytes !== undefined) return;
  const job = await statsRebuildRow(ctx, folderId);
  if (!recountDirect && job !== null) {
    // A waiting job is woken by its child, or by a changed revision. Merely
    // observing an unknown child must not restart every ancestor's scan.
    if (job.revision !== (stats.revision ?? 0)) await scheduleStatsRebuild(ctx, folderId);
    return;
  }
  if (recountDirect) {
    await ctx.db.patch("folderStats", stats._id, {
      subtreeBytes: undefined,
      ...(recountDirect ? { directReady: false } : {}),
      revision: (stats.revision ?? 0) + 1,
    });
  }
  await scheduleStatsRebuild(ctx, folderId);
  if (folder.filesystemMissingAt === undefined) {
    await updateAncestorBytes(ctx, folder.parentId, null);
  }
}

export async function scheduleStatsRebuild(ctx: MutationCtx, folderId: Id<"folders">) {
  const existing = await statsRebuildRow(ctx, folderId);
  if (existing?.scheduled) return;
  const stats = await folderStatsRow(ctx, folderId);
  if (stats === null) return;
  let jobId: Id<"folderStatsRebuilds">;
  if (existing !== null) {
    jobId = existing._id;
    await ctx.db.patch("folderStatsRebuilds", jobId, { scheduled: true });
  } else {
    jobId = await ctx.db.insert("folderStatsRebuilds", {
      folderId, revision: stats.revision ?? 0,
      phase: stats.directReady === false ? "entries" : "children",
      cursor: null, items: 0, bytes: 0,
      subtreeBytes: stats.directReady === false ? 0 : stats.totalBytes,
      pendingChildren: false, scheduled: true,
    });
  }
  await ctx.scheduler.runAfter(0, internal.folderStats.rebuild, { jobId });
}

/** A child just published a previously unknown total; wake its waiting parent. */
export async function notifyParentStatsReady(ctx: MutationCtx, folder: Doc<"folders">) {
  if (folder.parentId === undefined || folder.filesystemMissingAt !== undefined) return;
  const parent = await ctx.db.get("folders", folder.parentId);
  if (parent === null) return;
  const stats = await ensureStatsRow(ctx, parent);
  await ctx.db.patch("folderStats", stats._id, {
    subtreeBytes: undefined, revision: (stats.revision ?? 0) + 1,
  });
  await scheduleStatsRebuild(ctx, parent._id);
}

async function ensureStatsRow(ctx: MutationCtx, folder: Doc<"folders">) {
  const existing = await folderStatsRow(ctx, folder._id);
  if (existing !== null) return existing;
  const id = await ctx.db.insert("folderStats", {
    folderId: folder._id, galleryId: folder.galleryId,
    itemCount: 0, totalBytes: 0, directReady: false, revision: 0,
  });
  return (await ctx.db.get("folderStats", id))!;
}

export async function settleReadyEntry(
  ctx: MutationCtx,
  input: {
    folderId: Id<"folders">; galleryId: Id<"galleries">; size: number;
    previous?: { folderId: Id<"folders">; galleryId: Id<"galleries">; size: number };
  },
): Promise<void> {
  const { previous } = input;
  if (previous !== undefined && previous.folderId === input.folderId) {
    await adjustFolderStats(ctx, input, { bytes: input.size - previous.size });
    return;
  }
  if (previous !== undefined) await adjustFolderStats(ctx, previous, { items: -1, bytes: -previous.size });
  await adjustFolderStats(ctx, input, { items: 1, bytes: input.size });
}

export async function adjustFolderStatsForEntries(
  ctx: MutationCtx,
  entries: Array<{ folderId: Id<"folders">; galleryId: Id<"galleries">; size: number }>,
  sign: 1 | -1,
): Promise<void> {
  const byFolder = new Map<Id<"folders">, {
    folderId: Id<"folders">; galleryId: Id<"galleries">; items: number; bytes: number;
  }>();
  for (const entry of entries) {
    const current = byFolder.get(entry.folderId) ?? { folderId: entry.folderId, galleryId: entry.galleryId, items: 0, bytes: 0 };
    current.items += sign;
    current.bytes += sign * entry.size;
    byFolder.set(entry.folderId, current);
  }
  for (const delta of byFolder.values()) await adjustFolderStats(ctx, delta, delta);
}

export async function deleteFolderStats(ctx: MutationCtx, folderId: Id<"folders">): Promise<void> {
  const folder = await ctx.db.get("folders", folderId);
  if (folder !== null && folder.filesystemMissingAt === undefined) {
    await reparentFolderStats(ctx, folder, { filesystemMissingAt: Date.now() });
  }
  const job = await statsRebuildRow(ctx, folderId);
  if (job !== null) await ctx.db.delete("folderStatsRebuilds", job._id);
  const stats = await folderStatsRow(ctx, folderId);
  if (stats !== null) await ctx.db.delete("folderStats", stats._id);
}

export function folderStatsRow(ctx: QueryCtx, folderId: Id<"folders">) {
  return ctx.db.query("folderStats").withIndex("by_folderId", q => q.eq("folderId", folderId)).unique();
}
export function statsRebuildRow(ctx: QueryCtx, folderId: Id<"folders">) {
  return ctx.db.query("folderStatsRebuilds").withIndex("by_folderId", q => q.eq("folderId", folderId)).unique();
}
