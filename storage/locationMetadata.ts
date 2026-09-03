import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import exifr from "exifr";
import sharp, { type Exif } from "sharp";
import type { MediaProcessingClaim } from "./convex.js";
import {
  absoluteStoragePath,
  buildStorageKey,
  storageDirectoryMode,
  storageFileMode,
} from "./paths.js";

const preservedIfd0Tags = new Set([
  "Artist",
  "Copyright",
  "DateTime",
  "ImageDescription",
  "Make",
  "Model",
  "Orientation",
  "Software",
]);

const preservedExifTags = new Set([
  "DateTimeDigitized",
  "DateTimeOriginal",
  "ExposureProgram",
  "ExposureTime",
  "Flash",
  "FNumber",
  "FocalLength",
  "ISOSpeedRatings",
  "LensMake",
  "LensModel",
  "MeteringMode",
  "WhiteBalance",
]);

export async function writeImageWithoutLocationData(
  sourcePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const exifInput = imageExifInput(sourcePath, metadata.exif);
  const gps = await exifr.gps(exifInput).catch(() => undefined);
  if (
    !isRecord(gps) ||
    typeof gps.latitude !== "number" ||
    typeof gps.longitude !== "number"
  ) {
    await copyFile(sourcePath, outputPath);
    return;
  }
  if (metadata.format === "jpeg") {
    await copyJpegWithoutGps(sourcePath, outputPath);
    return;
  }
  if (
    metadata.exif !== undefined &&
    (await copyContainerWithoutGps(
      sourcePath,
      outputPath,
      metadata.exif,
    ))
  ) {
    return;
  }
  await unlink(outputPath).catch(() => undefined);
  const exif = await preservedExif(exifInput);
  signal?.throwIfAborted();

  const animated =
    (metadata.format === "gif" || metadata.format === "webp") &&
    (metadata.pages ?? 1) > 1;
  let output = sharp(sourcePath, { animated })
    .keepIccProfile()
    .keepXmp()
    .withExif(exif);
  if (metadata.density !== undefined) {
    output = output.withDensity(metadata.density);
  }
  if (metadata.format === "heif") {
    output = output.heif({
      compression: metadata.compression === "av1" ? "av1" : "hevc",
    });
  } else if (metadata.format !== undefined) {
    output = output.toFormat(metadata.format);
  }
  await output.toFile(outputPath);
  signal?.throwIfAborted();
}

