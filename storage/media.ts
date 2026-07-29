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

const ffmpegImageExtensions = new Set(["bmp", "dib"]);

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
    if (
      input.mediaKind === "image" &&
      !ffmpegImageExtensions.has(input.extension.toLocaleLowerCase())
    ) {
      await sharp(input.sourcePath)
        .rotate()
        .resize(480, 360, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(temporaryPath);
    } else {
      await runFfmpeg(
        input.sourcePath,
        temporaryPath,
        input.mediaKind === "video",
        input.signal,
      );
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
  seekVideo: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...(seekVideo ? ["-ss", "00:00:01"] : []),
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

type MetadataValue = string | number;
type MediaMetadata = Record<string, MetadataValue>;

type FfprobeStream = {
  codec_long_name?: unknown;
  codec_name?: unknown;
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  side_data_list?: unknown;
};

export async function extractMediaMetadataJson(
  filePath: string,
  mediaKind: MediaKind,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (mediaKind !== "image" && mediaKind !== "video") {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    const metadata =
      mediaKind === "image"
        ? await extractImageMetadata(filePath, signal)
        : await extractVideoMetadata(filePath, signal);
    if (Object.keys(metadata).length === 0) {
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

async function extractImageMetadata(
  filePath: string,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  const image = await sharp(filePath).metadata().catch(() => undefined);
  signal?.throwIfAborted();
  const resolution =
    image === undefined
      ? displayResolution(firstVideoStream(await runFfprobe(filePath, signal)))
      : displayResolution({
          width: (image.autoOrient ?? image).width,
          height: (image.autoOrient ?? image).height,
        });
  const parsed: unknown = await exifr
    .parse(filePath, {
      pick: [
        "Make",
        "Model",
        "LensModel",
        "DateTimeOriginal",
        "ExposureTime",
        "FNumber",
        "ISO",
        "FocalLength",
        "latitude",
        "longitude",
        "GPSAltitude",
        "GPSAltitudeRef",
      ],
    })
    .catch(() => undefined);
  signal?.throwIfAborted();

  const exif = isRecord(parsed) ? parsed : {};
  const metadata: MediaMetadata = {};
  if (resolution !== undefined) metadata.Resolution = resolution;
  copyString(metadata, "Make", exif.Make);
  copyString(metadata, "Model", exif.Model);
  copyString(metadata, "LensModel", exif.LensModel);
  copyDate(metadata, "DateTimeOriginal", exif.DateTimeOriginal);
  copyNumber(metadata, "ExposureTime", exif.ExposureTime);
  copyNumber(metadata, "FNumber", exif.FNumber);
  copyNumber(metadata, "ISO", exif.ISO);
  copyNumber(metadata, "FocalLength", exif.FocalLength);
  copyNumber(metadata, "GPSLatitude", exif.latitude);
  copyNumber(metadata, "GPSLongitude", exif.longitude);
  const altitude = finiteNumber(exif.GPSAltitude);
  if (altitude !== undefined) {
    metadata.GPSAltitude =
      finiteNumber(exif.GPSAltitudeRef) === 1 ? -altitude : altitude;
  }
  return metadata;
}

async function extractVideoMetadata(
  filePath: string,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  const payload = await runFfprobe(filePath, signal);
  signal?.throwIfAborted();
  return videoMetadataFromFfprobe(payload);
}

export function videoMetadataFromFfprobe(payload: unknown): MediaMetadata {
  if (!isRecord(payload)) return {};
  const format = isRecord(payload.format) ? payload.format : {};
  const tags = isRecord(format.tags) ? format.tags : {};
  const streams = ffprobeStreams(payload);
  const video = firstVideoStream(payload);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const metadata: MediaMetadata = {};

  if (video !== undefined) {
    const rotation = videoRotation(video);
    const resolution = displayResolution(video);
    if (resolution !== undefined) metadata.Resolution = resolution;
    copyString(
      metadata,
      "VideoCodec",
      video.codec_long_name ?? video.codec_name,
    );
    const frameRate = parseFrameRate(video.avg_frame_rate);
    if (frameRate !== undefined) metadata.FrameRate = frameRate;
    if (rotation !== undefined && rotation !== 0) {
      metadata.Rotation = rotation;
    }
  }
  if (audio !== undefined) {
    copyString(
      metadata,
      "AudioCodec",
      audio.codec_long_name ?? audio.codec_name,
    );
  }
  copyString(metadata, "Format", format.format_long_name);
  copyNumber(metadata, "Duration", format.duration);
  copyString(
    metadata,
    "DateTimeOriginal",
    firstTag(
      tags,
      "com.apple.quicktime.creationdate",
      "creation_time",
    ),
  );
  copyString(metadata, "Make", firstTag(tags, "com.apple.quicktime.make"));
  copyString(metadata, "Model", firstTag(tags, "com.apple.quicktime.model"));
  copyString(
    metadata,
    "Software",
    firstTag(tags, "com.apple.quicktime.software", "encoder"),
  );

  const isoLocation = firstTag(
    tags,
    "com.apple.quicktime.location.ISO6709",
    "location",
    "location-eng",
  );
  const location =
    typeof isoLocation === "string"
      ? parseIso6709Location(isoLocation)
      : undefined;
  if (location !== undefined) {
    metadata.GPSLatitude = location.latitude;
    metadata.GPSLongitude = location.longitude;
    if (location.altitude !== undefined) {
      metadata.GPSAltitude = location.altitude;
    }
  }
  copyNumber(
    metadata,
    "GPSHorizontalAccuracy",
    firstTag(
      tags,
      "com.apple.quicktime.location.accuracy.horizontal",
    ),
  );
  return metadata;
}

export function parseIso6709Location(value: string):
  | { latitude: number; longitude: number; altitude?: number }
  | undefined {
  const match = value.trim().match(
    /^([+-](?:\d+(?:\.\d*)?|\.\d+))([+-](?:\d+(?:\.\d*)?|\.\d+))([+-](?:\d+(?:\.\d*)?|\.\d+))?(?:\/.*)?$/,
  );
  if (match === null) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  const altitude = match[3] === undefined ? undefined : Number(match[3]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (altitude !== undefined && !Number.isFinite(altitude))
  ) {
    return undefined;
  }
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude }),
  };
}

async function runFfprobe(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=codec_name,codec_long_name,codec_type,width,height,avg_frame_rate:stream_tags=creation_time:stream_side_data=rotation:format=format_long_name,duration:format_tags",
        sourcePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(stdout);
      else reject(error);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("ffprobe was aborted"),
      );
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffprobe exceeded ${config.ffmpegTimeoutMs}ms`));
    }, config.ffmpegTimeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(new Error("ffprobe output exceeded 1MB"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr || `ffprobe exited with ${code}`));
    });
  });
  return JSON.parse(output) as unknown;
}

function ffprobeStreams(payload: unknown): FfprobeStream[] {
  if (!isRecord(payload) || !Array.isArray(payload.streams)) return [];
  return payload.streams.filter(isRecord) as FfprobeStream[];
}

function firstVideoStream(payload: unknown): FfprobeStream | undefined {
  return ffprobeStreams(payload).find(
    (stream) => stream.codec_type === "video",
  );
}

function displayResolution(
  stream: Pick<FfprobeStream, "width" | "height" | "side_data_list"> | undefined,
): string | undefined {
  if (stream === undefined) return undefined;
  const width = finiteNumber(stream.width);
  const height = finiteNumber(stream.height);
  if (width === undefined || height === undefined) return undefined;
  const rotation = videoRotation(stream);
  const swapsAxes =
    rotation !== undefined && Math.abs(rotation) % 180 === 90;
  return swapsAxes ? `${height} × ${width}` : `${width} × ${height}`;
}

function videoRotation(stream: FfprobeStream): number | undefined {
  if (!Array.isArray(stream.side_data_list)) return undefined;
  for (const item of stream.side_data_list) {
    if (!isRecord(item)) continue;
    const rotation = finiteNumber(item.rotation);
    if (rotation !== undefined) return rotation;
  }
  return undefined;
}

function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return finiteNumber(value);
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return undefined;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}

function firstTag(
  tags: Record<string, unknown>,
  ...names: string[]
): unknown {
  for (const name of names) {
    if (tags[name] !== undefined) return tags[name];
  }
  return undefined;
}

function copyString(
  target: MediaMetadata,
  key: string,
  value: unknown,
): void {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    target[key] = value.toISOString();
  } else if (typeof value === "string" && value.trim() !== "") {
    target[key] = value;
  }
}

function copyDate(
  target: MediaMetadata,
  key: string,
  value: unknown,
): void {
  copyString(target, key, value);
}

function copyNumber(
  target: MediaMetadata,
  key: string,
  value: unknown,
): void {
  const number = finiteNumber(value);
  if (number !== undefined) target[key] = number;
}

function finiteNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configureMediaConcurrency(): void {
  sharp.concurrency(config.sharpConcurrency);
}
