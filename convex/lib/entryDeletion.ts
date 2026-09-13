import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { adjustGalleryStats } from "./galleryStats";
import { adjustFolderStats } from "./folderStats";

// Call only after authorization (or from the internal expiry job).
export async function queueEntryDeletion(
  ctx: MutationCtx,
  gallery: Doc<"galleries">,
  entry: Doc<"entries">,
) {
  if (entry.state !== "ready") return;
  await ctx.db.patch("entries", entry._id, {
    state: "deleted",
    deletedAt: Date.now(),
  });
  await adjustGalleryStats(ctx, gallery, { items: -1, bytes: -entry.size });
  await adjustFolderStats(ctx, entry, { items: -1, bytes: -entry.size });
  await ctx.db.insert("storageDeleteJobs", {
    entryId: entry._id,
    storageKey: entry.storageKey,
    thumbnailKey: entry.thumbnailKey,
    previewKey: entry.previewKey,
    deleteEntry: true,
    status: "queued",
    attempts: 0,
    availableAt: 0,
  });
}
