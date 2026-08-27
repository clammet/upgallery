import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  folderAccessPolicy,
  folderDiscoverability,
  folderPreviewMode,
} from "./lib/validators";
import type { Id } from "./_generated/dataModel";
import {
  getFilesystemFolderSegments,
  getFilesystemStorageKey,
} from "./lib/filesystem";
import {
  cleanFilesystemSegment,
  MAX_FOLDER_DEPTH,
  normalizeSlug,
} from "./lib/normalize";
import { createToken, sha256 } from "./lib/crypto";
import { createFolderStats } from "./lib/folderStats";
import {
  folderAccessPolicyOf,
  folderDiscoverabilityOf,
} from "./lib/folderAccess";
import {
  assertCanManageGallery,
  canManageGallery,
  getCurrentProfile,
  getEffectiveRole,
  isOwningProfile,
  requireGalleryManager,
  requireGalleryRole,
  resolveFolderAccess,
  roleAtLeast,
  shouldListFolder,
} from "./lib/permissions";
import { readFilesystemSyncStatus } from "./lib/filesystemSyncStatus";
import { uploaderAttribution } from "./lib/profiles";

type FolderPreviewMode = "first" | "random" | "first3" | "random3";

const MAX_BULK_FOLDERS = 128;

function randomPreviewThreshold(
  seed: number,
  folderId: Id<"folders">,
) {
  let hash = seed | 0;
  const value = folderId.toString();
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").padEnd(64, "0");
}

