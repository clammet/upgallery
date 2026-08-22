import { config } from "./config.js";

// Convex refusals that carry a code (a name the folder already holds) keep it
// so the HTTP layer can forward it to the browser.
export class ConvexRequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConvexRequestError";
    this.code = code;
  }
}

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
    const body =
      typeof payload === "object" && payload !== null ? payload : {};
    const message =
      "error" in body && typeof body.error === "string"
        ? body.error
        : `Convex request failed with status ${response.status}`;
    throw new ConvexRequestError(
      message,
      "code" in body && typeof body.code === "string" ? body.code : undefined,
    );
  }
  return payload as T;
}

export type UploadClaim = {
  intentId: string;
  name: string;
  // Path of the user-backed file this upload replaces, when that differs
  // from where the upload lands (a case variant of the name).
  replacesStorageKey?: string;
  declaredMimeType: string;
  declaredSize: number;
  galleryId: string;
  galleryKind: "image" | "uploader";
  storageKind: "shared" | "user";
  storageRoot: string;
  folderSegments: string[];
  maxFileSize: number;
  removeLocationData: boolean;
};

export type DownloadClaim = {
  entryId: string;
  storageKey: string;
  mimeType: string;
  fileName: string;
  disposition: "inline" | "attachment" | "thumbnail" | "preview";
};

export type MaintenanceClaim =
  | { kind: "none" }
  | {
      kind: "delete";
      jobId: string;
      storageKey: string;
      thumbnailKey?: string;
      previewKey?: string;
      removePhysical: boolean;
      removeThumbnail: boolean;
      removePreview: boolean;
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
      sourcePreviewKey?: string;
      sha256: string;
      extension: string;
    }
  | {
      kind: "entryMove";
      jobId: string;
      entryId: string;
      galleryKind: "image";
      targetStorageKind: "shared" | "user";
      targetStorageRoot: string;
      targetFolderSegments: string[];
      fileName: string;
      // Overwrite a same-named destination file rather than refusing it.
      replace?: boolean;
      replacesStorageKey?: string;
      sourceStorageKey: string;
      sourceThumbnailKey?: string;
      sourcePreviewKey?: string;
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
      mediaKind: "image" | "video" | "audio";
      galleryKind: "image" | "uploader";
      storageKind: "shared" | "user";
      storageRoot: string;
      size: number;
      filesystemModifiedAt?: number;
      processThumbnail: boolean;
      processMetadata: boolean;
      generatePreview: boolean;
      removeLocationData: boolean;
    };

export type FilesystemOperationClaim = {
  operationId: string;
  kind: "mkdir" | "rename" | "rmdir" | "fileRename" | "move";
  storageRoot: string;
  sourceSegments?: string[];
  destinationSegments: string[];
};

export type FilesystemOperationResult = {
  folderId: string | null;
  entryId: string | null;
};

export type RecoverableFilesystemOperationClaim =
  | { kind: "none" }
  | {
      kind: "ready";
      operation: FilesystemOperationClaim;
    };
