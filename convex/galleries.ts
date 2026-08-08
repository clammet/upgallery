import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  folderPreviewMode,
  galleryKind,
  storageKind,
  themeValidator,
  uploaderAccess,
} from "./lib/validators";
import {
  DEFAULT_MAX_FILE_SIZE,
  MAX_HOSTS_PER_GALLERY,
  normalizeHost,
  normalizeRootPath,
  normalizeSlug,
  normalizeStorageRoot,
} from "./lib/normalize";
import {
  getCurrentProfile,
  getEffectiveRole,
  requireGalleryRole,
  requireSystemAdmin,
  roleAtLeast,
} from "./lib/permissions";
import { publicProfile } from "./lib/profiles";
import type { Doc, Id } from "./_generated/dataModel";

const hostInput = v.object({
  host: v.string(),
  rootPath: v.string(),
});

const MIN_THUMBNAIL_FRAME_SIZE = 96;
const MAX_THUMBNAIL_FRAME_SIZE = 512;

function validateThumbnailFrameSize(theme: {
  thumbnailFrameSize?: number;
}) {
  if (
    theme.thumbnailFrameSize !== undefined &&
    (!Number.isSafeInteger(theme.thumbnailFrameSize) ||
      theme.thumbnailFrameSize < MIN_THUMBNAIL_FRAME_SIZE ||
      theme.thumbnailFrameSize > MAX_THUMBNAIL_FRAME_SIZE)
  ) {
    throw new Error(
      `Thumbnail frame size must be between ${MIN_THUMBNAIL_FRAME_SIZE} and ${MAX_THUMBNAIL_FRAME_SIZE} pixels`,
    );
  }
}

async function assertHostsAvailable(
  ctx: Parameters<typeof requireSystemAdmin>[0],
  hosts: Array<{ host: string; rootPath: string }>,
  exceptGalleryId?: Id<"galleries">,
) {
  if (hosts.length === 0 || hosts.length > MAX_HOSTS_PER_GALLERY) {
    throw new Error(
      `A gallery must have between 1 and ${MAX_HOSTS_PER_GALLERY} host routes.`,
    );
  }
  const seen = new Set<string>();
  for (const route of hosts) {
    const key = `${route.host}\n${route.rootPath}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate host route: ${route.host}${route.rootPath}`);
    }
    seen.add(key);
    const matches = await ctx.db
      .query("galleryHosts")
      .withIndex("by_host", (q) => q.eq("host", route.host))
      .take(32);
    if (
      matches.some(
        (match) =>
          match.rootPath === route.rootPath &&
          match.galleryId !== exceptGalleryId,
      )
    ) {
      throw new Error(`Host route is already in use: ${route.host}${route.rootPath}`);
    }
  }
}

