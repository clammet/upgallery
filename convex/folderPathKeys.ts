import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { folderPathKey } from "./lib/folderPath";

const BACKFILL_PAGE_SIZE = 128;

// Entries created before recursive folder previews existed carry no
// folderPathKey; galleries.update schedules this walk when an owner turns
// the option on. Idempotent: rows whose key is already current are skipped.
export const backfill = internalMutation({
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
    const keyByFolderId = new Map<Id<"folders">, string | null>();
    for (const entry of result.page) {
      let key = keyByFolderId.get(entry.folderId);
      if (key === undefined) {
        const folder = await ctx.db.get("folders", entry.folderId);
        key = folder === null ? null : folderPathKey(folder);
        keyByFolderId.set(entry.folderId, key);
      }
      if (key !== null && entry.folderPathKey !== key) {
        await ctx.db.patch("entries", entry._id, { folderPathKey: key });
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.folderPathKeys.backfill, {
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

export async function scheduleFolderPathKeyBackfill(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
) {
  await ctx.scheduler.runAfter(0, internal.folderPathKeys.backfill, {
    galleryId,
    paginationOpts: { numItems: BACKFILL_PAGE_SIZE, cursor: null },
  });
}
