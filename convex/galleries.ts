import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  folderPreviewMode,
  galleryKind,
  storageKind,
  systemGalleryRole,
  themeValidator,
} from "./lib/validators";
import { formatBytes } from "./lib/format";
import { createGalleryStats, readGalleryStats } from "./lib/galleryStats";
import { createFolderStats } from "./lib/folderStats";
import {
  DEFAULT_MAX_FILE_SIZE,
  MAX_HOSTS_PER_GALLERY,
  normalizeHost,
  normalizeRootPath,
  normalizeSlug,
  normalizeStorageRoot,
} from "./lib/normalize";
import {
  canManageGallery,
  getCurrentProfile,
  getEffectiveRole,
  requireGalleryRole,
  requireSystemAdmin,
  resolveFolderAccess,
  roleAtLeast,
} from "./lib/permissions";
import { publicProfile } from "./lib/profiles";
import type { Doc, Id } from "./_generated/dataModel";
import { readFilesystemSyncStatus } from "./lib/filesystemSyncStatus";
import { queueFilesystemSyncJob } from "./storageJobs";

const hostInput = v.object({
  host: v.string(),
  rootPath: v.string(),
});

const galleryAvailability = v.object({
  normalizedSlug: v.union(v.string(), v.null()),
  normalizedStorageRoot: v.union(v.string(), v.null()),
  slugAvailable: v.boolean(),
  storageRootAvailable: v.boolean(),
});

const MIN_THUMBNAIL_FRAME_SIZE = 96;
const MAX_THUMBNAIL_FRAME_SIZE = 512;
const DEFAULT_GALLERY_PAGE_SIZE = 100;
const MIN_GALLERY_PAGE_SIZE = 50;
const MAX_GALLERY_PAGE_SIZE = 250;
const GALLERY_PAGE_SIZE_STEP = 50;

function validatePaginationPageSize(pageSize: number) {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < MIN_GALLERY_PAGE_SIZE ||
    pageSize > MAX_GALLERY_PAGE_SIZE ||
    pageSize % GALLERY_PAGE_SIZE_STEP !== 0
  ) {
    throw new Error(
      `Gallery page size must be ${MIN_GALLERY_PAGE_SIZE}-${MAX_GALLERY_PAGE_SIZE} in steps of ${GALLERY_PAGE_SIZE_STEP}`,
    );
  }
}

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
  const access = await resolveFolderAccess(
    ctx,
    gallery._id,
    rootFolder,
    profile,
    anonymousClaim,
  );
  return {
    gallery,
    rootFolder,
    access: {
      role: access.role,
      canView: access.canView,
      canUpload: access.canUpload,
      canManage: canManageGallery(gallery, access.role),
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
    hosts: v.array(hostInput),
    folderPreviewMode: v.optional(folderPreviewMode),
    theme: v.optional(themeValidator),
  },
  returns: v.id("galleries"),
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
      throw new Error("That internal slug is already in use");
    }
    const duplicateStorageRoot = await ctx.db
      .query("galleries")
      .withIndex("by_storageRoot", (q) => q.eq("storageRoot", storageRoot))
      .first();
    if (duplicateStorageRoot !== null) {
      throw new Error("That internal storage path is already in use");
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
      maxFileSizeLimit: maxFileSize,
      anonymousRole: "viewer",
      authenticatedRole: "viewer",
      folderPreviewMode: args.folderPreviewMode ?? "first",
      infiniteScroll: true,
      paginationPageSize: DEFAULT_GALLERY_PAGE_SIZE,
      theme: args.theme ?? {},
    });
    await createGalleryStats(ctx, galleryId);
    const rootFolderId = await ctx.db.insert("folders", {
      galleryId,
      ancestorIds: [],
      name,
      slug: "",
      accessPolicy: "inherit",
      discoverability: "listed",
    });
    await ctx.db.patch("galleries", galleryId, { rootFolderId });
    await createFolderStats(ctx, rootFolderId, galleryId);
    if (args.storageKind === "user") {
      await queueFilesystemSyncJob(ctx, { galleryId, folderId: rootFolderId });
    }
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

