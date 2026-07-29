import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireGalleryRole } from "./lib/permissions";

async function requireGalleryOwner(
  ctx: Parameters<typeof requireGalleryRole>[0],
  galleryId: Id<"galleries">,
) {
  const gallery = await ctx.db.get("galleries", galleryId);
  if (gallery === null || gallery.deletedAt !== undefined) {
    throw new Error("Gallery not found");
  }
  const rootFolder =
    gallery.rootFolderId === undefined
      ? null
      : await ctx.db.get("folders", gallery.rootFolderId);
  const actor = await requireGalleryRole(ctx, gallery, rootFolder, "owner");
  return { actor, gallery };
}

export const list = query({
  args: { galleryId: v.id("galleries") },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      return [];
    }
    return await ctx.db
      .query("fileTypeIcons")
      .withIndex("by_galleryId_and_extension", (q) =>
        q.eq("galleryId", args.galleryId),
      )
      .take(256);
  },
});

export const upsert = mutation({
  args: {
    galleryId: v.id("galleries"),
    extension: v.string(),
    label: v.string(),
    icon: v.string(),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requireGalleryOwner(ctx, args.galleryId);
    const extension = args.extension
      .trim()
      .toLocaleLowerCase()
      .replace(/^\./, "");
    if (!/^[a-z0-9]{1,16}$/.test(extension)) {
      throw new Error("Extension must contain 1–16 letters or numbers");
    }
    const icon = args.icon.trim();
    const label = args.label.trim();
    const thumbnailUrl = args.thumbnailUrl?.trim() || undefined;
    if (
      icon.length < 1 ||
      icon.length > 16 ||
      label.length < 1 ||
      label.length > 80
    ) {
      throw new Error(
        "Icon must contain 1–16 characters and label 1–80 characters",
      );
    }
    if (thumbnailUrl !== undefined && thumbnailUrl.length > 2048) {
      throw new Error("Thumbnail URL is too long");
    }
    const existing = await ctx.db
      .query("fileTypeIcons")
      .withIndex("by_galleryId_and_extension", (q) =>
        q.eq("galleryId", args.galleryId).eq("extension", extension),
      )
      .unique();
    const values = {
      galleryId: args.galleryId,
      extension,
      label,
      icon,
      thumbnailUrl,
    };
    if (existing === null) {
      await ctx.db.insert("fileTypeIcons", values);
    } else {
      await ctx.db.patch("fileTypeIcons", existing._id, values);
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "file_type_icon.upserted",
      galleryId: args.galleryId,
      detail: extension,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: { iconId: v.id("fileTypeIcons") },
  handler: async (ctx, args) => {
    const icon = await ctx.db.get("fileTypeIcons", args.iconId);
    if (icon === null || icon.galleryId === undefined) {
      throw new Error("File-type override not found");
    }
    const { actor } = await requireGalleryOwner(ctx, icon.galleryId);
    await ctx.db.delete("fileTypeIcons", args.iconId);
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "file_type_icon.removed",
      galleryId: icon.galleryId,
      detail: icon.extension,
      createdAt: Date.now(),
    });
    return null;
  },
});