export const list = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    previewSeed: v.optional(v.number()),
    // GalleryPage loads entries through its paginated query. UploaderPage and
    // older callers retain the embedded first page by omitting this flag.
    includeEntries: v.optional(v.boolean()),
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
    const folderAccess = await resolveFolderAccess(
      ctx,
      gallery._id,
      folder,
      profile,
      args.anonymousClaim,
    );
    if (!folderAccess.canView) {
      throw new Error("Unauthorized");
    }
    const role = folderAccess.role;
    const filesystemSync =
      gallery.storageKind === "user"
        ? await readFilesystemSyncStatus(ctx, folder._id)
        : null;
    const canUpload =
      gallery.pendingMigrationId === undefined && roleAtLeast(role, "editor");

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
        (await shouldListFolder(ctx, child, profile, args.anonymousClaim))
      ) {
        folders.push(child);
      }
    }

    const previewSeed = Math.trunc(args.previewSeed ?? 0);
    if (!Number.isSafeInteger(previewSeed)) {
      throw new Error("Invalid folder preview seed");
    }
    const folderPreviews = await Promise.all(
      folders.map(async (child) => {
        const mode =
          child.previewMode ?? gallery.folderPreviewMode ?? "first";
        const count = mode === "first3" || mode === "random3" ? 3 : 1;
        let candidates;
        if (mode === "first" || mode === "first3") {
          candidates = await ctx.db
            .query("entries")
            .withIndex(
              "by_folderId_and_state_and_mediaKind_and_moveJobId_and_name",
              (q) =>
                q
                  .eq("folderId", child._id)
                  .eq("state", "ready")
                  .eq("mediaKind", "image")
                  .eq("moveJobId", undefined),
            )
            .take(count);
        } else {
          const threshold = randomPreviewThreshold(
            previewSeed,
            child._id,
          );
          const afterThreshold = await ctx.db
            .query("entries")
            .withIndex(
              "by_folderId_and_state_and_mediaKind_and_moveJobId_and_sha256",
              (q) =>
                q
                  .eq("folderId", child._id)
                  .eq("state", "ready")
                  .eq("mediaKind", "image")
                  .eq("moveJobId", undefined)
                  .gte("sha256", threshold),
            )
            .take(count);
          const beforeThreshold =
            afterThreshold.length >= count
              ? []
              : await ctx.db
                  .query("entries")
                  .withIndex(
                    "by_folderId_and_state_and_mediaKind_and_moveJobId_and_sha256",
                    (q) =>
                      q
                        .eq("folderId", child._id)
                        .eq("state", "ready")
                        .eq("mediaKind", "image")
                        .eq("moveJobId", undefined)
                        .lt("sha256", threshold),
                  )
                  .take(count - afterThreshold.length);
          candidates = [...afterThreshold, ...beforeThreshold];
        }
        return {
          folderId: child._id,
          mode,
          entries: candidates.map((entry) => ({
            _id: entry._id,
            name: entry.name,
            thumbnailKey: entry.thumbnailKey,
            thumbnailState: entry.thumbnailState,
          })),
        };
      }),
    );

    const entries =
      args.includeEntries === false
        ? []
        : await ctx.db
            .query("entries")
            .withIndex("by_folderId_and_state", (q) =>
              q.eq("folderId", folder._id).eq("state", "ready"),
            )
            .order("desc")
            .take(128);
    const items = [];
    const uploaderByProfileId = new Map<Id<"profiles">, string>();
    for (const entry of entries) {
      if (entry.moveJobId !== undefined) {
        continue;
      }
      const ownsEntry =
        gallery.kind === "uploader" &&
        profile !== null &&
        isOwningProfile(entry.ownerProfileId, profile._id);
      if (
        gallery.kind === "uploader" &&
        entry.unlisted === true &&
        !ownsEntry
      ) {
        continue;
      }
      const counterPromise = ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique();
      let uploader = uploaderByProfileId.get(entry.ownerProfileId);
      if (uploader === undefined) {
        const uploaderProfile = await ctx.db.get(
          "profiles",
          entry.ownerProfileId,
        );
        uploader =
          uploaderProfile === null
            ? "Unknown"
            : uploaderAttribution(uploaderProfile);
        uploaderByProfileId.set(entry.ownerProfileId, uploader);
      }
      const counter = await counterPromise;
      const locked = entry.passwordHash !== undefined;
      const canDelete = ownsEntry;
      const concealProtectedMetadata = locked && !canDelete;
      items.push({
        ...entry,
        uploader,
        description: locked ? undefined : entry.description,
        metadataJson: concealProtectedMetadata
          ? undefined
          : entry.metadataJson,
        passwordSalt: undefined,
        passwordHash: undefined,
        passwordIterations: undefined,
        passwordProtected: locked,
        canDelete,
        views: counter?.views ?? 0,
      });
    }

    // Admin access is granted by owner role at the gallery root, matching
    // galleries.adminDetails — a folder-scoped owner grant is not enough.
    let galleryRole = role;
    if (
      profile !== null &&
      gallery.rootFolderId !== undefined &&
      gallery.rootFolderId !== folder._id
    ) {
      const galleryRoot = await ctx.db.get("folders", gallery.rootFolderId);
      galleryRole = await getEffectiveRole(
        ctx,
        gallery._id,
        galleryRoot,
        profile,
        args.anonymousClaim,
      );
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
      folderPreviews,
      entries: items,
      breadcrumbs,
      filesystemSync:
        gallery.storageKind === "user"
          ? filesystemSync
          : null,
      access: {
        role,
        canUpload,
        canEditFolder: roleAtLeast(role, "editor"),
        canManage: canManageGallery(gallery, role),
        canAdminGallery: roleAtLeast(galleryRole, "owner"),
      },
    };
  },
});

export const create = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    parentId: v.id("folders"),
    name: v.string(),
    accessPolicy: folderAccessPolicy,
    discoverability: folderDiscoverability,
    previewMode: v.optional(folderPreviewMode),
    existingOk: v.optional(v.boolean()),
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
    const actor = await requireGalleryRole(
      ctx,
      gallery,
      parent,
      "editor",
      args.anonymousClaim,
    );
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
    const existing = siblings.find((sibling) => sibling.slug === slug);
    if (existing !== undefined) {
      if (args.existingOk === true) {
        return { kind: "complete" as const, folderId: existing._id };
      }
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
        accessPolicy: args.accessPolicy,
        discoverability: args.discoverability,
        previewMode: args.previewMode,
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
      accessPolicy: args.accessPolicy,
      discoverability: args.discoverability,
      previewMode: args.previewMode,
    });
    await createFolderStats(ctx, folderId, gallery._id);
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

