import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { cleanFilesystemSegment } from "./lib/normalize";
import {
  getCurrentProfile,
  requireGalleryManager,
} from "./lib/permissions";

const BULK_BATCH_SIZE = 32;
const MAX_SELECTION_IDS = 8192;

const entrySelection = v.union(
  v.object({
    kind: v.literal("ids"),
    entryIds: v.array(v.id("entries")),
  }),
  v.object({
    kind: v.literal("folder"),
    excludedEntryIds: v.array(v.id("entries")),
  }),
);

const operationStatus = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("failed"),
);

const operationSummary = v.object({
  _id: v.id("bulkOperations"),
  kind: v.union(v.literal("delete"), v.literal("move")),
  status: operationStatus,
  sourceGalleryId: v.id("galleries"),
  sourceFolderId: v.id("folders"),
  destinationGalleryId: v.optional(v.id("galleries")),
  destinationFolderId: v.optional(v.id("folders")),
  discoveryComplete: v.boolean(),
  totalItems: v.number(),
  completedItems: v.number(),
  failedItems: v.number(),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type Selection =
  | { kind: "ids"; entryIds: Array<Id<"entries">> }
  | { kind: "folder"; excludedEntryIds: Array<Id<"entries">> };

function normalizeSelection(selection: Selection): Selection {
  if (selection.kind === "ids") {
    const entryIds = [...new Set(selection.entryIds)];
    if (entryIds.length < 1 || entryIds.length > MAX_SELECTION_IDS) {
      throw new Error(
        `Select between 1 and ${MAX_SELECTION_IDS} files`,
      );
    }
    return { kind: "ids", entryIds };
  }
  const excludedEntryIds = [...new Set(selection.excludedEntryIds)];
  if (excludedEntryIds.length > MAX_SELECTION_IDS) {
    throw new Error(`Cannot exclude more than ${MAX_SELECTION_IDS} files`);
  }
  return { kind: "folder", excludedEntryIds };
}

async function requireSource(
  ctx: MutationCtx,
  input: {
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
    anonymousClaim?: string;
  },
) {
  const [gallery, folder] = await Promise.all([
    ctx.db.get("galleries", input.galleryId),
    ctx.db.get("folders", input.folderId),
  ]);
  if (
    gallery === null ||
    gallery.deletedAt !== undefined ||
    gallery.kind !== "image" ||
    gallery.pendingMigrationId !== undefined ||
    folder === null ||
    folder.galleryId !== gallery._id ||
    folder.filesystemMissingAt !== undefined
  ) {
    throw new Error("Source folder is unavailable");
  }
  const actor = await requireGalleryManager(
    ctx,
    gallery,
    folder,
    input.anonymousClaim,
  );
  return { gallery, folder, actor };
}

async function insertOperation(
  ctx: MutationCtx,
  input: {
    kind: "delete" | "move";
    sourceGallery: Doc<"galleries">;
    sourceFolder: Doc<"folders">;
    actorProfileId: Id<"profiles">;
    selection: Selection;
    destinationGalleryId?: Id<"galleries">;
    destinationFolderId?: Id<"folders">;
  },
) {
  const now = Date.now();
  const operationId = await ctx.db.insert("bulkOperations", {
    actorProfileId: input.actorProfileId,
    kind: input.kind,
    sourceGalleryId: input.sourceGallery._id,
    sourceFolderId: input.sourceFolder._id,
    selectionKind: input.selection.kind,
    ...(input.selection.kind === "ids"
      ? { entryIds: input.selection.entryIds }
      : { excludedEntryIds: input.selection.excludedEntryIds }),
    destinationGalleryId: input.destinationGalleryId,
    destinationFolderId: input.destinationFolderId,
    cutoffCreatedAt: now,
    nextIndex: 0,
    discoveryComplete: false,
    status: "queued",
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.bulkOperations.process, {
    operationId,
  });
  await ctx.db.insert("auditEvents", {
    actorProfileId: input.actorProfileId,
    action: `entries.bulk_${input.kind}_queued`,
    galleryId: input.sourceGallery._id,
    detail:
      input.selection.kind === "folder"
        ? `all files in ${input.sourceFolder.name}`
        : `${input.selection.entryIds.length} selected files`,
    createdAt: now,
  });
  return operationId;
}

export const startDelete = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    selection: entrySelection,
  },
  returns: v.id("bulkOperations"),
  handler: async (ctx, args) => {
    const source = await requireSource(ctx, args);
    return await insertOperation(ctx, {
      kind: "delete",
      sourceGallery: source.gallery,
      sourceFolder: source.folder,
      actorProfileId: source.actor._id,
      selection: normalizeSelection(args.selection),
    });
  },
});

