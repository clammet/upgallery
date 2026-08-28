/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("friendly folder route resolution", () => {
  test("resolves exact nested names and rejects inaccessible or missing paths", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const galleryId = await ctx.db.insert("galleries", {
        name: "Gallery",
        slug: "gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "gallery",
        maxFileSize: 1024,
        anonymousRole: "viewer",
        theme: {},
      });
      const rootId = await ctx.db.insert("folders", {
        galleryId,
        ancestorIds: [],
        name: "Gallery",
        slug: "",
        accessPolicy: "public",
        discoverability: "listed",
      });
      const pixId = await ctx.db.insert("folders", {
        galleryId,
        parentId: rootId,
        ancestorIds: [rootId],
        name: "pix",
        slug: "pix",
        accessPolicy: "inherit",
        discoverability: "listed",
      });
      const firewurxId = await ctx.db.insert("folders", {
        galleryId,
        parentId: pixId,
        ancestorIds: [rootId, pixId],
        name: "Firewurx",
        slug: "firewurx",
        accessPolicy: "inherit",
        discoverability: "listed",
      });
      await ctx.db.insert("folders", {
        galleryId,
        parentId: rootId,
        ancestorIds: [rootId],
        name: "Private",
        slug: "private",
        accessPolicy: "restricted",
        discoverability: "listed",
      });
      await ctx.db.patch("galleries", galleryId, { rootFolderId: rootId });
      return { galleryId, firewurxId };
    });

    await expect(
      t.query(api.folders.resolvePath, {
        galleryId: seeded.galleryId,
        names: ["pix", "Firewurx"],
      }),
    ).resolves.toBe(seeded.firewurxId);
    await expect(
      t.query(api.folders.resolvePath, {
        galleryId: seeded.galleryId,
        names: ["pix", "firewurx"],
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.folders.resolvePath, {
        galleryId: seeded.galleryId,
        names: ["Private"],
      }),
    ).resolves.toBeNull();
  });
});
