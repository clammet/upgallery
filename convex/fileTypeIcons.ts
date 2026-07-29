import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSystemAdmin } from "./lib/permissions";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("fileTypeIcons").take(256);
  },
});

export const upsert = mutation({
  args: {
    extension: v.string(),
    label: v.string(),
    icon: v.string(),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireSystemAdmin(ctx);
    const extension = args.extension
      .trim()
      .toLocaleLowerCase()
      .replace(/^\./, "");
    if (!/^[a-z0-9]{1,16}$/.test(extension)) {
      throw new Error("Extension must contain 1–16 letters or numbers");
    }
    if (args.icon.length > 16 || args.label.trim().length > 80) {
      throw new Error("Icon or label is too long");
    }
    const existing = await ctx.db
      .query("fileTypeIcons")
      .withIndex("by_extension", (q) => q.eq("extension", extension))
      .unique();
    const values = {
      extension,
      label: args.label.trim(),
      icon: args.icon,
      thumbnailUrl: args.thumbnailUrl?.trim() || undefined,
    };
    if (existing === null) {
      await ctx.db.insert("fileTypeIcons", values);
    } else {
      await ctx.db.patch("fileTypeIcons", existing._id, values);
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "file_type_icon.upserted",
      detail: extension,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: { iconId: v.id("fileTypeIcons") },
  handler: async (ctx, args) => {
    await requireSystemAdmin(ctx);
    await ctx.db.delete("fileTypeIcons", args.iconId);
    return null;
  },
});
