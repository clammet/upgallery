import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import {
  callConvex,
  type FilesystemSyncJobClaim,
  type MaintenanceClaim,
  type MediaProcessingClaim,
  type RecoverableFilesystemOperationClaim,
} from "./convex.js";
import { delay, runWithHeartbeat } from "./heartbeat.js";
import { processMaintenanceClaim } from "./maintenance.js";
import { configureMediaConcurrency } from "./media.js";
import { processMediaClaim } from "./mediaWorker.js";
import {
  executeFilesystemOperation,
  runUserDirectorySync,
} from "./userFilesystem.js";

let lastSuccessfulConvexAt = 0;
const shutdown = new AbortController();

await mkdir(config.storageRoot, { recursive: true });
configureMediaConcurrency();

const healthServer = createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url === "/readyz") {
    const maximumAge = Math.max(30_000, config.pollIntervalMs * 10);
    const ready =
      lastSuccessfulConvexAt > 0 &&
      Date.now() - lastSuccessfulConvexAt <= maximumAge;
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({ ok: ready }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
});
healthServer.listen(config.workerHealthPort, "0.0.0.0", () => {
  console.log(
    `upgallery storage worker health listening on :${config.workerHealthPort}`,
  );
});

installShutdownHandlers();

const loops = [
  ...Array.from(
    { length: config.mediaWorkerConcurrency },
    (_, index) =>
      runLoop(`media-${index + 1}`, claimAndProcessMedia, shutdown.signal),
  ),
  ...Array.from(
    { length: config.filesystemSyncWorkerConcurrency },
    (_, index) =>
      runLoop(
        `filesystem-sync-${index + 1}`,
        claimAndProcessFilesystemSync,
        shutdown.signal,
      ),
  ),
  runLoop("maintenance", claimAndProcessMaintenance, shutdown.signal),
  runLoop(
    "filesystem-operation-recovery",
    claimAndRecoverFilesystemOperation,
    shutdown.signal,
  ),
  runRecoverySweep(shutdown.signal),
];

await Promise.all(loops);

async function trackedCall<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const result = await callConvex<T>(path, body);
  lastSuccessfulConvexAt = Date.now();
  return result;
}

async function claimAndProcessMedia(signal: AbortSignal): Promise<boolean> {
  const claim = await trackedCall<MediaProcessingClaim>(
    "/internal/storage/claim-media-processing",
  );
  if (claim.kind === "none") return false;
  await runWithHeartbeat({
    signal,
    timeoutMs: config.workerTaskTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    renew: () =>
      trackedCall("/internal/storage/renew-media-processing", {
        jobId: claim.jobId,
      }),
    task: (taskSignal) => processMediaClaim(claim, taskSignal),
  });
  return true;
}

async function claimAndProcessFilesystemSync(
  signal: AbortSignal,
): Promise<boolean> {
  const claim = await trackedCall<FilesystemSyncJobClaim>(
    "/internal/storage/claim-filesystem-sync-job",
  );
  if (claim.kind === "none") return false;
  try {
    await runWithHeartbeat({
      signal,
      timeoutMs: config.workerTaskTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      renew: () =>
        trackedCall("/internal/storage/renew-filesystem-sync-job", {
          jobId: claim.jobId,
        }),
      task: (taskSignal) =>
        runUserDirectorySync(
          claim.galleryId,
          claim.folderId,
          taskSignal,
        ),
    });
    await trackedCall("/internal/storage/complete-filesystem-sync-job", {
      jobId: claim.jobId,
    });
  } catch (error) {
    if (signal.aborted) return true;
    await trackedCall("/internal/storage/complete-filesystem-sync-job", {
      jobId: claim.jobId,
      error:
        error instanceof Error
          ? error.message
          : "Filesystem synchronization failed",
    });
  }
  return true;
}

async function claimAndProcessMaintenance(
  signal: AbortSignal,
): Promise<boolean> {
  const claim = await trackedCall<MaintenanceClaim>(
    "/internal/storage/claim-maintenance",
  );
  if (claim.kind === "none") return false;
  await runWithHeartbeat({
    signal,
    timeoutMs: config.workerTaskTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    renew: () => renewMaintenanceClaim(claim),
    task: (taskSignal) => processMaintenanceClaim(claim, taskSignal),
  });
  return true;
}

async function renewMaintenanceClaim(
  claim: Exclude<MaintenanceClaim, { kind: "none" }>,
): Promise<unknown> {
  if (claim.kind === "delete") {
    return await trackedCall("/internal/storage/renew-delete", {
      jobId: claim.jobId,
    });
  }
  return await trackedCall("/internal/storage/renew-migration", {
    migrationId: claim.migrationId,
    entryId: claim.entryId,
  });
}

async function claimAndRecoverFilesystemOperation(
  signal: AbortSignal,
): Promise<boolean> {
  const claim = await trackedCall<RecoverableFilesystemOperationClaim>(
    "/internal/storage/claim-recoverable-filesystem-operation",
  );
  if (claim.kind === "none") return false;
  try {
    await runWithHeartbeat({
      signal,
      timeoutMs: config.workerTaskTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      renew: () =>
        trackedCall("/internal/storage/renew-filesystem-operation", {
          operationId: claim.operation.operationId,
        }),
      task: (taskSignal) =>
        executeFilesystemOperation(claim.operation, taskSignal),
    });
  } catch (error) {
    if (signal.aborted) return true;
    await trackedCall("/internal/storage/fail-filesystem-operation", {
      operationId: claim.operation.operationId,
      error:
        error instanceof Error
          ? error.message
          : "Filesystem operation recovery failed",
      retry: true,
    });
  }
  return true;
}

async function runRecoverySweep(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await trackedCall("/internal/storage/recover-stale-requests");
    } catch (error) {
      if (!signal.aborted) {
        console.error("storage request recovery sweep failed:", error);
      }
    }
    await delay(60_000, signal).catch(() => undefined);
  }
}

async function runLoop(
  name: string,
  cycle: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let processed = false;
    try {
      processed = await cycle(signal);
    } catch (error) {
      if (!signal.aborted) {
        console.error(`${name} worker failed:`, error);
      }
    }
    if (!processed && !signal.aborted) {
      await delay(config.pollIntervalMs, signal).catch(() => undefined);
    }
  }
}

function installShutdownHandlers(): void {
  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; stopping storage worker`);
    shutdown.abort(new Error(`Storage worker received ${signal}`));
    healthServer.close();
    const force = setTimeout(() => {
      console.error("Storage worker shutdown grace period expired");
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