export const removeMany = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderIds: v.array(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const folderIds = [...new Set(args.folderIds)];
    if (folderIds.length < 1 || folderIds.length > MAX_BULK_FOLDERS) {
      throw new Error(
        `Select between 1 and ${MAX_BULK_FOLDERS} folders to delete`,
      );
    }
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image"
    ) {
      throw new Error("Gallery not found");
    }
    if (gallery.pendingMigrationId !== undefined) {
      throw new Error("Folders cannot be deleted during storage migration");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryManager(
      ctx,
      gallery,
      rootFolder,
      args.anonymousClaim,
    );
    const folders = [];
    for (const folderId of folderIds) {
      const folder = await ctx.db.get("folders", folderId);
      if (
        folder === null ||
        folder.galleryId !== gallery._id ||
        folder.filesystemMissingAt !== undefined
      ) {
        throw new Error("A selected folder is no longer available");
      }
      if (gallery.rootFolderId === folder._id || folder.parentId === undefined) {
        throw new Error("The root folder cannot be deleted");
      }
      folders.push(folder);
    }

    const now = Date.now();
    if (gallery.storageKind === "user") {
      const operations = [];
      for (const folder of folders) {
        const token = createToken();
        const operationId = await ctx.db.insert("filesystemOperations", {
          galleryId: gallery._id,
          parentId: folder.parentId!,
          folderId: folder._id,
          actorProfileId: actor._id,
          kind: "rmdir",
          name: cleanFilesystemSegment(folder.name),
          accessPolicy: folderAccessPolicyOf(folder),
          discoverability: folderDiscoverabilityOf(folder),
          previewMode: folder.previewMode,
          tokenHash: await sha256(token),
          expiresAt: now + 15 * 60 * 1000,
          state: "pending",
          attempts: 0,
        });
        operations.push({ folderId: folder._id, operationId, token });
      }
      return { kind: "filesystem" as const, operations };
    }
    for (const folder of folders) {
      // filesystemMissingAt doubles as the tombstone for app-initiated
      // deletes: every listing and destination check already excludes it,
      // and cleanupMissingFolder removes the subtree behind it.
      await ctx.db.patch("folders", folder._id, {
        filesystemMissingAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.filesystemSync.cleanupMissingFolder,
        { folderId: folder._id },
      );
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "folders.deleted",
      galleryId: gallery._id,
      detail: `${folders.length} folder${folders.length === 1 ? "" : "s"}`,
      createdAt: now,
    });
    return { kind: "complete" as const };
  },
});

