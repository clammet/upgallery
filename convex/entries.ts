import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import {
  assertCanManageGallery,
  canViewFolder,
  getCurrentProfile,
  getEffectiveRole,
  isOwningProfile,
  requireCurrentProfile,
  requireGalleryManager,
  requireGalleryRole,
  roleAtLeast,
  shouldListFolder,
  unauthorizedError,
} from "./lib/permissions";
import {
  cleanDescription,
  cleanFileName,
  cleanFilesystemSegment,
  entryNameKey,
  fileExtensionFromName,
} from "./lib/normalize";
import {
  findReadyEntryByNameKey,
  resolveLandingName,
} from "./lib/entryNames";
import {
  createPasswordHash,
  createToken,
  sha256,
  verifyPassword,
} from "./lib/crypto";
import { formatBytes } from "./lib/format";
import { adjustGalleryStats } from "./lib/galleryStats";
import {
  adjustFolderStats,
  adjustFolderStatsForEntries,
  readFolderStats,
} from "./lib/folderStats";
import {
  conflictPolicy,
  disposition,
  gallerySortOrder,
} from "./lib/validators";
import {
  markThumbnailPendingIfNeeded,
  MEDIA_METADATA_VERSION,
  requestMediaPreview,
} from "./lib/storageJobs";
import { uploaderAttribution } from "./lib/profiles";
import schema from "./schema";

const MAX_PASSWORD_LENGTH = 256;
const MAX_THUMBNAIL_TICKETS = 128;
const MAX_BULK_ENTRIES = 128;
const MAX_GALLERY_PAGE_SIZE = 250;

const galleryEntryValidator = schema
  .doc("entries")
  .omit("passwordSalt", "passwordHash", "passwordIterations")
  .extend({
    uploader: v.string(),
    passwordProtected: v.boolean(),
    canDelete: v.boolean(),
    views: v.number(),
  });

function galleryEntryForViewer(
  entry: Doc<"entries">,
  uploader: string,
  views: number,
) {
  const locked = entry.passwordHash !== undefined;
  return {
    ...entry,
    uploader,
    description: locked ? undefined : entry.description,
    metadataJson: locked ? undefined : entry.metadataJson,
    passwordSalt: undefined,
    passwordHash: undefined,
    passwordIterations: undefined,
    passwordProtected: locked,
    canDelete: false,
    views,
  };
}

function validateGalleryPaginationSize(numItems: number) {
  if (
    !Number.isSafeInteger(numItems) ||
    numItems < 1 ||
    numItems > MAX_GALLERY_PAGE_SIZE
  ) {
    throw new Error(`Gallery pages cannot exceed ${MAX_GALLERY_PAGE_SIZE} files`);
  }
}

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

function metadataHasLocation(metadataJson?: string): boolean {
  if (metadataJson === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "GPSLatitude" in parsed &&
      "GPSLongitude" in parsed
    );
  } catch {
    return false;
  }
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
    requireCurrentProfile(ctx, anonymousClaim),
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
  const allowed = roleAtLeast(role, "editor");
  if (!allowed) {
    throw unauthorizedError();
  }
  return { gallery, folder, profile };
}

async function loadViewableImageFolder(
  ctx: QueryCtx,
  args: {
    anonymousClaim?: string;
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
  },
) {
  const [gallery, folder, profile] = await Promise.all([
    ctx.db.get("galleries", args.galleryId),
    ctx.db.get("folders", args.folderId),
    getCurrentProfile(ctx, args.anonymousClaim),
  ]);
  if (
    gallery === null ||
    gallery.deletedAt !== undefined ||
    gallery.kind !== "image" ||
    folder === null ||
    folder.galleryId !== gallery._id ||
    !(await canViewFolder(ctx, folder, profile, args.anonymousClaim))
  ) {
    throw new Error("Folder not found");
  }
  return { gallery, folder, profile };
}

// The entries a gallery folder shows: ready, and not hidden by an in-flight
// bulk move.
function listedFolderEntriesByCreatedAt(
  ctx: QueryCtx,
  folderId: Id<"folders">,
) {
  return ctx.db
    .query("entries")
    .withIndex(
      "by_folderId_and_state_and_moveJobId_and_createdAt",
      (q) =>
        q
          .eq("folderId", folderId)
          .eq("state", "ready")
          .eq("moveJobId", undefined),
    );
}

