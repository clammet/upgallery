import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { storageKind } from "./lib/validators";
import { normalizeStorageRoot } from "./lib/normalize";
import { requireSystemAdmin } from "./lib/permissions";

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
    const actor = await requireSystemAdmin(ctx);
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
    if (gallery.storageKind === "user") {
      if (gallery.rootFolderId === undefined) {
        throw new Error("The user-mounted gallery has no root folder");
      }
      const [rootSync, queuedSync, processingSync, failedSync] =
        await Promise.all([
          ctx.db
            .query("filesystemSyncStates")
            .withIndex("by_folderId", (q) =>
              q.eq("folderId", gallery.rootFolderId!),
            )
            .unique(),
          ctx.db
            .query("filesystemSyncJobs")
            .withIndex("by_galleryId_and_status", (q) =>
              q.eq("galleryId", gallery._id).eq("status", "queued"),
            )
            .first(),
          ctx.db
            .query("filesystemSyncJobs")
            .withIndex("by_galleryId_and_status", (q) =>
              q.eq("galleryId", gallery._id).eq("status", "processing"),
            )
            .first(),
          ctx.db
            .query("filesystemSyncJobs")
            .withIndex("by_galleryId_and_status", (q) =>
              q.eq("galleryId", gallery._id).eq("status", "failed"),
            )
            .first(),
        ]);
      if (
        rootSync?.lastCompletedAt === undefined ||
        queuedSync !== null ||
        processingSync !== null ||
        failedSync !== null
      ) {
        throw new Error(
          "Wait for the user-mounted gallery scan to finish before migrating storage",
        );
      }
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
