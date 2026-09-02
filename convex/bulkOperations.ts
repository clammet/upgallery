import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { adjustGalleryStats } from "./lib/galleryStats";
import { adjustFolderStats } from "./lib/folderStats";
import { validateFilesystemSegment } from "./lib/normalize";
import {
  getCurrentProfile,
  requireCurrentProfile,
  requireGalleryManager,
  unauthorizedError,
} from "./lib/permissions";
import {
  bulkConflictPolicy,
  bulkOperationStatus,
  conflictPolicy,
} from "./lib/validators";
import {
  isEntryExistsError,
  reservedNameKeys,
  resolveLandingName,
  type ConflictPolicy,
} from "./lib/entryNames";
import { operationStatus } from "./lib/bulkOperations";

const BULK_BATCH_SIZE = 32;
const MAX_SELECTION_IDS = 8192;
const MAX_LISTED_CONFLICTS = 100;
const CONFLICT_BATCH_SIZE = 32;

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

const operationSummary = v.object({
  _id: v.id("bulkOperations"),
  kind: v.union(v.literal("delete"), v.literal("move")),
  status: bulkOperationStatus,
  sourceGalleryId: v.id("galleries"),
  sourceFolderId: v.id("folders"),
  destinationGalleryId: v.optional(v.id("galleries")),
  destinationFolderId: v.optional(v.id("folders")),
  discoveryComplete: v.boolean(),
  totalItems: v.number(),
  completedItems: v.number(),
  failedItems: v.number(),
  conflictItems: v.number(),
  // Parked items awaiting a policy, capped for display; conflictItems is
  // the full count.
  conflicts: v.array(
    v.object({
      jobId: v.id("entryMoveJobs"),
      entryId: v.id("entries"),
      name: v.string(),
    }),
  ),
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
    conflictItems: 0,
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
    const summaries = [];
    for (const operation of operations) {
      if (operation.dismissedAt !== undefined) continue;
      const conflicts = [];
      if (operation.conflictItems > 0) {
        const jobs = await ctx.db
          .query("entryMoveJobs")
          .withIndex("by_bulkOperationId_and_status", (q) =>
            q.eq("bulkOperationId", operation._id).eq("status", "conflict"),
          )
          .take(MAX_LISTED_CONFLICTS);
        for (const job of jobs) {
          const entry = await ctx.db.get("entries", job.entryId);
          conflicts.push({
            jobId: job._id,
            entryId: job.entryId,
            name: entry?.name ?? "Deleted file",
          });
        }
      }
      summaries.push({
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
        conflictItems: operation.conflictItems,
        conflicts,
        error: operation.error,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      });
    }
    return summaries;
  },
});

// Operations with parked conflicts are not finished and stay listed until a
// policy (or Skip) settles them.
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
        operation.dismissedAt !== undefined ||
        (operation.status !== "complete" && operation.status !== "failed")
      ) {
        continue;
      }
      await ctx.db.patch("bulkOperations", operation._id, {
        dismissedAt: now,
      });
      dismissed += 1;
    }
    return dismissed;
  },
});

async function queueMoveJob(
  ctx: MutationCtx,
  input: {
    jobId?: Id<"entryMoveJobs">;
    entry: Doc<"entries">;
    operation: Doc<"bulkOperations">;
    sourceGalleryId: Id<"galleries">;
    destinationGalleryId: Id<"galleries">;
    destinationFolderId: Id<"folders">;
    policy: ConflictPolicy | undefined;
    targetName: string;
  },
) {
  const now = Date.now();
  const fields = {
    entryId: input.entry._id,
    sourceGalleryId: input.sourceGalleryId,
    destinationGalleryId: input.destinationGalleryId,
    destinationFolderId: input.destinationFolderId,
    actorProfileId: input.operation.actorProfileId,
    bulkOperationId: input.operation._id,
    expectedSourceStorageKey: input.entry.storageKey,
    conflictPolicy: input.policy,
    targetName:
      input.targetName === input.entry.name ? undefined : input.targetName,
    status: "queued" as const,
    attempts: 0,
    availableAt: 0,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
    error: undefined,
  };
  let jobId = input.jobId;
  if (jobId === undefined) {
    jobId = await ctx.db.insert("entryMoveJobs", fields);
  } else {
    await ctx.db.patch("entryMoveJobs", jobId, fields);
  }
  await ctx.db.patch("entries", input.entry._id, {
    moveJobId: jobId,
    migrationState: "moving",
    migrationClaimedAt: undefined,
    migrationAttempts: 0,
    migrationRetryAt: undefined,
    migrationError: undefined,
    updatedAt: now,
  });
}

