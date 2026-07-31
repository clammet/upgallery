import { stat } from "node:fs/promises";
import { callConvex, type MediaProcessingClaim } from "./convex.js";
import {
  createPreview,
  createThumbnail,
  extractMediaMetadataJson,
} from "./media.js";
import { rewriteStoredImageWithoutLocationData } from "./locationMetadata.js";
import { absoluteStoragePath } from "./paths.js";

export async function processMediaClaim(
  claim: Extract<MediaProcessingClaim, { kind: "ready" }>,
  signal: AbortSignal,
): Promise<void> {
  try {
    let sourcePath = absoluteStoragePath(claim.storageKey);
    const before = await stat(sourcePath);
    if (!claim.removeLocationData) {
      assertExpectedUserFile(claim, before);
    }
    const replacement = claim.removeLocationData
      ? await rewriteStoredImageWithoutLocationData(claim, signal)
      : undefined;
    if (replacement !== undefined) {
      sourcePath = absoluteStoragePath(replacement.storageKey);
    }
    const mediaInput = {
      sourcePath,
      galleryKind: claim.galleryKind,
      storageKind: claim.storageKind,
      storageRoot: claim.storageRoot,
      sha256: replacement?.sha256 ?? claim.sha256,
      extension: claim.extension,
      mediaKind: claim.mediaKind,
      signal,
    };
    const thumbnailKey = claim.processThumbnail
      ? await createThumbnail(mediaInput)
      : undefined;
    const metadataJson = claim.processMetadata
      ? await extractMediaMetadataJson(sourcePath, claim.mediaKind, signal)
      : undefined;
    const previewKey = claim.generatePreview
      ? await createPreview(mediaInput)
      : undefined;
    const after = await stat(sourcePath);
    if (replacement === undefined) {
      assertExpectedUserFile(claim, after);
    }
    await callConvex("/internal/storage/complete-media-processing", {
      jobId: claim.jobId,
      thumbnailKey,
      metadataJson,
      metadataProcessed: claim.processMetadata,
      previewKey,
      ...replacement,
    });
  } catch (error) {
    await callConvex("/internal/storage/complete-media-processing", {
      jobId: claim.jobId,
      error:
        error instanceof Error ? error.message : "Media processing failed",
    });
  }
}

function assertExpectedUserFile(
  claim: Extract<MediaProcessingClaim, { kind: "ready" }>,
  metadata: { size: number; mtimeMs: number },
): void {
  if (claim.storageKind !== "user") return;
  if (
    metadata.size !== claim.size ||
    claim.filesystemModifiedAt === undefined ||
    metadata.mtimeMs !== claim.filesystemModifiedAt
  ) {
    throw new Error("User-backed file changed before media processing completed");
  }
}
