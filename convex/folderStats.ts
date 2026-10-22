import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  folderStatsRow,
  notifyParentStatsReady,
  requestFolderStatsRebuild,
  scheduleStatsRebuild,
} from "./lib/folderStats";
import { getCurrentProfile, resolveFolderAccess, unauthorizedError } from "./lib/permissions";

const ENTRY_BATCH = 200;
const CHILD_BATCH = 32;

// Size sorting never scans a subtree in a public query. A viewer may request
// its missing counters once; repeated requests share the same internal jobs.
export const prepare = mutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    anonymousClaim: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    const parent = await ctx.db.get("folders", args.folderId);
    if (gallery === null || parent === null || parent.galleryId !== gallery._id ||
        parent.filesystemMissingAt !== undefined) throw unauthorizedError();
    const access = await resolveFolderAccess(ctx, gallery._id, parent,
      await getCurrentProfile(ctx, args.anonymousClaim), args.anonymousClaim);
    if (!access.canView) throw unauthorizedError();
    if (!(parent.sortOrder ?? gallery.sortOrder ?? "nameAsc").startsWith("size")) return null;
    // Rebuilding the parent discovers unknown children in bounded pages. Any
    // transition that invalidates a child's total also invalidates ancestors.
    await requestFolderStatsRebuild(ctx, parent._id);
    return null;
  },
});

// Optional deployment maintenance: recount old direct counters as well as
// subtree totals. One folder per invocation, with a bounded rebuild per folder.
// Run only against the explicitly selected deployment: convex run folderStats:backfill '{}'
export const backfill = internalMutation({
  args: { folderCursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("folders").paginate({
      numItems: 1, cursor: args.folderCursor ?? null,
    });
    for (const folder of page.page) await requestFolderStatsRebuild(ctx, folder._id, true);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.folderStats.backfill, { folderCursor: page.continueCursor });
    }
    return null;
  },
});

// A job reads one bounded page per transaction. Entry and parent-pointer
// changes increment the stats revision; a stale scan restarts rather than
// publishing a mixture of old and new totals. Waiting parents are woken by
// their children, so no polling loop runs while descendant work is pending.
export const rebuild = internalMutation({
  args: { jobId: v.id("folderStatsRebuilds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("folderStatsRebuilds", args.jobId);
    if (existing === null) return null;
    const folder = await ctx.db.get("folders", existing.folderId);
    const stats = await folderStatsRow(ctx, existing.folderId);
    if (folder === null || stats === null || stats.subtreeBytes !== undefined) {
      await ctx.db.delete("folderStatsRebuilds", existing._id);
      return null;
    }
    let job = existing;
    if (job.revision !== (stats.revision ?? 0) || job.phase === "waiting") {
      job = {
        ...job, revision: stats.revision ?? 0,
        phase: stats.directReady === false ? "entries" : "children",
        cursor: null, items: 0, bytes: 0,
        subtreeBytes: stats.directReady === false ? 0 : stats.totalBytes,
        pendingChildren: false,
      };
    }
    await ctx.db.patch("folderStatsRebuilds", job._id, {
      revision: job.revision, phase: job.phase, cursor: job.cursor,
      items: job.items, bytes: job.bytes, subtreeBytes: job.subtreeBytes,
      pendingChildren: job.pendingChildren, scheduled: false,
    });
    if (job.phase === "entries") {
      const page = await ctx.db.query("entries")
        .withIndex("by_folderId_and_state", q => q.eq("folderId", folder._id).eq("state", "ready"))
        .paginate({ numItems: ENTRY_BATCH, cursor: job.cursor, maximumRowsRead: ENTRY_BATCH });
      const items = job.items + page.page.length;
      const bytes = job.bytes + page.page.reduce((sum, entry) => sum + entry.size, 0);
      if (page.isDone) {
        await ctx.db.patch("folderStats", stats._id, { itemCount: items, totalBytes: bytes, directReady: true });
        await ctx.db.patch("folderStatsRebuilds", job._id, {
          phase: "children", cursor: null, items, bytes, subtreeBytes: bytes,
        });
      } else {
        await ctx.db.patch("folderStatsRebuilds", job._id, { cursor: page.continueCursor, items, bytes });
      }
      await scheduleStatsRebuild(ctx, folder._id);
      return null;
    }
    const page = await ctx.db.query("folders")
      .withIndex("by_galleryId_and_parentId", q => q.eq("galleryId", folder.galleryId).eq("parentId", folder._id))
      .paginate({ numItems: CHILD_BATCH, cursor: job.cursor, maximumRowsRead: CHILD_BATCH });
    let bytes = job.subtreeBytes;
    let pendingChildren = job.pendingChildren;
    for (const child of page.page) {
      if (child.filesystemMissingAt !== undefined) continue;
      const childStats = await folderStatsRow(ctx, child._id);
      if (childStats?.subtreeBytes === undefined) {
        pendingChildren = true;
        await requestFolderStatsRebuild(ctx, child._id);
      } else {
        bytes += childStats.subtreeBytes;
      }
    }
    const current = (await folderStatsRow(ctx, folder._id))!;
    if ((current.revision ?? 0) !== job.revision) {
      await scheduleStatsRebuild(ctx, folder._id);
    } else if (!page.isDone) {
      await ctx.db.patch("folderStatsRebuilds", job._id, {
        cursor: page.continueCursor, subtreeBytes: bytes, pendingChildren,
      });
      await scheduleStatsRebuild(ctx, folder._id);
    } else if (pendingChildren) {
      await ctx.db.patch("folderStatsRebuilds", job._id, { phase: "waiting" });
    } else {
      await ctx.db.patch("folderStats", stats._id, { subtreeBytes: bytes });
      await ctx.db.delete("folderStatsRebuilds", job._id);
      await notifyParentStatsReady(ctx, folder);
    }
    return null;
  },
});
