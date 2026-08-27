/// <reference types="vite/client" />
import { runToCompletion } from "@convex-dev/migrations";
import migrationsComponent from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { components, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("folder access migration translates legacy privacy without overwriting new fields", async () => {
  const t = convexTest(schema, modules);
  migrationsComponent.register(t);

  await t.run(async (ctx) => {
    const galleryId = await ctx.db.insert("galleries", {
      name: "Migration gallery",
      slug: "migration-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "migration-gallery",
      maxFileSize: 1024,
      theme: {},
    });
    const rootFolderId = await ctx.db.insert("folders", {
      galleryId,
      ancestorIds: [],
      name: "Migration gallery",
      slug: "",
      privacy: "private",
    });
    const legacyPublicId = await ctx.db.insert("folders", {
      galleryId,
      parentId: rootFolderId,
      ancestorIds: [rootFolderId],
      name: "Public",
      slug: "public",
      privacy: "public",
    });
    const legacyUnlistedId = await ctx.db.insert("folders", {
      galleryId,
      parentId: rootFolderId,
      ancestorIds: [rootFolderId],
      name: "Unlisted",
      slug: "unlisted",
      privacy: "unlisted",
    });
    const legacyPrivateId = await ctx.db.insert("folders", {
      galleryId,
      parentId: rootFolderId,
      ancestorIds: [rootFolderId],
      name: "Private",
      slug: "private",
      privacy: "private",
    });
    const newFieldsId = await ctx.db.insert("folders", {
      galleryId,
      parentId: rootFolderId,
      ancestorIds: [rootFolderId],
      name: "Already migrated",
      slug: "already-migrated",
      accessPolicy: "restricted",
      discoverability: "unlisted",
    });
    const actorProfileId = await ctx.db.insert("profiles", {
      identityId: "migration-actor",
      isAnonymous: false,
      isSystemAdmin: true,
      lastSeenAt: 0,
    });
    const legacyOperationId = await ctx.db.insert("filesystemOperations", {
      galleryId,
      parentId: rootFolderId,
      actorProfileId,
      kind: "mkdir",
      name: "Pending unlisted folder",
      privacy: "unlisted",
      tokenHash: "hash",
      expiresAt: 1,
      state: "pending",
    });

    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.migrateFolderAccess,
    );
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.migrateFilesystemOperationAccess,
    );

    expect(await ctx.db.get("folders", rootFolderId)).toMatchObject({
      accessPolicy: "inherit",
      discoverability: "listed",
    });
    expect(await ctx.db.get("folders", legacyPublicId)).toMatchObject({
      accessPolicy: "public",
      discoverability: "listed",
    });
    expect(await ctx.db.get("folders", legacyUnlistedId)).toMatchObject({
      accessPolicy: "public",
      discoverability: "unlisted",
    });
    expect(await ctx.db.get("folders", legacyPrivateId)).toMatchObject({
      accessPolicy: "restricted",
      discoverability: "listed",
    });
    expect(await ctx.db.get("folders", newFieldsId)).toMatchObject({
      accessPolicy: "restricted",
      discoverability: "unlisted",
    });
    const folders = await ctx.db.query("folders").collect();
    expect(folders.every((folder) => folder.privacy === undefined)).toBe(true);
    expect(
      await ctx.db.get("filesystemOperations", legacyOperationId),
    ).toMatchObject({
      accessPolicy: "public",
      discoverability: "unlisted",
    });
  });
});
