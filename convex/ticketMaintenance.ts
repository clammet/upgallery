import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const CLEANUP_BATCH_SIZE = 256;

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("downloadTickets")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const ticket of expired) {
      await ctx.db.delete("downloadTickets", ticket._id);
    }
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.ticketMaintenance.cleanupExpired,
        {},
      );
    }
    return expired.length;
  },
});
