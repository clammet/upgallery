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

  test("selects a gallery's public route for an internal slug URL", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const galleryId = await ctx.db.insert("galleries", {
        name: "Gallery",
        slug: "gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "gallery",
        maxFileSize: 1024,
        theme: {},
      });
      await ctx.db.insert("galleryHosts", {
        galleryId,
        host: "photos.example.com",
        rootPath: "/gallery",
      });
      await ctx.db.insert("galleryHosts", {
        galleryId,
        host: "alternate.example.com",
        rootPath: "/album",
      });
    });

    await expect(
      t.query(api.galleries.canonicalRouteBySlug, {
        slug: "gallery",
        currentHost: "photos.example.com:4173",
      }),
    ).resolves.toEqual({
      host: "photos.example.com",
      rootPath: "/gallery",
    });
    await expect(
      t.query(api.galleries.canonicalRouteBySlug, {
        slug: "gallery",
        currentHost: "app.example.com",
      }),
    ).resolves.toEqual({
      host: "photos.example.com",
      rootPath: "/gallery",
    });
  });
});

test("host resolution returns live route boundaries and keeps access authoritative", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const galleryId = await ctx.db.insert("galleries", {
      name: "Public", slug: "public", kind: "image", storageKind: "shared",
      storageRoot: "public", maxFileSize: 1024, theme: {},
    });
    const rootId = await ctx.db.insert("folders", {
      galleryId, name: "Public", slug: "", ancestorIds: [], accessPolicy: "public", discoverability: "listed",
    });
    await ctx.db.patch("galleries", galleryId, { rootFolderId: rootId });
    const nestedId = await ctx.db.insert("galleries", {
      name: "Restricted", slug: "restricted", kind: "image", storageKind: "shared",
      storageRoot: "restricted", maxFileSize: 1024, theme: {},
    });
    const restrictedRootId = await ctx.db.insert("folders", {
      galleryId: nestedId, name: "Restricted", slug: "", ancestorIds: [], accessPolicy: "restricted", discoverability: "listed",
    });
    await ctx.db.patch("galleries", nestedId, { rootFolderId: restrictedRootId });
    await ctx.db.insert("galleryHosts", { galleryId, host: "photos.example.com", rootPath: "/gallery" });
    const nestedRouteId = await ctx.db.insert("galleryHosts", { galleryId: nestedId, host: "photos.example.com", rootPath: "/gallery/private" });
    return { galleryId, nestedId, rootId, nestedRouteId };
  });
  const args = { host: "photos.example.com:5173", path: "/gallery/trip/day1" };
  const resolved = await t.query(api.galleries.resolveByHost, args);
  expect(resolved?.gallery._id).toBe(ids.galleryId);
  expect(resolved?.hostRouteRoots).toEqual(["/gallery", "/gallery/private"]);
  expect(resolved?.access.canView).toBe(true);
  const restricted = await t.query(api.galleries.resolveByHost, { ...args, path: "/gallery/private/album" });
  expect(restricted?.gallery._id).toBe(ids.nestedId);
  expect(restricted?.access.canView).toBe(false);
  await t.run(async ctx => {
    await ctx.db.delete("galleryHosts", ids.nestedRouteId);
    await ctx.db.patch("folders", ids.rootId, { accessPolicy: "restricted" });
  });
  const changed = await t.query(api.galleries.resolveByHost, args);
  expect(changed?.hostRouteRoots).toEqual(["/gallery"]);
  expect(changed?.access.canView).toBe(false);
});