export const startMove = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    sourceGalleryId: v.id("galleries"),
    sourceFolderId: v.id("folders"),
    destinationGalleryId: v.id("galleries"),
    destinationFolderId: v.id("folders"),
    selection: entrySelection,
  },
  returns: v.id("bulkOperations"),
  handler: async (ctx, args) => {
    const source = await requireSource(ctx, {
      galleryId: args.sourceGalleryId,
      folderId: args.sourceFolderId,
      anonymousClaim: args.anonymousClaim,
    });
    const [destinationGallery, destinationFolder] = await Promise.all([
      ctx.db.get("galleries", args.destinationGalleryId),
      ctx.db.get("folders", args.destinationFolderId),
    ]);
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
    const destinationActor = await requireGalleryManager(
      ctx,
      destinationGallery,
      destinationFolder,
      args.anonymousClaim,
    );
    if (source.actor._id !== destinationActor._id) {
      throw new Error("Gallery ownership could not be verified");
    }
    return await insertOperation(ctx, {
      kind: "move",
      sourceGallery: source.gallery,
      sourceFolder: source.folder,
      actorProfileId: source.actor._id,
      selection: normalizeSelection(args.selection),
      destinationGalleryId: destinationGallery._id,
      destinationFolderId: destinationFolder._id,
    });
  },
});

export const listMine = query({
  args: { anonymousClaim: v.optional(v.string()) },
  returns: v.array(operationSummary),
  handler: async (ctx, args) => {
    const profile = await getCurrentProfile(ctx, args.anonymousClaim);
    if (profile === null) return [];
    const operations = await ctx.db
      .query("bulkOperations")
      .withIndex("by_actorProfileId_and_createdAt", (q) =>
        q.eq("actorProfileId", profile._id),
      )
      .order("desc")
      .take(30);
    return operations
      .filter((operation) => operation.dismissedAt === undefined)
      .map((operation) => ({
        _id: operation._id,
        kind: operation.kind,
        status: operation.status,
        sourceGalleryId: operation.sourceGalleryId,
        sourceFolderId: operation.sourceFolderId,
        destinationGalleryId: operation.destinationGalleryId,
        destinationFolderId: operation.destinationFolderId,
        discoveryComplete: operation.discoveryComplete,
        totalItems: operation.totalItems,
        completedItems: operation.completedItems,
        failedItems: operation.failedItems,
        error: operation.error,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      }));
  },
});

export const dismissFinished = mutation({
  args: { anonymousClaim: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const profile = await getCurrentProfile(ctx, args.anonymousClaim);
    if (profile === null) return 0;
    const operations = await ctx.db
      .query("bulkOperations")
      .withIndex("by_actorProfileId_and_createdAt", (q) =>
        q.eq("actorProfileId", profile._id),
      )
      .order("desc")
      .take(30);
    const now = Date.now();
    let dismissed = 0;
    for (const operation of operations) {
      if (
        operation.dismissedAt === undefined &&
        (operation.status === "complete" || operation.status === "failed")
      ) {
        await ctx.db.patch("bulkOperations", operation._id, {
          dismissedAt: now,
        });
        dismissed += 1;
      }
    }
    return dismissed;
  },
});

async function pendingDestinationNames(
  ctx: MutationCtx,
  destinationFolderId: Id<"folders">,
) {
  const jobs = [
    ...(await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_destinationFolderId_and_status", (q) =>
        q.eq("destinationFolderId", destinationFolderId).eq("status", "queued"),
      )
      .take(512)),
    ...(await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_destinationFolderId_and_status", (q) =>
        q
          .eq("destinationFolderId", destinationFolderId)
          .eq("status", "processing"),
      )
      .take(512)),
  ];
  const names = new Set<string>();
  for (const job of jobs) {
    const entry = await ctx.db.get("entries", job.entryId);
    if (entry !== null) names.add(entry.name);
  }
  return names;
}

function finalStatus(failedItems: number) {
  return failedItems > 0 ? "failed" as const : "complete" as const;
}

