import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  canViewFolder,
  getCurrentProfile,
  getEffectiveRole,
  isOwningProfile,
  requireCurrentProfile,
  requireGalleryRole,
  roleAtLeast,
} from "./lib/permissions";
import {
  cleanDescription,
  cleanFileName,
  cleanFilesystemSegment,
} from "./lib/normalize";
import {
  createPasswordHash,
  createToken,
  sha256,
  verifyPassword,
} from "./lib/crypto";
import { disposition } from "./lib/validators";
import { requestMediaPreview } from "./lib/storageJobs";

const MAX_PASSWORD_LENGTH = 256;
const MAX_THUMBNAIL_TICKETS = 128;
const MAX_BULK_ENTRIES = 128;

function isHeifEntry(entry: {
  mimeType: string;
  extension: string;
  mediaKind: string;
}) {
  return (
    entry.mediaKind === "image" &&
    (new Set([
      "image/heic",
      "image/heic-sequence",
      "image/heif",
      "image/heif-sequence",
    ]).has(entry.mimeType.toLowerCase()) ||
      new Set(["heic", "heics", "heif", "heifs", "hif"]).has(
        entry.extension.toLowerCase(),
      ))
  );
}

async function assertCanUpload(
  ctx: Parameters<typeof getCurrentProfile>[0],
  galleryId: Parameters<typeof getEffectiveRole>[1],
  folderId: Parameters<typeof getEffectiveRole>[2] extends infer _T
    ? import("./_generated/dataModel").Id<"folders">
    : never,
  anonymousClaim?: string,
) {
  const [gallery, folder, profile] = await Promise.all([
    ctx.db.get("galleries", galleryId),
    ctx.db.get("folders", folderId),
    getCurrentProfile(ctx, anonymousClaim),
  ]);
  if (
    gallery === null ||
    gallery.deletedAt !== undefined ||
    folder === null ||
    folder.galleryId !== gallery._id
  ) {
    throw new Error("Gallery folder not found");
  }
  if (gallery.pendingMigrationId !== undefined) {
    throw new Error("Uploads are paused while this gallery is migrating");
  }
  if (profile === null) {
    throw new Error("Not authenticated");
  }
  const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
  const allowed =
    gallery.kind === "image"
      ? roleAtLeast(role, "editor")
      : gallery.uploaderAccess === "anonymous"
        ? true
        : gallery.uploaderAccess === "sso"
          ? !profile.isAnonymous
          : roleAtLeast(role, "editor");
  if (!allowed) {
    throw new Error("Unauthorized");
  }
  return { gallery, folder, profile };
}

