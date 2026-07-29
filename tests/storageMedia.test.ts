// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, test } from "vitest";

let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "upgallery-bmp-thumbnail-"));
  process.env.CONVEX_SITE_URL = "http://convex.invalid";
  process.env.STORAGE_INTERNAL_SECRET =
    "test-storage-secret-with-more-than-24-characters";
  process.env.STORAGE_ROOT = storageRoot;
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

test("BMP images generate JPEG thumbnails", async () => {
  const sourcePath = join(storageRoot, "source.bmp");
  await writeFile(sourcePath, twoByTwoBmp());
  const { createThumbnail, extractMediaMetadataJson } = await import(
    "../storage/media.js"
  );

  const sha256 = "b".repeat(64);
  const thumbnailKey = await createThumbnail({
    sourcePath,
    galleryKind: "uploader",
    storageKind: "shared",
    storageRoot: "bmp-test",
    sha256,
    extension: "bmp",
    mediaKind: "image",
  });

  expect(thumbnailKey).toBe(
    `protected/uploaders/bmp-test/bb/bb/${sha256}.thumb.jpg`,
  );
  const thumbnail = await readFile(join(storageRoot, thumbnailKey!));
  const metadata = await sharp(thumbnail).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBeLessThanOrEqual(480);
  expect(metadata.height).toBeLessThanOrEqual(360);
  const mediaMetadata = JSON.parse(
    (await extractMediaMetadataJson(sourcePath, "image"))!,
  );
  expect(mediaMetadata).toMatchObject({ Resolution: "2 × 2" });
});

test("image metadata includes auto-oriented resolution", async () => {
  const sourcePath = join(storageRoot, "resolution.jpg");
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 3,
      background: "#123456",
    },
  })
    .jpeg()
    .toFile(sourcePath);
  const { extractMediaMetadataJson } = await import("../storage/media.js");

  const json = await extractMediaMetadataJson(sourcePath, "image");

  expect(JSON.parse(json!)).toMatchObject({ Resolution: "12 × 8" });
});

test("QuickTime metadata includes display resolution and decoded location", async () => {
  const { videoMetadataFromFfprobe } = await import("../storage/media.js");

  const metadata = videoMetadataFromFfprobe({
    streams: [
      {
        codec_type: "video",
        codec_long_name: "H.265 / HEVC",
        width: 1920,
        height: 1080,
        avg_frame_rate: "49800/1661",
        side_data_list: [{ rotation: -90 }],
      },
      {
        codec_type: "audio",
        codec_long_name: "AAC",
      },
    ],
    format: {
      format_long_name: "QuickTime / MOV",
      duration: "2.768333",
      tags: {
        "com.apple.quicktime.location.ISO6709":
          "-37.8109+144.9990+021.322/",
        "com.apple.quicktime.location.accuracy.horizontal": "6.431634",
        "com.apple.quicktime.make": "Apple",
        "com.apple.quicktime.model": "iPhone 16",
        "com.apple.quicktime.software": "26.5.2",
        "com.apple.quicktime.creationdate": "2026-07-29T16:42:04+1000",
      },
    },
  });

  expect(metadata).toMatchObject({
    Resolution: "1080 × 1920",
    VideoCodec: "H.265 / HEVC",
    AudioCodec: "AAC",
    Format: "QuickTime / MOV",
    Duration: 2.768333,
    FrameRate: 29.98,
    Rotation: -90,
    DateTimeOriginal: "2026-07-29T16:42:04+1000",
    Make: "Apple",
    Model: "iPhone 16",
    Software: "26.5.2",
    GPSLatitude: -37.8109,
    GPSLongitude: 144.999,
    GPSAltitude: 21.322,
    GPSHorizontalAccuracy: 6.431634,
  });
});

function twoByTwoBmp(): Buffer {
  const width = 2;
  const height = 2;
  const rowSize = 8;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);

  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);

  const pixels = [
    0, 0, 255, 0, 255, 0, 0, 0,
    255, 0, 0, 255, 255, 255, 0, 0,
  ];
  Buffer.from(pixels).copy(buffer, 54);
  return buffer;
}
