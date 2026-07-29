import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const STORAGE_JOB_LEASE_MS = 2 * 60 * 1000;
export const STORAGE_JOB_MAX_ATTEMPTS = 5;

export function storageJobRetryDelay(attempts: number): number {
  return Math.min(5 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempts - 1));
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
  for (const job of existingJobs) {
    await ctx.db.delete("mediaProcessingJobs", job._id);
  }
  if (
    input.alreadyProcessed ||
    (input.mediaKind !== "image" && input.mediaKind !== "video")
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
  });
}