export const process = internalMutation({
  args: { operationId: v.id("bulkOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("bulkOperations", args.operationId);
    if (
      operation === null ||
      operation.status === "complete" ||
      operation.status === "failed"
    ) {
      return null;
    }
    const [sourceGallery, sourceFolder] = await Promise.all([
      ctx.db.get("galleries", operation.sourceGalleryId),
      ctx.db.get("folders", operation.sourceFolderId),
    ]);
    if (
      sourceGallery === null ||
      sourceGallery.deletedAt !== undefined ||
      sourceFolder === null ||
      sourceFolder.galleryId !== sourceGallery._id
    ) {
      await ctx.db.patch("bulkOperations", operation._id, {
        status: "failed",
        discoveryComplete: true,
        error: "Source folder is no longer available",
        updatedAt: Date.now(),
      });
      return null;
    }

    let candidates: Array<Doc<"entries"> | null>;
    let nextIndex = operation.nextIndex;
    let nextCursor = operation.cursor;
    let discoveryComplete = false;
    if (operation.selectionKind === "ids") {
      const ids = operation.entryIds ?? [];
      const batchIds = ids.slice(nextIndex, nextIndex + BULK_BATCH_SIZE);
      candidates = [];
      for (const entryId of batchIds) {
        candidates.push(await ctx.db.get("entries", entryId));
      }
      nextIndex += batchIds.length;
      discoveryComplete = nextIndex >= ids.length;
    } else {
      const result = await ctx.db
        .query("entries")
        .withIndex(
          "by_folderId_and_state_and_moveJobId_and_createdAt",
          (q) =>
            q
              .eq("folderId", sourceFolder._id)
              .eq("state", "ready")
              .eq("moveJobId", undefined)
              .lte("createdAt", operation.cutoffCreatedAt),
        )
        .order("desc")
        .paginate({
          numItems: BULK_BATCH_SIZE,
          cursor: operation.cursor ?? null,
        });
      const excluded = new Set(operation.excludedEntryIds ?? []);
      candidates = result.page.filter((entry) => !excluded.has(entry._id));
      discoveryComplete = result.isDone;
      nextCursor = result.isDone ? undefined : result.continueCursor;
    }

    let totalItems = operation.totalItems;
    let completedItems = operation.completedItems;
    let failedItems = operation.failedItems;
    let firstError = operation.error;
    let removedBytes = 0;
    let removedItems = 0;
    const destinationGallery =
      operation.destinationGalleryId === undefined
        ? null
        : await ctx.db.get("galleries", operation.destinationGalleryId);
    const destinationFolder =
      operation.destinationFolderId === undefined
        ? null
        : await ctx.db.get("folders", operation.destinationFolderId);
    const reservedDestinationNames =
      operation.kind === "move" && destinationGallery?.storageKind === "user"
        ? await pendingDestinationNames(ctx, destinationFolder?._id ?? sourceFolder._id)
        : new Set<string>();

    for (const entry of candidates) {
      totalItems += 1;
      if (
        entry === null ||
        entry.galleryId !== sourceGallery._id ||
        entry.folderId !== sourceFolder._id ||
        entry.state !== "ready" ||
        entry.moveJobId !== undefined
      ) {
        failedItems += 1;
        firstError ??= "A selected file was no longer available";
        continue;
      }
      if (operation.kind === "delete") {
        const now = Date.now();
        await ctx.db.patch("entries", entry._id, {
          state: "deleted",
          deletedAt: now,
          updatedAt: now,
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
        removedItems += 1;
        removedBytes += entry.size;
        completedItems += 1;
        continue;
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
        failedItems += 1;
        firstError ??= "Move destination is no longer available";
        continue;
      }
      if (
        entry.galleryId === destinationGallery._id &&
        entry.folderId === destinationFolder._id
      ) {
        completedItems += 1;
        continue;
      }
      if (entry.size > destinationGallery.maxFileSize) {
        failedItems += 1;
        firstError ??= `${entry.name} exceeds the destination file size limit`;
        continue;
      }
      if (destinationGallery.storageKind === "user") {
        try {
          cleanFilesystemSegment(entry.name);
        } catch (error) {
          failedItems += 1;
          firstError ??=
            error instanceof Error ? error.message : "File name is invalid";
          continue;
        }
        const existing = await ctx.db
          .query("entries")
          .withIndex(
            "by_folderId_and_state_and_moveJobId_and_name",
            (q) =>
              q
                .eq("folderId", destinationFolder._id)
                .eq("state", "ready")
                .eq("moveJobId", undefined)
                .eq("name", entry.name),
          )
          .first();
        if (
          (existing !== null && existing._id !== entry._id) ||
          reservedDestinationNames.has(entry.name)
        ) {
          failedItems += 1;
          firstError ??= `${entry.name} already exists in the destination folder`;
          continue;
        }
        reservedDestinationNames.add(entry.name);
      }
      const moveJobId = await ctx.db.insert("entryMoveJobs", {
        entryId: entry._id,
        sourceGalleryId: sourceGallery._id,
        destinationGalleryId: destinationGallery._id,
        destinationFolderId: destinationFolder._id,
        actorProfileId: operation.actorProfileId,
        bulkOperationId: operation._id,
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
        updatedAt: Date.now(),
      });
    }

    if (removedItems > 0) {
      await ctx.db.patch("galleries", sourceGallery._id, {
        itemCount: Math.max(0, sourceGallery.itemCount - removedItems),
        totalBytes: Math.max(0, sourceGallery.totalBytes - removedBytes),
      });
    }
    const settledItems = completedItems + failedItems;
    const finished = discoveryComplete && settledItems >= totalItems;
    await ctx.db.patch("bulkOperations", operation._id, {
      status: finished ? finalStatus(failedItems) : "processing",
      nextIndex,
      cursor: nextCursor,
      discoveryComplete,
      totalItems,
      completedItems,
      failedItems,
      error: firstError,
      updatedAt: Date.now(),
    });
    if (!discoveryComplete) {
      await ctx.scheduler.runAfter(0, internal.bulkOperations.process, {
        operationId: operation._id,
      });
    }
    return null;
  },
});
