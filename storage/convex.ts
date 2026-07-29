import { config } from "./config.js";

export async function callConvex<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${config.convexSiteUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-upgallery-storage-secret": config.storageSecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Convex request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export type UploadClaim = {
  intentId: string;
  name: string;
  declaredMimeType: string;
  declaredSize: number;
  galleryId: string;
  galleryKind: "image" | "uploader";
  storageKind: "shared" | "user";
  storageRoot: string;
  folderSegments: string[];
  maxFileSize: number;
};

export type DownloadClaim = {
  entryId: string;
  storageKey: string;
  mimeType: string;
  fileName: string;
  disposition: "inline" | "attachment" | "thumbnail";
};

export type MaintenanceClaim =
  | { kind: "none" }
  | {
      kind: "delete";
      jobId: string;
      storageKey: string;
      thumbnailKey?: string;
      removePhysical: boolean;
    }
  | {
      kind: "migration";
      migrationId: string;
      entryId: string;
      galleryKind: "image" | "uploader";
      targetStorageKind: "shared" | "user";
      targetStorageRoot: string;
      targetFolderSegments: string[];
      fileName: string;
      sourceStorageKey: string;
      sourceThumbnailKey?: string;
      sha256: string;
      extension: string;
    };

export type FilesystemSyncJobClaim =
  | { kind: "none" }
  | {
      kind: "ready";
      jobId: string;
      galleryId: string;
      folderId: string;
    };

export type MediaProcessingClaim =
  | { kind: "none" }
  | {
      kind: "ready";
      jobId: string;
      entryId: string;
      storageKey: string;
      sha256: string;
      extension: string;
      mediaKind: "image" | "video";
      galleryKind: "image" | "uploader";
      storageKind: "shared" | "user";
      storageRoot: string;
      size: number;
      filesystemModifiedAt?: number;
    };

export type FilesystemOperationClaim = {
  operationId: string;
  kind: "mkdir" | "rename";
  storageRoot: string;
  sourceSegments?: string[];
  destinationSegments: string[];
};

export type RecoverableFilesystemOperationClaim =
  | { kind: "none" }
  | {
      kind: "ready";
      operation: FilesystemOperationClaim;
    };