function sortedFolderEntries(
  ctx: QueryCtx,
  folderId: Id<"folders">,
  sortOrder:
    | "nameAsc"
    | "nameDesc"
    | "sizeAsc"
    | "sizeDesc"
    | "dateAsc"
    | "dateDesc",
) {
  const index = sortOrder.startsWith("name")
    ? ("by_folderId_and_state_and_moveJobId_and_nameKey" as const)
    : sortOrder.startsWith("size")
      ? ("by_folderId_and_state_and_moveJobId_and_size" as const)
      : ("by_folderId_and_state_and_moveJobId_and_sortTimestamp" as const);
  return ctx.db
    .query("entries")
    .withIndex(index, (q) =>
      q
        .eq("folderId", folderId)
        .eq("state", "ready")
        .eq("moveJobId", undefined),
    )
    .order(sortOrder.endsWith("Asc") ? "asc" : "desc");
}

function reverseGallerySortOrder(
  sortOrder:
    | "nameAsc"
    | "nameDesc"
    | "sizeAsc"
    | "sizeDesc"
    | "dateAsc"
    | "dateDesc",
) {
  switch (sortOrder) {
    case "nameAsc":
      return "nameDesc" as const;
    case "nameDesc":
      return "nameAsc" as const;
    case "sizeAsc":
      return "sizeDesc" as const;
    case "sizeDesc":
      return "sizeAsc" as const;
    case "dateAsc":
      return "dateDesc" as const;
    case "dateDesc":
      return "dateAsc" as const;
  }
}

// Check transaction headroom every this many entries while counting.
const COUNT_METRICS_INTERVAL = 256;
// Stop counting once a transaction has less than this left, so a very large
// folder returns a lower bound instead of failing the query.
const COUNT_RESERVE_DOCUMENTS = 1_024;
const COUNT_RESERVE_BYTES = 1024 * 1024;

// Number of files the paged gallery can show in a folder, for its
// "Page X/Y" label. Served from folderStats; a folder that has no stats row
// yet (created before folderStats.backfill ran) is counted by walking the
// listing index, and one too big to count in one transaction comes back as a
// lower bound with `exact: false`.
export const countFolderEntries = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
  },
  returns: v.object({ count: v.number(), exact: v.boolean() }),
  handler: async (ctx, args) => {
    const { folder } = await loadViewableImageFolder(ctx, args);
    const stats = await readFolderStats(ctx, folder._id);
    if (stats !== null) {
      return { count: stats.itemCount, exact: true };
    }
    let count = 0;
    for await (const _entry of listedFolderEntriesByCreatedAt(ctx, folder._id)) {
      count += 1;
      if (count % COUNT_METRICS_INTERVAL !== 0) continue;
      const metrics = await ctx.meta.getTransactionMetrics();
      if (
        metrics.documentsRead.remaining < COUNT_RESERVE_DOCUMENTS ||
        metrics.bytesRead.remaining < COUNT_RESERVE_BYTES
      ) {
        return { count, exact: false };
      }
    }
    return { count, exact: true };
  },
});

export const listGalleryPage = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    // Included in the client query key so pagination resets immediately when
    // the persisted gallery/folder setting changes. The server still derives
    // the authoritative effective setting below.
    sortOrder: v.optional(gallerySortOrder),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(galleryEntryValidator),
  handler: async (ctx, args) => {
    validateGalleryPaginationSize(args.paginationOpts.numItems);
    const { gallery, folder } = await loadViewableImageFolder(ctx, args);
    const sortOrder = folder.sortOrder ?? gallery.sortOrder ?? "nameAsc";
    const result = await sortedFolderEntries(ctx, folder._id, sortOrder)
      .paginate(args.paginationOpts);
    const page = [];
    const uploaderByProfileId = new Map<Id<"profiles">, string>();
    for (const entry of result.page) {
      const counterPromise = ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique();
      let uploader = uploaderByProfileId.get(entry.ownerProfileId);
      if (uploader === undefined) {
        const profile = await ctx.db.get("profiles", entry.ownerProfileId);
        uploader =
          profile === null ? "Unknown" : uploaderAttribution(profile);
        uploaderByProfileId.set(entry.ownerProfileId, uploader);
      }
      const counter = await counterPromise;
      page.push(galleryEntryForViewer(entry, uploader, counter?.views ?? 0));
    }
    return { ...result, page };
  },
});

