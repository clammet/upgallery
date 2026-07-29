import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
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
  } else if (claim.kind === "entryMove") {
    await processEntryMove(claim, signal);
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
    }
    if (claim.removeThumbnail && claim.thumbnailKey !== undefined) {
      await unlink(absoluteStoragePath(claim.thumbnailKey)).catch(
        (error: unknown) => {
          if (!isMissing(error)) throw error;
        },
      );
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
    await copyAtomically(
      claim.sourceStorageKey,
      storageKey,
      signal,
      claim.sha256,
    );
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

async function processEntryMove(
  claim: Extract<MaintenanceClaim, { kind: "entryMove" }>,
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
    await copyAtomically(
      claim.sourceStorageKey,
      storageKey,
      signal,
      claim.sha256,
    );
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
    const filesystemMetadata =
      claim.targetStorageKind === "user"
        ? await stat(absoluteStoragePath(storageKey))
        : undefined;
    await callConvex("/internal/storage/complete-entry-move", {
      jobId: claim.jobId,
      storageKey,
      thumbnailKey,
      filesystemModifiedAt: filesystemMetadata?.mtimeMs,
      filesystemIdentity:
        filesystemMetadata === undefined
          ? undefined
          : `${filesystemMetadata.dev}:${filesystemMetadata.ino}`,
    });
  } catch (error) {
    await callConvex("/internal/storage/complete-entry-move", {
      jobId: claim.jobId,
      error: error instanceof Error ? error.message : "Move failed",
    });
  }
}

async function copyAtomically(
  sourceKey: string,
  destinationKey: string,
  signal: AbortSignal,
  expectedSha256?: string,
) {
  const source = absoluteStoragePath(sourceKey);
  const destination = absoluteStoragePath(destinationKey);
  await mkdir(dirname(destination), { recursive: true });
  let destinationExists = true;
  try {
    await access(destination);
  } catch {
    destinationExists = false;
  }
  if (destinationExists) {
    if (
      expectedSha256 !== undefined &&
      (await fileSha256(destination, signal)) !== expectedSha256
    ) {
      throw new Error("Destination already contains a different file");
    }
    return;
  }
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

async function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
