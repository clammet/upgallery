import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { storageKind } from "./lib/validators";
import { normalizeStorageRoot } from "./lib/normalize";
import { requireGalleryRole } from "./lib/permissions";

export const request = mutation({
  args: {
    galleryId: v.id("galleries"),
    targetStorageKind: storageKind,
    targetStorageRoot: v.string(),
  },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      throw new Error("Gallery not found");
    }
    if (gallery.kind !== "image") {
      throw new Error("Uploader galleries always use shared protected storage");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryRole(ctx, gallery, rootFolder, "owner");
    if (gallery.pendingMigrationId !== undefined) {
      throw new Error("This gallery already has a pending migration");
    }
    const targetStorageRoot = normalizeStorageRoot(args.targetStorageRoot);
    if (
      args.targetStorageKind === gallery.storageKind &&
      targetStorageRoot === gallery.storageRoot
    ) {
      throw new Error("The target storage location is unchanged");
    }
    const migrationId = await ctx.db.insert("storageMigrations", {
      galleryId: gallery._id,
      sourceStorageKind: gallery.storageKind,
      targetStorageKind: args.targetStorageKind,
      targetStorageRoot,
      status: "queued",
      movedItems: 0,
      failedItems: 0,
    });
    await ctx.db.patch("galleries", gallery._id, {
      pendingMigrationId: migrationId,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "storage_migration.requested",
      galleryId: gallery._id,
      detail: `${gallery.storageKind}:${gallery.storageRoot} -> ${args.targetStorageKind}:${targetStorageRoot}`,
      createdAt: Date.now(),
    });
    return migrationId;
  },
});
