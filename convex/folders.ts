import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { privacy } from "./lib/validators";
import {
  cleanFilesystemSegment,
  MAX_FOLDER_DEPTH,
  normalizeSlug,
} from "./lib/normalize";
import { createToken, sha256 } from "./lib/crypto";
import {
  canViewFolder,
  getCurrentProfile,
  getEffectiveRole,
  requireGalleryRole,
  roleAtLeast,
  shouldListFolder,
} from "./lib/permissions";

export const list = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
  },
  handler: async (ctx, args) => {
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.folderId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      folder === null ||
      folder.galleryId !== gallery._id
    ) {
      throw new Error("Folder not found");
    }
    const profile = await getCurrentProfile(ctx, args.anonymousClaim);
    if (!(await canViewFolder(ctx, folder, profile))) {
      throw new Error("Unauthorized");
    }
    const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
    const filesystemSync =
      gallery.storageKind === "user"
        ? await ctx.db
            .query("filesystemSyncStates")
            .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
            .unique()
        : null;
    const canUpload =
      gallery.pendingMigrationId === undefined &&
      (gallery.kind === "image"
        ? roleAtLeast(role, "editor")
        : gallery.uploaderAccess === "anonymous"
          ? profile !== null
          : gallery.uploaderAccess === "sso"
            ? profile !== null && !profile.isAnonymous
            : roleAtLeast(role, "editor"));

    const candidateFolders = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", folder._id),
      )
      .take(128);
    const folders = [];
    for (const child of candidateFolders) {
      if (
        child.filesystemMissingAt === undefined &&
        (await shouldListFolder(ctx, child, profile))
      ) {
        folders.push(child);
      }
    }

    const entries = await ctx.db
      .query("entries")
      .withIndex("by_folderId_and_state", (q) =>
        q.eq("folderId", folder._id).eq("state", "ready"),
      )
      .order("desc")
      .take(128);
    const items = [];
    for (const entry of entries) {
      const counter = await ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique();
      const locked = entry.passwordHash !== undefined;
      items.push({
        ...entry,
        description: locked ? undefined : entry.description,
        exifJson: locked ? undefined : entry.exifJson,
        passwordSalt: undefined,
        passwordHash: undefined,
        passwordIterations: undefined,
        passwordProtected: locked,
        views: counter?.views ?? 0,
        downloads: counter?.downloads ?? 0,
      });
    }

    const breadcrumbs = [];
    for (const ancestorId of folder.ancestorIds) {
      const ancestor = await ctx.db.get("folders", ancestorId);
      if (ancestor !== null) {
        breadcrumbs.push({ _id: ancestor._id, name: ancestor.name });
      }
    }
    breadcrumbs.push({ _id: folder._id, name: folder.name });

    return {
      gallery,
      folder,
      folders,
      entries: items,
      breadcrumbs,
      filesystemSync:
        gallery.storageKind === "user"
          ? {
              isRunning: filesystemSync?.activeSyncId !== undefined,
              lastFinishedAt: filesystemSync?.lastCheckedAt,
              hasError: filesystemSync?.error !== undefined,
            }
          : null,
      access: {
        role,
        canUpload,
        canEditFolder: roleAtLeast(role, "editor"),
        canManage: roleAtLeast(role, "owner"),
      },
    };
  },
});

