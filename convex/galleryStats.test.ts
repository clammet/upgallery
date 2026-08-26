/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { adjustGalleryStats, readGalleryStats } from "./lib/galleryStats";

const modules = import.meta.glob("./**/*.ts");

describe("galleryStats", () => {
  test("seeds from legacy gallery counters and then leaves the gallery document alone", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const galleryId = await ctx.db.insert("galleries", {
        name: "Legacy",
        slug: "legacy",
        kind: "image",
        storageKind: "shared",
        storageRoot: "legacy",
        maxFileSize: 1024,
        theme: {},
        itemCount: 3,
        totalBytes: 300,
      });
      const gallery = (await ctx.db.get("galleries", galleryId))!;
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 3,
        totalBytes: 300,
      });

      await adjustGalleryStats(ctx, gallery, { items: 1, bytes: 50 });
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 4,
        totalBytes: 350,
      });

      // Deltas never drive the counters negative.
      await adjustGalleryStats(ctx, gallery, { items: -10, bytes: -1000 });
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 0,
        totalBytes: 0,
      });

      await adjustGalleryStats(ctx, gallery, { bytes: 7 });
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 0,
        totalBytes: 7,
      });

      // Exactly one stats row, and the legacy fields are untouched.
      const rows = await ctx.db
        .query("galleryStats")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
        .collect();
      expect(rows).toHaveLength(1);
      expect(await ctx.db.get("galleries", galleryId)).toMatchObject({
        itemCount: 3,
        totalBytes: 300,
      });
    });
  });

  test("galleries without legacy counters start at zero", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const galleryId = await ctx.db.insert("galleries", {
        name: "Fresh",
        slug: "fresh",
        kind: "image",
        storageKind: "shared",
        storageRoot: "fresh",
        maxFileSize: 1024,
        theme: {},
      });
      const gallery = (await ctx.db.get("galleries", galleryId))!;
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 0,
        totalBytes: 0,
      });
      await adjustGalleryStats(ctx, gallery, { items: 2, bytes: 20 });
      expect(await readGalleryStats(ctx, gallery)).toEqual({
        itemCount: 2,
        totalBytes: 20,
      });
    });
  });
});
