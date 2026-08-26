import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function readFilesystemSyncStatus(
  ctx: Pick<QueryCtx, "db">,
  folderId: Id<"folders">,
) {
  const [state, jobs] = await Promise.all([
    ctx.db
      .query("filesystemSyncStates")
      .withIndex("by_folderId", (q) => q.eq("folderId", folderId))
      .unique(),
    ctx.db
      .query("filesystemSyncJobs")
      .withIndex("by_folderId", (q) => q.eq("folderId", folderId))
      .take(16),
  ]);
  const running =
    state?.activeSyncId !== undefined ||
    jobs.some((job) => job.status === "processing");
  const queued = jobs.some((job) => job.status === "queued");
  return {
    status: running
      ? ("running" as const)
      : queued
        ? ("queued" as const)
        : ("idle" as const),
    // Retained for callers that only need the active/not-active distinction.
    isRunning: running,
    lastFinishedAt: state?.lastCheckedAt,
    hasError:
      state?.error !== undefined ||
      jobs.some((job) => job.status === "failed"),
  };
}