export const checkAvailability = query({
  args: {
    slug: v.string(),
    storageRoot: v.string(),
  },
  returns: galleryAvailability,
  handler: async (ctx, args) => {
    await requireSystemAdmin(ctx);

    let normalizedSlug: string | null = null;
    let normalizedStorageRoot: string | null = null;
    try {
      normalizedSlug = normalizeSlug(args.slug);
    } catch {
      // Partially typed manual values are reported as unavailable, not thrown.
    }
    try {
      normalizedStorageRoot = normalizeStorageRoot(args.storageRoot);
    } catch {
      // Partially typed manual values are reported as unavailable, not thrown.
    }

    const duplicateSlug =
      normalizedSlug === null
        ? null
        : await ctx.db
            .query("galleries")
            .withIndex("by_slug", (q) => q.eq("slug", normalizedSlug!))
            .first();
    const duplicateStorageRoot =
      normalizedStorageRoot === null
        ? null
        : await ctx.db
            .query("galleries")
            .withIndex("by_storageRoot", (q) =>
              q.eq("storageRoot", normalizedStorageRoot!),
            )
            .first();

    return {
      normalizedSlug,
      normalizedStorageRoot,
      slugAvailable: normalizedSlug !== null && duplicateSlug === null,
      storageRootAvailable:
        normalizedStorageRoot !== null && duplicateStorageRoot === null,
    };
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
    const ownerGrants = grants.filter((grant) => grant.role === "owner");
    const ids = [...new Set(ownerGrants.map((grant) => grant.galleryId))];
    const galleries: Array<Doc<"galleries">> = [];
    for (const galleryId of ids.slice(0, 100)) {
      const gallery = await ctx.db.get("galleries", galleryId);
      // Only gallery-wide owner grants confer admin access; a grant scoped to
      // a subfolder does not.
      if (
        gallery !== null &&
        gallery.deletedAt === undefined &&
        ownerGrants.some(
          (grant) =>
            grant.galleryId === galleryId &&
            (grant.folderId === undefined ||
              grant.folderId === gallery.rootFolderId),
        )
      ) {
        galleries.push(gallery);
      }
    }
    return galleries;
  },
});

