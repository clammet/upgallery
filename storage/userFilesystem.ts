import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { callConvex } from "./convex.js";
import type { FilesystemOperationClaim } from "./convex.js";
import { config } from "./config.js";
import { runWithHeartbeat } from "./heartbeat.js";
import {
  classifyMedia,
  resolveExtension,
  resolveMimeType,
} from "./media.js";
import {
  absoluteStoragePath,
  userFilesystemStorageKey,
} from "./paths.js";

const MAX_DIRECTORY_ITEMS = 500;
const MAX_RECURSIVE_DIRECTORIES = 2_000;

type SyncClaim =
  | { kind: "busy"; retryAfterMs?: number }
  | {
      kind: "ready";
      syncId: string;
      storageRoot: string;
      folderSegments: string[];
      knownModifiedAt?: number;
      maxFileSize: number;
      knownChildFolderIds: string[];
    };

type FileCheck =
  | { kind: "unchanged" }
  | { kind: "metadata"; entryId?: string };

export async function runUserDirectorySync(
  galleryId: string,
  folderId: string,
  signal: AbortSignal,
): Promise<void> {
  await syncUserDirectory(
    galleryId,
    folderId,
    { visited: new Set<string>() },
    true,
    signal,
  );
}

async function syncUserDirectory(
  galleryId: string,
  folderId: string,
  tree: { visited: Set<string> },
  isRequestedRoot: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (tree.visited.has(folderId)) {
    return;
  }
  tree.visited.add(folderId);
  if (tree.visited.size > MAX_RECURSIVE_DIRECTORIES) {
    throw new Error(
      `Recursive update exceeds ${MAX_RECURSIVE_DIRECTORIES} directories`,
    );
  }
  const claim = await callConvex<SyncClaim>(
    "/internal/storage/claim-filesystem-sync",
    { galleryId, folderId },
  );
  if (claim.kind === "busy") {
    if (isRequestedRoot) {
      throw new Error(
        `Filesystem synchronization is already leased; retry after ${claim.retryAfterMs ?? config.pollIntervalMs}ms`,
      );
    }
    return;
  }
  try {
    const childFolderIds = await runWithHeartbeat({
      signal,
      timeoutMs: config.workerTaskTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      renew: () =>
        callConvex("/internal/storage/renew-filesystem-sync-lease", {
          galleryId,
          folderId,
          syncId: claim.syncId,
        }),
      task: async (syncSignal) => {
        const directoryKey = userFilesystemStorageKey(
          claim.storageRoot,
          claim.folderSegments,
        );
        const directoryPath = absoluteStoragePath(directoryKey);
        if (claim.folderSegments.length === 0) {
          await mkdir(directoryPath, { recursive: true });
        }
        const before = await stat(directoryPath);
        if (!before.isDirectory()) {
          throw new Error("Requested user-backed path is not a directory");
        }
        const comparison = await callConvex<{ shouldScan: boolean }>(
          "/internal/storage/compare-filesystem-directory",
          {
            galleryId,
            folderId,
            syncId: claim.syncId,
            modifiedAt: before.mtimeMs,
          },
        );
        if (!comparison.shouldScan) {
          return isRequestedRoot ? [] : claim.knownChildFolderIds;
        }

        const children = (await readdir(directoryPath, { withFileTypes: true }))
          .filter((child) => child.name !== ".upgallery")
          .filter(
            (child) =>
              !/\.partial-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
                child.name,
              ),
          );
        if (children.length > MAX_DIRECTORY_ITEMS) {
          throw new Error(
            `Directory contains more than ${MAX_DIRECTORY_ITEMS} items`,
          );
        }

        const childFolderIds: string[] = [];
        for (const child of children.filter((item) => item.isDirectory())) {
          syncSignal.throwIfAborted();
          const childPath = absoluteStoragePath(`${directoryKey}/${child.name}`);
          const metadata = await lstat(childPath);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            continue;
          }
          const reconciled = await callConvex<{ folderId: string }>(
            "/internal/storage/reconcile-filesystem-directory",
            {
              galleryId,
              parentId: folderId,
              syncId: claim.syncId,
              name: child.name,
              identity: filesystemIdentity(metadata),
            },
          );
          childFolderIds.push(reconciled.folderId);
        }

        for (const child of children.filter((item) => item.isFile())) {
          syncSignal.throwIfAborted();
          const storageKey = userFilesystemStorageKey(
            claim.storageRoot,
            claim.folderSegments,
            child.name,
          );
          const filePath = absoluteStoragePath(storageKey);
          const beforeFile = await lstat(filePath);
          if (!beforeFile.isFile() || beforeFile.isSymbolicLink()) {
            continue;
          }
          if (beforeFile.size > claim.maxFileSize) {
            console.warn(
              `Skipping oversized user-backed file ${storageKey} (${beforeFile.size} bytes)`,
            );
            continue;
          }
          const identity = filesystemIdentity(beforeFile);
          const check = await callConvex<FileCheck>(
            "/internal/storage/check-filesystem-file",
            {
              galleryId,
              folderId,
              syncId: claim.syncId,
              name: child.name,
              storageKey,
              size: beforeFile.size,
              modifiedAt: beforeFile.mtimeMs,
              identity,
            },
          );
          if (check.kind === "unchanged") {
            continue;
          }

          const sha256 = await hashFile(filePath, syncSignal);
          const afterFile = await stat(filePath);
          if (
            afterFile.size !== beforeFile.size ||
            afterFile.mtimeMs !== beforeFile.mtimeMs
          ) {
            throw new Error(
              `File changed while it was being indexed: ${child.name}`,
            );
          }
          const mimeType = resolveMimeType(
            child.name,
            "application/octet-stream",
          );
          const extension = resolveExtension(child.name, mimeType);
          const kind = classifyMedia(mimeType);
          await callConvex("/internal/storage/reconcile-filesystem-file", {
            galleryId,
            folderId,
            syncId: claim.syncId,
            entryId: check.entryId,
            name: child.name,
            storageKey,
            size: beforeFile.size,
            modifiedAt: beforeFile.mtimeMs,
            identity,
            mimeType,
            extension,
            mediaKind: kind,
            sha256,
          });
        }

        const after = await stat(directoryPath);
        if (after.mtimeMs !== before.mtimeMs) {
          throw new Error("Directory changed while it was being indexed");
        }
        await callConvex("/internal/storage/complete-filesystem-sync", {
          galleryId,
          folderId,
          syncId: claim.syncId,
          modifiedAt: after.mtimeMs,
        });
        return childFolderIds;
      },
    });
    for (const childFolderId of childFolderIds) {
      try {
        await syncUserDirectory(
          galleryId,
          childFolderId,
          tree,
          false,
          signal,
        );
      } catch (error) {
        console.error(
          `Queued failed child filesystem sync ${childFolderId} for retry:`,
          error,
        );
      }
    }
  } catch (error) {
    await callConvex("/internal/storage/fail-filesystem-sync", {
      folderId,
      syncId: claim.syncId,
      error:
        error instanceof Error
          ? error.message
          : "User directory synchronization failed",
    }).catch(() => undefined);
    if (!isRequestedRoot) {
      await callConvex("/internal/storage/queue-filesystem-sync", {
        galleryId,
        folderId,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function runFilesystemOperation(
  operationId: string,
  token: string,
) {
  let claim: FilesystemOperationClaim | undefined;
  try {
    claim = await callConvex<FilesystemOperationClaim>(
      "/internal/storage/claim-filesystem-operation",
      { operationId, token },
    );
    return await runWithHeartbeat({
      signal: new AbortController().signal,
      timeoutMs: config.workerTaskTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      renew: () =>
        callConvex("/internal/storage/renew-filesystem-operation", {
          operationId,
        }),
      task: (signal) => executeFilesystemOperation(claim!, signal),
    });
  } catch (error) {
    if (claim !== undefined) {
      await callConvex("/internal/storage/fail-filesystem-operation", {
        operationId,
        error:
          error instanceof Error ? error.message : "Filesystem operation failed",
        retry: true,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function executeFilesystemOperation(
  claim: FilesystemOperationClaim,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const destinationKey = userFilesystemStorageKey(
    claim.storageRoot,
    claim.destinationSegments,
  );
  const destination = absoluteStoragePath(destinationKey);
  await mkdir(dirname(destination), { recursive: true });
  if (claim.kind === "mkdir") {
    await mkdir(destination).catch(async (error: unknown) => {
      if (!isAlreadyExists(error) || !(await stat(destination)).isDirectory()) {
        throw error;
      }
    });
  } else {
    if (claim.sourceSegments === undefined) {
      throw new Error("Rename operation has no source path");
    }
    const source = absoluteStoragePath(
      userFilesystemStorageKey(claim.storageRoot, claim.sourceSegments),
    );
    try {
      await rename(source, destination);
    } catch (error) {
      if (!isMissing(error) || !(await isDirectory(destination))) {
        throw error;
      }
    }
  }
  signal.throwIfAborted();
  const metadata = await stat(destination);
  return await callConvex<{ folderId: string }>(
    "/internal/storage/complete-filesystem-operation",
    {
      operationId: claim.operationId,
      identity: filesystemIdentity(metadata),
    },
  );
}

function filesystemIdentity(metadata: {
  dev: number | bigint;
  ino: number | bigint;
}): string {
  return `${metadata.dev}:${metadata.ino}`;
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path)
    .then((metadata) => metadata.isDirectory())
    .catch(() => false);
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