async function galleryResult(
  ctx: Parameters<typeof getCurrentProfile>[0],
  gallery: Doc<"galleries">,
  anonymousClaim?: string,
) {
  const rootFolder =
    gallery.rootFolderId === undefined
      ? null
      : await ctx.db.get("folders", gallery.rootFolderId);
  const profile = await getCurrentProfile(ctx, anonymousClaim);
  const role = await getEffectiveRole(ctx, gallery._id, rootFolder, profile);
  return {
    gallery,
    rootFolder,
    access: {
      role,
      canView: rootFolder?.privacy !== "private" || roleAtLeast(role, "viewer"),
      canUpload: roleAtLeast(role, "editor"),
      canManage: roleAtLeast(role, "owner"),
    },
  };
}

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    kind: galleryKind,
    storageKind,
    storageRoot: v.string(),
    maxFileSize: v.optional(v.number()),
    uploaderAccess: v.optional(uploaderAccess),
    hosts: v.array(hostInput),
    folderPreviewMode: v.optional(folderPreviewMode),
    theme: v.optional(themeValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireSystemAdmin(ctx);
    const name = args.name.trim();
    if (name.length < 1 || name.length > 120) {
      throw new Error("Gallery name must contain between 1 and 120 characters");
    }
    const slug = normalizeSlug(args.slug);
    const storageRoot = normalizeStorageRoot(args.storageRoot);
    const duplicateSlug = await ctx.db
      .query("galleries")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (duplicateSlug !== null) {
      throw new Error("That gallery slug is already in use");
    }
    if (args.kind === "uploader" && args.storageKind !== "shared") {
      throw new Error("Uploader galleries must use shared storage");
    }
    const maxFileSize = args.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (
      !Number.isSafeInteger(maxFileSize) ||
      maxFileSize < 1024 ||
      maxFileSize > 10 * 1024 * 1024 * 1024
    ) {
      throw new Error("Maximum file size must be between 1 KiB and 10 GiB");
    }
    const hosts = args.hosts.map((route) => ({
      host: normalizeHost(route.host),
      rootPath: normalizeRootPath(route.rootPath),
    }));
    validateThumbnailFrameSize(args.theme ?? {});
    await assertHostsAvailable(ctx, hosts);

    const galleryId = await ctx.db.insert("galleries", {
      name,
      slug,
      kind: args.kind,
      storageKind: args.storageKind,
      storageRoot,
      maxFileSize,
      uploaderAccess:
        args.uploaderAccess ?? (args.kind === "uploader" ? "anonymous" : "sso"),
      folderPreviewMode: args.folderPreviewMode ?? "first",
      theme: args.theme ?? {},
      itemCount: 0,
      totalBytes: 0,
    });
    const rootFolderId = await ctx.db.insert("folders", {
      galleryId,
      ancestorIds: [],
      name,
      slug: "",
      privacy: "public",
    });
    await ctx.db.patch("galleries", galleryId, { rootFolderId });
    await ctx.db.insert("galleryRoles", {
      galleryId,
      profileId: actor._id,
      role: "owner",
    });
    for (const route of hosts) {
      await ctx.db.insert("galleryHosts", { galleryId, ...route });
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery.created",
      galleryId,
      detail: `${args.kind}:${slug}`,
      createdAt: Date.now(),
    });
    return galleryId;
  },
});

export const resolveBySlug = query({
  args: {
    slug: v.string(),
    anonymousClaim: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const gallery = await ctx.db
      .query("galleries")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (gallery === null || gallery.deletedAt !== undefined) {
      return null;
    }
    return await galleryResult(ctx, gallery, args.anonymousClaim);
  },
});

export const resolveByHost = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    host: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const host = normalizeHost(args.host);
    const path = normalizeRootPath(args.path);
    const routes = await ctx.db
      .query("galleryHosts")
      .withIndex("by_host", (q) => q.eq("host", host))
      .take(32);
    const matching = routes
      .filter(
        (route) =>
          route.rootPath === "/" ||
          path === route.rootPath ||
          path.startsWith(`${route.rootPath}/`),
      )
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
    if (matching === undefined) {
      return null;
    }
    const gallery = await ctx.db.get("galleries", matching.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      return null;
    }
    return {
      ...(await galleryResult(ctx, gallery, args.anonymousClaim)),
      routeRoot: matching.rootPath,
    };
  },
});

export const listManaged = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (profile === null) {
      return [];
    }
    if (profile.isSystemAdmin) {
      const galleries = await ctx.db.query("galleries").order("desc").take(200);
      return galleries.filter((gallery) => gallery.deletedAt === undefined);
    }
    const grants = await ctx.db
      .query("galleryRoles")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(256);
    const ids = [
      ...new Set(
        grants
          .filter((grant) => grant.role === "owner")
          .map((grant) => grant.galleryId),
      ),
    ];
    const galleries: Array<Doc<"galleries">> = [];
    for (const galleryId of ids.slice(0, 100)) {
      const gallery = await ctx.db.get("galleries", galleryId);
      if (gallery !== null && gallery.deletedAt === undefined) {
        galleries.push(gallery);
      }
    }
    return galleries;
  },
});

