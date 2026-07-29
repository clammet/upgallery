import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { callConvex, type MaintenanceClaim } from "./convex.js";
import {
  absoluteStoragePath,
  buildStorageKey,
} from "./paths.js";

export async function runMaintenanceOnce(): Promise<void> {
  const claim = await callConvex<MaintenanceClaim>(
    "/internal/storage/claim-maintenance",
  );
  await processMaintenanceClaim(claim, new AbortController().signal);
}

export async function processMaintenanceClaim(
  claim: MaintenanceClaim,
  signal: AbortSignal,
): Promise<void> {
  if (claim.kind === "delete") {
    await processDelete(claim, signal);
  } else if (claim.kind === "migration") {
    await processMigration(claim, signal);
  }
}

async function processDelete(
  claim: Extract<MaintenanceClaim, { kind: "delete" }>,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    if (claim.removePhysical) {
      await unlink(absoluteStoragePath(claim.storageKey)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      if (claim.thumbnailKey !== undefined) {
        await unlink(absoluteStoragePath(claim.thumbnailKey)).catch(
          (error: unknown) => {
            if (!isMissing(error)) throw error;
          },
        );
      }
    }
    await callConvex("/internal/storage/complete-delete", {
      jobId: claim.jobId,
    });
  } catch (error) {
    await callConvex("/internal/storage/complete-delete", {
      jobId: claim.jobId,
      error: error instanceof Error ? error.message : "Deletion failed",
    });
  }
}

async function processMigration(
  claim: Extract<MaintenanceClaim, { kind: "migration" }>,
  signal: AbortSignal,
) {
  try {
    const storageKey = buildStorageKey({
      galleryKind: claim.galleryKind,
      storageKind: claim.targetStorageKind,
      storageRoot: claim.targetStorageRoot,
      sha256: claim.sha256,
      extension: claim.extension,
      folderSegments: claim.targetFolderSegments,
      fileName: claim.fileName,
    });
    await copyAtomically(claim.sourceStorageKey, storageKey, signal);
    let thumbnailKey: string | undefined;
    if (claim.sourceThumbnailKey !== undefined) {
      thumbnailKey = buildStorageKey({
        galleryKind: claim.galleryKind,
        storageKind: claim.targetStorageKind,
        storageRoot: claim.targetStorageRoot,
        sha256: claim.sha256,
        extension: claim.extension,
        thumbnail: true,
        folderSegments: claim.targetFolderSegments,
        fileName: claim.fileName,
      });
      await copyAtomically(claim.sourceThumbnailKey, thumbnailKey, signal);
    }
    await callConvex("/internal/storage/complete-migration", {
      migrationId: claim.migrationId,
      entryId: claim.entryId,
      storageKey,
      thumbnailKey,
    });
  } catch (error) {
    await callConvex("/internal/storage/complete-migration", {
      migrationId: claim.migrationId,
      entryId: claim.entryId,
      error: error instanceof Error ? error.message : "Migration failed",
    });
  }
}

async function copyAtomically(
  sourceKey: string,
  destinationKey: string,
  signal: AbortSignal,
) {
  const source = absoluteStoragePath(sourceKey);
  const destination = absoluteStoragePath(destinationKey);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await access(destination);
    return;
  } catch {
    const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
