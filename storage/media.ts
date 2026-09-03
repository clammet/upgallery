import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, extname } from "node:path";
import exifr from "exifr";
import { extension as extensionForMime, lookup as lookupMime } from "mime-types";
import sharp from "sharp";
import { config } from "./config.js";
import {
  absoluteStoragePath,
  buildStorageKey,
  sanitizeExtension,
  storageFileMode,
} from "./paths.js";

export type MediaKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "archive"
  | "document"
  | "other";

const ffmpegImageExtensions = new Set(["bmp", "dib"]);
const heifImageExtensions = new Set([
  "heic",
  "heics",
  "heif",
  "heifs",
  "hif",
]);

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
  const decodedHeifPath = `${thumbnailPath}.partial-${randomUUID()}.png`;
  try {
    input.signal?.throwIfAborted();
    await mkdir(dirname(thumbnailPath), { recursive: true });
    if (
      input.mediaKind === "image" &&
      !ffmpegImageExtensions.has(input.extension.toLocaleLowerCase())
    ) {
      try {
        await writeSharpThumbnail(input.sourcePath, temporaryPath);
      } catch (error) {
        if (
          !heifImageExtensions.has(input.extension.toLocaleLowerCase()) &&
          !(await isHeifContainer(input.sourcePath))
        ) {
          throw error;
        }
        await runHeifThumbnailer(
          input.sourcePath,
          decodedHeifPath,
          input.signal,
        );
        await writeSharpThumbnail(decodedHeifPath, temporaryPath);
      }
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
    await chmod(thumbnailPath, storageFileMode(thumbnailKey));
    return thumbnailKey;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Thumbnail generation failed for ${extname(input.sourcePath)}${detail}`,
      { cause: error },
    );
  } finally {
    await unlink(decodedHeifPath).catch(() => undefined);
  }
}

export async function createPreview(input: {
  sourcePath: string;
  galleryKind: "image" | "uploader";
  storageKind: "shared" | "user";
  storageRoot: string;
  sha256: string;
  extension: string;
  mediaKind: MediaKind;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.mediaKind !== "image") {
    throw new Error("Full-resolution previews are only supported for images");
  }
  const previewKey = buildStorageKey({ ...input, preview: true });
  const previewPath = absoluteStoragePath(previewKey);
  const temporaryPath = `${previewPath}.partial-${randomUUID()}.jpg`;
  try {
    input.signal?.throwIfAborted();
    await mkdir(dirname(previewPath), { recursive: true });
    await sharp(input.sourcePath)
      .rotate()
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(temporaryPath);
    input.signal?.throwIfAborted();
    await rename(temporaryPath, previewPath);
    await chmod(previewPath, storageFileMode(previewKey));
    return previewKey;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Preview generation failed for ${extname(input.sourcePath)}${detail}`,
      { cause: error },
    );
  }
}

async function isHeifContainer(sourcePath: string): Promise<boolean> {
  const metadata = await sharp(sourcePath).metadata().catch(() => undefined);
  return metadata?.format === "heif";
}

async function writeSharpThumbnail(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  await sharp(sourcePath)
    .rotate()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(outputPath);
}

async function runHeifThumbnailer(
  sourcePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runMediaCommand(
    config.heifThumbnailerCommand,
    ["-s", "512", "-p", sourcePath, outputPath],
    "HEIF thumbnailer",
    signal,
  );
}

async function runFfmpeg(
  sourcePath: string,
  outputPath: string,
  seekVideo: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await runMediaCommand(
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
      "scale=512:512:force_original_aspect_ratio=decrease",
      "-y",
      outputPath,
    ],
    "ffmpeg",
    signal,
  );
}