export const listOwnedImageGalleries = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (profile === null) {
      return [];
    }
    let galleries: Array<Doc<"galleries">>;
    if (profile.isSystemAdmin) {
      galleries = await ctx.db.query("galleries").order("desc").take(200);
    } else {
      const grants = await ctx.db
        .query("galleryRoles")
        .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
        .take(256);
      const galleryIds = [
        ...new Set(
          grants
            .filter(
              (grant) =>
                grant.role === "owner" && grant.folderId === undefined,
            )
            .map((grant) => grant.galleryId),
        ),
      ];
      galleries = [];
      for (const galleryId of galleryIds.slice(0, 100)) {
        const gallery = await ctx.db.get("galleries", galleryId);
        if (gallery !== null) {
          galleries.push(gallery);
        }
      }
    }
    return galleries
      .filter(
        (gallery) =>
          gallery.kind === "image" &&
          gallery.deletedAt === undefined &&
          gallery.pendingMigrationId === undefined &&
          gallery.rootFolderId !== undefined,
      )
      .map((gallery) => ({
        _id: gallery._id,
        name: gallery.name,
        rootFolderId: gallery.rootFolderId!,
      }));
  },
});

export const adminDetails = query({
  args: { galleryId: v.id("galleries") },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      throw new Error("Gallery not found");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    await requireGalleryRole(ctx, gallery, rootFolder, "owner");
    const hosts = await ctx.db
      .query("galleryHosts")
      .withIndex("by_galleryId", (q) => q.eq("galleryId", gallery._id))
      .take(32);
    const grants = await ctx.db
      .query("galleryRoles")
      .withIndex("by_galleryId_and_folderId", (q) =>
        q.eq("galleryId", gallery._id),
      )
      .take(256);
    const enrichedGrants = [];
    for (const grant of grants) {
      const profile = await ctx.db.get("profiles", grant.profileId);
      enrichedGrants.push({
        ...grant,
        profile: profile === null ? null : publicProfile(profile),
      });
    }
    const migrations = await ctx.db
      .query("storageMigrations")
      .withIndex("by_galleryId", (q) => q.eq("galleryId", gallery._id))
      .order("desc")
      .take(20);
    return { gallery, rootFolder, hosts, grants: enrichedGrants, migrations };
  },
});

export const update = mutation({
  args: {
    galleryId: v.id("galleries"),
    name: v.string(),
    maxFileSize: v.number(),
    uploaderAccess,
    hosts: v.array(hostInput),
    folderPreviewMode: v.optional(folderPreviewMode),
    theme: themeValidator,
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
    const hosts = args.hosts.map((route) => ({
      host: normalizeHost(route.host),
      rootPath: normalizeRootPath(route.rootPath),
    }));
    validateThumbnailFrameSize(args.theme);
    await assertHostsAvailable(ctx, hosts, gallery._id);
    if (
      !Number.isSafeInteger(args.maxFileSize) ||
      args.maxFileSize < 1024 ||
      args.maxFileSize > 10 * 1024 * 1024 * 1024
    ) {
      throw new Error("Maximum file size must be between 1 KiB and 10 GiB");
    }
    const oldHosts = await ctx.db
      .query("galleryHosts")
      .withIndex("by_galleryId", (q) => q.eq("galleryId", gallery._id))
      .take(32);
    for (const host of oldHosts) {
      await ctx.db.delete("galleryHosts", host._id);
    }
    for (const host of hosts) {
      await ctx.db.insert("galleryHosts", {
        galleryId: gallery._id,
        ...host,
      });
    }
    await ctx.db.patch("galleries", gallery._id, {
      name: args.name.trim(),
      maxFileSize: args.maxFileSize,
      uploaderAccess: args.uploaderAccess,
      folderPreviewMode:
        args.folderPreviewMode ?? gallery.folderPreviewMode ?? "first",
      theme: args.theme,
    });
    if (rootFolder !== null) {
      await ctx.db.patch("folders", rootFolder._id, {
        name: args.name.trim(),
      });
    }
    if (
      gallery.storageKind === "user" &&
      gallery.maxFileSize !== args.maxFileSize
    ) {
      const syncStates = await ctx.db
        .query("filesystemSyncStates")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", gallery._id))
        .take(256);
      for (const state of syncStates) {
        await ctx.db.patch("filesystemSyncStates", state._id, {
          knownModifiedAt: undefined,
        });
      }
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery.updated",
      galleryId: gallery._id,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: { galleryId: v.id("galleries") },
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
    await ctx.db.patch("galleries", gallery._id, {
      deletedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.galleryCleanup.queueEntries, {
      galleryId: gallery._id,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery.deleted",
      galleryId: gallery._id,
      createdAt: Date.now(),
    });
    return null;
  },
});