export const create = mutation({
  args: {
    galleryId: v.id("galleries"),
    parentId: v.id("folders"),
    name: v.string(),
    privacy,
  },
  handler: async (ctx, args) => {
    const [gallery, parent] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.parentId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      parent === null ||
      parent.galleryId !== gallery._id
    ) {
      throw new Error("Folder not found");
    }
    if (gallery.kind !== "image") {
      throw new Error("Uploader galleries do not support folders");
    }
    const actor = await requireGalleryRole(ctx, gallery, parent, "editor");
    if (parent.ancestorIds.length + 1 >= MAX_FOLDER_DEPTH) {
      throw new Error(`Folders cannot be nested deeper than ${MAX_FOLDER_DEPTH}`);
    }
    const name = args.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new Error("Folder name must contain between 1 and 120 characters");
    }
    const slug = normalizeSlug(name);
    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", parent._id),
      )
      .take(256);
    if (siblings.some((sibling) => sibling.slug === slug)) {
      throw new Error("A folder with that name already exists here");
    }
    if (gallery.storageKind === "user") {
      cleanFilesystemSegment(name);
      const token = createToken();
      const operationId = await ctx.db.insert("filesystemOperations", {
        galleryId: gallery._id,
        parentId: parent._id,
        actorProfileId: actor._id,
        kind: "mkdir",
        name,
        privacy: args.privacy,
        tokenHash: await sha256(token),
        expiresAt: Date.now() + 15 * 60 * 1000,
        state: "pending",
        attempts: 0,
      });
      return {
        kind: "filesystem" as const,
        operationId,
        token,
      };
    }
    const folderId = await ctx.db.insert("folders", {
      galleryId: gallery._id,
      parentId: parent._id,
      ancestorIds: [...parent.ancestorIds, parent._id],
      name,
      slug,
      privacy: args.privacy,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "folder.created",
      galleryId: gallery._id,
      detail: name,
      createdAt: Date.now(),
    });
    return { kind: "complete" as const, folderId };
  },
});

export const update = mutation({
  args: {
    folderId: v.id("folders"),
    name: v.string(),
    privacy,
  },
  handler: async (ctx, args) => {
    const folder = await ctx.db.get("folders", args.folderId);
    if (folder === null) {
      throw new Error("Folder not found");
    }
    const gallery = await ctx.db.get("galleries", folder.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      throw new Error("Gallery not found");
    }
    const actor = await requireGalleryRole(ctx, gallery, folder, "editor");
    if (gallery.rootFolderId === folder._id) {
      if (args.name.trim() !== folder.name) {
        throw new Error("Rename the root folder from gallery settings");
      }
      if (!actor.isSystemAdmin) {
        const role = await getEffectiveRole(ctx, gallery._id, folder, actor);
        if (!roleAtLeast(role, "owner")) {
          throw new Error("Only a gallery owner can change root privacy");
        }
      }
    }
    const name = args.name.trim();
    const slug =
      gallery.rootFolderId === folder._id ? "" : normalizeSlug(args.name);
    if (gallery.rootFolderId !== folder._id) {
      const siblings = await ctx.db
        .query("folders")
        .withIndex("by_galleryId_and_parentId", (q) =>
          q.eq("galleryId", gallery._id).eq("parentId", folder.parentId),
        )
        .take(256);
      if (
        siblings.some(
          (sibling) => sibling._id !== folder._id && sibling.slug === slug,
        )
      ) {
        throw new Error("A folder with that name already exists here");
      }
    }
    if (
      gallery.storageKind === "user" &&
      gallery.rootFolderId !== folder._id &&
      name !== folder.name
    ) {
      cleanFilesystemSegment(name);
      const token = createToken();
      const operationId = await ctx.db.insert("filesystemOperations", {
        galleryId: gallery._id,
        parentId: folder.parentId!,
        folderId: folder._id,
        actorProfileId: actor._id,
        kind: "rename",
        name,
        privacy: args.privacy,
        tokenHash: await sha256(token),
        expiresAt: Date.now() + 15 * 60 * 1000,
        state: "pending",
        attempts: 0,
      });
      return {
        kind: "filesystem" as const,
        operationId,
        token,
      };
    }
    await ctx.db.patch("folders", folder._id, {
      name,
      slug,
      privacy: args.privacy,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "folder.updated",
      galleryId: gallery._id,
      detail: name,
      createdAt: Date.now(),
    });
    return { kind: "complete" as const, folderId: folder._id };
  },
});