export async function rewriteStoredImageWithoutLocationData(
  claim: Extract<MediaProcessingClaim, { kind: "ready" }>,
  signal: AbortSignal,
): Promise<{
  storageKey: string;
  sha256: string;
  size: number;
  filesystemModifiedAt?: number;
  filesystemIdentity?: string;
}> {
  const sourcePath = absoluteStoragePath(claim.storageKey);
  const temporaryPath = `${sourcePath}.location-partial-${randomUUID()}`;
  try {
    await writeImageWithoutLocationData(sourcePath, temporaryPath, signal);
    const [sha256, temporaryMetadata] = await Promise.all([
      sha256File(temporaryPath, signal),
      stat(temporaryPath),
    ]);
    const storageKey =
      claim.galleryKind === "image" && claim.storageKind === "user"
        ? claim.storageKey
        : buildStorageKey({
            galleryKind: claim.galleryKind,
            storageKind: claim.storageKind,
            storageRoot: claim.storageRoot,
            sha256,
            extension: claim.extension,
          });
    const destinationPath = absoluteStoragePath(storageKey);
    await mkdir(dirname(destinationPath), {
      recursive: true,
      mode: storageDirectoryMode(storageKey),
    });

    if (destinationPath === sourcePath) {
      await rename(temporaryPath, destinationPath);
    } else {
      try {
        await access(destinationPath);
        await unlink(temporaryPath);
      } catch {
        await rename(temporaryPath, destinationPath);
      }
    }

    await chmod(destinationPath, storageFileMode(storageKey));

    const installed = await stat(destinationPath);
    return {
      storageKey,
      sha256,
      size: temporaryMetadata.size,
      filesystemModifiedAt:
        claim.storageKind === "user" ? installed.mtimeMs : undefined,
      filesystemIdentity:
        claim.storageKind === "user"
          ? `${installed.dev}:${installed.ino}`
          : undefined,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    const onAbort = () => {
      stream.destroy(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Image processing was aborted"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
    stream.once("close", () =>
      signal?.removeEventListener("abort", onAbort),
    );
  });
}

async function preservedExif(
  input: string | Uint8Array,
): Promise<Exif> {
  const parsed: unknown = await exifr
    .parse(input, {
      ifd0: {},
      ifd1: false,
      exif: true,
      gps: false,
      interop: false,
      xmp: false,
      iptc: false,
      icc: false,
      mergeOutput: false,
      translateKeys: true,
      translateValues: false,
      reviveValues: true,
    })
    .catch(() => undefined);
  if (!isRecord(parsed)) return {};

  const ifd0 = filteredExifDirectory(parsed.ifd0, preservedIfd0Tags);
  const ifd2 = filteredExifDirectory(parsed.exif, preservedExifTags);
  return {
    ...(Object.keys(ifd0).length === 0 ? {} : { IFD0: ifd0 }),
    ...(Object.keys(ifd2).length === 0 ? {} : { IFD2: ifd2 }),
  };
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

function filteredExifDirectory(
  input: unknown,
  allowedTags: Set<string>,
): Record<string, string> {
  if (!isRecord(input)) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowedTags.has(key)) continue;
    const formatted = exifValue(value);
    if (formatted !== undefined) output[key] = formatted;
  }
  return output;
}

function exifValue(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return [
      value.getUTCFullYear().toString().padStart(4, "0"),
      (value.getUTCMonth() + 1).toString().padStart(2, "0"),
      value.getUTCDate().toString().padStart(2, "0"),
    ].join(":") +
      ` ${value.getUTCHours().toString().padStart(2, "0")}:` +
      `${value.getUTCMinutes().toString().padStart(2, "0")}:` +
      value.getUTCSeconds().toString().padStart(2, "0");
  }
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function copyJpegWithoutGps(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  await copyFile(sourcePath, outputPath);
  const file = await open(outputPath, "r+");
  try {
    const metadata = await file.stat();
    const length = Math.min(metadata.size, 1024 * 1024);
    const prefix = Buffer.alloc(length);
    const { bytesRead } = await file.read(prefix, 0, length, 0);
    const visiblePrefix = prefix.subarray(0, bytesRead);
    if (scrubJpegGps(visiblePrefix)) {
      await file.write(visiblePrefix, 0, visiblePrefix.length, 0);
    }
  } finally {
    await file.close();
  }
}

async function copyContainerWithoutGps(
  sourcePath: string,
  outputPath: string,
  exif: Uint8Array,
): Promise<boolean> {
  if (exif.length < 16) return false;
  await copyFile(sourcePath, outputPath);
  const file = await open(outputPath, "r+");
  try {
    const needle = Buffer.from(exif.subarray(0, Math.min(32, exif.length)));
    const exifOffset = await findBytes(file, needle);
    if (exifOffset === null) return false;
    const block = Buffer.alloc(exif.length);
    const { bytesRead } = await file.read(
      block,
      0,
      block.length,
      exifOffset,
    );
    if (bytesRead !== block.length) return false;
    const tiffOffset =
      block.subarray(0, 6).equals(Buffer.from("Exif\0\0", "binary"))
        ? 6
        : 0;
    if (!scrubTiffGps(block, tiffOffset, block.length)) return false;
    await file.write(block, 0, block.length, exifOffset);
    return true;
  } finally {
    await file.close();
  }
}

async function findBytes(
  file: Awaited<ReturnType<typeof open>>,
  needle: Buffer,
): Promise<number | null> {
  const chunkSize = 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize + needle.length - 1);
  let carryLength = 0;
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(
      chunk,
      carryLength,
      chunkSize,
      position,
    );
    if (bytesRead === 0) return null;
    const available = carryLength + bytesRead;
    const match = chunk.subarray(0, available).indexOf(needle);
    if (match >= 0) return position - carryLength + match;
    carryLength = Math.min(needle.length - 1, available);
    chunk.copy(chunk, 0, available - carryLength, available);
    position += bytesRead;
  }
}

