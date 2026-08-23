import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type FolderStats = { itemCount: number; totalBytes: number };

/**
 * Live ready-file count and byte total per folder.
 *
 * Same shape and reasoning as lib/galleryStats.ts, one level down: the
 * counters live apart from the folder document so uploads and deletes do not
 * invalidate every query that reads the folder. "Ready" means
 * `entries.state === "ready"`; files hidden mid-move (moveJobId set) still
 * count toward their current folder.
 *
 * Every folder gets a row when it is created. Folders that predate the table
 * get theirs from folderStats.backfill; until then readFolderStats returns
 * null and callers fall back to counting.
 */
export async function readFolderStats(
  ctx: QueryCtx,
  folderId: Id<"folders">,
): Promise<FolderStats | null> {
  const stats = await statsRow(ctx, folderId);
  return stats === null
    ? null
    : { itemCount: stats.itemCount, totalBytes: stats.totalBytes };
}

export async function createFolderStats(
  ctx: MutationCtx,
  folderId: Id<"folders">,
  galleryId: Id<"galleries">,
): Promise<void> {
  await ctx.db.insert("folderStats", {
    folderId,
    galleryId,
    itemCount: 0,
    totalBytes: 0,
  });
}

export async function adjustFolderStats(
  ctx: MutationCtx,
  folder: { folderId: Id<"folders">; galleryId: Id<"galleries"> },
  delta: { items?: number; bytes?: number },
): Promise<void> {
  const items = delta.items ?? 0;
  const bytes = delta.bytes ?? 0;
  if (items === 0 && bytes === 0) return;
  const stats = await statsRow(ctx, folder.folderId);
  if (stats === null) {
    await ctx.db.insert("folderStats", {
      folderId: folder.folderId,
      galleryId: folder.galleryId,
      itemCount: Math.max(0, items),
      totalBytes: Math.max(0, bytes),
    });
    return;
  }
  await ctx.db.patch("folderStats", stats._id, {
    itemCount: Math.max(0, stats.itemCount + items),
    totalBytes: Math.max(0, stats.totalBytes + bytes),
  });
}

/**
 * Folder-level effect of an entry becoming ready in `folder`, whether it is
 * new, revived from "deleted", or an already-ready entry being replaced —
 * possibly in a different folder than before.
 */
export async function settleReadyEntry(
  ctx: MutationCtx,
  input: {
    folderId: Id<"folders">;
    galleryId: Id<"galleries">;
    size: number;
    previous?: { folderId: Id<"folders">; galleryId: Id<"galleries">; size: number };
  },
): Promise<void> {
  const { previous } = input;
  if (previous !== undefined && previous.folderId === input.folderId) {
    await adjustFolderStats(ctx, input, { bytes: input.size - previous.size });
    return;
  }
  if (previous !== undefined) {
    await adjustFolderStats(ctx, previous, {
      items: -1,
      bytes: -previous.size,
    });
  }
  await adjustFolderStats(ctx, input, { items: 1, bytes: input.size });
}

/**
 * Apply one delta per folder for a batch of entries, so a mutation that
 * touches many entries writes each stats row once.
 */
export async function adjustFolderStatsForEntries(
  ctx: MutationCtx,
  entries: Array<{
    folderId: Id<"folders">;
    galleryId: Id<"galleries">;
    size: number;
  }>,
  sign: 1 | -1,
): Promise<void> {
  const byFolder = new Map<
    Id<"folders">,
    { folderId: Id<"folders">; galleryId: Id<"galleries">; items: number; bytes: number }
  >();
  for (const entry of entries) {
    const current = byFolder.get(entry.folderId) ?? {
      folderId: entry.folderId,
      galleryId: entry.galleryId,
      items: 0,
      bytes: 0,
    };
    current.items += sign;
    current.bytes += sign * entry.size;
    byFolder.set(entry.folderId, current);
  }
  for (const delta of byFolder.values()) {
    await adjustFolderStats(ctx, delta, delta);
  }
}

export async function deleteFolderStats(
  ctx: MutationCtx,
  folderId: Id<"folders">,
): Promise<void> {
  const stats = await statsRow(ctx, folderId);
  if (stats !== null) {
    await ctx.db.delete("folderStats", stats._id);
  }
}

function statsRow(ctx: QueryCtx, folderId: Id<"folders">) {
  return ctx.db
    .query("folderStats")
    .withIndex("by_folderId", (q) => q.eq("folderId", folderId))
    .unique();
}
