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

test("user-backed generated thumbnails remain hidden and sharded", async () => {
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
    `public/users/alice/photos/.upgallery/thumbnails/ab/cd/${"abcd".padEnd(64, "0")}.thumb.jpg`,
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
    `public/users/alice/photos/.upgallery/previews/ab/cd/${"abcd".padEnd(64, "0")}.preview.jpg`,
  );
});