export const listOwnedImageGalleries = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    // The gallery being browsed. It is offered as a destination whenever the
    // caller can bulk-move there without owning it (editors, anonymous
    // visitors), since grants alone would miss it.
    galleryId: v.optional(v.id("galleries")),
  },
  handler: async (ctx, args) => {
    const profile = await getCurrentProfile(ctx, args.anonymousClaim);
    if (profile === null) {
      if (args.galleryId === undefined) {
        return [];
      }
      const current = await ctx.db.get("galleries", args.galleryId);
      if (
        current === null ||
        current.kind !== "image" ||
        current.deletedAt !== undefined ||
        current.pendingMigrationId !== undefined ||
        current.rootFolderId === undefined
      ) {
        return [];
      }
      const root = await ctx.db.get("folders", current.rootFolderId);
      const role = await getEffectiveRole(
        ctx,
        current._id,
        root,
        null,
        args.anonymousClaim,
      );
      return canManageGallery(current, role)
        ? [
            {
              _id: current._id,
              name: current.name,
              rootFolderId: current.rootFolderId,
            },
          ]
        : [];
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
      if (
        args.galleryId !== undefined &&
        !galleryIds.includes(args.galleryId)
      ) {
        const current = await ctx.db.get("galleries", args.galleryId);
        if (current !== null) {
          const root =
            current.rootFolderId === undefined
              ? null
              : await ctx.db.get("folders", current.rootFolderId);
          const role = await getEffectiveRole(
            ctx,
            current._id,
            root,
            profile,
            args.anonymousClaim,
          );
          if (canManageGallery(current, role)) {
            galleries.push(current);
          }
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
      return null;
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
    return {
      gallery,
      stats: await readGalleryStats(ctx, gallery),
      filesystemSync:
        gallery.storageKind === "user" && rootFolder !== null
          ? await readFilesystemSyncStatus(ctx, rootFolder._id)
          : null,
      rootFolder,
      hosts,
      grants: enrichedGrants,
      migrations,
    };
  },
});

export const update = mutation({
  args: {
    galleryId: v.id("galleries"),
    // Every setting is optional with patch semantics: omitted fields keep
    // their stored value. Clients send only what the user changed, so a
    // stale tab or an older build cannot reset settings it never touched.
    name: v.optional(v.string()),
    maxFileSize: v.optional(v.number()),
    maxFileSizeLimit: v.optional(v.number()),
    hosts: v.optional(v.array(hostInput)),
    folderPreviewMode: v.optional(folderPreviewMode),
    quickMove: v.optional(v.boolean()),
    editorBulkActions: v.optional(v.boolean()),
    infiniteScroll: v.optional(v.boolean()),
    paginationPageSize: v.optional(v.number()),
    friendlyFolderUrls: v.optional(v.boolean()),
    theme: v.optional(themeValidator),
  },
  returns: v.null(),
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
    if (args.theme !== undefined) {
      validateThumbnailFrameSize(args.theme);
    }
    if (args.paginationPageSize !== undefined) {
      validatePaginationPageSize(args.paginationPageSize);
    }
    if (
      args.maxFileSize !== undefined &&
      (!Number.isSafeInteger(args.maxFileSize) ||
        args.maxFileSize < 1024 ||
        args.maxFileSize > 10 * 1024 * 1024 * 1024)
    ) {
      throw new Error("Maximum file size must be between 1 KiB and 10 GiB");
    }
    let maxFileSizeLimit = gallery.maxFileSizeLimit ?? gallery.maxFileSize;
    if (args.maxFileSizeLimit !== undefined) {
      if (!actor.isSystemAdmin) {
        throw new Error(
          "Only system administrators can change the maximum file size limit",
        );
      }
      if (
        !Number.isSafeInteger(args.maxFileSizeLimit) ||
        args.maxFileSizeLimit < 1024 ||
        args.maxFileSizeLimit > 10 * 1024 * 1024 * 1024
      ) {
        throw new Error(
          "Maximum file size limit must be between 1 KiB and 10 GiB",
        );
      }
      maxFileSizeLimit = args.maxFileSizeLimit;
    }
    if ((args.maxFileSize ?? gallery.maxFileSize) > maxFileSizeLimit) {
      throw new Error(
        `Maximum file size cannot exceed the ${formatBytes(maxFileSizeLimit)} limit set by a system administrator`,
      );
    }
    if (args.hosts !== undefined) {
      if (!actor.isSystemAdmin) {
        throw new Error("Only system administrators can change host routes");
      }
      const hosts = args.hosts.map((route) => ({
        host: normalizeHost(route.host),
        rootPath: normalizeRootPath(route.rootPath),
      }));
      await assertHostsAvailable(ctx, hosts, gallery._id);
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
    }
    const name = args.name?.trim();
    // The limit is written when set explicitly, and pinned on legacy
    // galleries (which have none) whenever the size changes so owners
    // cannot raise the size afterwards.
    const writeLimit =
      args.maxFileSizeLimit !== undefined ||
      (args.maxFileSize !== undefined &&
        gallery.maxFileSizeLimit === undefined);
    await ctx.db.patch("galleries", gallery._id, {
      ...(name === undefined ? {} : { name }),
      ...(args.maxFileSize === undefined
        ? {}
        : { maxFileSize: args.maxFileSize }),
      ...(writeLimit ? { maxFileSizeLimit } : {}),
      ...(args.folderPreviewMode === undefined
        ? {}
        : { folderPreviewMode: args.folderPreviewMode }),
      ...(args.quickMove === undefined
        ? {}
        : { quickMove: args.quickMove ? true : undefined }),
      ...(args.editorBulkActions === undefined
        ? {}
        : { editorBulkActions: args.editorBulkActions ? true : undefined }),
      ...(args.infiniteScroll === undefined
        ? {}
        : { infiniteScroll: args.infiniteScroll }),
      ...(args.paginationPageSize === undefined
        ? {}
        : { paginationPageSize: args.paginationPageSize }),
      ...(args.friendlyFolderUrls === undefined
        ? {}
        : {
            friendlyFolderUrls: args.friendlyFolderUrls ? true : undefined,
          }),
      ...(args.theme === undefined ? {} : { theme: args.theme }),
    });
    if (name !== undefined && rootFolder !== null) {
      await ctx.db.patch("folders", rootFolder._id, { name });
    }
    if (
      gallery.storageKind === "user" &&
      args.maxFileSize !== undefined &&
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

export const setSystemPermission = mutation({
  args: {
    galleryId: v.id("galleries"),
    principal: v.union(v.literal("anonymous"), v.literal("authenticated")),
    role: systemGalleryRole,
  },
  returns: v.null(),
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
      ...(args.principal === "anonymous"
        ? { anonymousRole: args.role }
        : { authenticatedRole: args.role }),
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "gallery.system_permission.updated",
      galleryId: gallery._id,
      detail: `${args.principal}:${args.role}`,
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