function scrubJpegGps(jpeg: Buffer): boolean {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
  let changed = false;
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    while (jpeg[offset] === 0xff && jpeg[offset + 1] === 0xff) offset += 1;
    if (jpeg[offset] !== 0xff || offset + 4 > jpeg.length) break;
    const marker = jpeg[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const segmentLength = jpeg.readUInt16BE(offset + 2);
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentLength < 2 || segmentEnd > jpeg.length) break;
    const payloadOffset = offset + 4;
    if (
      marker === 0xe1 &&
      segmentLength >= 8 &&
      jpeg.subarray(payloadOffset, payloadOffset + 6).equals(
        Buffer.from("Exif\0\0", "binary"),
      )
    ) {
      changed =
        scrubTiffGps(jpeg, payloadOffset + 6, segmentEnd) || changed;
    }
    offset = segmentEnd;
  }
  return changed;
}

function scrubTiffGps(
  buffer: Buffer,
  tiffOffset: number,
  tiffEnd: number,
): boolean {
  if (tiffOffset + 8 > tiffEnd) return false;
  const byteOrder = buffer.toString("ascii", tiffOffset, tiffOffset + 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return false;
  const readUint16 = (offset: number) =>
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readUint32 = (offset: number) =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const writeUint16 = (value: number, offset: number) =>
    littleEndian
      ? buffer.writeUInt16LE(value, offset)
      : buffer.writeUInt16BE(value, offset);
  if (readUint16(tiffOffset + 2) !== 42) return false;
  const ifd0Offset = tiffOffset + readUint32(tiffOffset + 4);
  if (ifd0Offset + 2 > tiffEnd) return false;
  const entryCount = readUint16(ifd0Offset);
  const entriesOffset = ifd0Offset + 2;
  const entriesEnd = entriesOffset + entryCount * 12;
  if (entriesEnd + 4 > tiffEnd) return false;

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    if (readUint16(entryOffset) !== 0x8825) continue;
    const gpsOffset = tiffOffset + readUint32(entryOffset + 8);
    scrubGpsDirectory(
      buffer,
      gpsOffset,
      tiffOffset,
      tiffEnd,
      littleEndian,
    );
    buffer.copy(
      buffer,
      entryOffset,
      entryOffset + 12,
      entriesEnd + 4,
    );
    buffer.fill(0, entriesEnd - 8, entriesEnd + 4);
    writeUint16(entryCount - 1, ifd0Offset);
    return true;
  }
  return false;
}

function scrubGpsDirectory(
  buffer: Buffer,
  gpsOffset: number,
  tiffOffset: number,
  tiffEnd: number,
  littleEndian: boolean,
): void {
  if (gpsOffset + 2 > tiffEnd) return;
  const readUint16 = (offset: number) =>
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readUint32 = (offset: number) =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const entryCount = readUint16(gpsOffset);
  const entriesOffset = gpsOffset + 2;
  const entriesEnd = entriesOffset + entryCount * 12;
  if (entriesEnd + 4 > tiffEnd) return;
  const typeSizes: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    7: 1,
    9: 4,
    10: 8,
  };
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    const valueSize =
      (typeSizes[readUint16(entryOffset + 2)] ?? 0) *
      readUint32(entryOffset + 4);
    if (valueSize > 4) {
      const valueOffset = tiffOffset + readUint32(entryOffset + 8);
      if (valueOffset >= tiffOffset && valueOffset + valueSize <= tiffEnd) {
        buffer.fill(0, valueOffset, valueOffset + valueSize);
      }
    }
  }
  buffer.fill(0, gpsOffset, entriesEnd + 4);
}
