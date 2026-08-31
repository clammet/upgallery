import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { galleryRole } from "./lib/validators";
import { normalizeEmail } from "./lib/normalize";
import { requireGalleryRole } from "./lib/permissions";
import {
  ensureUnknownUploaderProfile,
  placeholderIdentityId,
} from "./lib/profiles";

const OWNERSHIP_BATCH_SIZE = 100;

async function hasGalleryWideOwnerGrant(
  ctx: MutationCtx,
  galleryId: Id<"galleries">,
  rootFolderId: Id<"folders"> | undefined,
  profileId: Id<"profiles">,
): Promise<boolean> {
  const grants = await ctx.db
    .query("galleryRoles")
    .withIndex("by_galleryId_and_profileId", (q) =>
      q.eq("galleryId", galleryId).eq("profileId", profileId),
    )
    .take(128);
  return grants.some(
    (grant) =>
      grant.role === "owner" &&
      (grant.folderId === undefined || grant.folderId === rootFolderId),
  );
}

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
    if (profile !== null && profile.isAnonymous) {
      throw new Error("Anonymous visitors cannot be granted access");
    }
    if (profile === null) {
      const email = args.email === undefined ? "" : normalizeEmail(args.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Enter the email address of the user to invite");
      }
      const placeholderId = await ctx.db.insert("profiles", {
        identityId: placeholderIdentityId(email),
        email,
        isAnonymous: false,
        isSystemAdmin: false,
        lastSeenAt: 0,
      });
      profile = await ctx.db.get("profiles", placeholderId);
    }
    if (profile === null) {
      throw new Error("Profile not found");
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

export const takeUnknownUploaderItems = mutation({
  args: { grantId: v.id("galleryRoles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db.get("galleryRoles", args.grantId);
    if (grant === null) throw new Error("Permission grant not found");
    const gallery = await ctx.db.get("galleries", grant.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image" ||
      gallery.storageKind !== "user"
    ) {
      throw new Error("Unknown uploader items only exist in user-mounted galleries");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryRole(ctx, gallery, rootFolder, "owner");
    const targetProfile = await ctx.db.get("profiles", grant.profileId);
    if (targetProfile === null) throw new Error("Target owner not found");
    if (
      grant.role !== "owner" ||
      (grant.folderId !== undefined && grant.folderId !== gallery.rootFolderId)
    ) {
      throw new Error(
        "Unknown uploader items can only be assigned to a gallery owner",
      );
    }
    const unknownUploader = await ensureUnknownUploaderProfile(ctx);
    await ctx.scheduler.runAfter(
      0,
      internal.roles.takeUnknownUploaderItemsBatch,
      {
        galleryId: gallery._id,
        targetProfileId: grant.profileId,
        unknownProfileId: unknownUploader._id,
        cursor: null,
      },
    );
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "filesystem_uploader.taken",
      galleryId: gallery._id,
      detail: grant.profileId,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const takeUnknownUploaderItemsBatch = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    targetProfileId: v.id("profiles"),
    unknownProfileId: v.id("profiles"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.storageKind !== "user" ||
      !(await hasGalleryWideOwnerGrant(
        ctx,
        gallery._id,
        gallery.rootFolderId,
        args.targetProfileId,
      ))
    ) {
      return null;
    }
    const page = await ctx.db
      .query("entries")
      .withIndex("by_galleryId_and_storageKind", (q) =>
        q.eq("galleryId", gallery._id).eq("storageKind", "user"),
      )
      .paginate({ numItems: OWNERSHIP_BATCH_SIZE, cursor: args.cursor });
    for (const entry of page.page) {
      if (entry.ownerProfileId !== args.unknownProfileId) continue;
      await ctx.db.patch("entries", entry._id, {
        ownerProfileId: args.targetProfileId,
        filesystemOwnershipClaimed: true,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.roles.takeUnknownUploaderItemsBatch,
        { ...args, cursor: page.continueCursor },
      );
    }
    return null;
  },
});

// One-off after deploying the Unknown-uploader change. This walks every
// user-mounted gallery and changes legacy filesystem-discovered entries from
// the gallery owner to Unknown. Web uploads (which have an uploadIntentId) and
// entries already adopted by an owner are deliberately preserved.
//
//   npx convex run roles:backfillUnknownUploaderOwnership
export const backfillUnknownUploaderOwnership = internalMutation({
  args: { galleryCursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const galleries = await ctx.db
      .query("galleries")
      .paginate({ numItems: 5, cursor: args.galleryCursor ?? null });
    const unknownUploader = await ensureUnknownUploaderProfile(ctx);
    for (const gallery of galleries.page) {
      if (
        gallery.deletedAt === undefined &&
        gallery.kind === "image" &&
        gallery.storageKind === "user"
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.roles.backfillUnknownUploaderGallery,
          {
            galleryId: gallery._id,
            unknownProfileId: unknownUploader._id,
            cursor: null,
          },
        );
      }
    }
    if (!galleries.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.roles.backfillUnknownUploaderOwnership,
        { galleryCursor: galleries.continueCursor },
      );
    }
    return null;
  },
});

export const backfillUnknownUploaderGallery = internalMutation({
  args: {
    galleryId: v.id("galleries"),
    unknownProfileId: v.id("profiles"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.storageKind !== "user"
    ) {
      return null;
    }
    const page = await ctx.db
      .query("entries")
      .withIndex("by_galleryId_and_storageKind", (q) =>
        q.eq("galleryId", gallery._id).eq("storageKind", "user"),
      )
      .paginate({ numItems: OWNERSHIP_BATCH_SIZE, cursor: args.cursor });
    for (const entry of page.page) {
      if (
        entry.uploadIntentId !== undefined ||
        entry.filesystemOwnershipClaimed === true
      ) {
        continue;
      }
      await ctx.db.patch("entries", entry._id, {
        ownerProfileId: args.unknownProfileId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.roles.backfillUnknownUploaderGallery,
        { ...args, cursor: page.continueCursor },
      );
    }
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
