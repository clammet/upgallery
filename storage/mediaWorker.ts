import { stat } from "node:fs/promises";
import { callConvex, type MediaProcessingClaim } from "./convex.js";
import {
  createThumbnail,
  extractExifJson,
} from "./media.js";
import { absoluteStoragePath } from "./paths.js";

export async function processMediaClaim(
  claim: Extract<MediaProcessingClaim, { kind: "ready" }>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const sourcePath = absoluteStoragePath(claim.storageKey);
    const before = await stat(sourcePath);
    assertExpectedUserFile(claim, before);
    const thumbnailKey = await createThumbnail({
      sourcePath,
      galleryKind: claim.galleryKind,
      storageKind: claim.storageKind,
      storageRoot: claim.storageRoot,
      sha256: claim.sha256,
      extension: claim.extension,
      mediaKind: claim.mediaKind,
      signal,
    });
    const exifJson = await extractExifJson(
      sourcePath,
      claim.mediaKind,
      signal,
    );
    const after = await stat(sourcePath);
    assertExpectedUserFile(claim, after);
    await callConvex("/internal/storage/complete-media-processing", {
      jobId: claim.jobId,
      thumbnailKey,
      exifJson,
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