// Finished operations the user never cleared would otherwise sit in the
// status bar forever. The cron hides them once they have been idle this long.
const AUTO_DISMISS_AFTER_MS = 60 * 60 * 1000;
const AUTO_DISMISS_BATCH = 100;

export const dismissStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - AUTO_DISMISS_AFTER_MS;
    let dismissed = 0;
    for (const status of ["complete", "failed"] as const) {
      const stale = await ctx.db
        .query("bulkOperations")
        .withIndex("by_dismissedAt_and_status_and_updatedAt", (q) =>
          q
            .eq("dismissedAt", undefined)
            .eq("status", status)
            .lt("updatedAt", cutoff),
        )
        .take(AUTO_DISMISS_BATCH);
      for (const operation of stale) {
        await ctx.db.patch("bulkOperations", operation._id, {
          dismissedAt: now,
        });
        dismissed += 1;
      }
    }
    if (dismissed === AUTO_DISMISS_BATCH * 2) {
      await ctx.scheduler.runAfter(0, internal.bulkOperations.dismissStale, {});
    }
    return dismissed;
  },
});

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
    let conflictItems = operation.conflictItems;
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
    // "skip" is an operation-wide choice, not something a queued job carries.
    const itemPolicy =
      operation.conflictPolicy === "skip" ? undefined : operation.conflictPolicy;
    // Names in-flight work will occupy in the destination; picks made in
    // this batch are added as they happen.
    const reserved =
      operation.kind === "move" && destinationFolder !== null
        ? await reservedNameKeys(ctx, destinationFolder._id)
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
          validateFilesystemSegment(entry.name);
        } catch (error) {
          failedItems += 1;
          firstError ??=
            error instanceof Error ? error.message : "File name is invalid";
          continue;
        }
      }
      // A taken name is queued under the operation's policy when it has
      // one, skipped (and withdrawn from the operation) under "skip", and
      // otherwise parked until the user decides.
      let targetName: string;
      try {
        targetName = (
          await resolveLandingName(ctx, {
            gallery: destinationGallery,
            folderId: destinationFolder._id,
            name: entry.name,
            policy: itemPolicy,
            excludeEntryId: entry._id,
            reserved,
          })
        ).name;
      } catch (error) {
        if (!isEntryExistsError(error)) throw error;
        if (operation.conflictPolicy === "skip") {
          totalItems -= 1;
          continue;
        }
        await ctx.db.insert("entryMoveJobs", {
          entryId: entry._id,
          sourceGalleryId: sourceGallery._id,
          destinationGalleryId: destinationGallery._id,
          destinationFolderId: destinationFolder._id,
          actorProfileId: operation.actorProfileId,
          bulkOperationId: operation._id,
          expectedSourceStorageKey: entry.storageKey,
          status: "conflict",
          attempts: 0,
          availableAt: 0,
        });
        conflictItems += 1;
        continue;
      }
      await queueMoveJob(ctx, {
        entry,
        operation,
        sourceGalleryId: sourceGallery._id,
        destinationGalleryId: destinationGallery._id,
        destinationFolderId: destinationFolder._id,
        policy: itemPolicy,
        targetName,
      });
    }

    if (removedItems > 0) {
      await adjustGalleryStats(ctx, sourceGallery, {
        items: -removedItems,
        bytes: -removedBytes,
      });
      await adjustFolderStats(
        ctx,
        { folderId: sourceFolder._id, galleryId: sourceGallery._id },
        { items: -removedItems, bytes: -removedBytes },
      );
    }
    await ctx.db.patch("bulkOperations", operation._id, {
      status: operationStatus({
        discoveryComplete,
        totalItems,
        completedItems,
        failedItems,
        conflictItems,
      }),
      nextIndex,
      cursor: nextCursor,
      discoveryComplete,
      totalItems,
      completedItems,
      failedItems,
      conflictItems,
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

// Re-validates a parked item and queues it under the chosen policy, or
// fails it when the file or destination went away meanwhile.
async function resolveParkedJob(
  ctx: MutationCtx,
  job: Doc<"entryMoveJobs">,
  policy: ConflictPolicy,
) {
  if (job.status !== "conflict" || job.bulkOperationId === undefined) return;
  const operation = await ctx.db.get("bulkOperations", job.bulkOperationId);
  if (operation === null) return;
  const [entry, destinationGallery, destinationFolder] = await Promise.all([
    ctx.db.get("entries", job.entryId),
    ctx.db.get("galleries", job.destinationGalleryId),
    ctx.db.get("folders", job.destinationFolderId),
  ]);
  const now = Date.now();
  const fail = async (message: string) => {
    await ctx.db.patch("entryMoveJobs", job._id, {
      status: "failed",
      error: message,
    });
    const counts = {
      ...operation,
      conflictItems: Math.max(0, operation.conflictItems - 1),
      failedItems: operation.failedItems + 1,
    };
    await ctx.db.patch("bulkOperations", operation._id, {
      conflictItems: counts.conflictItems,
      failedItems: counts.failedItems,
      error: operation.error ?? message,
      status: operationStatus(counts),
      updatedAt: now,
    });
  };
  if (
    entry === null ||
    entry.state !== "ready" ||
    entry.moveJobId !== undefined ||
    entry.galleryId !== operation.sourceGalleryId ||
    entry.folderId !== operation.sourceFolderId
  ) {
    return await fail("A selected file was no longer available");
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
    return await fail("Move destination is no longer available");
  }
  if (entry.size > destinationGallery.maxFileSize) {
    return await fail(`${entry.name} exceeds the destination file size limit`);
  }
  const landing = await resolveLandingName(ctx, {
    gallery: destinationGallery,
    folderId: destinationFolder._id,
    name: entry.name,
    policy,
    excludeEntryId: entry._id,
    excludeJobId: job._id,
  });
  await queueMoveJob(ctx, {
    jobId: job._id,
    entry,
    operation,
    sourceGalleryId: operation.sourceGalleryId,
    destinationGalleryId: destinationGallery._id,
    destinationFolderId: destinationFolder._id,
    policy,
    targetName: landing.name,
  });
  const counts = {
    ...operation,
    conflictItems: Math.max(0, operation.conflictItems - 1),
  };
  await ctx.db.patch("bulkOperations", operation._id, {
    conflictItems: counts.conflictItems,
    status: operationStatus(counts),
    updatedAt: now,
  });
}

export const resolveConflict = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    jobId: v.id("entryMoveJobs"),
    policy: conflictPolicy,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const job = await ctx.db.get("entryMoveJobs", args.jobId);
    if (
      job === null ||
      job.status !== "conflict" ||
      job.bulkOperationId === undefined
    ) {
      throw new Error("This conflict is no longer pending");
    }
    const operation = await ctx.db.get("bulkOperations", job.bulkOperationId);
    if (operation === null || operation.actorProfileId !== profile._id) {
      throw unauthorizedError();
    }
    await resolveParkedJob(ctx, job, args.policy);
    return null;
  },
});