export const moveMany = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    destinationFolderId: v.id("folders"),
    folderIds: v.array(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const folderIds = [...new Set(args.folderIds)];
    if (folderIds.length < 1 || folderIds.length > MAX_BULK_FOLDERS) {
      throw new Error(
        `Select between 1 and ${MAX_BULK_FOLDERS} folders to move`,
      );
    }
    const [gallery, destination] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.destinationFolderId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image"
    ) {
      throw new Error("Gallery not found");
    }
    if (gallery.pendingMigrationId !== undefined) {
      throw new Error("Folders cannot be moved during storage migration");
    }
    if (
      destination === null ||
      destination.galleryId !== gallery._id ||
      destination.filesystemMissingAt !== undefined
    ) {
      throw new Error("Destination folder is unavailable");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryManager(
      ctx,
      gallery,
      rootFolder,
      args.anonymousClaim,
    );

    const selectedIds = new Set(folderIds);
    const folders = [];
    for (const folderId of folderIds) {
      const folder = await ctx.db.get("folders", folderId);
      if (
        folder === null ||
        folder.galleryId !== gallery._id ||
        folder.filesystemMissingAt !== undefined
      ) {
        throw new Error("A selected folder is no longer available");
      }
      if (gallery.rootFolderId === folder._id || folder.parentId === undefined) {
        throw new Error("The root folder cannot be moved");
      }
      if (
        destination._id === folder._id ||
        destination.ancestorIds.includes(folder._id)
      ) {
        throw new Error(`${folder.name} cannot be moved into itself`);
      }
      if (folder.ancestorIds.some((ancestorId) => selectedIds.has(ancestorId))) {
        throw new Error("Move one branch of nested folders at a time");
      }
      folders.push(folder);
    }
    const movingFolders = folders.filter(
      (folder) => folder.parentId !== destination._id,
    );
    if (movingFolders.length === 0) {
      return { kind: "complete" as const, moved: 0 };
    }

    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", gallery._id).eq("parentId", destination._id),
      )
      .take(512);
    const movingIds = new Set(movingFolders.map((folder) => folder._id));
    const reserved = siblings.filter(
      (sibling) =>
        !movingIds.has(sibling._id) &&
        sibling.filesystemMissingAt === undefined,
    );
    const reservedSlugs = new Set(reserved.map((sibling) => sibling.slug));
    const reservedNames = new Set(reserved.map((sibling) => sibling.name));
    for (const folder of movingFolders) {
      if (
        reservedSlugs.has(folder.slug) ||
        (gallery.storageKind === "user" && reservedNames.has(folder.name))
      ) {
        throw new Error(
          `A folder named ${folder.name} already exists in the destination`,
        );
      }
      reservedSlugs.add(folder.slug);
      reservedNames.add(folder.name);
    }

    // The moved folder's subtree must still fit inside MAX_FOLDER_DEPTH at
    // its new position, so measure each subtree's height first. The walk is
    // capped: a tree too large to measure is too risky to move blindly.
    const movedAncestorCount = destination.ancestorIds.length + 1;
    if (movedAncestorCount >= MAX_FOLDER_DEPTH) {
      throw new Error(
        `Folders cannot be nested deeper than ${MAX_FOLDER_DEPTH}`,
      );
    }
    let walked = 0;
    for (const folder of movingFolders) {
      let frontier = [folder._id];
      let depth = movedAncestorCount;
      while (frontier.length > 0) {
        const next: Array<Id<"folders">> = [];
        for (const frontierId of frontier) {
          const children = await ctx.db
            .query("folders")
            .withIndex("by_galleryId_and_parentId", (q) =>
              q.eq("galleryId", gallery._id).eq("parentId", frontierId),
            )
            .take(512);
          walked += children.length;
          if (walked > 2048) {
            throw new Error("The selected folders contain too many subfolders to move");
          }
          for (const child of children) {
            if (child.filesystemMissingAt === undefined) {
              next.push(child._id);
            }
          }
        }
        if (next.length > 0 && depth + 1 >= MAX_FOLDER_DEPTH) {
          throw new Error(
            `Folders cannot be nested deeper than ${MAX_FOLDER_DEPTH}`,
          );
        }
        frontier = next;
        depth += 1;
      }
    }

    const now = Date.now();
    if (gallery.storageKind === "user") {
      const operations = [];
      for (const folder of movingFolders) {
        cleanFilesystemSegment(folder.name);
        const token = createToken();
        const operationId = await ctx.db.insert("filesystemOperations", {
          galleryId: gallery._id,
          // For a move the operation's parent is the destination folder; the
          // moved folder itself travels in folderId.
          parentId: destination._id,
          folderId: folder._id,
          actorProfileId: actor._id,
          kind: "move",
          name: folder.name,
          accessPolicy: folderAccessPolicyOf(folder),
          discoverability: folderDiscoverabilityOf(folder),
          previewMode: folder.previewMode,
          tokenHash: await sha256(token),
          expiresAt: now + 15 * 60 * 1000,
          state: "pending",
          attempts: 0,
        });
        operations.push({ folderId: folder._id, operationId, token });
      }
      return {
        kind: "filesystem" as const,
        operations,
        moved: movingFolders.length,
      };
    }
    for (const folder of movingFolders) {
      await ctx.db.patch("folders", folder._id, {
        parentId: destination._id,
        ancestorIds: [...destination.ancestorIds, destination._id],
      });
      await ctx.scheduler.runAfter(0, internal.folders.reparentSubtree, {
        folderId: folder._id,
      });
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "folders.moved",
      galleryId: gallery._id,
      detail: `${movingFolders.length} folder${movingFolders.length === 1 ? "" : "s"} to ${destination.name}`,
      createdAt: now,
    });
    return { kind: "complete" as const, moved: movingFolders.length };
  },
});

