// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  DEFAULT_STORAGE_ROOT_SENTINEL,
  findMissingStorageRootSentinels,
  parseMountRoots,
  parseSentinelName,
} from "../storage/storageRoots.js";

let storageRoot = "";

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "upgallery-roots-"));
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

test("parseMountRoots splits, trims, normalizes and dedupes", () => {
  expect(parseMountRoots(undefined)).toEqual([]);
  expect(parseMountRoots("")).toEqual([]);
  expect(parseMountRoots(" public/shared , public/users/, public/shared")).toEqual([
    "public/shared",
    "public/users",
  ]);
});

test("parseMountRoots rejects absolute paths and parent traversal", () => {
  expect(() => parseMountRoots("/data/media")).toThrow(/relative/);
  expect(() => parseMountRoots("public/../etc")).toThrow(/relative/);
});

test("parseSentinelName defaults and rejects paths", () => {
  expect(parseSentinelName(undefined)).toBe(DEFAULT_STORAGE_ROOT_SENTINEL);
  expect(parseSentinelName("  ")).toBe(DEFAULT_STORAGE_ROOT_SENTINEL);
  expect(parseSentinelName(".mounted")).toBe(".mounted");
  expect(() => parseSentinelName("a/b")).toThrow(/bare file name/);
});

test("every present sentinel satisfies the guard", async () => {
  for (const root of ["public/shared", "protected/uploaders"]) {
    await mkdir(join(storageRoot, root), { recursive: true });
    await writeFile(
      join(storageRoot, root, DEFAULT_STORAGE_ROOT_SENTINEL),
      "",
    );
  }
  expect(
    await findMissingStorageRootSentinels({
      storageRoot,
      mountRoots: ["public/shared", "protected/uploaders"],
      sentinelName: DEFAULT_STORAGE_ROOT_SENTINEL,
    }),
  ).toEqual([]);
});

test("a missing sentinel or an empty replacement directory is reported", async () => {
  await mkdir(join(storageRoot, "public/shared"), { recursive: true });
  await writeFile(
    join(storageRoot, "public/shared", DEFAULT_STORAGE_ROOT_SENTINEL),
    "",
  );
  // Docker created this one as an empty directory because the source was gone.
  await mkdir(join(storageRoot, "public/users"), { recursive: true });
  // Not a regular file must not count either.
  await mkdir(
    join(storageRoot, "derivatives/gallery", DEFAULT_STORAGE_ROOT_SENTINEL),
    { recursive: true },
  );
  expect(
    await findMissingStorageRootSentinels({
      storageRoot,
      mountRoots: ["public/shared", "public/users", "derivatives/gallery"],
      sentinelName: DEFAULT_STORAGE_ROOT_SENTINEL,
    }),
  ).toEqual([
    join(storageRoot, "public/users", DEFAULT_STORAGE_ROOT_SENTINEL),
    join(storageRoot, "derivatives/gallery", DEFAULT_STORAGE_ROOT_SENTINEL),
  ]);
});
