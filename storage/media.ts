import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, extname } from "node:path";
import exifr from "exifr";
import { extension as extensionForMime, lookup as lookupMime } from "mime-types";
import sharp from "sharp";
import { config } from "./config.js";
import { absoluteStoragePath, buildStorageKey, sanitizeExtension } from "./paths.js";

export type MediaKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "archive"
  | "document"
  | "other";

export function classifyMedia(mimeType: string): MediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("text/")) return "text";
  if (
    mimeType.includes("zip") ||
    mimeType.includes("tar") ||
    mimeType.includes("rar") ||
    mimeType.includes("7z")
  ) {
    return "archive";
  }
  if (
    mimeType.includes("pdf") ||
    mimeType.includes("document") ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("presentation")
  ) {
    return "document";
  }
  return "other";
}

export function resolveMimeType(
  fileName: string,
  suppliedMimeType: string,
): string {
  if (
    suppliedMimeType.includes("/") &&
    suppliedMimeType.length <= 200 &&
    suppliedMimeType !== "application/octet-stream"
  ) {
    return suppliedMimeType;
  }
  return lookupMime(fileName) || "application/octet-stream";
}

export function resolveExtension(fileName: string, mimeType: string): string {
  const fromMime = extensionForMime(mimeType);
  return sanitizeExtension(
    fileName,
    typeof fromMime === "string" ? fromMime : undefined,
  );
}

export async function createThumbnail(input: {
  sourcePath: string;
  galleryKind: "image" | "uploader";
  storageKind: "shared" | "user";
  storageRoot: string;
  sha256: string;
  extension: string;
  mediaKind: MediaKind;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.mediaKind !== "image" && input.mediaKind !== "video") {
    return undefined;
  }
  const thumbnailKey = buildStorageKey({ ...input, thumbnail: true });
  const thumbnailPath = absoluteStoragePath(thumbnailKey);
  const temporaryPath = `${thumbnailPath}.partial-${randomUUID()}.jpg`;
  try {
    input.signal?.throwIfAborted();
    await mkdir(dirname(thumbnailPath), { recursive: true });
    if (input.mediaKind === "image") {
      await sharp(input.sourcePath)
        .rotate()
        .resize(480, 360, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(temporaryPath);
    } else {
      await runFfmpeg(input.sourcePath, temporaryPath, input.signal);
    }
    input.signal?.throwIfAborted();
    await rename(temporaryPath, thumbnailPath);
    return thumbnailKey;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(
      `Thumbnail generation failed for ${extname(input.sourcePath)}`,
      { cause: error },
    );
  }
}

async function runFfmpeg(
  sourcePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "00:00:01",
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:360:force_original_aspect_ratio=decrease",
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("ffmpeg was aborted"),
      );
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffmpeg exceeded ${config.ffmpegTimeoutMs}ms`));
    }, config.ffmpegTimeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

export async function extractExifJson(
  filePath: string,
  mediaKind: MediaKind,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (mediaKind !== "image") {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    const metadata: unknown = await exifr.parse(filePath, {
      pick: [
        "Make",
        "Model",
        "LensModel",
        "DateTimeOriginal",
        "ExposureTime",
        "FNumber",
        "ISO",
        "FocalLength",
        "ImageWidth",
        "ImageHeight",
        "GPSLatitude",
        "GPSLongitude",
      ],
    });
    if (metadata === undefined || metadata === null) {
      return undefined;
    }
    signal?.throwIfAborted();
    const json = JSON.stringify(metadata);
    return json.length <= 100_000 ? json : undefined;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : error;
    }
    return undefined;
  }
}

export function configureMediaConcurrency(): void {
  sharp.concurrency(config.sharpConcurrency);
}
