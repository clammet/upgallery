import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type GalleryStats = { itemCount: number; totalBytes: number };

/**
 * Live item/byte counters for a gallery.
 *
 * They live in their own table rather than on the gallery document so that
 * every upload, delete, and move does not rewrite the gallery document. Every
 * listing query reads the gallery document (for settings and access checks),
 * so a counter patch there invalidated every open page, folder listing, and
 * route query — on every upload.
 *
 * Galleries created before this table carry the old `itemCount`/`totalBytes`
 * fields; those seed the stats row on first write and are otherwise ignored.
 */
export async function readGalleryStats(
  ctx: QueryCtx,
  gallery: Doc<"galleries">,
): Promise<GalleryStats> {
  const stats = await statsRow(ctx, gallery._id);
  if (stats !== null) {
    return { itemCount: stats.itemCount, totalBytes: stats.totalBytes };
  }
  return legacyStats(gallery);
}

export async function adjustGalleryStats(
  ctx: MutationCtx,
  gallery: Doc<"galleries">,
  delta: { items?: number; bytes?: number },
): Promise<void> {
  const items = delta.items ?? 0;
  const bytes = delta.bytes ?? 0;
  const stats = await statsRow(ctx, gallery._id);
  if (stats === null) {
    const legacy = legacyStats(gallery);
    await ctx.db.insert("galleryStats", {
      galleryId: gallery._id,
      itemCount: Math.max(0, legacy.itemCount + items),
      totalBytes: Math.max(0, legacy.totalBytes + bytes),
    });
    return;
  }
  if (items === 0 && bytes === 0) return;
  await ctx.db.patch("galleryStats", stats._id, {
    itemCount: Math.max(0, stats.itemCount + items),
    totalBytes: Math.max(0, stats.totalBytes + bytes),
  });
}

export async function createGalleryStats(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
): Promise<void> {
  await ctx.db.insert("galleryStats", {
    galleryId,
    itemCount: 0,
    totalBytes: 0,
  });
}

function statsRow(ctx: QueryCtx, galleryId: Id<"galleries">) {
  return ctx.db
    .query("galleryStats")
    .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
    .unique();
}

function legacyStats(gallery: Doc<"galleries">): GalleryStats {
  return {
    itemCount: gallery.itemCount ?? 0,
    totalBytes: gallery.totalBytes ?? 0,
  };
}