// A lightbox link can target an entry outside the currently loaded page. Keep
// that lookup separate from pagination so the URL works immediately without
// fetching every preceding page in a large folder.
export const getGalleryViewerEntry = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    requestedEntryId: v.string(),
  },
  returns: v.union(v.null(), galleryEntryValidator),
  handler: async (ctx, args) => {
    const { folder } = await loadViewableImageFolder(ctx, args);
    const entryId = ctx.db.normalizeId("entries", args.requestedEntryId);
    if (entryId === null) return null;
    const entry = await ctx.db.get("entries", entryId);
    if (
      entry === null ||
      entry.galleryId !== args.galleryId ||
      entry.folderId !== folder._id ||
      entry.state !== "ready" ||
      entry.moveJobId !== undefined
    ) {
      return null;
    }
    const [counter, uploaderProfile] = await Promise.all([
      ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
        .unique(),
      ctx.db.get("profiles", entry.ownerProfileId),
    ]);
    return galleryEntryForViewer(
      entry,
      uploaderProfile === null
        ? "Unknown"
        : uploaderAttribution(uploaderProfile),
      counter?.views ?? 0,
    );
  },
});

// Lets the lightbox continue from the final file in one folder to the first
// file in the next visible sibling folder. Folder sibling order matches the
// folder listing index (creation order).
export const nextSiblingGalleryViewerTarget = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    currentEntryId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      folderId: v.id("folders"),
      folderName: v.string(),
      entry: v.union(v.null(), galleryEntryValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const { gallery, folder, profile } = await loadViewableImageFolder(
      ctx,
      args,
    );
    if (folder.parentId === undefined) return null;

    const currentEntryId = ctx.db.normalizeId("entries", args.currentEntryId);
    if (currentEntryId === null) return null;
    const sortOrder = folder.sortOrder ?? gallery.sortOrder ?? "nameAsc";
    const finalEntry = await sortedFolderEntries(
      ctx,
      folder._id,
      reverseGallerySortOrder(sortOrder),
    ).first();
    if (finalEntry?._id !== currentEntryId) return null;

    const candidates = await ctx.db
      .query("folders")
      .withIndex("by_galleryId_and_parentId", (q) =>
        q
          .eq("galleryId", gallery._id)
          .eq("parentId", folder.parentId)
          .gt("_creationTime", folder._creationTime),
      )
      .take(128);
    let sibling: Doc<"folders"> | null = null;
    for (const candidate of candidates) {
      if (
        candidate.filesystemMissingAt === undefined &&
        (await shouldListFolder(
          ctx,
          candidate,
          profile,
          args.anonymousClaim,
        ))
      ) {
        sibling = candidate;
        break;
      }
    }
    if (sibling === null) return null;

    const siblingSortOrder =
      sibling.sortOrder ?? gallery.sortOrder ?? "nameAsc";
    const firstEntry = await sortedFolderEntries(
      ctx,
      sibling._id,
      siblingSortOrder,
    ).first();
    if (firstEntry === null) {
      return {
        folderId: sibling._id,
        folderName: sibling.name,
        entry: null,
      };
    }

    const [counter, uploaderProfile] = await Promise.all([
      ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", firstEntry._id))
        .unique(),
      ctx.db.get("profiles", firstEntry.ownerProfileId),
    ]);
    return {
      folderId: sibling._id,
      folderName: sibling.name,
      entry: galleryEntryForViewer(
        firstEntry,
        uploaderProfile === null
          ? "Unknown"
          : uploaderAttribution(uploaderProfile),
        counter?.views ?? 0,
      ),
    };
  },
});