export const createUploadIntent = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    name: v.string(),
    description: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { gallery, profile } = await assertCanUpload(
      ctx,
      args.galleryId,
      args.folderId,
      args.anonymousClaim,
    );
    if (
      !Number.isSafeInteger(args.size) ||
      args.size < 0 ||
      args.size > gallery.maxFileSize
    ) {
      throw new Error(
        `File exceeds this gallery's ${gallery.maxFileSize}-byte limit`,
      );
    }
    if (args.mimeType.length > 200) {
      throw new Error("Invalid MIME type");
    }
    if (args.password !== undefined && gallery.kind !== "uploader") {
      throw new Error("Passwords are only supported by uploader galleries");
    }
    if (
      args.password !== undefined &&
      (args.password.length < 1 || args.password.length > MAX_PASSWORD_LENGTH)
    ) {
      throw new Error(
        `Password must contain between 1 and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }
    const token = createToken();
    const password =
      args.password === undefined
        ? undefined
        : await createPasswordHash(args.password);
    const intentId = await ctx.db.insert("uploadIntents", {
      galleryId: gallery._id,
      folderId: args.folderId,
      ownerProfileId: profile._id,
      name: cleanFileName(args.name),
      description: cleanDescription(args.description),
      declaredMimeType: args.mimeType || "application/octet-stream",
      declaredSize: args.size,
      tokenHash: await sha256(token),
      passwordSalt: password?.salt,
      passwordHash: password?.hash,
      passwordIterations: password?.iterations,
      expiresAt: Date.now() + 15 * 60 * 1000,
      state: "pending",
      attempts: 0,
    });
    return { intentId, token };
  },
});

export const createDownloadTicket = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
    password: v.optional(v.string()),
    disposition,
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("entries", args.entryId);
    if (
      entry === null ||
      entry.galleryId !== args.galleryId ||
      entry.state !== "ready"
    ) {
      throw new Error("File not found");
    }
    const [gallery, folder, profile] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
      getCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      folder === null ||
      !(await canViewFolder(ctx, folder, profile))
    ) {
      throw new Error("Unauthorized");
    }
    if (gallery.kind !== "uploader") {
      throw new Error("Image gallery files are served directly");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    const token = createToken();
    await ctx.db.insert("downloadTickets", {
      entryId: entry._id,
      tokenHash: await sha256(token),
      disposition: args.disposition,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return { token };
  },
});

export const requestPreview = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("entries", args.entryId);
    if (
      entry === null ||
      entry.galleryId !== args.galleryId ||
      entry.state !== "ready" ||
      !isHeifEntry(entry)
    ) {
      throw new Error("File not found");
    }
    const [gallery, folder, profile] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
      getCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      folder === null ||
      !(await canViewFolder(ctx, folder, profile))
    ) {
      throw new Error("Unauthorized");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    if (entry.previewKey === undefined) {
      if (entry.previewError !== undefined) {
        await ctx.db.patch("entries", entry._id, {
          previewError: undefined,
          updatedAt: Date.now(),
        });
      }
      await requestMediaPreview(ctx, {
        entryId: entry._id,
        storageKey: entry.storageKey,
        sha256: entry.sha256,
      });
      return { status: "pending" as const };
    }
    if (gallery.kind === "image") {
      return {
        status: "ready" as const,
        previewKey: entry.previewKey,
      };
    }
    const token = createToken();
    await ctx.db.insert("downloadTickets", {
      entryId: entry._id,
      tokenHash: await sha256(token),
      disposition: "preview",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return {
      status: "ready" as const,
      previewKey: entry.previewKey,
      token,
    };
  },
});

export const getForUploaderView = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("entries", args.entryId);
    if (
      entry === null ||
      entry.galleryId !== args.galleryId ||
      entry.state !== "ready"
    ) {
      return null;
    }
    const [gallery, folder, profile] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
      getCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "uploader" ||
      folder === null ||
      !(await canViewFolder(ctx, folder, profile))
    ) {
      return null;
    }
    return {
      name: entry.name,
      size: entry.size,
      mimeType: entry.mimeType,
      previewKey: entry.previewKey,
      previewError: entry.previewError,
      passwordProtected: entry.passwordHash !== undefined,
    };
  },
});

export const createThumbnailTickets = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    entryIds: v.array(v.id("entries")),
  },
  handler: async (ctx, args) => {
    if (args.entryIds.length > MAX_THUMBNAIL_TICKETS) {
      throw new Error(
        `Cannot request more than ${MAX_THUMBNAIL_TICKETS} thumbnails`,
      );
    }
    const [gallery, folder, profile] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.folderId),
      getCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "uploader" ||
      folder === null ||
      folder.galleryId !== gallery._id ||
      !(await canViewFolder(ctx, folder, profile))
    ) {
      throw new Error("Unauthorized");
    }

    const tickets: Array<{
      entryId: (typeof args.entryIds)[number];
      token: string;
    }> = [];
    const seen = new Set<string>();
    for (const entryId of args.entryIds) {
      if (seen.has(entryId)) continue;
      seen.add(entryId);
      const entry = await ctx.db.get("entries", entryId);
      if (
        entry === null ||
        entry.galleryId !== gallery._id ||
        entry.folderId !== folder._id ||
        entry.state !== "ready" ||
        entry.thumbnailKey === undefined ||
        entry.passwordHash !== undefined
      ) {
        continue;
      }
      const token = createToken();
      await ctx.db.insert("downloadTickets", {
        entryId,
        tokenHash: await sha256(token),
        disposition: "thumbnail",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      tickets.push({ entryId, token });
    }
    return tickets;
  },
});

export const updateMetadata = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    entryId: v.id("entries"),
    description: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const entry = await ctx.db.get("entries", args.entryId);
    if (entry === null || entry.state !== "ready") {
      throw new Error("File not found");
    }
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
    ]);
    if (gallery === null || folder === null) {
      throw new Error("Gallery not found");
    }
    const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
    const owns = await isOwningProfile(
      ctx,
      entry.ownerProfileId,
      profile._id,
    );
    if (!owns && !roleAtLeast(role, "editor")) {
      throw new Error("Unauthorized");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    await ctx.db.patch("entries", entry._id, {
      description: cleanDescription(args.description),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    entryId: v.id("entries"),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const entry = await ctx.db.get("entries", args.entryId);
    if (entry === null || entry.state !== "ready") {
      return null;
    }
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
    ]);
    if (gallery === null || folder === null) {
      throw new Error("Gallery not found");
    }
    const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
    const owns = await isOwningProfile(
      ctx,
      entry.ownerProfileId,
      profile._id,
    );
    if (
      (gallery.kind === "uploader" && !owns) ||
      (gallery.kind === "image" && !owns && !roleAtLeast(role, "editor"))
    ) {
      throw new Error("Unauthorized");
    }
    if (entry.migrationState === "moving") {
      throw new Error("File is currently being moved");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    await ctx.db.patch("entries", entry._id, {
      state: "deleted",
      deletedAt: Date.now(),
    });
    await ctx.db.patch("galleries", gallery._id, {
      itemCount: Math.max(0, gallery.itemCount - 1),
      totalBytes: Math.max(0, gallery.totalBytes - entry.size),
    });
    await ctx.db.insert("storageDeleteJobs", {
      entryId: entry._id,
      storageKey: entry.storageKey,
      thumbnailKey: entry.thumbnailKey,
      previewKey: entry.previewKey,
      deleteEntry: true,
      status: "queued",
      attempts: 0,
      availableAt: 0,
    });
    return null;
  },
});

export const removeMany = mutation({
  args: {
    galleryId: v.id("galleries"),
    entryIds: v.array(v.id("entries")),
  },
  handler: async (ctx, args) => {
    const entryIds = [...new Set(args.entryIds)];
    if (entryIds.length < 1 || entryIds.length > MAX_BULK_ENTRIES) {
      throw new Error(
        `Select between 1 and ${MAX_BULK_ENTRIES} files to delete`,
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
    const rootFolder =
      gallery.rootFolderId === undefined
        ? null
        : await ctx.db.get("folders", gallery.rootFolderId);
    const actor = await requireGalleryRole(
      ctx,
      gallery,
      rootFolder,
      "owner",
    );
    const entries = [];
    for (const entryId of entryIds) {
      const entry = await ctx.db.get("entries", entryId);
      if (
        entry === null ||
        entry.galleryId !== gallery._id ||
        entry.state !== "ready"
      ) {
        throw new Error("A selected file is no longer available");
      }
      if (entry.migrationState === "moving") {
        throw new Error(`${entry.name} is currently being moved`);
      }
      entries.push(entry);
    }

    const now = Date.now();
    let removedBytes = 0;
    for (const entry of entries) {
      removedBytes += entry.size;
      await ctx.db.patch("entries", entry._id, {
        state: "deleted",
        deletedAt: now,
      });
      await ctx.db.insert("storageDeleteJobs", {
        entryId: entry._id,
        storageKey: entry.storageKey,
        thumbnailKey: entry.thumbnailKey,
        previewKey: entry.previewKey,
        deleteEntry: true,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
    }
    await ctx.db.patch("galleries", gallery._id, {
      itemCount: Math.max(0, gallery.itemCount - entries.length),
      totalBytes: Math.max(0, gallery.totalBytes - removedBytes),
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "entries.deleted",
      galleryId: gallery._id,
      detail: `${entries.length} file${entries.length === 1 ? "" : "s"}`,
      createdAt: now,
    });
    return { removed: entries.length };
  },
});

export const moveMany = mutation({
  args: {
    sourceGalleryId: v.id("galleries"),
    destinationGalleryId: v.id("galleries"),
    destinationFolderId: v.id("folders"),
    entryIds: v.array(v.id("entries")),
  },
  handler: async (ctx, args) => {
    const entryIds = [...new Set(args.entryIds)];
    if (entryIds.length < 1 || entryIds.length > MAX_BULK_ENTRIES) {
      throw new Error(
        `Select between 1 and ${MAX_BULK_ENTRIES} files to move`,
      );
    }
    const [sourceGallery, destinationGallery, destinationFolder] =
      await Promise.all([
        ctx.db.get("galleries", args.sourceGalleryId),
        ctx.db.get("galleries", args.destinationGalleryId),
        ctx.db.get("folders", args.destinationFolderId),
      ]);
    if (
      sourceGallery === null ||
      sourceGallery.deletedAt !== undefined ||
      sourceGallery.kind !== "image" ||
      sourceGallery.pendingMigrationId !== undefined
    ) {
      throw new Error("Source gallery is unavailable");
    }
    if (
      destinationGallery === null ||
      destinationGallery.deletedAt !== undefined ||
      destinationGallery.kind !== "image" ||
      destinationGallery.pendingMigrationId !== undefined ||
      destinationFolder === null ||
      destinationFolder.galleryId !== destinationGallery._id ||
      destinationFolder.filesystemMissingAt !== undefined
    ) {
      throw new Error("Destination folder is unavailable");
    }
    const [sourceRoot, destinationRoot] = await Promise.all([
      sourceGallery.rootFolderId === undefined
        ? null
        : ctx.db.get("folders", sourceGallery.rootFolderId),
      destinationGallery.rootFolderId === undefined
        ? null
        : ctx.db.get("folders", destinationGallery.rootFolderId),
    ]);
    const sourceActor = await requireGalleryRole(
      ctx,
      sourceGallery,
      sourceRoot,
      "owner",
    );
    const destinationActor = await requireGalleryRole(
      ctx,
      destinationGallery,
      destinationRoot,
      "owner",
    );
    if (sourceActor._id !== destinationActor._id) {
      throw new Error("Gallery ownership could not be verified");
    }

    const entries = [];
    for (const entryId of entryIds) {
      const entry = await ctx.db.get("entries", entryId);
      if (
        entry === null ||
        entry.galleryId !== sourceGallery._id ||
        entry.state !== "ready"
      ) {
        throw new Error("A selected file is no longer available");
      }
      if (entry.migrationState !== undefined) {
        throw new Error(`${entry.name} is already being moved`);
      }
      if (entry.size > destinationGallery.maxFileSize) {
        throw new Error(
          `${entry.name} exceeds the destination gallery's file size limit`,
        );
      }
      entries.push(entry);
    }

    const movingEntries = entries.filter(
      (entry) =>
        entry.galleryId !== destinationGallery._id ||
        entry.folderId !== destinationFolder._id,
    );
    if (destinationGallery.storageKind === "user") {
      const existing = await ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", destinationFolder._id).eq("state", "ready"),
        )
        .take(512);
      const movingIds = new Set(movingEntries.map((entry) => entry._id));
      const reservedNames = new Set(
        existing
          .filter((entry) => !movingIds.has(entry._id))
          .map((entry) => entry.name),
      );
      for (const entry of movingEntries) {
        cleanFilesystemSegment(entry.name);
        if (reservedNames.has(entry.name)) {
          throw new Error(
            `${entry.name} already exists in the destination folder`,
          );
        }
        reservedNames.add(entry.name);
      }
    }

    const now = Date.now();
    for (const entry of movingEntries) {
      const moveJobId = await ctx.db.insert("entryMoveJobs", {
        entryId: entry._id,
        sourceGalleryId: sourceGallery._id,
        destinationGalleryId: destinationGallery._id,
        destinationFolderId: destinationFolder._id,
        actorProfileId: sourceActor._id,
        expectedSourceStorageKey: entry.storageKey,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
      await ctx.db.patch("entries", entry._id, {
        moveJobId,
        migrationState: "moving",
        migrationClaimedAt: undefined,
        migrationAttempts: 0,
        migrationRetryAt: undefined,
        migrationError: undefined,
        updatedAt: now,
      });
    }
    if (movingEntries.length > 0) {
      await ctx.db.insert("auditEvents", {
        actorProfileId: sourceActor._id,
        action: "entries.move_queued",
        galleryId: sourceGallery._id,
        detail: `${movingEntries.length} file${movingEntries.length === 1 ? "" : "s"} to ${destinationGallery.name}/${destinationFolder.name}`,
        createdAt: now,
      });
    }
    return { queued: movingEntries.length };
  },
});
