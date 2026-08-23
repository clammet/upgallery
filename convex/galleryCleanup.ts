import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { adjustFolderStatsForEntries } from "./lib/folderStats";

export const queueEntries = internalMutation({
  args: { galleryId: v.id("galleries") },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("entries")
      .withIndex("by_galleryId_and_state", (q) =>
        q.eq("galleryId", args.galleryId).eq("state", "ready"),
      )
      .take(32);
    for (const entry of entries) {
      await ctx.db.patch("entries", entry._id, {
        state: "deleted",
        deletedAt: Date.now(),
      });
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
    await adjustFolderStatsForEntries(ctx, entries, -1);
    if (entries.length === 32) {
      await ctx.scheduler.runAfter(0, internal.galleryCleanup.queueEntries, {
        galleryId: args.galleryId,
      });
    }
    return null;
  },
});