// Select-all uses this lightweight paginated surface to determine the exact
// count without forcing the thumbnail grid to load every entry document.
export const listSelectableIds = query({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(v.id("entries")),
  handler: async (ctx, args) => {
    validateGalleryPaginationSize(args.paginationOpts.numItems);
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("folders", args.folderId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "image" ||
      folder === null ||
      folder.galleryId !== gallery._id
    ) {
      throw new Error("Folder not found");
    }
    await assertCanManageGallery(
      ctx,
      gallery,
      folder,
      args.anonymousClaim,
    );
    const result = await ctx.db
      .query("entries")
      .withIndex(
        "by_folderId_and_state_and_moveJobId_and_createdAt",
        (q) =>
          q
            .eq("folderId", folder._id)
            .eq("state", "ready")
            .eq("moveJobId", undefined),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((entry) => entry._id),
    };
  },
});

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
    removeLocationData: v.optional(v.boolean()),
    unlisted: v.optional(v.boolean()),
    // Required to proceed when the folder already holds this name; without
    // it the intent is refused with entry_exists so the client can ask.
    conflict: v.optional(conflictPolicy),
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
        `File exceeds this gallery's ${formatBytes(gallery.maxFileSize)} limit`,
      );
    }
    if (args.mimeType.length > 200) {
      throw new Error("Invalid MIME type");
    }
    if (args.password !== undefined && gallery.kind !== "uploader") {
      throw new Error("Passwords are only supported by uploader galleries");
    }
    if (args.unlisted === true && gallery.kind !== "uploader") {
      throw new Error("Unlisted uploads are only supported by uploader galleries");
    }
    if (
      args.password !== undefined &&
      (args.password.length < 1 || args.password.length > MAX_PASSWORD_LENGTH)
    ) {
      throw new Error(
        `Password must contain between 1 and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }
    const name = cleanFileName(args.name);
    // Early refusal so no bytes are sent for a name the user must decide on;
    // claimUpload repeats the check when the storage server starts.
    if (args.conflict === undefined) {
      await resolveLandingName(ctx, {
        gallery,
        folderId: args.folderId,
        name,
      });
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
      name,
      description: cleanDescription(args.description),
      declaredMimeType: args.mimeType || "application/octet-stream",
      declaredSize: args.size,
      removeLocationData: args.removeLocationData || undefined,
      unlisted: args.unlisted || undefined,
      conflictPolicy: args.conflict,
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
      !(await canViewFolder(ctx, folder, profile, args.anonymousClaim))
    ) {
      throw unauthorizedError();
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
      !(await canViewFolder(ctx, folder, profile, args.anonymousClaim))
    ) {
      throw unauthorizedError();
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

export const removeLocationData = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const [gallery, entry] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("entries", args.entryId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      entry === null ||
      entry.galleryId !== gallery._id ||
      entry.state !== "ready" ||
      entry.mediaKind !== "image"
    ) {
      throw new Error("Image not found");
    }
    const [folder, actor] = await Promise.all([
      ctx.db.get("folders", entry.folderId),
      requireCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (folder === null || folder.galleryId !== gallery._id) {
      throw new Error("Image not found");
    }
    const allowed =
      gallery.kind === "image"
        ? roleAtLeast(
            await getEffectiveRole(ctx, gallery._id, folder, actor),
            "editor",
          )
        : isOwningProfile(entry.ownerProfileId, actor._id);
    if (!allowed) {
      throw unauthorizedError();
    }
    if (!metadataHasLocation(entry.metadataJson)) {
      throw new Error("This image does not contain location data");
    }

    const jobs = await ctx.db
      .query("mediaProcessingJobs")
      .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
      .take(16);
    const activeRemoval = jobs.find(
      (job) =>
        job.removeLocationData === true &&
        (job.status === "queued" || job.status === "processing"),
    );
    if (activeRemoval !== undefined) {
      await markThumbnailPendingIfNeeded(ctx, entry._id);
      return { queued: false };
    }

    const reusable = jobs.find((job) => job.status === "queued") ??
      jobs.find((job) => job.status === "failed");
    if (reusable !== undefined) {
      await ctx.db.patch("mediaProcessingJobs", reusable._id, {
        removeLocationData: true,
        ...(reusable.status === "failed"
          ? {
              status: "queued" as const,
              attempts: 0,
              availableAt: 0,
              claimedAt: undefined,
              leaseExpiresAt: undefined,
              processorVersion: undefined,
              error: undefined,
            }
          : {}),
      });
    } else {
      await ctx.db.insert("mediaProcessingJobs", {
        entryId: entry._id,
        expectedStorageKey: entry.storageKey,
        expectedSha256: entry.sha256,
        status: "queued",
        attempts: 0,
        availableAt: 0,
        removeLocationData: true,
      });
    }
    await markThumbnailPendingIfNeeded(ctx, entry._id);
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "entry.location_removal_requested",
      galleryId: gallery._id,
      detail: entry.name,
      createdAt: Date.now(),
    });
    return { queued: true };
  },
});

export const refreshMetadata = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const [gallery, entry] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("entries", args.entryId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      entry === null ||
      entry.galleryId !== gallery._id ||
      entry.state !== "ready" ||
      (entry.mediaKind !== "image" &&
        entry.mediaKind !== "video" &&
        entry.mediaKind !== "audio")
    ) {
      throw new Error("Media not found");
    }
    if (entry.metadataVersion === MEDIA_METADATA_VERSION) {
      return { queued: false };
    }
    const [folder, actor] = await Promise.all([
      ctx.db.get("folders", entry.folderId),
      requireCurrentProfile(ctx, args.anonymousClaim),
    ]);
    if (folder === null || folder.galleryId !== gallery._id) {
      throw new Error("Media not found");
    }
    const allowed =
      gallery.kind === "image"
        ? roleAtLeast(
            await getEffectiveRole(ctx, gallery._id, folder, actor),
            "editor",
          )
        : isOwningProfile(entry.ownerProfileId, actor._id);
    if (!allowed) throw unauthorizedError();

    const jobs = await ctx.db
      .query("mediaProcessingJobs")
      .withIndex("by_entryId", (q) => q.eq("entryId", entry._id))
      .take(16);
    const active = jobs.find(
      (job) => job.status === "queued" || job.status === "processing",
    );
    if (active !== undefined) {
      await markThumbnailPendingIfNeeded(ctx, entry._id);
      return { queued: false };
    }
    const failed = jobs.find((job) => job.status === "failed");
    if (failed !== undefined) {
      await ctx.db.patch("mediaProcessingJobs", failed._id, {
        status: "queued",
        attempts: 0,
        availableAt: 0,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        processorVersion: undefined,
        error: undefined,
      });
    } else {
      await ctx.db.insert("mediaProcessingJobs", {
        entryId: entry._id,
        expectedStorageKey: entry.storageKey,
        expectedSha256: entry.sha256,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
    }
    await markThumbnailPendingIfNeeded(ctx, entry._id);
    return { queued: true };
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
      !(await canViewFolder(ctx, folder, profile, args.anonymousClaim))
    ) {
      throw unauthorizedError();
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
    const owns = isOwningProfile(entry.ownerProfileId, profile._id);
    if (!owns && !roleAtLeast(role, "editor")) {
      throw unauthorizedError();
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

export const rename = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    entryId: v.id("entries"),
    name: v.string(),
    password: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      kind: v.literal("complete"),
      entryId: v.id("entries"),
      name: v.string(),
    }),
    v.object({
      kind: v.literal("filesystem"),
      operationId: v.id("filesystemOperations"),
      token: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const [gallery, entry] = await Promise.all([
      ctx.db.get("galleries", args.galleryId),
      ctx.db.get("entries", args.entryId),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      entry === null ||
      entry.galleryId !== gallery._id ||
      entry.state !== "ready"
    ) {
      throw new Error("File not found");
    }
    const folder = await ctx.db.get("folders", entry.folderId);
    if (folder === null || folder.galleryId !== gallery._id) {
      throw new Error("File not found");
    }
    // Image galleries let editors rename anything; uploader galleries let
    // uploaders rename only their own files (proving the file password when
    // one is set, like deletion).
    let actor;
    if (gallery.kind === "uploader") {
      actor = await requireCurrentProfile(ctx, args.anonymousClaim);
      if (!isOwningProfile(entry.ownerProfileId, actor._id)) {
        throw unauthorizedError();
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
    } else {
      actor = await requireGalleryRole(
        ctx,
        gallery,
        folder,
        "editor",
        args.anonymousClaim,
      );
    }
    if (entry.migrationState !== undefined) {
      throw new Error("File is currently being moved");
    }

    const name =
      gallery.storageKind === "user"
        ? cleanFilesystemSegment(args.name)
        : cleanFileName(args.name);
    if (name === entry.name) {
      return { kind: "complete" as const, entryId: entry._id, name };
    }
    // Changing only the case of the entry's own name is allowed.
    if (
      (await findReadyEntryByNameKey(
        ctx,
        folder._id,
        entryNameKey(name),
        entry._id,
      )) !== null
    ) {
      throw new Error("A file with that name already exists here");
    }

    if (gallery.storageKind === "user") {
      const token = createToken();
      const operationId = await ctx.db.insert("filesystemOperations", {
        galleryId: gallery._id,
        parentId: folder._id,
        entryId: entry._id,
        actorProfileId: actor._id,
        kind: "fileRename",
        name,
        tokenHash: await sha256(token),
        expiresAt: Date.now() + 15 * 60 * 1000,
        state: "pending",
        attempts: 0,
      });
      return { kind: "filesystem" as const, operationId, token };
    }

    const now = Date.now();
    await ctx.db.patch("entries", entry._id, {
      name,
      nameKey: entryNameKey(name),
      extension: fileExtensionFromName(name, entry.extension),
      updatedAt: now,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "entry.renamed",
      galleryId: gallery._id,
      detail: `${entry.name} → ${name}`,
      createdAt: now,
    });
    return { kind: "complete" as const, entryId: entry._id, name };
  },
});

export const setMarkdownMode = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    entryId: v.id("entries"),
    markdown: v.boolean(),
  },
  handler: async (ctx, args) => {
    const [profile, entry] = await Promise.all([
      requireCurrentProfile(ctx, args.anonymousClaim),
      ctx.db.get("entries", args.entryId),
    ]);
    if (entry === null || entry.state !== "ready") {
      throw new Error("File not found");
    }
    const gallery = await ctx.db.get("galleries", entry.galleryId);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      gallery.kind !== "uploader"
    ) {
      throw new Error("File not found");
    }
    if (!isOwningProfile(entry.ownerProfileId, profile._id)) {
      throw unauthorizedError();
    }
    if (
      entry.mediaKind !== "text" ||
      !/\.(?:md|markdown|txt)$/i.test(entry.name)
    ) {
      throw new Error("Only text and Markdown files can change rendering mode");
    }

    const name = cleanFileName(
      entry.name.replace(
        /\.(?:md|markdown|txt)$/i,
        args.markdown ? ".md" : ".txt",
      ),
    );
    if (
      name === entry.name &&
      entry.extension === (args.markdown ? "md" : "txt")
    ) {
      return { name };
    }
    await ctx.db.patch("entries", entry._id, {
      name,
      nameKey: entryNameKey(name),
      extension: args.markdown ? "md" : "txt",
      updatedAt: Date.now(),
    });
    return { name };
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
    const owns = isOwningProfile(entry.ownerProfileId, profile._id);
    if (
      (gallery.kind === "uploader" && !owns) ||
      (gallery.kind === "image" && !owns && !roleAtLeast(role, "editor"))
    ) {
      throw unauthorizedError();
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
    await adjustGalleryStats(ctx, gallery, { items: -1, bytes: -entry.size });
    await adjustFolderStats(ctx, entry, { items: -1, bytes: -entry.size });
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
    anonymousClaim: v.optional(v.string()),
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
    const actor = await requireGalleryManager(
      ctx,
      gallery,
      rootFolder,
      args.anonymousClaim,
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
    await adjustGalleryStats(ctx, gallery, {
      items: -entries.length,
      bytes: -removedBytes,
    });
    await adjustFolderStatsForEntries(ctx, entries, -1);
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