// "Replace all" / "Auto rename all" / "Skip": adopts the choice for the
// caller's operations that have parked items (or one operation), so both the
// parked items and any conflicts discovered later resolve themselves.
export const resolveConflicts = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    policy: bulkConflictPolicy,
    operationId: v.optional(v.id("bulkOperations")),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const operations =
      args.operationId === undefined
        ? await ctx.db
            .query("bulkOperations")
            .withIndex("by_actorProfileId_and_createdAt", (q) =>
              q.eq("actorProfileId", profile._id),
            )
            .order("desc")
            .take(30)
        : [await ctx.db.get("bulkOperations", args.operationId)];
    let adopted = 0;
    for (const operation of operations) {
      if (
        operation === null ||
        operation.actorProfileId !== profile._id ||
        operation.dismissedAt !== undefined ||
        operation.kind !== "move" ||
        operation.conflictItems === 0
      ) {
        continue;
      }
      await ctx.db.patch("bulkOperations", operation._id, {
        conflictPolicy: args.policy,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.bulkOperations.applyConflictPolicy,
        { operationId: operation._id },
      );
      adopted += 1;
    }
    return adopted;
  },
});

export const applyConflictPolicy = internalMutation({
  args: { operationId: v.id("bulkOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get("bulkOperations", args.operationId);
    if (
      operation === null ||
      operation.conflictPolicy === undefined ||
      operation.dismissedAt !== undefined
    ) {
      return null;
    }
    const jobs = await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_bulkOperationId_and_status", (q) =>
        q.eq("bulkOperationId", operation._id).eq("status", "conflict"),
      )
      .take(CONFLICT_BATCH_SIZE);
    if (operation.conflictPolicy === "skip") {
      // Skipped items leave the operation: the files stay where they are.
      for (const job of jobs) {
        await ctx.db.delete("entryMoveJobs", job._id);
      }
      const counts = {
        ...operation,
        conflictItems: Math.max(0, operation.conflictItems - jobs.length),
        totalItems: Math.max(0, operation.totalItems - jobs.length),
      };
      await ctx.db.patch("bulkOperations", operation._id, {
        conflictItems: counts.conflictItems,
        totalItems: counts.totalItems,
        status: operationStatus(counts),
        updatedAt: Date.now(),
      });
    } else {
      for (const job of jobs) {
        await resolveParkedJob(ctx, job, operation.conflictPolicy);
      }
    }
    if (jobs.length === CONFLICT_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.bulkOperations.applyConflictPolicy,
        { operationId: operation._id },
      );
    }
    return null;
  },
});