async function runMediaCommand(
  command: string,
  args: string[],
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
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
          : new Error(`${label} was aborted`),
      );
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${label} exceeded ${config.ffmpegTimeoutMs}ms`));
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
      else finish(new Error(stderr || `${label} exited with ${code}`));
    });
  });
}

type MetadataValue = string | number;
type MediaMetadata = Record<string, MetadataValue>;

type FfprobeStream = {
  bit_rate?: unknown;
  bits_per_raw_sample?: unknown;
  bits_per_sample?: unknown;
  channel_layout?: unknown;
  channels?: unknown;
  codec_long_name?: unknown;
  codec_name?: unknown;
  codec_type?: unknown;
  sample_rate?: unknown;
  tags?: unknown;
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
  if (
    mediaKind !== "image" &&
    mediaKind !== "video" &&
    mediaKind !== "audio"
  ) {
    return undefined;
  }
  try {
    signal?.throwIfAborted();
    const metadata =
      mediaKind === "image"
        ? await extractImageMetadata(filePath, signal)
        : await extractFfprobeMetadata(filePath, signal);
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
  const exifInput = imageExifInput(filePath, image?.exif);
  const [parsed, parsedGps] = await Promise.all([
    exifr
      .parse(exifInput, {
        pick: [
          "Make",
          "Model",
          "Software",
          "LensModel",
          "DateTimeOriginal",
          "ExposureTime",
          "FNumber",
          "ISO",
          "FocalLength",
          "GPSAltitude",
          "GPSAltitudeRef",
          "GPSHPositioningError",
        ],
      })
      .catch(() => undefined),
    exifr.gps(exifInput).catch(() => undefined),
  ]);
  signal?.throwIfAborted();

  const exif = isRecord(parsed) ? parsed : {};
  const metadata: MediaMetadata = {};
  if (resolution !== undefined) metadata.Resolution = resolution;
  copyString(metadata, "Make", exif.Make);
  copyString(metadata, "Model", exif.Model);
  copyString(metadata, "Software", exif.Software);
  copyString(metadata, "LensModel", exif.LensModel);
  copyDate(metadata, "DateTimeOriginal", exif.DateTimeOriginal);
  copyNumber(metadata, "ExposureTime", exif.ExposureTime);
  copyNumber(metadata, "FNumber", exif.FNumber);
  copyNumber(metadata, "ISO", exif.ISO);
  copyNumber(metadata, "FocalLength", exif.FocalLength);
  const gps: Record<string, unknown> = isRecord(parsedGps) ? parsedGps : {};
  copyNumber(metadata, "GPSLatitude", gps.latitude);
  copyNumber(metadata, "GPSLongitude", gps.longitude);
  const altitude = finiteNumber(exif.GPSAltitude);
  if (altitude !== undefined) {
    metadata.GPSAltitude =
      finiteNumber(exif.GPSAltitudeRef) === 1 ? -altitude : altitude;
  }
  copyNumber(
    metadata,
    "GPSHorizontalAccuracy",
    exif.GPSHPositioningError,
  );
  return metadata;
}

function imageExifInput(
  filePath: string,
  exif: Uint8Array | undefined,
): string | Uint8Array {
  if (exif === undefined) return filePath;
  if (
    exif.length >= 8 &&
    exif[0] === 0x45 &&
    exif[1] === 0x78 &&
    exif[2] === 0x69 &&
    exif[3] === 0x66 &&
    exif[4] === 0 &&
    exif[5] === 0
  ) {
    return exif.subarray(6);
  }
  if (
    exif.length >= 8 &&
    ((exif[0] === 0x49 && exif[1] === 0x49) ||
      (exif[0] === 0x4d && exif[1] === 0x4d))
  ) {
    return exif;
  }
  return filePath;
}

async function extractFfprobeMetadata(
  filePath: string,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  const payload = await runFfprobe(filePath, signal);
  signal?.throwIfAborted();
  return mediaMetadataFromFfprobe(payload);
}

export function videoMetadataFromFfprobe(payload: unknown): MediaMetadata {
  return mediaMetadataFromFfprobe(payload);
}

export function audioMetadataFromFfprobe(payload: unknown): MediaMetadata {
  return mediaMetadataFromFfprobe(payload);
}

function mediaMetadataFromFfprobe(payload: unknown): MediaMetadata {
  if (!isRecord(payload)) return {};
  const format = isRecord(payload.format) ? payload.format : {};
  const tags = isRecord(format.tags) ? format.tags : {};
  const streams = ffprobeStreams(payload);
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const subtitles = streams.filter(
    (stream) => stream.codec_type === "subtitle",
  );
  const metadata: MediaMetadata = {};

  for (const [index, video] of videos.entries()) {
    const prefix = streamPrefix("Video", index, videos.length);
    const rotation = videoRotation(video);
    const resolution = displayResolution(video);
    if (resolution !== undefined) metadata[`${prefix}Resolution`] = resolution;
    copyString(
      metadata,
      `${prefix}Codec`,
      video.codec_long_name ?? video.codec_name,
    );
    copyString(metadata, `${prefix}Language`, streamLanguage(video));
    copyNumber(metadata, `${prefix}BitRate`, streamBitRate(video));
    const frameRate = parseFrameRate(video.avg_frame_rate);
    if (frameRate !== undefined) metadata[`${prefix}FrameRate`] = frameRate;
    copyNumber(metadata, `${prefix}BitDepth`, streamBitDepth(video));
    if (rotation !== undefined && rotation !== 0) {
      metadata[`${prefix}Rotation`] = rotation;
    }
  }
  for (const [index, audio] of audios.entries()) {
    const prefix = streamPrefix("Audio", index, audios.length);
    copyString(
      metadata,
      `${prefix}Codec`,
      audio.codec_long_name ?? audio.codec_name,
    );
    copyString(metadata, `${prefix}Language`, streamLanguage(audio));
    copyNumber(metadata, `${prefix}BitRate`, streamBitRate(audio));
    copyNumber(metadata, `${prefix}SampleRate`, audio.sample_rate);
    const channels = audioChannelDescription(audio);
    if (channels !== undefined) metadata[`${prefix}Channels`] = channels;
    copyNumber(metadata, `${prefix}BitDepth`, streamBitDepth(audio));
  }
  const subtitleLanguages = [
    ...new Set(
      subtitles.map((stream) => streamLanguage(stream) ?? "und"),
    ),
  ];
  if (subtitleLanguages.length > 0) {
    metadata.Subtitles = subtitleLanguages.join(", ");
  }
  copyString(metadata, "Format", format.format_long_name);
  copyNumber(metadata, "Duration", format.duration);
  copyString(metadata, "Title", firstTag(tags, "title", "TITLE"));
  copyString(metadata, "Artist", firstTag(tags, "artist", "ARTIST"));
  copyString(metadata, "Album", firstTag(tags, "album", "ALBUM"));
  copyString(
    metadata,
    "AlbumArtist",
    firstTag(tags, "album_artist", "ALBUMARTIST", "ALBUM_ARTIST"),
  );
  copyString(metadata, "Genre", firstTag(tags, "genre", "GENRE"));
  copyString(metadata, "Track", firstTag(tags, "track", "TRACK"));
  copyString(metadata, "Disc", firstTag(tags, "disc", "DISC"));
  copyString(metadata, "Date", firstTag(tags, "date", "DATE", "year", "YEAR"));
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
        "stream=codec_name,codec_long_name,codec_type,width,height,avg_frame_rate,sample_rate,channels,channel_layout,bits_per_sample,bits_per_raw_sample,bit_rate:stream_tags:stream_side_data=rotation:format=format_long_name,duration:format_tags",
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

function streamBitRate(stream: FfprobeStream): number | undefined {
  const tags = isRecord(stream.tags) ? stream.tags : {};
  const bitRate = finiteNumber(
    stream.bit_rate ?? firstTag(tags, "BPS", "BPS-eng", "bps"),
  );
  return bitRate !== undefined && bitRate > 0 ? bitRate : undefined;
}

function streamBitDepth(stream: FfprobeStream): number | undefined {
  const bitDepth = finiteNumber(
    stream.bits_per_raw_sample ?? stream.bits_per_sample,
  );
  return bitDepth !== undefined && bitDepth > 0 ? bitDepth : undefined;
}

function audioChannelDescription(
  stream: FfprobeStream,
): string | number | undefined {
  const channels = finiteNumber(stream.channels);
  const layout =
    typeof stream.channel_layout === "string" &&
      stream.channel_layout.trim() !== ""
      ? stream.channel_layout.trim()
      : undefined;
  if (channels !== undefined && layout !== undefined) {
    return `${channels} (${layout})`;
  }
  return channels ?? layout;
}

function streamPrefix(
  kind: "Video" | "Audio",
  index: number,
  count: number,
): string {
  return count === 1 ? kind : `${kind}${index + 1}`;
}

function streamLanguage(stream: FfprobeStream): string | undefined {
  const tags = isRecord(stream.tags) ? stream.tags : {};
  const language = firstTag(tags, "language", "LANGUAGE");
  return typeof language === "string" && language.trim() !== ""
    ? language.trim()
    : undefined;
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
