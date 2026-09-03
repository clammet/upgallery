// @vitest-environment node
import { beforeAll, expect, test } from "vitest";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "http://convex.invalid";
  process.env.STORAGE_INTERNAL_SECRET =
    "test-storage-secret-with-more-than-24-characters";
  process.env.STORAGE_ROOT = ".storage-test";
});

test("user-backed originals preserve folders and file names", async () => {
  const { buildStorageKey } = await import("../storage/paths.js");
  expect(
    buildStorageKey({
      galleryKind: "image",
      storageKind: "user",
      storageRoot: "alice/photos",
      folderSegments: ["2026", "July"],
      fileName: "beach sunset.jpg",
      sha256: "a".repeat(64),
      extension: "jpg",
    }),
  ).toBe("public/users/alice/photos/2026/July/beach sunset.jpg");
});

test("user-backed thumbnails use the central gallery derivative root", async () => {
  const { buildStorageKey } = await import("../storage/paths.js");
  expect(
    buildStorageKey({
      galleryKind: "image",
      storageKind: "user",
      storageRoot: "alice/photos",
      sha256: "abcd".padEnd(64, "0"),
      extension: "jpg",
      thumbnail: true,
    }),
  ).toBe(
    `derivatives/gallery/user/alice/photos/thumbnails/ab/cd/${"abcd".padEnd(64, "0")}.thumb.jpg`,
  );
});

test("generated previews use a separate full-resolution cache path", async () => {
  const { buildStorageKey } = await import("../storage/paths.js");
  expect(
    buildStorageKey({
      galleryKind: "image",
      storageKind: "user",
      storageRoot: "alice/photos",
      sha256: "abcd".padEnd(64, "0"),
      extension: "heic",
      preview: true,
    }),
  ).toBe(
    `derivatives/gallery/user/alice/photos/previews/ab/cd/${"abcd".padEnd(64, "0")}.preview.jpg`,
  );
});

test("shared gallery derivatives are separated from originals", async () => {
  const { buildStorageKey } = await import("../storage/paths.js");
  const sha256 = "ef01".padEnd(64, "0");
  expect(
    buildStorageKey({
      galleryKind: "image",
      storageKind: "shared",
      storageRoot: "family",
      sha256,
      extension: "jpg",
      thumbnail: true,
    }),
  ).toBe(`derivatives/gallery/shared/family/thumbnails/ef/01/${sha256}.thumb.jpg`);
});

test("uploader derivatives use the protected central up namespace", async () => {
  const { buildStorageKey, publicMediaPath } = await import("../storage/paths.js");
  const sha256 = "1234".padEnd(64, "0");
  const key = buildStorageKey({
    galleryKind: "uploader",
    storageKind: "shared",
    storageRoot: "support",
    sha256,
    extension: "heic",
    preview: true,
  });
  expect(key).toBe(
    `derivatives/up/support/previews/12/34/${sha256}.preview.jpg`,
  );
  expect(() => publicMediaPath(key)).toThrow(
    "Protected files do not have direct media URLs",
  );
});

test("gallery derivatives have direct immutable media URLs", async () => {
  const { publicMediaPath } = await import("../storage/paths.js");
  expect(
    publicMediaPath(
      "derivatives/gallery/shared/family/thumbnails/aa/bb/hash.thumb.jpg",
    ),
  ).toBe(
    "/media/derivatives/gallery/shared/family/thumbnails/aa/bb/hash.thumb.jpg",
  );
});

test("directly served storage is readable without exposing protected files", async () => {
  const { storageFileMode } = await import("../storage/paths.js");

  expect(storageFileMode("public/shared/family/aa/bb/photo.jpg")).toBe(0o644);
  expect(storageFileMode("public/users/alice/photos/photo.jpg")).toBe(0o644);
  expect(
    storageFileMode(
      "derivatives/gallery/shared/family/thumbnails/aa/bb/photo.thumb.jpg",
    ),
  ).toBe(0o644);
  expect(storageFileMode("protected/uploaders/drop/aa/bb/archive.zip")).toBe(
    0o600,
  );
  expect(
    storageFileMode("derivatives/up/drop/previews/aa/bb/photo.preview.jpg"),
  ).toBe(0o600);
});
