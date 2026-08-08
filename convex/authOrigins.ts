import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { normalizeHost } from "./lib/normalize";

export const isGalleryOrigin = internalQuery({
  args: { origin: v.string() },
  handler: async (ctx, args) => {
    let requested: URL;
    try {
      requested = new URL(args.origin);
    } catch {
      return false;
    }
    if (requested.origin !== args.origin || requested.origin === "null") {
      return false;
    }
    if (requested.protocol !== "https:") {
      return false;
    }
    const matches = await ctx.db
      .query("galleryHosts")
      .withIndex("by_host", (q) => q.eq("host", normalizeHost(requested.host)))
      .take(1);
    return matches.length > 0;
  },
});
