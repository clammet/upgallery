/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  adjustFolderStats,
  adjustFolderStatsForEntries,
  createFolderStats,
  deleteFolderStats,
  readFolderStats,
  settleReadyEntry,
} from "./lib/folderStats";

const modules = import.meta.glob("./**/*.ts");

async function seedGalleryWithFolders(ctx: MutationCtx) {
  const galleryId = await ctx.db.insert("galleries", {
    name: "Stats",
    slug: "stats",
    kind: "image",
    storageKind: "shared",
    storageRoot: "stats",
    maxFileSize: 1024,
    uploaderAccess: "sso",
    theme: {},
  });
  const rootId = await ctx.db.insert("folders", {
    galleryId,
    ancestorIds: [],
    name: "Stats",
    slug: "",
    privacy: "public",
  });
  const childId = await ctx.db.insert("folders", {
    galleryId,
    parentId: rootId,
    ancestorIds: [rootId],
    name: "Child",
    slug: "child",
    privacy: "public",
  });
  await ctx.db.patch("galleries", galleryId, { rootFolderId: rootId });
  return { galleryId, rootId, childId };
}

async function seedEntries(
  ctx: MutationCtx,
  input: {
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
    count: number;
    size: number;
    state?: "ready" | "deleted";
    prefix: string;
  },
) {
  const profileId = await ctx.db.insert("profiles", {
    identityId: `anon:${input.prefix}`,
    isAnonymous: true,
    isSystemAdmin: false,
    lastSeenAt: 1,
  });
  for (let index = 0; index < input.count; index += 1) {
    const sha256 = `${input.prefix}${index}`.padStart(64, "0");
    await ctx.db.insert("entries", {
      galleryId: input.galleryId,
      folderId: input.folderId,
      ownerProfileId: profileId,
      name: `${input.prefix}-${index}.jpg`,
      nameKey: `${input.prefix}-${index}.jpg`,
      mimeType: "image/jpeg",
      extension: "jpg",
      mediaKind: "image",
      size: input.size,
      sha256,
      storageKind: "shared",
      storageKey: `public/shared/stats/${sha256}.jpg`,
      state: input.state ?? "ready",
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
}

describe("folderStats", () => {
  test("creates, adjusts, clamps, and deletes per-folder counters", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const { galleryId, rootId, childId } = await seedGalleryWithFolders(ctx);
      expect(await readFolderStats(ctx, rootId)).toBeNull();

      await createFolderStats(ctx, rootId, galleryId);
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 0,
        totalBytes: 0,
      });

      await adjustFolderStats(
        ctx,
        { folderId: rootId, galleryId },
        { items: 2, bytes: 20 },
      );
      // Deltas never drive the counters negative.
      await adjustFolderStats(
        ctx,
        { folderId: rootId, galleryId },
        { items: -5, bytes: -5 },
      );
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 0,
        totalBytes: 15,
      });

      // A folder without a row gets one from its first delta.
      await adjustFolderStats(
        ctx,
        { folderId: childId, galleryId },
        { items: 1, bytes: 7 },
      );
      expect(await readFolderStats(ctx, childId)).toEqual({
        itemCount: 1,
        totalBytes: 7,
      });
      // A zero delta is a no-op and never creates a row.
      await deleteFolderStats(ctx, childId);
      await adjustFolderStats(ctx, { folderId: childId, galleryId }, {});
      expect(await readFolderStats(ctx, childId)).toBeNull();

      // Exactly one row per folder.
      const rows = await ctx.db
        .query("folderStats")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
        .collect();
      expect(rows).toHaveLength(1);
    });
  });

  test("settleReadyEntry handles new, replaced, revived, and relocated entries", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const { galleryId, rootId, childId } = await seedGalleryWithFolders(ctx);
      await createFolderStats(ctx, rootId, galleryId);
      await createFolderStats(ctx, childId, galleryId);

      // New upload.
      await settleReadyEntry(ctx, { folderId: rootId, galleryId, size: 10 });
      // Replace in place: count unchanged, bytes follow the new size.
      await settleReadyEntry(ctx, {
        folderId: rootId,
        galleryId,
        size: 25,
        previous: { folderId: rootId, galleryId, size: 10 },
      });
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 1,
        totalBytes: 25,
      });

      // Revive a deleted entry: no previous ready state to subtract.
      await settleReadyEntry(ctx, { folderId: childId, galleryId, size: 4 });
      // Relocate a ready entry from root to child.
      await settleReadyEntry(ctx, {
        folderId: childId,
        galleryId,
        size: 25,
        previous: { folderId: rootId, galleryId, size: 25 },
      });
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 0,
        totalBytes: 0,
      });
      expect(await readFolderStats(ctx, childId)).toEqual({
        itemCount: 2,
        totalBytes: 29,
      });
    });
  });

  test("batch adjustments write each folder once", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const { galleryId, rootId, childId } = await seedGalleryWithFolders(ctx);
      await adjustFolderStatsForEntries(
        ctx,
        [
          { folderId: rootId, galleryId, size: 1 },
          { folderId: rootId, galleryId, size: 2 },
          { folderId: childId, galleryId, size: 3 },
        ],
        1,
      );
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 2,
        totalBytes: 3,
      });
      expect(await readFolderStats(ctx, childId)).toEqual({
        itemCount: 1,
        totalBytes: 3,
      });
      await adjustFolderStatsForEntries(
        ctx,
        [{ folderId: rootId, galleryId, size: 1 }],
        -1,
      );
      expect(await readFolderStats(ctx, rootId)).toEqual({
        itemCount: 1,
        totalBytes: 2,
      });
    });
  });

  test("backfill counts ready entries per folder, across batches, and overwrites stale rows", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const ids = await t.run(async (ctx) => {
        const seeded = await seedGalleryWithFolders(ctx);
        // More than one ENTRY_BATCH so the root folder spans invocations.
        await seedEntries(ctx, {
          galleryId: seeded.galleryId,
          folderId: seeded.rootId,
          count: 1_203,
          size: 2,
          prefix: "a",
        });
        await seedEntries(ctx, {
          galleryId: seeded.galleryId,
          folderId: seeded.rootId,
          count: 5,
          size: 100,
          state: "deleted",
          prefix: "d",
        });
        await seedEntries(ctx, {
          galleryId: seeded.galleryId,
          folderId: seeded.childId,
          count: 3,
          size: 7,
          prefix: "c",
        });
        // A stale row that the backfill must overwrite.
        await ctx.db.insert("folderStats", {
          folderId: seeded.childId,
          galleryId: seeded.galleryId,
          itemCount: 999,
          totalBytes: 999,
        });
        return seeded;
      });

      await t.mutation(internal.folderStats.backfill, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      await t.run(async (ctx) => {
        expect(await readFolderStats(ctx, ids.rootId)).toEqual({
          itemCount: 1_203,
          totalBytes: 2_406,
        });
        expect(await readFolderStats(ctx, ids.childId)).toEqual({
          itemCount: 3,
          totalBytes: 21,
        });
        const rows = await ctx.db
          .query("folderStats")
          .withIndex("by_galleryId", (q) => q.eq("galleryId", ids.galleryId))
          .collect();
        expect(rows).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
