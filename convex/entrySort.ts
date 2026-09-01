import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { entrySortTimestamp } from "./lib/entrySort";

const BACKFILL_PAGE_SIZE = 128;

export const backfillSortTimestamps = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("entries")
      .withIndex("by_galleryId_and_state", (q) =>
        q.eq("galleryId", args.galleryId).eq("state", "ready"),
      )
      .paginate(args.paginationOpts);
    for (const entry of result.page) {
      const sortFallbackTimestamp =
        entry.sortFallbackTimestamp ??
        entry.filesystemModifiedAt ??
        entry.createdAt;
      const sortTimestamp = entrySortTimestamp(entry);
      if (
        entry.sortFallbackTimestamp !== sortFallbackTimestamp ||
        entry.sortTimestamp !== sortTimestamp
      ) {
        await ctx.db.patch("entries", entry._id, {
          sortFallbackTimestamp,
          sortTimestamp,
        });
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.entrySort.backfillSortTimestamps, {
        galleryId: args.galleryId,
        paginationOpts: {
          numItems: BACKFILL_PAGE_SIZE,
          cursor: result.continueCursor,
        },
      });
    }
    return null;
  },
});

export async function scheduleSortTimestampBackfill(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
) {
  await ctx.scheduler.runAfter(0, internal.entrySort.backfillSortTimestamps, {
    galleryId,
    paginationOpts: { numItems: BACKFILL_PAGE_SIZE, cursor: null },
  });
}
