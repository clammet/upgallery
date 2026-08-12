// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, test } from "vitest";

let storageRoot: string;
let previousHeifThumbnailerCommand: string | undefined;
let previousFakeHeifImage: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "upgallery-bmp-thumbnail-"));
  process.env.CONVEX_SITE_URL = "http://convex.invalid";
  process.env.STORAGE_INTERNAL_SECRET =
    "test-storage-secret-with-more-than-24-characters";
  process.env.STORAGE_ROOT = storageRoot;
  previousHeifThumbnailerCommand =
    process.env.STORAGE_HEIF_THUMBNAILER_COMMAND;
  previousFakeHeifImage = process.env.UPGALLERY_FAKE_HEIF_IMAGE;
  const decodedImagePath = join(storageRoot, "fake-heif-decoded.png");
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 3,
      background: "#884422",
    },
  })
    .png()
    .toFile(decodedImagePath);
  const fakeThumbnailerPath = join(storageRoot, "fake-heif-thumbnailer");
  await writeFile(
    fakeThumbnailerPath,
    [
      "#!/bin/sh",
      'for output in "$@"; do',
      "  :",
      "done",
      'cp "$UPGALLERY_FAKE_HEIF_IMAGE" "$output"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  process.env.STORAGE_HEIF_THUMBNAILER_COMMAND = fakeThumbnailerPath;
  process.env.UPGALLERY_FAKE_HEIF_IMAGE = decodedImagePath;
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  if (previousHeifThumbnailerCommand === undefined) {
    delete process.env.STORAGE_HEIF_THUMBNAILER_COMMAND;
  } else {
    process.env.STORAGE_HEIF_THUMBNAILER_COMMAND =
      previousHeifThumbnailerCommand;
  }
  if (previousFakeHeifImage === undefined) {
    delete process.env.UPGALLERY_FAKE_HEIF_IMAGE;
  } else {
    process.env.UPGALLERY_FAKE_HEIF_IMAGE = previousFakeHeifImage;
  }
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
    `derivatives/up/bmp-test/thumbnails/bb/bb/${sha256}.thumb.jpg`,
  );
  const thumbnail = await readFile(join(storageRoot, thumbnailKey!));
  const metadata = await sharp(thumbnail).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBeLessThanOrEqual(512);
  expect(metadata.height).toBeLessThanOrEqual(512);
  const mediaMetadata = JSON.parse(
    (await extractMediaMetadataJson(sourcePath, "image"))!,
  );
  expect(mediaMetadata).toMatchObject({ Resolution: "2 × 2" });
});

test("image thumbnails fit inside a 512px square without changing aspect ratio", async () => {
  const sourcePath = join(storageRoot, "wide-source.jpg");
  await sharp({
    create: {
      width: 1200,
      height: 600,
      channels: 3,
      background: "#335577",
    },
  })
    .jpeg()
    .toFile(sourcePath);
  const { createThumbnail } = await import("../storage/media.js");
  const sha256 = "w".repeat(64);

  const thumbnailKey = await createThumbnail({
    sourcePath,
    galleryKind: "image",
    storageKind: "shared",
    storageRoot: "wide-test",
    sha256,
    extension: "jpg",
    mediaKind: "image",
  });

  await expect(
    sharp(join(storageRoot, thumbnailKey!)).metadata(),
  ).resolves.toMatchObject({
    format: "jpeg",
    width: 512,
    height: 256,
  });
});

