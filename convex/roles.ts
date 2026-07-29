import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { galleryRole } from "./lib/validators";
import { normalizeEmail } from "./lib/normalize";
import { requireGalleryRole } from "./lib/permissions";

export const upsert = mutation({
  args: {
    galleryId: v.id("galleries"),
    folderId: v.optional(v.id("folders")),
    profileId: v.optional(v.id("profiles")),
    email: v.optional(v.string()),
    role: galleryRole,
  },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      throw new Error("Gallery not found");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryRole(ctx, gallery, rootFolder, "owner");
    const folder =
      args.folderId === undefined
        ? null
        : await ctx.db.get("folders", args.folderId);
    if (folder !== null && folder.galleryId !== gallery._id) {
      throw new Error("Folder does not belong to this gallery");
    }
    let profile =
      args.profileId === undefined
        ? null
        : await ctx.db.get("profiles", args.profileId);
    if (profile === null && args.email !== undefined) {
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", normalizeEmail(args.email!)))
        .unique();
    }
    if (profile === null || profile.isAnonymous) {
      throw new Error(
        "Choose an existing Google SSO user before granting access",
      );
    }
    const grants = await ctx.db
      .query("galleryRoles")
      .withIndex("by_galleryId_and_profileId", (q) =>
        q.eq("galleryId", gallery._id).eq("profileId", profile!._id),
      )
      .take(128);
    const existing = grants.find(
      (grant) => grant.folderId === args.folderId,
    );
    if (existing === undefined) {
      await ctx.db.insert("galleryRoles", {
        galleryId: gallery._id,
        folderId: args.folderId,
        profileId: profile._id,
        role: args.role,
      });
    } else {
      await ctx.db.patch("galleryRoles", existing._id, { role: args.role });
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery_role.upserted",
      galleryId: gallery._id,
      detail: `${profile.email ?? profile._id}:${args.role}`,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const revoke = mutation({
  args: { grantId: v.id("galleryRoles") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get("galleryRoles", args.grantId);
    if (grant === null) {
      return null;
    }
    const gallery = await ctx.db.get("galleries", grant.galleryId);
    if (gallery === null) {
      return null;
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryRole(ctx, gallery, rootFolder, "owner");
    const owners = await ctx.db
      .query("galleryRoles")
      .withIndex("by_galleryId_and_folderId", (q) =>
        q.eq("galleryId", gallery._id).eq("folderId", undefined),
      )
      .take(128);
    if (
      grant.role === "owner" &&
      grant.folderId === undefined &&
      owners.filter((owner) => owner.role === "owner").length <= 1
    ) {
      throw new Error("A gallery must retain at least one owner");
    }
    await ctx.db.delete("galleryRoles", grant._id);
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery_role.revoked",
      galleryId: gallery._id,
      detail: grant.profileId,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const mine = query({
  args: { galleryId: v.id("galleries") },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (gallery === null) {
      return null;
    }
    const root =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const profile = await requireGalleryRole(ctx, gallery, root, "viewer");
    return { profileId: profile._id };
  },
});
