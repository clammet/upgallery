import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const STORAGE_JOB_LEASE_MS = 2 * 60 * 1000;
export const STORAGE_JOB_MAX_ATTEMPTS = 5;
export const MEDIA_PROCESSOR_VERSION = 2;
export const MEDIA_METADATA_VERSION = 5;

export function storageJobRetryDelay(attempts: number): number {
  return Math.min(5 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

export async function markThumbnailPendingIfNeeded(
  ctx: MutationCtx,
  entryId: Id<"entries">,
) {
  const entry = await ctx.db.get("entries", entryId);
  if (
    entry !== null &&
    entry.state === "ready" &&
    entry.thumbnailKey === undefined &&
    entry.thumbnailState !== "pending" &&
    (entry.mediaKind === "image" || entry.mediaKind === "video")
  ) {
    await ctx.db.patch("entries", entry._id, {
      thumbnailState: "pending",
      updatedAt: Date.now(),
    });
  }
}

export async function replaceMediaProcessingJob(
  ctx: MutationCtx,
  input: {
    entryId: Id<"entries">;
    storageKey: string;
    sha256: string;
    mediaKind: "image" | "video" | "audio" | "text" | "archive" | "document" | "other";
    alreadyProcessed: boolean;
  },
) {
  const existingJobs = await ctx.db
    .query("mediaProcessingJobs")
    .withIndex("by_entryId", (q) => q.eq("entryId", input.entryId))
    .take(16);
  const previewRequested = existingJobs.some(
    (job) => job.previewRequested === true,
  );
  const shouldGeneratePreview =
    input.mediaKind === "image" && previewRequested;
  for (const job of existingJobs) {
    await ctx.db.delete("mediaProcessingJobs", job._id);
  }
  await ctx.db.patch("entries", input.entryId, {
    thumbnailState:
      !input.alreadyProcessed &&
      (input.mediaKind === "image" || input.mediaKind === "video")
        ? "pending"
        : undefined,
  });
  if (
    (input.alreadyProcessed && !shouldGeneratePreview) ||
    (input.mediaKind !== "image" &&
      input.mediaKind !== "video" &&
      input.mediaKind !== "audio")
  ) {
    return;
  }
  await ctx.db.insert("mediaProcessingJobs", {
    entryId: input.entryId,
    expectedStorageKey: input.storageKey,
    expectedSha256: input.sha256,
    status: "queued",
    attempts: 0,
    availableAt: 0,
    processorVersion: MEDIA_PROCESSOR_VERSION,
    previewRequested: shouldGeneratePreview || undefined,
  });
}

export async function requestMediaPreview(
  ctx: MutationCtx,
  input: {
    entryId: Id<"entries">;
    storageKey: string;
    sha256: string;
  },
) {
  const jobs = await ctx.db
    .query("mediaProcessingJobs")
    .withIndex("by_entryId", (q) => q.eq("entryId", input.entryId))
    .take(16);
  const job =
    jobs.find((candidate) => candidate.status === "processing") ??
    jobs.find((candidate) => candidate.status === "queued") ??
    jobs.find((candidate) => candidate.status === "failed");
  if (job !== undefined) {
    await ctx.db.patch("mediaProcessingJobs", job._id, {
      previewRequested: true,
      ...(job.status === "failed"
        ? {
            status: "queued" as const,
            attempts: 0,
            availableAt: 0,
            claimedAt: undefined,
            leaseExpiresAt: undefined,
            processorVersion: MEDIA_PROCESSOR_VERSION,
            error: undefined,
          }
        : {}),
    });
    await markThumbnailPendingIfNeeded(ctx, input.entryId);
    return job._id;
  }
  const jobId = await ctx.db.insert("mediaProcessingJobs", {
    entryId: input.entryId,
    expectedStorageKey: input.storageKey,
    expectedSha256: input.sha256,
    status: "queued",
    attempts: 0,
    availableAt: 0,
    processorVersion: MEDIA_PROCESSOR_VERSION,
    previewRequested: true,
  });
  await markThumbnailPendingIfNeeded(ctx, input.entryId);
  return jobId;
}