test("HEIC images fall back to the libheif thumbnailer", async () => {
  const sourcePath = join(storageRoot, "source.heic");
  await writeFile(sourcePath, "fake HEIC input");
  const { createThumbnail } = await import("../storage/media.js");

  const sha256 = "h".repeat(64);
  const thumbnailKey = await createThumbnail({
    sourcePath,
    galleryKind: "uploader",
    storageKind: "shared",
    storageRoot: "heic-test",
    sha256,
    extension: "heic",
    mediaKind: "image",
  });

  expect(thumbnailKey).toBe(
    `derivatives/up/heic-test/thumbnails/hh/hh/${sha256}.thumb.jpg`,
  );
  const thumbnail = await readFile(join(storageRoot, thumbnailKey!));
  const metadata = await sharp(thumbnail).metadata();
  expect(metadata).toMatchObject({
    format: "jpeg",
    width: 12,
    height: 8,
  });
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

test("location removal strips GPS while preserving camera metadata", async () => {
  const sourcePath = join(storageRoot, "with-location.jpg");
  const outputPath = join(storageRoot, "without-location.jpg");
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 3,
      background: "#123456",
    },
  })
    .withExif({
      IFD0: {
        Make: "Acme",
        Model: "Pocket Camera",
        Orientation: "1",
      },
      IFD2: {
        DateTimeOriginal: "2026:07:29 10:00:00",
        LensModel: "Tiny Lens",
      },
      IFD3: {
        GPSLatitudeRef: "S",
        GPSLatitude: "37/1 48/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "144/1 59/1 0/1",
      },
    })
    .jpeg()
    .toFile(sourcePath);
  const { writeImageWithoutLocationData } = await import(
    "../storage/locationMetadata.js"
  );
  const { extractMediaMetadataJson } = await import("../storage/media.js");
  const { fileHasLocationMetadata } = await import("../src/lib/metadata.js");

  const before = JSON.parse(
    (await extractMediaMetadataJson(sourcePath, "image"))!,
  );
  const beforePixels = await sharp(sourcePath).raw().toBuffer();
  expect(before).toMatchObject({
    Make: "Acme",
    Model: "Pocket Camera",
    LensModel: "Tiny Lens",
    GPSLatitude: -37.8,
  });
  await expect(
    fileHasLocationMetadata(await readFile(sourcePath)),
  ).resolves.toBe(true);

  await writeImageWithoutLocationData(sourcePath, outputPath);

  const after = JSON.parse(
    (await extractMediaMetadataJson(outputPath, "image"))!,
  );
  expect(after).toMatchObject({
    Resolution: "12 × 8",
    Make: "Acme",
    Model: "Pocket Camera",
    LensModel: "Tiny Lens",
  });
  expect(after).not.toHaveProperty("GPSLatitude");
  expect(after).not.toHaveProperty("GPSLongitude");
  expect(after).not.toHaveProperty("GPSAltitude");
  await expect(
    fileHasLocationMetadata(await readFile(outputPath)),
  ).resolves.toBe(false);
  await expect(sharp(outputPath).raw().toBuffer()).resolves.toEqual(
    beforePixels,
  );
});

test("full-resolution previews preserve the source pixel dimensions", async () => {
  const sourcePath = join(storageRoot, "preview-source.jpg");
  await sharp({
    create: {
      width: 123,
      height: 77,
      channels: 3,
      background: "#224466",
    },
  })
    .jpeg()
    .toFile(sourcePath);
  const { createPreview } = await import("../storage/media.js");
  const sha256 = "c".repeat(64);

  const previewKey = await createPreview({
    sourcePath,
    galleryKind: "uploader",
    storageKind: "shared",
    storageRoot: "preview-test",
    sha256,
    extension: "jpg",
    mediaKind: "image",
  });

  expect(previewKey).toBe(
    `derivatives/up/preview-test/previews/cc/cc/${sha256}.preview.jpg`,
  );
  await expect(
    sharp(join(storageRoot, previewKey)).metadata(),
  ).resolves.toMatchObject({
    format: "jpeg",
    width: 123,
    height: 77,
  });
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
      bit_rate: "8000000",
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
    BitRate: 8000000,
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

test("audio metadata includes stream properties, tags, and bitrate", async () => {
  const { audioMetadataFromFfprobe } = await import("../storage/media.js");

  const metadata = audioMetadataFromFfprobe({
    streams: [
      {
        codec_type: "audio",
        codec_long_name: "PCM signed 16-bit little-endian",
        sample_rate: "44100",
        channels: 2,
        channel_layout: "stereo",
        bits_per_sample: 16,
        bit_rate: "1411200",
      },
    ],
    format: {
      format_long_name: "WAV / WAVE (Waveform Audio)",
      duration: "155.588571",
      bit_rate: "1411202",
      tags: {
        title: "Across the Dream",
        artist: "Test Artist",
        album: "Test Album",
      },
    },
  });

  expect(metadata).toEqual({
    AudioCodec: "PCM signed 16-bit little-endian",
    SampleRate: 44100,
    Channels: 2,
    ChannelLayout: "stereo",
    BitDepth: 16,
    Format: "WAV / WAVE (Waveform Audio)",
    Duration: 155.588571,
    BitRate: 1411202,
    Title: "Across the Dream",
    Artist: "Test Artist",
    Album: "Test Album",
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