// After a folder is reparented or renamed its descendants' denormalized
// state is stale: child folders still carry the old ancestor chain, and in
// user-backed galleries entry storage keys still embed the old path. Walk
// the subtree one folder per transaction, repairing both.
export const reparentSubtree = internalMutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const folder = await ctx.db.get("folders", args.folderId);
    if (folder === null || folder.filesystemMissingAt !== undefined) {
      return null;
    }
    const gallery = await ctx.db.get("galleries", folder.galleryId);
    if (gallery === null || gallery.deletedAt !== undefined) {
      return null;
    }
    if (gallery.storageKind === "user" && gallery.rootFolderId !== undefined) {
      const segments = await getFilesystemFolderSegments(ctx, gallery, folder);
      const entries = ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", folder._id),
        );
      for await (const entry of entries) {
        if (entry.storageKind !== "user") {
          continue;
        }
        const storageKey = getFilesystemStorageKey(
          gallery,
          segments,
          entry.name,
        );
        if (storageKey !== entry.storageKey) {
          await ctx.db.patch("entries", entry._id, {
            storageKey,
            updatedAt: Date.now(),
          });
        }
      }
    }
    const ancestorIds = [...folder.ancestorIds, folder._id];
    const children = ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q.eq("galleryId", folder.galleryId).eq("parentId", folder._id),
      );
    for await (const child of children) {
      if (
        child.ancestorIds.length !== ancestorIds.length ||
        child.ancestorIds.some((id, index) => id !== ancestorIds[index])
      ) {
        await ctx.db.patch("folders", child._id, { ancestorIds });
      }
      await ctx.scheduler.runAfter(0, internal.folders.reparentSubtree, {
        folderId: child._id,
      });
    }
    return null;
  },
});

export const listOwnedMoveDestinations = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
  },
  handler: async (ctx, args) => {
    const gallery = await ctx.db.get("galleries", args.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image" ||
      gallery.pendingMigrationId !== undefined
    ) {
      throw new Error("Gallery not found");
    }
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    await assertCanManageGallery(
      ctx,
      gallery,
      rootFolder,
      args.anonymousClaim,
    );
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_galleryId", (q) => q.eq("galleryId", gallery._id))
      .take(512);
    return folders.filter(
      (folder) => folder.filesystemMissingAt === undefined,
    );
  },
});

export const update = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    folderId: v.id("folders"),
    name: v.string(),
    accessPolicy: folderAccessPolicy,
    discoverability: folderDiscoverability,
    previewMode: v.optional(folderPreviewMode),
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
    const actor = await requireGalleryRole(
      ctx,
      gallery,
      folder,
      "editor",
      args.anonymousClaim,
    );
    if (gallery.rootFolderId === folder._id) {
      if (args.name.trim() !== folder.name) {
        throw new Error("Rename the root folder from gallery settings");
      }
      if (
        args.accessPolicy !== "inherit" ||
        args.discoverability !== "listed"
      ) {
        throw new Error("Root access is controlled by gallery permissions");
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
        accessPolicy: args.accessPolicy,
        discoverability: args.discoverability,
        previewMode: args.previewMode,
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
      accessPolicy: args.accessPolicy,
      discoverability: args.discoverability,
      previewMode: args.previewMode,
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
