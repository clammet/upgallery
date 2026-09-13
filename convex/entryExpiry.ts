import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { queueEntryDeletion } from "./lib/entryDeletion";

export const expire = internalMutation({
  args: { entryId: v.id("entries"), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("entries", args.entryId);
    // A previous deletion or replacement makes this scheduled job a no-op.
    if (entry === null || entry.state !== "ready" || entry.expiresAt !== args.expiresAt) {
      return null;
    }
    if (entry.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(entry.expiresAt, internal.entryExpiry.expire, args);
      return null;
    }
    // Let an in-flight storage move settle before deleting its final keys.
    if (entry.migrationState === "moving" || entry.moveJobId !== undefined || entry.filesystemOperationId !== undefined) {
      await ctx.scheduler.runAfter(60_000, internal.entryExpiry.expire, args);
      return null;
    }
    const gallery = await ctx.db.get("galleries", entry.galleryId);
    if (gallery !== null) await queueEntryDeletion(ctx, gallery, entry);
    return null;
  },
});
