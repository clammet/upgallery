import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const ENTRY_BATCH = 1_000;

// One-off: give every existing folder a folderStats row by counting its
// ready entries. `backfill` walks folders one per invocation and hands each
// to `backfillFolder`, which counts in batches (carrying the partial total
// across invocations for large folders) and then resumes the walk. Re-running
// is safe; rows are overwritten with a fresh count. Each function makes a
// single paginated query, which is all Convex allows per execution.
//
//   npx convex run folderStats:backfill
export const backfill = internalMutation({
  args: { folderCursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const folders = await ctx.db
      .query("folders")
      .paginate({ numItems: 1, cursor: args.folderCursor ?? null });
    const folder = folders.page[0];
    if (folder === undefined) return null;
    await ctx.scheduler.runAfter(0, internal.folderStats.backfillFolder, {
      folderId: folder._id,
      nextFolderCursor: folders.isDone ? null : folders.continueCursor,
      entryCursor: null,
      items: 0,
      bytes: 0,
    });
    return null;
  },
});

export const backfillFolder = internalMutation({
  args: {
    folderId: v.id("folders"),
    // Where `backfill` resumes once this folder is written; null at the end.
    nextFolderCursor: v.union(v.string(), v.null()),
    entryCursor: v.union(v.string(), v.null()),
    items: v.number(),
    bytes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const resumeWalk = async () => {
      if (args.nextFolderCursor !== null) {
        await ctx.scheduler.runAfter(0, internal.folderStats.backfill, {
          folderCursor: args.nextFolderCursor,
        });
      }
    };
    const folder = await ctx.db.get("folders", args.folderId);
    if (folder === null) {
      await resumeWalk();
      return null;
    }
    const page = await ctx.db
      .query("entries")
      .withIndex("by_folderId_and_state", (q) =>
        q.eq("folderId", folder._id).eq("state", "ready"),
      )
      .paginate({ numItems: ENTRY_BATCH, cursor: args.entryCursor });
    const items = args.items + page.page.length;
    let bytes = args.bytes;
    for (const entry of page.page) bytes += entry.size;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.folderStats.backfillFolder, {
        ...args,
        entryCursor: page.continueCursor,
        items,
        bytes,
      });
      return null;
    }
    const existing = await ctx.db
      .query("folderStats")
      .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
      .unique();
    if (existing === null) {
      await ctx.db.insert("folderStats", {
        folderId: folder._id,
        galleryId: folder.galleryId,
        itemCount: items,
        totalBytes: bytes,
      });
    } else {
      await ctx.db.patch("folderStats", existing._id, {
        itemCount: items,
        totalBytes: bytes,
      });
    }
    await resumeWalk();
    return null;
  },
});
