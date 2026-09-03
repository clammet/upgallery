import { resolve } from "node:path";
import { parseMountRoots, parseSentinelName } from "./storageRoots.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const config = {
  // Baked into the image by the Docker build; empty in local development.
  gitCommit: process.env.STORAGE_GIT_COMMIT?.trim() ?? "",
  port: positiveInteger("PORT", 8787),
  workerHealthPort: positiveInteger("WORKER_HEALTH_PORT", 8788),
  convexSiteUrl: required("CONVEX_SITE_URL").replace(/\/+$/, ""),
  storageSecret: required("STORAGE_INTERNAL_SECRET"),
  storageRoot: resolve(process.env.STORAGE_ROOT?.trim() || ".storage"),
  // Startup guard for bind-mounted roots (see storageRoots.ts). Comma
  // separated paths relative to STORAGE_ROOT; each must contain the sentinel
  // file. Unset means no guard.
  storageMountRoots: parseMountRoots(process.env.STORAGE_MOUNT_ROOTS),
  storageRootSentinel: parseSentinelName(process.env.STORAGE_ROOT_SENTINEL),
  pollIntervalMs: positiveInteger("STORAGE_POLL_INTERVAL_MS", 1_000),
  heartbeatIntervalMs: positiveInteger(
    "STORAGE_HEARTBEAT_INTERVAL_MS",
    30_000,
  ),
  shutdownGraceMs: positiveInteger("STORAGE_SHUTDOWN_GRACE_MS", 60_000),
  temporaryMaxAgeMs: positiveInteger(
    "STORAGE_TEMP_MAX_AGE_MS",
    24 * 60 * 60 * 1000,
  ),
  ffmpegTimeoutMs: positiveInteger("STORAGE_FFMPEG_TIMEOUT_MS", 5 * 60 * 1000),
  heifThumbnailerCommand:
    process.env.STORAGE_HEIF_THUMBNAILER_COMMAND?.trim() || "heif-thumbnailer",
  workerTaskTimeoutMs: positiveInteger(
    "STORAGE_WORKER_TASK_TIMEOUT_MS",
    60 * 60 * 1000,
  ),
  maxConcurrentUploads: positiveInteger("STORAGE_MAX_CONCURRENT_UPLOADS", 4),
  maxQueuedUploads: positiveInteger("STORAGE_MAX_QUEUED_UPLOADS", 16),
  maxConcurrentDownloads: positiveInteger(
    "STORAGE_MAX_CONCURRENT_DOWNLOADS",
    16,
  ),
  maxQueuedDownloads: positiveInteger("STORAGE_MAX_QUEUED_DOWNLOADS", 64),
  maxConcurrentFilesystemOperations: positiveInteger(
    "STORAGE_MAX_CONCURRENT_FILESYSTEM_OPERATIONS",
    2,
  ),
  maxQueuedFilesystemOperations: positiveInteger(
    "STORAGE_MAX_QUEUED_FILESYSTEM_OPERATIONS",
    16,
  ),
  mediaWorkerConcurrency: positiveInteger(
    "STORAGE_MEDIA_WORKER_CONCURRENCY",
    2,
  ),
  filesystemSyncWorkerConcurrency: positiveInteger(
    "STORAGE_SYNC_WORKER_CONCURRENCY",
    2,
  ),
  sharpConcurrency: positiveInteger("STORAGE_SHARP_CONCURRENCY", 1),
  absoluteUploadLimit: positiveInteger(
    "MAX_ABSOLUTE_UPLOAD_BYTES",
    10 * 1024 * 1024 * 1024,
  ),
};

if (config.storageSecret.length < 24) {
  throw new Error("STORAGE_INTERNAL_SECRET must contain at least 24 characters");
}
