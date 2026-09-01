/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import authComponent from "@clammet/convex-googly-auth/test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

function setupTest() {
  const t = convexTest(schema, modules);
  authComponent.register(t);
  return t;
}

// Seeds the live counters the way a gallery with existing content would
// have them, whether or not galleries.create already made the stats row.
async function seedGalleryStats(
  ctx: Pick<MutationCtx, "db">,
  galleryId: Id<"galleries">,
  stats: { itemCount: number; totalBytes: number },
) {
  const existing = await galleryStatsOf(ctx, galleryId);
  if (existing === null) {
    await ctx.db.insert("galleryStats", { galleryId, ...stats });
  } else {
    await ctx.db.patch("galleryStats", existing._id, stats);
  }
}

async function seedFolderStats(
  ctx: Pick<MutationCtx, "db">,
  galleryId: Id<"galleries">,
  folderId: Id<"folders">,
  stats: { itemCount: number; totalBytes: number },
) {
  const existing = await folderStatsOf(ctx, folderId);
  if (existing === null) {
    await ctx.db.insert("folderStats", { galleryId, folderId, ...stats });
  } else {
    await ctx.db.patch("folderStats", existing._id, stats);
  }
}

function folderStatsOf(ctx: Pick<QueryCtx, "db">, folderId: Id<"folders">) {
  return ctx.db
    .query("folderStats")
    .withIndex("by_folderId", (q) => q.eq("folderId", folderId))
    .unique();
}

function galleryStatsOf(ctx: Pick<QueryCtx, "db">, galleryId: Id<"galleries">) {
  return ctx.db
    .query("galleryStats")
    .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
    .unique();
}

async function seedProfile(
  t: TestConvex<typeof schema>,
  input: { email?: string; anonymous?: boolean; admin?: boolean },
) {
  profileSequence += 1;
  const anonymousClaim = input.anonymous
    ? profileSequence.toString(16).padStart(64, "0")
    : undefined;
  const googleSubject = input.anonymous
    ? undefined
    : `https://accounts.google.com|test-user-${profileSequence}`;
  const profileId =
    googleSubject === undefined
      ? await t.mutation(api.profiles.ensureCurrent, { anonymousClaim })
      : await asUser(t, googleSubject, input.email).mutation(
          api.profiles.ensureCurrent,
          {},
        );
  if (input.admin === true) {
    await t.run(async (ctx) => {
      await ctx.db.patch("profiles", profileId, { isSystemAdmin: true });
    });
  }
  return { googleSubject, profileId, anonymousClaim };
}

function asUser(
  t: TestConvex<typeof schema>,
  googleSubject: string | undefined,
  email?: string,
) {
  if (googleSubject === undefined) {
    throw new Error("Expected a Google-authenticated profile");
  }
  return t.withIdentity({
    subject: googleSubject.split("|")[1]!,
    issuer: "https://accounts.google.com",
    tokenIdentifier: googleSubject,
    email,
    name: "Test User",
  });
}

describe("upgallery backend", () => {
  test("OAuth routing accepts configured tenant origins only", async () => {
    const t = setupTest();
    await t.run(async (ctx) => {
        const galleryId = await ctx.db.insert("galleries", {
          name: "Tenant gallery",
          slug: "tenant-gallery",
          kind: "image",
          storageKind: "shared",
          storageRoot: "tenant",
          maxFileSize: 1024,
          theme: {},
          itemCount: 0,
          totalBytes: 0,
        });
        await ctx.db.insert("galleryHosts", {
          galleryId,
          host: "photos.example.com",
          rootPath: "/",
        });
      });

      await expect(
      t.query(internal.authOrigins.isGalleryOrigin, {
          origin: "https://photos.example.com",
        }),
      ).resolves.toBe(true);
      await expect(
      t.query(internal.authOrigins.isGalleryOrigin, {
          origin: "https://attacker.example",
        }),
      ).resolves.toBe(false);
      await expect(
      t.query(internal.authOrigins.isGalleryOrigin, {
          origin: "http://photos.example.com",
        }),
      ).resolves.toBe(false);
      await expect(
      t.query(internal.authOrigins.isGalleryOrigin, {
          origin: "https://photos.example.com/not-an-origin",
        }),
      ).resolves.toBe(false);
  });

  test("a system admin creates a routed gallery with a root owner grant", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Family Photos",
      slug: "family-photos",
      kind: "image",
      storageKind: "shared",
      storageRoot: "family",
      hosts: [{ host: "photos.example.com", rootPath: "/" }],
    });

    const created = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      const roles = await ctx.db
        .query("galleryRoles")
        .withIndex("by_galleryId_and_profileId", (q) =>
          q.eq("galleryId", galleryId).eq("profileId", admin.profileId),
        )
        .take(10);
      const hosts = await ctx.db
        .query("galleryHosts")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
        .take(10);
      const rootFolder =
        gallery?.rootFolderId === undefined
          ? null
          : await ctx.db.get("folders", gallery.rootFolderId);
      return { gallery, roles, hosts, rootFolder };
    });

    expect(created.gallery?.rootFolderId).toBeDefined();
    expect(created.gallery).toMatchObject({
      anonymousRole: "viewer",
      authenticatedRole: "viewer",
    });
    expect(created.rootFolder).toMatchObject({
      accessPolicy: "inherit",
      discoverability: "listed",
    });
    expect(created.roles).toMatchObject([{ role: "owner" }]);
    expect(created.hosts).toMatchObject([
      { host: "photos.example.com", rootPath: "/" },
    ]);
  });

  test("a user-mounted gallery queues its initial scan and cannot migrate before it finishes", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Mounted gallery",
      slug: "mounted-gallery",
      kind: "image",
      storageKind: "user",
      storageRoot: "mounted-gallery",
      hosts: [{ host: "mounted.example.com", rootPath: "/" }],
    });
    const details = await authed.query(api.galleries.adminDetails, {
      galleryId,
    });
    expect(details?.filesystemSync).toMatchObject({
      status: "queued",
      isRunning: false,
      hasError: false,
    });

    const job = await t.mutation(internal.storageJobs.claimFilesystemSync, {});
    expect(job).toMatchObject({
      kind: "ready",
      galleryId,
      folderId: details!.rootFolder!._id,
    });
    expect(
      (
        await authed.query(api.galleries.adminDetails, {
          galleryId,
        })
      )?.filesystemSync,
    ).toMatchObject({ status: "running", isRunning: true });
    await expect(
      authed.mutation(api.migrations.request, {
        galleryId,
        targetStorageKind: "shared",
        targetStorageRoot: "mounted-gallery-shared",
      }),
    ).rejects.toThrow(/scan to finish/);
    if (job.kind !== "ready") throw new Error("Expected initial scan work");
    const sync = await t.mutation(
      internal.filesystemSync.claimFilesystemSync,
      { galleryId, folderId: job.folderId },
    );
    if (sync.kind !== "ready") throw new Error("Expected a scan lease");
    await t.mutation(internal.filesystemSync.compareFilesystemDirectory, {
      galleryId,
      folderId: job.folderId,
      syncId: sync.syncId,
      modifiedAt: 1000,
    });
    let sweepCursor: string | undefined;
    for (;;) {
      const sweep = await t.mutation(
        internal.filesystemSync.completeFilesystemSync,
        {
          galleryId,
          folderId: job.folderId,
          syncId: sync.syncId,
          modifiedAt: 1000,
          cursor: sweepCursor,
        },
      );
      if (sweep.done) break;
      sweepCursor = sweep.cursor;
    }
    await t.mutation(internal.storageJobs.completeFilesystemSync, {
      jobId: job.jobId,
    });
    await expect(
      authed.mutation(api.migrations.request, {
        galleryId,
        targetStorageKind: "shared",
        targetStorageRoot: "mounted-gallery-shared",
      }),
    ).resolves.toBeDefined();
  });

  test("gallery owners can lower the max file size but not raise it or edit system settings", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const adminAuthed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await adminAuthed.mutation(api.galleries.create, {
      name: "Owned gallery",
      slug: "owned-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "owned-gallery",
      maxFileSize: 8 * 1024 * 1024,
      hosts: [{ host: "owned.example.com", rootPath: "/" }],
    });
    const owner = await seedProfile(t, { email: "owner@example.com" });
    await adminAuthed.mutation(api.roles.upsert, {
      galleryId,
      profileId: owner.profileId,
      role: "owner",
    });
    const ownerAuthed = asUser(t, owner.googleSubject, "owner@example.com");
    const base = {
      galleryId,
      name: "Owned gallery",
      theme: {},
    };

    await ownerAuthed.mutation(api.galleries.update, {
      ...base,
      maxFileSize: 4 * 1024 * 1024,
    });
    await expect(
      ownerAuthed.mutation(api.galleries.update, {
        ...base,
        maxFileSize: 16 * 1024 * 1024,
      }),
    ).rejects.toThrow(/cannot exceed/);
    await expect(
      ownerAuthed.mutation(api.galleries.update, {
        ...base,
        maxFileSize: 4 * 1024 * 1024,
        maxFileSizeLimit: 16 * 1024 * 1024,
      }),
    ).rejects.toThrow(/system administrators/);
    await expect(
      ownerAuthed.mutation(api.galleries.update, {
        ...base,
        maxFileSize: 4 * 1024 * 1024,
        hosts: [{ host: "hijacked.example.com", rootPath: "/" }],
      }),
    ).rejects.toThrow(/system administrators/);
    await expect(
      ownerAuthed.mutation(api.migrations.request, {
        galleryId,
        targetStorageKind: "user",
        targetStorageRoot: "elsewhere",
      }),
    ).rejects.toThrow(/Unauthorized/);

    await adminAuthed.mutation(api.galleries.update, {
      ...base,
      maxFileSize: 8 * 1024 * 1024,
      maxFileSizeLimit: 32 * 1024 * 1024,
    });
    await ownerAuthed.mutation(api.galleries.update, {
      ...base,
      maxFileSize: 32 * 1024 * 1024,
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(gallery).toMatchObject({
      anonymousRole: "viewer",
      authenticatedRole: "viewer",
      infiniteScroll: true,
      paginationPageSize: 100,
    });
    expect(gallery?.maxFileSize).toBe(32 * 1024 * 1024);
    expect(gallery?.maxFileSizeLimit).toBe(32 * 1024 * 1024);

    // Quick move defaults off and owners can toggle it both ways.
    expect(gallery?.quickMove).toBeUndefined();
    await ownerAuthed.mutation(api.galleries.update, {
      ...base,
      maxFileSize: 32 * 1024 * 1024,
      quickMove: true,
    });
    const quickMoveOn = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(quickMoveOn?.quickMove).toBe(true);

    // Updates are patches: fields a save omits keep their stored value, so
    // a stale tab or an older client build cannot reset settings it never
    // rendered.
    await ownerAuthed.mutation(api.galleries.update, {
      galleryId,
      name: "Renamed gallery",
    });
    const patched = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(patched).toMatchObject({
      name: "Renamed gallery",
      maxFileSize: 32 * 1024 * 1024,
      quickMove: true,
    });

    await ownerAuthed.mutation(api.galleries.update, {
      ...base,
      quickMove: false,
    });
    const quickMoveOff = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(quickMoveOff?.quickMove).toBeUndefined();
    expect(quickMoveOff?.maxFileSize).toBe(32 * 1024 * 1024);

    await ownerAuthed.mutation(api.galleries.update, {
      galleryId,
      infiniteScroll: false,
      paginationPageSize: 250,
    });
    await expect(
      ownerAuthed.mutation(api.galleries.update, {
        galleryId,
        paginationPageSize: 125,
      }),
    ).rejects.toThrow(/steps of 50/);
    await expect(
      ownerAuthed.mutation(api.galleries.update, {
        galleryId,
        paginationPageSize: 300,
      }),
    ).rejects.toThrow(/50-250/);
    const paginationSettings = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(paginationSettings).toMatchObject({
      infiniteScroll: false,
      paginationPageSize: 250,
    });
  });

  test("gallery owners can grant and revoke anonymous editor access", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const adminClient = asUser(
      t,
      admin.googleSubject,
      "admin@example.com",
    );
    const galleryId = await adminClient.mutation(api.galleries.create, {
      name: "Community gallery",
      slug: "community-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "community-gallery",
      hosts: [{ host: "community.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const rootFolderId = gallery!.rootFolderId!;
    const anonymous = await seedProfile(t, { anonymous: true });

    const disabledListing = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(disabledListing.access).toMatchObject({
      role: "viewer",
      canUpload: false,
      canEditFolder: false,
      canManage: false,
    });
    await expect(
      t.mutation(api.folders.create, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        parentId: rootFolderId,
        name: "Before enabled",
        accessPolicy: "public",
        discoverability: "listed",
      }),
    ).rejects.toThrow(/Unauthorized/);

    const owner = await seedProfile(t, { email: "owner@example.com" });
    await adminClient.mutation(api.roles.upsert, {
      galleryId,
      profileId: owner.profileId,
      role: "owner",
    });
    const ownerClient = asUser(
      t,
      owner.googleSubject,
      "owner@example.com",
    );
    await ownerClient.mutation(api.galleries.setSystemPermission, {
      galleryId,
      principal: "anonymous",
      role: "editor",
    });
    const enabledListing = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(enabledListing.access).toMatchObject({
      role: "editor",
      canUpload: true,
      canEditFolder: true,
      canManage: false,
      canAdminGallery: false,
    });

    const created = await t.mutation(api.folders.create, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      parentId: rootFolderId,
      name: "Visitor folder",
      accessPolicy: "public",
      discoverability: "listed",
    });
    expect(created).toMatchObject({ kind: "complete" });
    if (created.kind !== "complete") {
      throw new Error("Expected a shared-storage folder");
    }
    await expect(
      t.mutation(api.folders.update, {
        anonymousClaim: anonymous.anonymousClaim,
        folderId: created.folderId,
        name: "Visitor renamed",
        accessPolicy: "public",
        discoverability: "listed",
      }),
    ).resolves.toMatchObject({ kind: "complete" });

    // Bulk actions stay owner-only until the gallery's editor bulk toggle is
    // on; the two switches together give anonymous visitors the full set.
    await expect(
      t.mutation(api.folders.moveMany, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        destinationFolderId: rootFolderId,
        folderIds: [created.folderId],
      }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      t.query(api.galleries.listOwnedImageGalleries, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
      }),
    ).resolves.toEqual([]);
    await ownerClient.mutation(api.galleries.update, {
      galleryId,
      editorBulkActions: true,
    });
    const bulkListing = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(bulkListing.access).toMatchObject({
      role: "editor",
      canManage: true,
      canAdminGallery: false,
    });
    await expect(
      t.query(api.galleries.listOwnedImageGalleries, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ _id: galleryId, rootFolderId }),
    ]);
    await expect(
      t.query(api.folders.listOwnedMoveDestinations, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: created.folderId }),
      ]),
    );
    const nested = await t.mutation(api.folders.create, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      parentId: rootFolderId,
      name: "Visitor nested",
      accessPolicy: "public",
      discoverability: "listed",
    });
    if (nested.kind !== "complete") {
      throw new Error("Expected a shared-storage folder");
    }
    await expect(
      t.mutation(api.folders.moveMany, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        destinationFolderId: created.folderId,
        folderIds: [nested.folderId],
      }),
    ).resolves.toMatchObject({ kind: "complete" });
    const [movedEntryId, deletedEntryId] = await t.run(async (ctx) => {
      const insert = (name: string, sha: string) =>
        ctx.db.insert("entries", {
          galleryId,
          folderId: rootFolderId,
          ownerProfileId: anonymous.profileId,
          name,
          nameKey: name.toLowerCase(),
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image",
          size: 12,
          sha256: sha.repeat(64),
          storageKind: "shared",
          storageKey: `public/shared/community-gallery/${sha}${sha}/${name}`,
          state: "ready",
          createdAt: 1,
          updatedAt: 1,
        });
      return [await insert("moved.jpg", "d"), await insert("deleted.jpg", "e")];
    });
    await expect(
      t.mutation(api.bulkOperations.startMove, {
        anonymousClaim: anonymous.anonymousClaim,
        sourceGalleryId: galleryId,
        sourceFolderId: rootFolderId,
        destinationGalleryId: galleryId,
        destinationFolderId: created.folderId,
        selection: { kind: "ids", entryIds: [movedEntryId] },
      }),
    ).resolves.toBeDefined();
    await expect(
      t.mutation(api.entries.removeMany, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        entryIds: [deletedEntryId],
      }),
    ).resolves.toEqual({ removed: 1 });
    await expect(
      t.mutation(api.folders.removeMany, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        folderIds: [nested.folderId],
      }),
    ).resolves.toEqual({ kind: "complete" });

    await ownerClient.mutation(api.galleries.setSystemPermission, {
      galleryId,
      principal: "anonymous",
      role: "viewer",
    });
    const disabledAgain = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(disabledAgain.access).toMatchObject({
      role: "viewer",
      canManage: false,
    });
    await expect(
      t.mutation(api.folders.update, {
        anonymousClaim: anonymous.anonymousClaim,
        folderId: created.folderId,
        name: "No longer allowed",
        accessPolicy: "public",
        discoverability: "listed",
      }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      t.mutation(api.folders.moveMany, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        destinationFolderId: rootFolderId,
        folderIds: [created.folderId],
      }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      t.query(api.galleries.listOwnedImageGalleries, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
      }),
    ).resolves.toEqual([]);
  });

  test("user-mount items backfill to Unknown and can be adopted by an owner", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const admin = await seedProfile(t, {
        email: "admin@example.com",
        admin: true,
      });
      const authed = asUser(
        t,
        admin.googleSubject,
        "admin@example.com",
      );
      const galleryId = await authed.mutation(api.galleries.create, {
        name: "Mounted gallery",
        slug: "mounted-ownership",
        kind: "image",
        storageKind: "user",
        storageRoot: "mounted-ownership",
        hosts: [{ host: "mounted-ownership.example.com", rootPath: "/" }],
      });
      const details = await authed.query(api.galleries.adminDetails, {
        galleryId,
      });
      const rootFolderId = details!.rootFolder!._id;
      const ownerGrant = details!.grants.find(
        (grant) =>
          grant.profileId === admin.profileId && grant.role === "owner",
      );
      if (ownerGrant === undefined) throw new Error("Owner grant not found");
      const editor = await seedProfile(t, { email: "editor@example.com" });
      const editorClient = asUser(
        t,
        editor.googleSubject,
        "editor@example.com",
      );
      await authed.mutation(api.roles.upsert, {
        galleryId,
        profileId: editor.profileId,
        role: "editor",
      });
      await expect(
        editorClient.mutation(api.roles.takeUnknownUploaderItems, {
          grantId: ownerGrant._id,
        }),
      ).rejects.toThrow("Unauthorized");

      const [legacyEntryId, claimedEntryId] = await t.run(async (ctx) => {
        const base = {
          galleryId,
          folderId: rootFolderId,
          ownerProfileId: admin.profileId,
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image" as const,
          size: 12,
          sha256: "b".repeat(64),
          storageKind: "user" as const,
          state: "ready" as const,
          createdAt: 1,
          updatedAt: 1,
        };
        return await Promise.all([
          ctx.db.insert("entries", {
            ...base,
            name: "legacy.jpg",
            nameKey: "legacy.jpg",
            storageKey: "public/users/mounted-ownership/legacy.jpg",
            filesystemIdentity: "1:1",
          }),
          ctx.db.insert("entries", {
            ...base,
            name: "claimed.jpg",
            nameKey: "claimed.jpg",
            storageKey: "public/users/mounted-ownership/claimed.jpg",
            filesystemIdentity: "1:2",
            filesystemOwnershipClaimed: true,
          }),
        ]);
      });

      await t.mutation(internal.roles.backfillUnknownUploaderOwnership, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const backfilled = await t.run(async (ctx) => {
        const legacy = await ctx.db.get("entries", legacyEntryId);
        const claimed = await ctx.db.get("entries", claimedEntryId);
        const uploader =
          legacy === null
            ? null
            : await ctx.db.get("profiles", legacy.ownerProfileId);
        return { legacy, claimed, uploader };
      });
      expect(backfilled.uploader?.displayName).toBe("Unknown");
      expect(backfilled.legacy?.ownerProfileId).not.toBe(admin.profileId);
      expect(backfilled.claimed?.ownerProfileId).toBe(admin.profileId);

      await authed.mutation(api.roles.takeUnknownUploaderItems, {
        grantId: ownerGrant._id,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const adopted = await t.run(async (ctx) =>
        ctx.db.get("entries", legacyEntryId),
      );
      expect(adopted).toMatchObject({
        ownerProfileId: admin.profileId,
        filesystemOwnershipClaimed: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("gallery admin access requires a gallery-wide owner grant", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const adminAuthed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await adminAuthed.mutation(api.galleries.create, {
      name: "Scoped gallery",
      slug: "scoped-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "scoped-gallery",
      hosts: [{ host: "scoped.example.com", rootPath: "/" }],
    });
    const rootFolderId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      return gallery!.rootFolderId!;
    });
    const subFolderId = await t.run(async (ctx) =>
      ctx.db.insert("folders", {
        galleryId,
        parentId: rootFolderId,
        ancestorIds: [rootFolderId],
        name: "Sub",
        slug: "sub",
        accessPolicy: "public",
        discoverability: "listed",
      }),
    );
    const owner = await seedProfile(t, { email: "owner@example.com" });
    const scoped = await seedProfile(t, { email: "scoped@example.com" });
    await adminAuthed.mutation(api.roles.upsert, {
      galleryId,
      profileId: owner.profileId,
      role: "owner",
    });
    await adminAuthed.mutation(api.roles.upsert, {
      galleryId,
      profileId: scoped.profileId,
      folderId: subFolderId,
      role: "owner",
    });
    const ownerAuthed = asUser(t, owner.googleSubject, "owner@example.com");
    const scopedAuthed = asUser(t, scoped.googleSubject, "scoped@example.com");

    const ownerListing = await ownerAuthed.query(api.folders.list, {
      galleryId,
      folderId: subFolderId,
    });
    expect(ownerListing.access.canAdminGallery).toBe(true);
    const scopedListing = await scopedAuthed.query(api.folders.list, {
      galleryId,
      folderId: subFolderId,
    });
    expect(scopedListing.access.canManage).toBe(true);
    expect(scopedListing.access.canAdminGallery).toBe(false);

    const ownerManaged = await ownerAuthed.query(api.galleries.listManaged);
    expect(ownerManaged.map((gallery) => gallery._id)).toContain(galleryId);
    const scopedManaged = await scopedAuthed.query(api.galleries.listManaged);
    expect(scopedManaged).toHaveLength(0);
    await expect(
      scopedAuthed.query(api.galleries.adminDetails, { galleryId }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("gallery availability and creation reserve internal storage paths globally", async () => {
    const t = setupTest();
    const existingStorageRoot = "clam/gallery.nyanya.org/goodies";
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    await authed.mutation(api.galleries.create, {
      name: "Existing gallery",
      slug: "a7-existing-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: existingStorageRoot,
      hosts: [{ host: "existing.example.com", rootPath: "/" }],
    });

    await expect(
      authed.query(api.galleries.checkAvailability, {
        slug: "a7-existing-gallery",
        storageRoot: "b8-new-gallery",
      }),
    ).resolves.toMatchObject({
      slugAvailable: false,
      storageRootAvailable: true,
    });
    await expect(
      authed.query(api.galleries.checkAvailability, {
        slug: "b8-new-gallery",
        storageRoot: existingStorageRoot,
      }),
    ).resolves.toMatchObject({
      slugAvailable: true,
      storageRootAvailable: false,
    });
    await expect(
      authed.query(api.galleries.checkAvailability, {
        slug: "b8-new-gallery",
        storageRoot: "clam/gallery.nyanya.org/../private",
      }),
    ).resolves.toMatchObject({
      normalizedStorageRoot: null,
      storageRootAvailable: false,
    });
    await expect(
      authed.mutation(api.galleries.create, {
        name: "Conflicting gallery",
        slug: "b8-conflicting-gallery",
        kind: "image",
        storageKind: "user",
        storageRoot: existingStorageRoot,
        hosts: [{ host: "conflict.example.com", rootPath: "/" }],
      }),
    ).rejects.toThrow("That internal storage path is already in use");
  });

  test("anonymous uploader editor access creates a capability without storing its plaintext", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const adminClient = asUser(
      t,
      admin.googleSubject,
      "admin@example.com",
    );
    const galleryId = await adminClient.mutation(api.galleries.create, {
        name: "Drop box",
        slug: "drop-box",
        kind: "uploader",
        storageKind: "shared",
        storageRoot: "drop-box",
        hosts: [{ host: "up.example.com", rootPath: "/up" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    expect(
      await t.run(async (ctx) => ctx.db.get("folders", gallery!.rootFolderId!)),
    ).toMatchObject({
      accessPolicy: "inherit",
      discoverability: "listed",
    });
    await adminClient.mutation(api.galleries.setSystemPermission, {
      galleryId,
      principal: "anonymous",
      role: "editor",
    });
    const anonymousClaim = "b".repeat(64);
    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();
    const listing = await t.query(api.folders.list, {
      anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(listing.access.canUpload).toBe(true);
    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();

    const result = await t.mutation(api.entries.createUploadIntent, {
      anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "notes.txt",
      description: "from a guest",
      mimeType: "text/plain",
      size: 12,
      password: "secret",
    });
    const intent = await t.run(async (ctx) =>
      ctx.db.get("uploadIntents", result.intentId),
    );
    const anonymous = await t.query(api.profiles.current, { anonymousClaim });

    expect(result.token.length).toBeGreaterThan(32);
    expect(intent?.tokenHash).not.toBe(result.token);
    expect(intent?.passwordHash).not.toBe("secret");
    expect(anonymous).toMatchObject({ isAnonymous: true });
    expect(intent?.ownerProfileId).toBe(anonymous?._id);
  });

  test("a rejected anonymous write rolls profile creation back", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const galleryId = await asUser(
      t,
      admin.googleSubject,
      "admin@example.com",
    ).mutation(api.galleries.create, {
      name: "Private edits",
      slug: "private-edits",
      kind: "image",
      storageKind: "shared",
      storageRoot: "private-edits",
      hosts: [{ host: "private.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const anonymousClaim = "c".repeat(64);

    await expect(
      t.mutation(api.entries.createUploadIntent, {
        anonymousClaim,
        galleryId,
        folderId: gallery!.rootFolderId!,
        name: "not-allowed.txt",
        mimeType: "text/plain",
        size: 12,
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();
  });

  test("unlisted uploader entries are listed only for their uploader", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Unlisted uploads",
      slug: "unlisted-uploads",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "unlisted-uploads",
      hosts: [{ host: "unlisted.example.com", rootPath: "/up" }],
    });
    await authed.mutation(api.galleries.setSystemPermission, {
      galleryId,
      principal: "anonymous",
      role: "editor",
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const uploader = await seedProfile(t, { anonymous: true });
    const visitor = await seedProfile(t, { anonymous: true });
    const intent = await t.mutation(api.entries.createUploadIntent, {
      anonymousClaim: uploader.anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "share-by-link.txt",
      mimeType: "text/plain",
      size: 12,
      unlisted: true,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "text/plain",
        extension: "txt",
        mediaKind: "text",
        size: 12,
        sha256: "f".repeat(64),
        storageKey: `protected/uploaders/unlisted-uploads/ff/ff/${"f".repeat(64)}.txt`,
    });

    const uploaderListing = await t.query(api.folders.list, {
      anonymousClaim: uploader.anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(uploaderListing.entries).toMatchObject([
      { _id: entryId, unlisted: true, canDelete: true },
    ]);

    const visitorListing = await t.query(api.folders.list, {
      anonymousClaim: visitor.anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(visitorListing.entries).toEqual([]);

    const adminListing = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(adminListing.entries).toEqual([]);
  });

  test("anonymous uploader views count without profiles and expired tickets are cleaned", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Counted files",
      slug: "counted-files",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "counted-files",
      hosts: [{ host: "files.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "shared-image.jpg",
      mimeType: "image/jpeg",
      size: 123,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 123,
        sha256: "d".repeat(64),
        storageKey: `protected/uploaders/counted-files/dd/dd/${"d".repeat(64)}.jpg`,
        thumbnailKey: `derivatives/up/counted-files/thumbnails/dd/dd/${"d".repeat(64)}.thumb.jpg`,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("entries", entryId, {
        previewKey: `derivatives/up/counted-files/previews/dd/dd/${"d".repeat(64)}.preview.jpg`,
      });
    });
    const anonymousClaim = "d".repeat(64);

    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();

    await expect(
      t.query(api.entries.getForUploaderView, {
        anonymousClaim,
        galleryId,
        entryId,
      }),
    ).resolves.toMatchObject({
      name: "shared-image.jpg",
      passwordProtected: false,
    });

    const attachmentTicket = await t.mutation(
      api.entries.createDownloadTicket,
      {
        anonymousClaim,
        galleryId,
        entryId,
        disposition: "attachment",
      },
    );
    await t.mutation(internal.storageGateway.claimDownload, {
      token: attachmentTicket.token,
    });
    await t.mutation(internal.storageGateway.claimDownload, {
      token: attachmentTicket.token,
    });

    const [thumbnailTicket] = await t.mutation(
      api.entries.createThumbnailTickets,
      {
        anonymousClaim,
        galleryId,
        folderId: gallery!.rootFolderId!,
        entryIds: [entryId],
      },
    );
    expect(thumbnailTicket).toBeDefined();
    await t.mutation(internal.storageGateway.claimDownload, {
      token: thumbnailTicket!.token,
    });

    const previewTicket = await t.mutation(api.entries.createDownloadTicket, {
        anonymousClaim,
        galleryId,
        entryId,
        disposition: "preview",
    });
    await expect(
      t.mutation(internal.storageGateway.claimDownload, {
        token: previewTicket.token,
      }),
    ).resolves.toMatchObject({
      storageKey: `derivatives/up/counted-files/previews/dd/dd/${"d".repeat(64)}.preview.jpg`,
      mimeType: "image/jpeg",
      disposition: "preview",
    });

    const counter = await t.run(async (ctx) =>
      ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .unique(),
    );
    expect(counter).toMatchObject({ views: 2, downloads: 0 });
    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();

    const [expiredTicketId, futureTicketId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("downloadTickets", {
          entryId,
          tokenHash: "expired-ticket",
          disposition: "inline",
          expiresAt: Date.now() - 1,
        }),
        ctx.db.insert("downloadTickets", {
          entryId,
          tokenHash: "future-ticket",
          disposition: "inline",
          expiresAt: Date.now() + 60_000,
        }),
      ]),
    );
    await expect(
      t.mutation(internal.ticketMaintenance.cleanupExpired, {}),
    ).resolves.toBe(1);
    const retainedTickets = await t.run(async (ctx) => ({
      expired: await ctx.db.get("downloadTickets", expiredTicketId),
      future: await ctx.db.get("downloadTickets", futureTicketId),
    }));
    expect(retainedTickets.expired).toBeNull();
    expect(retainedTickets.future).not.toBeNull();

    const failedJobId = await t.run(async (ctx) =>
      ctx.db.insert("mediaProcessingJobs", {
        entryId,
        expectedStorageKey: `protected/uploaders/counted-files/dd/dd/${"d".repeat(64)}.jpg`,
        expectedSha256: "d".repeat(64),
        status: "failed",
        attempts: 5,
        availableAt: 0,
        error: "Unsupported decoder",
      }),
    );
    await expect(
      t.mutation(internal.storageJobs.claimMediaProcessing, {}),
    ).resolves.toMatchObject({
      kind: "ready",
      jobId: failedJobId,
    });
    const replayedJob = await t.run(async (ctx) =>
      ctx.db.get("mediaProcessingJobs", failedJobId),
    );
    expect(replayedJob).toMatchObject({
      status: "processing",
      attempts: 1,
      processorVersion: 2,
    });
  });

  test("HEIC preview requests reuse the durable media-processing queue", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "HEIC previews",
      slug: "heic-previews",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "heic-previews",
      hosts: [{ host: "heic.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "iphone.heic",
      mimeType: "image/heic",
      size: 456,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const sha = "e".repeat(64);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/heic",
        extension: "heic",
        mediaKind: "image",
        size: 456,
        sha256: sha,
        storageKey: `protected/uploaders/heic-previews/ee/ee/${sha}.heic`,
    });
    const visitor = await seedProfile(t, { anonymous: true });
    const initialClaim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(initialClaim).toMatchObject({
      kind: "ready",
      entryId,
      processThumbnail: true,
      generatePreview: false,
    });
    if (initialClaim.kind !== "ready") {
      throw new Error("Expected initial media work");
    }

    await expect(
      t.mutation(api.entries.requestPreview, {
        anonymousClaim: visitor.anonymousClaim,
        galleryId,
        entryId,
      }),
    ).resolves.toEqual({ status: "pending" });
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: initialClaim.jobId,
      thumbnailKey: `derivatives/up/heic-previews/thumbnails/ee/ee/${sha}.thumb.jpg`,
      metadataJson: '{"Resolution":"4032 × 3024"}',
    });

    const claim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(claim).toMatchObject({
      kind: "ready",
      entryId,
      processThumbnail: false,
      processMetadata: false,
      generatePreview: true,
    });
    if (claim.kind !== "ready") throw new Error("Expected preview work");
    const previewKey = `derivatives/up/heic-previews/previews/ee/ee/${sha}.preview.jpg`;
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: claim.jobId,
      previewKey,
    });

    const ready = await t.mutation(api.entries.requestPreview, {
      anonymousClaim: visitor.anonymousClaim,
      galleryId,
      entryId,
    });
    expect(ready).toMatchObject({
      status: "ready",
      previewKey,
    });
    if (ready.status !== "ready" || !("token" in ready)) {
      throw new Error("Expected a protected preview ticket");
    }
    await expect(
      t.mutation(internal.storageGateway.claimDownload, {
        token: ready.token!,
      }),
    ).resolves.toMatchObject({
      storageKey: previewKey,
      mimeType: "image/jpeg",
      disposition: "preview",
    });
  });

  test("Google sign-in upgrades an anonymous profile without losing ownership", async () => {
    const t = setupTest();
    const anonymousClaim = "a".repeat(64);
    const anonymousProfileId = await t.mutation(api.profiles.ensureCurrent, {
      anonymousClaim,
    });
    const googleSubject = "https://accounts.google.com|merged-user";

    const mergedProfileId = await asUser(
      t,
      googleSubject,
      "merged@example.com",
    ).mutation(api.profiles.ensureCurrent, {
      anonymousClaim,
    });
    const mergedProfile = await t.run(async (ctx) =>
      ctx.db.get("profiles", mergedProfileId),
    );

    expect(mergedProfileId).toBe(anonymousProfileId);
    expect(mergedProfile).toMatchObject({
      email: "merged@example.com",
      isAnonymous: false,
    });
    expect(mergedProfile?.identityId).toEqual(expect.any(String));
    await expect(
      t.query(api.profiles.current, { anonymousClaim }),
    ).resolves.toBeNull();
  });

  test("account preferences persist and a custom display name survives sign-in", async () => {
    const t = setupTest();
    const member = await seedProfile(t, { email: "prefs@example.com" });
    const user = asUser(t, member.googleSubject, "prefs@example.com");

    await expect(user.query(api.profiles.current, {})).resolves.toMatchObject({
      displayName: "Test User",
      infiniteScroll: true,
    });

    await user.mutation(api.profiles.updatePreferences, {
      displayName: "  Preferred Name  ",
      infiniteScroll: false,
    });
    await expect(user.query(api.profiles.current, {})).resolves.toMatchObject({
      displayName: "Preferred Name",
      infiniteScroll: false,
    });

    // Re-running sign-in must not reset the chosen name to the provider's.
    await user.mutation(api.profiles.ensureCurrent, {});
    await expect(user.query(api.profiles.current, {})).resolves.toMatchObject({
      displayName: "Preferred Name",
      infiniteScroll: false,
    });

    await user.mutation(api.profiles.updatePreferences, { infiniteScroll: true });
    await expect(user.query(api.profiles.current, {})).resolves.toMatchObject({
      displayName: "Preferred Name",
      infiniteScroll: true,
    });

    await expect(
      user.mutation(api.profiles.updatePreferences, { displayName: "   " }),
    ).rejects.toThrow("Display name must be");

    const anonymous = await seedProfile(t, { anonymous: true });
    await expect(
      t.mutation(api.profiles.updatePreferences, {
        anonymousClaim: anonymous.anonymousClaim,
        infiniteScroll: false,
      }),
    ).rejects.toThrow("Log in to change account preferences");
  });

  test("sign-in absorbs anonymous app data into an existing Google profile", async () => {
    const t = setupTest();
    const google = await seedProfile(t, { email: "member@example.com" });
    const anonymous = await seedProfile(t, { anonymous: true });
    const grantId = await t.run(async (ctx) => {
      const galleryId = await ctx.db.insert("galleries", {
        name: "Merged gallery",
        slug: "merged-gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "merged-gallery",
        maxFileSize: 1024,
        theme: {},
        itemCount: 0,
        totalBytes: 0,
      });
      return await ctx.db.insert("galleryRoles", {
        galleryId,
        profileId: anonymous.profileId,
        role: "owner",
      });
    });

    const profileId = await asUser(
      t,
      google.googleSubject,
      "member@example.com",
    ).mutation(api.profiles.ensureCurrent, {
      anonymousClaim: anonymous.anonymousClaim,
    });
    const merged = await t.run(async (ctx) => ({
      source: await ctx.db.get("profiles", anonymous.profileId),
      grant: await ctx.db.get("galleryRoles", grantId),
    }));

    expect(profileId).toBe(google.profileId);
    expect(merged.source).toBeNull();
    expect(merged.grant?.profileId).toBe(google.profileId);
    await expect(
      t.query(api.profiles.current, {
        anonymousClaim: anonymous.anonymousClaim,
      }),
    ).resolves.toBeNull();
  });

  test("granting a never-seen email creates an invite claimed on first sign-in", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Invite gallery",
      slug: "invite-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "invite",
      hosts: [{ host: "invite.example.com", rootPath: "/" }],
    });

    await authed.mutation(api.roles.upsert, {
      galleryId,
      email: " Invitee@Example.COM ",
      role: "editor",
    });

    const pending = await authed.query(api.galleries.adminDetails, {
      galleryId,
    });
    const pendingGrant = pending?.grants.find(
      (grant) => grant.profile?.email === "invitee@example.com",
    );
    expect(pendingGrant).toMatchObject({
      role: "editor",
      profile: {
        isPlaceholder: true,
        isAnonymous: false,
        invitedAt: expect.any(Number),
      },
    });

    const inviteeSubject = "https://accounts.google.com|invitee-user";
    const invitee = asUser(t, inviteeSubject, "invitee@example.com");
    const profileId = await invitee.mutation(api.profiles.ensureCurrent, {});

    const claimed = await t.run(async (ctx) => ({
      placeholder: await ctx.db.get("profiles", pendingGrant!.profileId),
      grant: await ctx.db.get("galleryRoles", pendingGrant!._id),
    }));
    expect(claimed.placeholder).toBeNull();
    expect(claimed.grant?.profileId).toBe(profileId);
    await expect(
      invitee.query(api.roles.mine, { galleryId }),
    ).resolves.toEqual({ profileId });
  });

  test("pending invites reuse one placeholder and cannot be system admins", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Reinvite gallery",
      slug: "reinvite-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "reinvite",
      hosts: [{ host: "reinvite.example.com", rootPath: "/" }],
    });

    await authed.mutation(api.roles.upsert, {
      galleryId,
      email: "pending@example.com",
      role: "viewer",
    });
    await authed.mutation(api.roles.upsert, {
      galleryId,
      email: "pending@example.com",
      role: "owner",
    });

    const placeholders = await t.run(async (ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "pending@example.com"))
        .take(8),
    );
    expect(placeholders).toHaveLength(1);

    const details = await authed.query(api.galleries.adminDetails, {
      galleryId,
    });
    const grants = details?.grants.filter(
      (grant) => grant.profileId === placeholders[0]!._id,
    );
    expect(grants).toHaveLength(1);
    expect(grants?.[0]).toMatchObject({ role: "owner" });

    await expect(
      authed.mutation(api.roles.upsert, {
        galleryId,
        email: "not-an-email",
        role: "viewer",
      }),
    ).rejects.toThrow("Enter the email address");
    await expect(
      authed.mutation(api.profiles.setSystemAdmin, {
        profileId: placeholders[0]!._id,
        enabled: true,
      }),
    ).rejects.toThrow("Only signed-in SSO profiles");
  });

  test("folder access overrides and discoverability are resolved independently", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Private",
      slug: "private-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "private",
      hosts: [{ host: "private.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const rootFolderId = gallery!.rootFolderId!;
    const restrictedFolder = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: rootFolderId,
      name: "Members only",
      accessPolicy: "restricted",
      discoverability: "listed",
    });
    if (restrictedFolder.kind !== "complete") {
      throw new Error("Shared storage folder unexpectedly required I/O");
    }
    const inheritedRestrictedFolder = await authed.mutation(
      api.folders.create,
      {
        galleryId,
        parentId: restrictedFolder.folderId,
        name: "Inherited restriction",
        accessPolicy: "inherit",
        discoverability: "listed",
      },
    );
    if (inheritedRestrictedFolder.kind !== "complete") {
      throw new Error("Shared storage folder unexpectedly required I/O");
    }
    const unlistedFolder = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: rootFolderId,
      name: "Secret link",
      accessPolicy: "public",
      discoverability: "unlisted",
    });
    if (unlistedFolder.kind !== "complete") {
      throw new Error("Shared storage folder unexpectedly required I/O");
    }
    const anonymous = await seedProfile(t, { anonymous: true });
    const viewer = await seedProfile(t, { email: "viewer@example.com" });
    const viewerClient = asUser(
      t,
      viewer.googleSubject,
      "viewer@example.com",
    );

    const anonymousRoot = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(anonymousRoot.folders.map((folder) => folder._id)).not.toContain(
      restrictedFolder.folderId,
    );
    expect(anonymousRoot.folders.map((folder) => folder._id)).not.toContain(
      unlistedFolder.folderId,
    );

    await expect(
      t.query(api.folders.list, {
        anonymousClaim: anonymous.anonymousClaim,
        galleryId,
        folderId: restrictedFolder.folderId,
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      viewerClient.query(api.folders.list, {
        galleryId,
        folderId: restrictedFolder.folderId,
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      viewerClient.query(api.folders.list, {
        galleryId,
        folderId: inheritedRestrictedFolder.folderId,
      }),
    ).rejects.toThrow("Unauthorized");

    const directUnlisted = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: unlistedFolder.folderId,
    });
    expect(directUnlisted.folder._id).toBe(unlistedFolder.folderId);
    expect(directUnlisted.access.role).toBe("viewer");

    await authed.mutation(api.roles.upsert, {
      galleryId,
      folderId: restrictedFolder.folderId,
      profileId: viewer.profileId,
      role: "viewer",
    });
    await expect(
      viewerClient.query(api.folders.list, {
        galleryId,
        folderId: restrictedFolder.folderId,
      }),
    ).resolves.toMatchObject({ access: { role: "viewer" } });

    await authed.mutation(api.galleries.setSystemPermission, {
      galleryId,
      principal: "anonymous",
      role: "editor",
    });
    const editorRoot = await t.query(api.folders.list, {
      anonymousClaim: anonymous.anonymousClaim,
      galleryId,
      folderId: rootFolderId,
    });
    expect(editorRoot.folders.map((folder) => folder._id)).toContain(
      unlistedFolder.folderId,
    );

    await expect(
      authed.mutation(api.folders.update, {
        folderId: rootFolderId,
        name: gallery!.name,
        accessPolicy: "public",
        discoverability: "listed",
      }),
    ).rejects.toThrow("Root access is controlled by gallery permissions");
  });

  test("gallery owners can reset a folder subtree to inherited access", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const admin = await seedProfile(t, {
        email: "admin@example.com",
        admin: true,
      });
      const editor = await seedProfile(t, { email: "editor@example.com" });
      const authed = asUser(t, admin.googleSubject, "admin@example.com");
      const editorClient = asUser(
        t,
        editor.googleSubject,
        "editor@example.com",
      );
      const galleryId = await authed.mutation(api.galleries.create, {
        name: "Reset access",
        slug: "reset-access",
        kind: "image",
        storageKind: "shared",
        storageRoot: "reset-access",
        hosts: [{ host: "reset-access.example.com", rootPath: "/" }],
      });
      const gallery = await t.run(async (ctx) =>
        ctx.db.get("galleries", galleryId),
      );
      const rootFolderId = gallery!.rootFolderId!;
      const branch = await authed.mutation(api.folders.create, {
        galleryId,
        parentId: rootFolderId,
        name: "Branch",
        accessPolicy: "restricted",
        discoverability: "listed",
      });
      const sibling = await authed.mutation(api.folders.create, {
        galleryId,
        parentId: rootFolderId,
        name: "Sibling",
        accessPolicy: "public",
        discoverability: "listed",
      });
      if (branch.kind !== "complete" || sibling.kind !== "complete") {
        throw new Error("Shared storage folder unexpectedly required I/O");
      }
      const child = await authed.mutation(api.folders.create, {
        galleryId,
        parentId: branch.folderId,
        name: "Child",
        accessPolicy: "public",
        discoverability: "listed",
      });
      if (child.kind !== "complete") {
        throw new Error("Shared storage folder unexpectedly required I/O");
      }
      const grandchild = await authed.mutation(api.folders.create, {
        galleryId,
        parentId: child.folderId,
        name: "Grandchild",
        accessPolicy: "restricted",
        discoverability: "listed",
      });
      if (grandchild.kind !== "complete") {
        throw new Error("Shared storage folder unexpectedly required I/O");
      }

      await authed.mutation(api.roles.upsert, {
        galleryId,
        profileId: editor.profileId,
        role: "editor",
      });
      await expect(
        editorClient.mutation(api.folders.resetAccessPolicySubtree, {
          folderId: branch.folderId,
        }),
      ).rejects.toThrow("Unauthorized");

      await authed.mutation(api.folders.resetAccessPolicySubtree, {
        folderId: branch.folderId,
      });
      const immediate = await t.run(async (ctx) =>
        ctx.db.get("folders", branch.folderId),
      );
      expect(immediate?.accessPolicy).toBe("inherit");

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const reset = await t.run(async (ctx) => ({
        child: await ctx.db.get("folders", child.folderId),
        grandchild: await ctx.db.get("folders", grandchild.folderId),
        sibling: await ctx.db.get("folders", sibling.folderId),
      }));
      expect(reset.child?.accessPolicy).toBe("inherit");
      expect(reset.grandchild?.accessPolicy).toBe("inherit");
      expect(reset.sibling?.accessPolicy).toBe("public");
    } finally {
      vi.useRealTimers();
    }
  });

  test("folder previews inherit gallery settings and support render-seeded overrides", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Preview gallery",
      slug: "preview-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "previews",
      folderPreviewMode: "first3",
      hosts: [{ host: "previews.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const created = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: gallery!.rootFolderId!,
      name: "Album",
      accessPolicy: "public",
      discoverability: "listed",
    });
    if (created.kind !== "complete") {
      throw new Error("Shared storage folder unexpectedly required I/O");
    }
    await t.run(async (ctx) => {
      for (const [index, name] of [
        "Charlie.jpg",
        "alpha.jpg",
        "delta.jpg",
        "Bravo.jpg",
      ].entries()) {
        // Spread the hashes across the hex range so seeded random previews
        // pick different entries regardless of how the folder id hashes.
        const hash = ["0", "4", "8", "c"][index]!.repeat(64);
        await ctx.db.insert("entries", {
          galleryId,
          folderId: created.folderId,
          ownerProfileId: admin.profileId,
          name,
          nameKey: name.toLowerCase(),
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image",
          size: 100 + index,
          sha256: hash,
          storageKind: "shared",
          storageKey: `public/galleries/previews/${name}`,
          thumbnailKey: `public/galleries/previews/${hash}.thumb.jpg`,
          state: "ready",
          createdAt: Date.now() + index,
          updatedAt: Date.now() + index,
        });
      }
    });

    const inherited = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      previewSeed: 11,
    });
    expect(inherited.folderPreviews).toMatchObject([
      {
        folderId: created.folderId,
        mode: "first3",
        entries: [
          { name: "alpha.jpg" },
          { name: "Bravo.jpg" },
          { name: "Charlie.jpg" },
        ],
      },
    ]);

    const suggestions = await authed.query(
      api.folders.previewFilenameSuggestions,
      {
        galleryId,
        folderId: created.folderId,
        search: "br",
      },
    );
    expect(suggestions).toEqual(["Bravo.jpg"]);

    await authed.mutation(api.folders.update, {
      folderId: created.folderId,
      name: "Album",
      accessPolicy: "public",
      discoverability: "listed",
      previewMode: "custom",
      previewSource: "DELTA.JPG",
    });
    const customFilename = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      previewSeed: 11,
    });
    expect(customFilename.folderPreviews[0]).toMatchObject({
      mode: "custom",
      entries: [{ name: "delta.jpg" }],
    });

    const customUrl = "https://images.example.com/folder-cover.jpg";
    await authed.mutation(api.folders.update, {
      folderId: created.folderId,
      name: "Album",
      accessPolicy: "public",
      discoverability: "listed",
      previewMode: "custom",
      previewSource: customUrl,
    });
    const customUrlListing = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      previewSeed: 11,
    });
    expect(customUrlListing.folderPreviews[0]).toMatchObject({
      mode: "custom",
      customUrl,
      entries: [],
    });

    await authed.mutation(api.folders.update, {
      folderId: created.folderId,
      name: "Album",
      accessPolicy: "public",
      discoverability: "listed",
      previewMode: "random",
    });
    const randomNames = new Set<string>();
    for (const previewSeed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const listing = await authed.query(api.folders.list, {
        galleryId,
        folderId: gallery!.rootFolderId!,
        previewSeed,
      });
      expect(listing.folderPreviews[0]?.mode).toBe("random");
      expect(listing.folderPreviews[0]?.entries).toHaveLength(1);
      randomNames.add(listing.folderPreviews[0]!.entries[0]!.name);
    }
    expect(randomNames.size).toBeGreaterThan(1);

    await authed.mutation(api.folders.update, {
      folderId: created.folderId,
      name: "Album",
      accessPolicy: "public",
      discoverability: "listed",
    });
    const reset = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      previewSeed: 11,
    });
    expect(reset.folderPreviews[0]?.mode).toBe("first3");

    await authed.mutation(api.galleries.update, {
      galleryId,
      folderPreviewMode: "custom",
      folderPreviewSource: "bravo.JPG",
    });
    const customDefault = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      previewSeed: 11,
    });
    expect(customDefault.folderPreviews[0]).toMatchObject({
      mode: "custom",
      entries: [{ name: "Bravo.jpg" }],
    });
  });

  test("a user-backed directory is reconciled incrementally and skips an unchanged mtime", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Mounted photos",
      slug: "mounted-photos",
      kind: "image",
      storageKind: "user",
      storageRoot: "alice/photos",
      hosts: [{ host: "mounted.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const folderId = gallery!.rootFolderId!;

    const firstClaim = await t.mutation(
      internal.filesystemSync.claimFilesystemSync,
      { galleryId, folderId },
    );
    expect(firstClaim.kind).toBe("ready");
    if (firstClaim.kind !== "ready")
      throw new Error("Sync was unexpectedly busy");
    expect(firstClaim.folderSegments).toEqual([]);
    expect(
      (
        await authed.query(api.folders.list, {
          galleryId,
          folderId,
        })
      ).filesystemSync,
    ).toMatchObject({
      isRunning: true,
      hasError: false,
    });
    expect(
      await t.mutation(internal.filesystemSync.compareFilesystemDirectory, {
          galleryId,
          folderId,
          syncId: firstClaim.syncId,
          modifiedAt: 1000,
      }),
    ).toEqual({ shouldScan: true });

    const newFolderId = await t.mutation(
      internal.filesystemSync.reconcileFilesystemDirectory,
      {
        galleryId,
        parentId: folderId,
        syncId: firstClaim.syncId,
        name: "From SFTP",
        identity: "1:10",
      },
    );
    const check = await t.mutation(
      internal.filesystemSync.checkFilesystemFile,
      {
        galleryId,
        folderId,
        syncId: firstClaim.syncId,
        name: "photo one.jpg",
        storageKey: "public/users/alice/photos/photo one.jpg",
        size: 1234,
        modifiedAt: 900,
        identity: "1:11",
      },
    );
    expect(check.kind).toBe("metadata");
    await t.mutation(internal.filesystemSync.reconcileFilesystemFile, {
        galleryId,
        folderId,
        syncId: firstClaim.syncId,
        name: "photo one.jpg",
        storageKey: "public/users/alice/photos/photo one.jpg",
        size: 1234,
        modifiedAt: 900,
        identity: "1:11",
        mimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        sha256: "a".repeat(64),
        thumbnailKey:
          "derivatives/gallery/user/alice/photos/thumbnails/aa/aa/thumb.jpg",
    });
    let sweepCursor: string | undefined;
    for (;;) {
      const sweep = await t.mutation(
        internal.filesystemSync.completeFilesystemSync,
        {
          galleryId,
          folderId,
          syncId: firstClaim.syncId,
          modifiedAt: 1000,
          cursor: sweepCursor,
        },
      );
      if (sweep.done) break;
      sweepCursor = sweep.cursor;
    }

    const listing = await authed.query(api.folders.list, {
      galleryId,
      folderId,
    });
    expect(listing.folders.map((folder) => folder._id)).toContain(newFolderId);
    expect(listing.filesystemSync).toMatchObject({
      isRunning: false,
      hasError: false,
    });
    expect(listing.filesystemSync?.lastFinishedAt).toBeTypeOf("number");
    expect(listing.entries).toMatchObject([
      {
        name: "photo one.jpg",
        storageKey: "public/users/alice/photos/photo one.jpg",
        filesystemModifiedAt: 900,
      },
    ]);

    const secondClaim = await t.mutation(
      internal.filesystemSync.claimFilesystemSync,
      { galleryId, folderId },
    );
    if (secondClaim.kind !== "ready")
      throw new Error("Sync was unexpectedly busy");
    const knownChildren = await t.query(
      internal.filesystemSync.listKnownChildFolders,
      { galleryId, folderId },
    );
    expect(knownChildren.folderIds).toContain(newFolderId);
    expect(
      await t.mutation(internal.filesystemSync.compareFilesystemDirectory, {
          galleryId,
          folderId,
          syncId: secondClaim.syncId,
          modifiedAt: 1000,
      }),
    ).toEqual({ shouldScan: false });
    expect(
      (
        await authed.query(api.folders.list, {
          galleryId,
          folderId,
        })
      ).filesystemSync,
    ).toMatchObject({
      isRunning: false,
      hasError: false,
    });
  });

  test("user-backed folder creation is completed only after the filesystem operation", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Filesystem gallery",
      slug: "filesystem-gallery",
      kind: "image",
      storageKind: "user",
      storageRoot: "studio",
      hosts: [{ host: "studio.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const result = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: gallery!.rootFolderId!,
      name: "Retouched",
      accessPolicy: "public",
      discoverability: "unlisted",
      previewMode: "random3",
    });
    expect(result.kind).toBe("filesystem");
    if (result.kind !== "filesystem") {
      throw new Error("Expected a filesystem operation");
    }
    const storedOperation = await t.run(async (ctx) =>
      ctx.db.get("filesystemOperations", result.operationId),
    );
    expect(storedOperation?.tokenHash).not.toBe(result.token);

    const operation = await t.mutation(
      internal.filesystemSync.claimFilesystemOperation,
      {
        operationId: result.operationId,
        token: result.token,
      },
    );
    expect(operation.destinationSegments).toEqual(["Retouched"]);
    await t.run(async (ctx) => {
      await ctx.db.patch("filesystemOperations", result.operationId, {
        leaseExpiresAt: 0,
      });
    });
    const recovered = await t.mutation(
      internal.filesystemSync.claimRecoverableFilesystemOperation,
      {},
    );
    expect(recovered).toMatchObject({
      kind: "ready",
      operation: {
        operationId: result.operationId,
        destinationSegments: ["Retouched"],
      },
    });
    const completed = await t.mutation(
      internal.filesystemSync.completeFilesystemOperation,
      {
        operationId: result.operationId,
        identity: "2:20",
      },
    );
    const folder = await t.run(async (ctx) =>
      ctx.db.get("folders", completed.folderId!),
    );
    expect(folder).toMatchObject({
      name: "Retouched",
      accessPolicy: "public",
      discoverability: "unlisted",
      previewMode: "random3",
      filesystemIdentity: "2:20",
    });
  });

  test("settings edited while a folder rename is pending survive completion", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Rename race gallery",
      slug: "rename-race-gallery",
      kind: "image",
      storageKind: "user",
      storageRoot: "rename-race",
      hosts: [{ host: "rename-race.example.com", rootPath: "/" }],
    });
    const folderId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      const rootFolderId = gallery!.rootFolderId!;
      return await ctx.db.insert("folders", {
        galleryId,
        parentId: rootFolderId,
        ancestorIds: [rootFolderId],
        name: "Shoots",
        slug: "shoots",
        accessPolicy: "public",
        discoverability: "listed",
      });
    });

    const rename = await authed.mutation(api.folders.update, {
      folderId,
      name: "Shoots 2024",
      accessPolicy: "public",
      discoverability: "listed",
    });
    expect(rename.kind).toBe("filesystem");
    if (rename.kind !== "filesystem") {
      throw new Error("Expected a filesystem operation");
    }
    // The stored name stays "Shoots" until the worker completes, so this
    // second edit takes the direct-patch path while the rename is pending.
    await authed.mutation(api.folders.update, {
      folderId,
      name: "Shoots",
      accessPolicy: "restricted",
      discoverability: "unlisted",
    });

    await t.mutation(internal.filesystemSync.claimFilesystemOperation, {
      operationId: rename.operationId,
      token: rename.token,
    });
    await t.mutation(internal.filesystemSync.completeFilesystemOperation, {
      operationId: rename.operationId,
      identity: "9:9",
    });
    const folder = await t.run(async (ctx) =>
      ctx.db.get("folders", folderId),
    );
    expect(folder).toMatchObject({
      name: "Shoots 2024",
      accessPolicy: "restricted",
      discoverability: "unlisted",
      filesystemIdentity: "9:9",
    });
  });

  test("gallery owners can bulk delete folders with their contents", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const owner = await seedProfile(t, {
        email: "owner@example.com",
        admin: true,
      });
      const editor = await seedProfile(t, { email: "editor@example.com" });
      const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
      const editorClient = asUser(t, editor.googleSubject, "editor@example.com");
      const galleryId = await ownerClient.mutation(api.galleries.create, {
        name: "Folder delete gallery",
        slug: "folder-delete-gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "folder-delete",
        hosts: [{ host: "folder-delete.example.com", rootPath: "/" }],
      });
      const rootFolderId = await t.run(async (ctx) => {
        await ctx.db.insert("galleryRoles", {
          galleryId,
          profileId: editor.profileId,
          role: "editor",
        });
        const gallery = await ctx.db.get("galleries", galleryId);
        return gallery!.rootFolderId!;
      });
      const trips = await ownerClient.mutation(api.folders.create, {
        galleryId,
        parentId: rootFolderId,
        name: "Trips",
        accessPolicy: "public",
        discoverability: "listed",
      });
      if (trips.kind !== "complete") {
        throw new Error("Shared gallery unexpectedly required filesystem I/O");
      }
      const japan = await ownerClient.mutation(api.folders.create, {
        galleryId,
        parentId: trips.folderId,
        name: "Japan",
        accessPolicy: "public",
        discoverability: "listed",
      });
      if (japan.kind !== "complete") {
        throw new Error("Shared gallery unexpectedly required filesystem I/O");
      }
      const entryId = await t.run(async (ctx) => {
        await seedGalleryStats(ctx, galleryId, {
          itemCount: 1,
          totalBytes: 12,
        });
        return await ctx.db.insert("entries", {
          galleryId,
          folderId: japan.folderId,
          ownerProfileId: owner.profileId,
          name: "shrine.jpg",
          nameKey: "shrine.jpg",
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image",
          size: 12,
          sha256: "b".repeat(64),
          storageKind: "shared",
          storageKey: "public/shared/folder-delete/bb/bb/shrine.jpg",
          state: "ready",
          createdAt: 1,
          updatedAt: 1,
        });
      });

      await expect(
        editorClient.mutation(api.folders.removeMany, {
          galleryId,
          folderIds: [trips.folderId],
        }),
      ).rejects.toThrow("Unauthorized");
      await expect(
        ownerClient.mutation(api.folders.removeMany, {
          galleryId,
          folderIds: [rootFolderId],
        }),
      ).rejects.toThrow("The root folder cannot be deleted");

      await expect(
        ownerClient.mutation(api.folders.removeMany, {
          galleryId,
          folderIds: [trips.folderId],
        }),
      ).resolves.toEqual({ kind: "complete" });
      const listing = await ownerClient.query(api.folders.list, {
        galleryId,
        folderId: rootFolderId,
      });
      expect(listing.folders).toHaveLength(0);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const cleaned = await t.run(async (ctx) => ({
        trips: await ctx.db.get("folders", trips.folderId),
        japan: await ctx.db.get("folders", japan.folderId),
        entry: await ctx.db.get("entries", entryId),
        stats: await galleryStatsOf(ctx, galleryId),
        deleteJobs: await ctx.db
          .query("storageDeleteJobs")
          .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
          .take(10),
      }));
      expect(cleaned.trips).toBeNull();
      expect(cleaned.japan).toBeNull();
      expect(cleaned.entry).toBeNull();
      expect(cleaned.stats).toMatchObject({ itemCount: 0, totalBytes: 0 });
      expect(cleaned.deleteJobs).toMatchObject([
        {
          storageKey: "public/shared/folder-delete/bb/bb/shrine.jpg",
          deleteOriginal: true,
          deleteEntry: false,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("user-backed folder deletion commits after the rmdir filesystem operation", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const owner = await seedProfile(t, {
        email: "owner@example.com",
        admin: true,
      });
      const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
      const galleryId = await ownerClient.mutation(api.galleries.create, {
        name: "Rmdir gallery",
        slug: "rmdir-gallery",
        kind: "image",
        storageKind: "user",
        storageRoot: "rmdir-studio",
        hosts: [{ host: "rmdir.example.com", rootPath: "/" }],
      });
      const { rootFolderId, folderId, entryId } = await t.run(async (ctx) => {
        const gallery = await ctx.db.get("galleries", galleryId);
        const rootFolderId = gallery!.rootFolderId!;
        const folderId = await ctx.db.insert("folders", {
          galleryId,
          parentId: rootFolderId,
          ancestorIds: [rootFolderId],
          name: "Shoots",
          slug: "shoots",
          accessPolicy: "public",
          discoverability: "listed",
          filesystemIdentity: "3:30",
        });
        await seedGalleryStats(ctx, galleryId, {
          itemCount: 1,
          totalBytes: 20,
        });
        const entryId = await ctx.db.insert("entries", {
          galleryId,
          folderId,
          ownerProfileId: owner.profileId,
          name: "portrait.jpg",
          nameKey: "portrait.jpg",
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image",
          size: 20,
          sha256: "c".repeat(64),
          storageKind: "user",
          storageKey: "public/users/rmdir-studio/Shoots/portrait.jpg",
          thumbnailKey: "thumbnails/rmdir/cc.jpg",
          state: "ready",
          createdAt: 1,
          updatedAt: 1,
        });
        return { rootFolderId, folderId, entryId };
      });

      const result = await ownerClient.mutation(api.folders.removeMany, {
        galleryId,
        folderIds: [folderId],
      });
      if (result.kind !== "filesystem") {
        throw new Error("Expected a filesystem operation");
      }
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].folderId).toBe(folderId);
      const stillListed = await ownerClient.query(api.folders.list, {
        galleryId,
        folderId: rootFolderId,
      });
      expect(stillListed.folders).toHaveLength(1);

      const claim = await t.mutation(
        internal.filesystemSync.claimFilesystemOperation,
        {
          operationId: result.operations[0].operationId,
          token: result.operations[0].token,
        },
      );
      expect(claim).toMatchObject({
        kind: "rmdir",
        destinationSegments: ["Shoots"],
      });
      await t.mutation(internal.filesystemSync.completeFilesystemOperation, {
        operationId: result.operations[0].operationId,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const cleaned = await t.run(async (ctx) => ({
        folder: await ctx.db.get("folders", folderId),
        entry: await ctx.db.get("entries", entryId),
        stats: await galleryStatsOf(ctx, galleryId),
        deleteJobs: await ctx.db
          .query("storageDeleteJobs")
          .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
          .take(10),
      }));
      expect(cleaned.folder).toBeNull();
      expect(cleaned.entry).toBeNull();
      expect(cleaned.stats).toMatchObject({ itemCount: 0, totalBytes: 0 });
      expect(cleaned.deleteJobs).toMatchObject([
        {
          thumbnailKey: "thumbnails/rmdir/cc.jpg",
          deleteOriginal: false,
          deleteEntry: false,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("gallery editors can rename files and viewers cannot", async () => {
    const t = setupTest();
    const owner = await seedProfile(t, {
      email: "owner@example.com",
      admin: true,
    });
    const editor = await seedProfile(t, { email: "editor@example.com" });
    const viewer = await seedProfile(t, { email: "viewer@example.com" });
    const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
    const editorClient = asUser(t, editor.googleSubject, "editor@example.com");
    const viewerClient = asUser(t, viewer.googleSubject, "viewer@example.com");
    const galleryId = await ownerClient.mutation(api.galleries.create, {
      name: "Rename gallery",
      slug: "rename-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "rename-gallery",
      hosts: [{ host: "rename.example.com", rootPath: "/" }],
    });
    const { entryId, rootFolderId } = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      const rootFolderId = gallery!.rootFolderId!;
      await ctx.db.insert("galleryRoles", {
        galleryId,
        profileId: editor.profileId,
        role: "editor",
      });
      const entryId = await ctx.db.insert("entries", {
        galleryId,
        folderId: rootFolderId,
        ownerProfileId: owner.profileId,
        name: "original.jpg",
        nameKey: "original.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 12,
        sha256: "a".repeat(64),
        storageKind: "shared",
        storageKey: "public/shared/rename-gallery/aa/aa/original.jpg",
        state: "ready",
        createdAt: 1,
        updatedAt: 1,
      });
      return { entryId, rootFolderId };
    });

    await expect(
      viewerClient.mutation(api.entries.rename, {
        galleryId,
        entryId,
        name: "not-allowed.jpg",
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      editorClient.mutation(api.entries.rename, {
        galleryId,
        entryId,
        name: "final.PNG",
      }),
    ).resolves.toMatchObject({ kind: "complete", name: "final.PNG" });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).resolves.toMatchObject({
      folderId: rootFolderId,
      name: "final.PNG",
      extension: "png",
    });
  });

  test("user-backed file renames commit after the filesystem operation", async () => {
    const t = setupTest();
    const owner = await seedProfile(t, {
      email: "owner@example.com",
      admin: true,
    });
    const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
    const galleryId = await ownerClient.mutation(api.galleries.create, {
      name: "Filesystem rename",
      slug: "filesystem-rename",
      kind: "image",
      storageKind: "user",
      storageRoot: "studio",
      hosts: [{ host: "files.example.com", rootPath: "/" }],
    });
    const entryId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      return await ctx.db.insert("entries", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        ownerProfileId: owner.profileId,
        name: "portrait.jpg",
        nameKey: "portrait.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 12,
        sha256: "b".repeat(64),
        storageKind: "user",
        storageKey: "public/users/studio/portrait.jpg",
        filesystemModifiedAt: 10,
        filesystemIdentity: "2:20",
        state: "ready",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const result = await ownerClient.mutation(api.entries.rename, {
      galleryId,
      entryId,
      name: "finished.jpg",
    });
    expect(result.kind).toBe("filesystem");
    if (result.kind !== "filesystem") {
      throw new Error("Expected a filesystem operation");
    }
    const claim = await t.mutation(
      internal.filesystemSync.claimFilesystemOperation,
      { operationId: result.operationId, token: result.token },
    );
    expect(claim).toMatchObject({
      kind: "fileRename",
      sourceSegments: ["portrait.jpg"],
      destinationSegments: ["finished.jpg"],
    });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).resolves.toMatchObject({
      filesystemOperationId: result.operationId,
      migrationState: "moving",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("filesystemOperations", result.operationId, {
        leaseExpiresAt: 0,
      });
    });
    await expect(
      t.mutation(internal.filesystemSync.claimRecoverableFilesystemOperation, {}),
    ).resolves.toMatchObject({
      kind: "ready",
      operation: { operationId: result.operationId, kind: "fileRename" },
    });
    await t.mutation(internal.filesystemSync.completeFilesystemOperation, {
      operationId: result.operationId,
      identity: "2:20",
      modifiedAt: 20,
    });
    const renamed = await t.run(async (ctx) => ctx.db.get("entries", entryId));
    expect(renamed).toMatchObject({
      name: "finished.jpg",
      storageKey: "public/users/studio/finished.jpg",
      filesystemModifiedAt: 20,
      filesystemIdentity: "2:20",
    });
    expect(renamed?.filesystemOperationId).toBeUndefined();
    expect(renamed?.migrationState).toBeUndefined();
  });

  test("image upload completion queues durable media processing", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Media queue",
      slug: "media-queue",
      kind: "image",
      storageKind: "shared",
      storageRoot: "media-queue",
      hosts: [{ host: "media.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "queued.jpg",
      mimeType: "image/jpeg",
      size: 123,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 123,
        sha256: "c".repeat(64),
        storageKey: `public/shared/media-queue/cc/cc/${"c".repeat(64)}.jpg`,
    });
    const job = await t.run(async (ctx) =>
      ctx.db
        .query("mediaProcessingJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .unique(),
    );
    expect(job).toMatchObject({
      status: "queued",
      attempts: 0,
      processorVersion: 2,
      expectedSha256: "c".repeat(64),
    });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).resolves.toMatchObject({ thumbnailState: "pending" });

    const claim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    if (claim.kind !== "ready") throw new Error("Expected media work");
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: claim.jobId,
      thumbnailKey: `derivatives/gallery/shared/media-queue/thumbnails/cc/cc/${"c".repeat(64)}.thumb.jpg`,
      metadataJson: '{"Make":"Test"}',
    });
    const completed = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      jobs: await ctx.db
        .query("mediaProcessingJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .take(10),
    }));
    expect(completed.entry?.thumbnailKey).toContain(".thumb.jpg");
    expect(completed.entry?.thumbnailState).toBeUndefined();
    expect(completed.entry?.metadataJson).toBe('{"Make":"Test"}');
    expect(completed.jobs).toHaveLength(0);

    const failedJobId = await t.run(async (ctx) => {
      await ctx.db.patch("entries", entryId, {
        thumbnailKey: undefined,
        thumbnailState: "pending",
      });
      return await ctx.db.insert("mediaProcessingJobs", {
        entryId,
        expectedStorageKey: `public/shared/media-queue/cc/cc/${"c".repeat(64)}.jpg`,
        expectedSha256: "c".repeat(64),
        status: "processing",
        attempts: 5,
        availableAt: 0,
      });
    });
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: failedJobId,
      error: "Unsupported decoder",
    });
    const failed = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      job: await ctx.db.get("mediaProcessingJobs", failedJobId),
    }));
    expect(failed.entry?.thumbnailState).toBe("failed");
    expect(failed.job).toMatchObject({
      status: "failed",
      error: "Unsupported decoder",
    });
  });

  test("audio uploads queue metadata processing without a thumbnail", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Audio metadata",
      slug: "audio-metadata",
      kind: "image",
      storageKind: "shared",
      storageRoot: "audio-metadata",
      hosts: [{ host: "audio.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "recording.wav",
      mimeType: "audio/x-wav",
      size: 27445868,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const sha256 = "d".repeat(64);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
      intentId: intent.intentId,
      actualMimeType: "audio/x-wav",
      extension: "wav",
      mediaKind: "audio",
      size: 27445868,
      sha256,
      storageKey: `public/shared/audio-metadata/dd/dd/${sha256}.wav`,
    });

    const claim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(claim).toMatchObject({
      kind: "ready",
      entryId,
      mediaKind: "audio",
      processThumbnail: false,
      processMetadata: true,
    });
    if (claim.kind !== "ready") throw new Error("Expected audio media work");

    const metadataJson = JSON.stringify({
      AudioCodec: "PCM signed 16-bit little-endian",
      AudioBitRate: 1411200,
      AudioSampleRate: 44100,
      AudioChannels: "2 (stereo)",
      AudioBitDepth: 16,
      Duration: 155.588571,
    });
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: claim.jobId,
      metadataJson,
      metadataProcessed: true,
    });

    await expect(
      t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).resolves.toMatchObject({ metadataJson, metadataVersion: 5 });
  });

  test("existing audio without metadata is picked up for backfill", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Audio backfill",
      slug: "audio-backfill",
      kind: "image",
      storageKind: "shared",
      storageRoot: "audio-backfill",
      hosts: [{ host: "backfill.example.com", rootPath: "/" }],
    });
    const entryId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      return await ctx.db.insert("entries", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        ownerProfileId: admin.profileId,
        name: "existing.wav",
        nameKey: "existing.wav",
        mimeType: "audio/x-wav",
        extension: "wav",
        mediaKind: "audio",
        size: 1234,
        sha256: "e".repeat(64),
        storageKind: "shared",
        storageKey: `public/shared/audio-backfill/ee/ee/${"e".repeat(64)}.wav`,
        state: "ready",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.mutation(internal.storageJobs.claimMediaProcessing, {}),
    ).resolves.toMatchObject({
      kind: "ready",
      entryId,
      mediaKind: "audio",
      processThumbnail: false,
      processMetadata: true,
    });
  });

  test("existing video is picked up when A/V metadata fields change", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Video backfill",
      slug: "video-backfill",
      kind: "image",
      storageKind: "shared",
      storageRoot: "video-backfill",
      hosts: [{ host: "video-backfill.example.com", rootPath: "/" }],
    });
    const entryId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      return await ctx.db.insert("entries", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        ownerProfileId: admin.profileId,
        name: "existing.mp4",
        nameKey: "existing.mp4",
        mimeType: "video/mp4",
        extension: "mp4",
        mediaKind: "video",
        size: 4321,
        sha256: "f".repeat(64),
        storageKind: "shared",
        storageKey: `public/shared/video-backfill/ff/ff/${"f".repeat(64)}.mp4`,
        thumbnailKey: `derivatives/gallery/shared/video-backfill/thumbnails/ff/ff/${"f".repeat(64)}.thumb.jpg`,
        metadataJson: '{"Duration":5}',
        metadataVersion: 2,
        state: "ready",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.mutation(internal.storageJobs.claimMediaProcessing, {}),
    ).resolves.toMatchObject({
      kind: "ready",
      entryId,
      mediaKind: "video",
      processThumbnail: false,
      processMetadata: true,
    });
  });

  test("owners can queue location removal and commit the rewritten image", async () => {
    const t = setupTest();
    const owner = await seedProfile(t, {
      email: "owner@example.com",
      admin: true,
    });
    const authed = asUser(t, owner.googleSubject, "owner@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Private metadata",
      slug: "private-metadata",
      kind: "image",
      storageKind: "shared",
      storageRoot: "private-metadata",
      hosts: [{ host: "metadata.example.com", rootPath: "/" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: gallery!.rootFolderId!,
      name: "located.jpg",
      mimeType: "image/jpeg",
      size: 500,
      removeLocationData: true,
    });
    await expect(
      t.mutation(internal.storageGateway.claimUpload, intent),
    ).resolves.toMatchObject({ removeLocationData: true });
    const oldSha = "a".repeat(64);
    const oldStorageKey = `public/shared/private-metadata/aa/aa/${oldSha}.jpg`;
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 500,
        sha256: oldSha,
        storageKey: oldStorageKey,
    });
    const initial = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    if (initial.kind !== "ready") throw new Error("Expected media work");
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: initial.jobId,
      thumbnailKey: `derivatives/gallery/shared/private-metadata/thumbnails/aa/aa/${oldSha}.thumb.jpg`,
      metadataJson: '{"Make":"Acme","GPSLatitude":-37.8,"GPSLongitude":144.98}',
    });

    const [editor, viewer] = await Promise.all([
      seedProfile(t, { email: "editor@example.com" }),
      seedProfile(t, { email: "viewer@example.com" }),
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("galleryRoles", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        profileId: editor.profileId,
        role: "editor",
      });
      await ctx.db.insert("galleryRoles", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        profileId: viewer.profileId,
        role: "viewer",
      });
    });
    await expect(
      asUser(t, viewer.googleSubject, "viewer@example.com").mutation(
        api.entries.removeLocationData,
        {
        galleryId,
        entryId,
        },
      ),
    ).rejects.toThrow("Unauthorized");
    await expect(
      asUser(t, editor.googleSubject, "editor@example.com").mutation(
        api.entries.removeLocationData,
        {
        galleryId,
        entryId,
        },
      ),
    ).resolves.toEqual({ queued: true });
    const removal = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(removal).toMatchObject({
      kind: "ready",
      entryId,
      processMetadata: true,
      removeLocationData: true,
    });
    if (removal.kind !== "ready") {
      throw new Error("Expected location removal work");
    }
    const newSha = "b".repeat(64);
    const newStorageKey = `public/shared/private-metadata/bb/bb/${newSha}.jpg`;
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: removal.jobId,
      storageKey: newStorageKey,
      sha256: newSha,
      size: 480,
      metadataJson: '{"Make":"Acme"}',
    });

    const completed = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      stats: await galleryStatsOf(ctx, galleryId),
      deleteJobs: await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .take(10),
    }));
    expect(completed.entry).toMatchObject({
      storageKey: newStorageKey,
      sha256: newSha,
      size: 480,
      metadataJson: '{"Make":"Acme"}',
    });
    expect(completed.stats?.totalBytes).toBe(480);
    expect(completed.deleteJobs).toMatchObject([
      {
        storageKey: oldStorageKey,
        deleteOriginal: true,
        deleteEntry: false,
        status: "queued",
      },
    ]);
  });

  test("uploader location removal is limited to the file creator", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const creator = await seedProfile(t, { email: "creator@example.com" });
    const stranger = await seedProfile(t, { email: "stranger@example.com" });
    const galleryId = await asUser(
      t,
      admin.googleSubject,
      "admin@example.com",
    ).mutation(api.galleries.create, {
      name: "Creator uploads",
      slug: "creator-uploads",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "creator-uploads",
      hosts: [{ host: "creator.example.com", rootPath: "/up" }],
    });
    await asUser(t, admin.googleSubject, "admin@example.com").mutation(
      api.galleries.setSystemPermission,
      {
        galleryId,
        principal: "authenticated",
        role: "editor",
      },
    );
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const creatorClient = asUser(
      t,
      creator.googleSubject,
      "creator@example.com",
    );
    const intent = await creatorClient.mutation(
      api.entries.createUploadIntent,
      {
        galleryId,
        folderId: gallery!.rootFolderId!,
        name: "creator-photo.jpg",
        mimeType: "image/jpeg",
        size: 400,
      },
    );
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const sha = "d".repeat(64);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 400,
        sha256: sha,
      storageKey: `protected/uploaders/creator-uploads/dd/dd/${sha}.jpg`,
    });
    const initial = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    if (initial.kind !== "ready") throw new Error("Expected media work");
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: initial.jobId,
      metadataJson: '{"GPSLatitude":-37.8,"GPSLongitude":144.98}',
    });

    await expect(
      asUser(t, stranger.googleSubject, "stranger@example.com").mutation(
        api.entries.removeLocationData,
        {
        galleryId,
        entryId,
        },
      ),
    ).rejects.toThrow("Unauthorized");
    await expect(
      creatorClient.mutation(api.entries.removeLocationData, {
        galleryId,
        entryId,
      }),
    ).resolves.toEqual({ queued: true });
  });

  test("durable storage jobs reclaim expired leases", async () => {
    const t = setupTest();
    const seeded = await t.run(async (ctx) => {
      const profileId = await ctx.db.insert("profiles", {
        identityId: "storage-owner",
        displayName: "Storage owner",
        isAnonymous: false,
        isSystemAdmin: true,
        lastSeenAt: Date.now(),
      });
      const galleryId = await ctx.db.insert("galleries", {
        name: "Durable jobs",
        slug: "durable-jobs",
        kind: "image",
        storageKind: "user",
        storageRoot: "durable",
        maxFileSize: 10_000,
        theme: {},
        itemCount: 1,
        totalBytes: 100,
      });
      const folderId = await ctx.db.insert("folders", {
        galleryId,
        ancestorIds: [],
        name: "Durable jobs",
        slug: "",
        accessPolicy: "inherit",
        discoverability: "listed",
      });
      await ctx.db.patch("galleries", galleryId, { rootFolderId: folderId });
      const entryId = await ctx.db.insert("entries", {
        galleryId,
        folderId,
        ownerProfileId: profileId,
        name: "photo.jpg",
        nameKey: "photo.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 100,
        sha256: "b".repeat(64),
        storageKind: "user",
        storageKey: "public/users/durable/photo.jpg",
        filesystemModifiedAt: 1000,
        filesystemIdentity: "1:2",
        state: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const deleteJobId = await ctx.db.insert("storageDeleteJobs", {
        entryId,
        storageKey: "public/users/durable/old.jpg",
        deleteEntry: false,
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
      return { deleteJobId, entryId, folderId, galleryId };
    });

    const queued = await t.mutation(internal.storageJobs.queueFilesystemSync, {
      galleryId: seeded.galleryId,
      folderId: seeded.folderId,
    });
    expect(queued.queued).toBe(true);
    const syncClaim = await t.mutation(
      internal.storageJobs.claimFilesystemSync,
      {},
    );
    expect(syncClaim.kind).toBe("ready");
    if (syncClaim.kind !== "ready") throw new Error("Expected sync work");
    await t.run(async (ctx) => {
      await ctx.db.patch("filesystemSyncJobs", syncClaim.jobId, {
        leaseExpiresAt: 0,
      });
    });
    const reclaimedSync = await t.mutation(
      internal.storageJobs.claimFilesystemSync,
      {},
    );
    expect(reclaimedSync).toMatchObject({
      kind: "ready",
      jobId: syncClaim.jobId,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("mediaProcessingJobs", {
        entryId: seeded.entryId,
        expectedStorageKey: "public/users/durable/photo.jpg",
        expectedSha256: "b".repeat(64),
        status: "queued",
        attempts: 0,
        availableAt: 0,
      });
    });
    const mediaClaim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(mediaClaim.kind).toBe("ready");
    if (mediaClaim.kind !== "ready") throw new Error("Expected media work");
    await t.run(async (ctx) => {
      await ctx.db.patch("mediaProcessingJobs", mediaClaim.jobId, {
        leaseExpiresAt: 0,
      });
    });
    const reclaimedMedia = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    expect(reclaimedMedia).toMatchObject({
      kind: "ready",
      jobId: mediaClaim.jobId,
    });

    const deleteClaim = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    expect(deleteClaim).toMatchObject({
      kind: "delete",
      jobId: seeded.deleteJobId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("storageDeleteJobs", seeded.deleteJobId, {
        leaseExpiresAt: 0,
      });
    });
    const reclaimedDelete = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    expect(reclaimedDelete).toMatchObject({
      kind: "delete",
      jobId: seeded.deleteJobId,
    });
  });

  test("uploader deletion is visible and authorized only for the uploader", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Owned uploads",
      slug: "owned-uploads",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "owned-uploads",
      hosts: [{ host: "owned.example.com", rootPath: "/up" }],
    });
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const uploader = await seedProfile(t, { anonymous: true });
    const entryId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("entries", {
        galleryId,
        folderId: gallery!.rootFolderId!,
        ownerProfileId: uploader.profileId,
        name: "mine.txt",
        nameKey: "mine.txt",
        mimeType: "text/plain",
        extension: "txt",
        mediaKind: "text",
        size: 12,
        sha256: "e".repeat(64),
        storageKind: "shared",
        storageKey: `protected/uploaders/owned-uploads/ee/ee/${"e".repeat(64)}.txt`,
        state: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await seedGalleryStats(ctx, galleryId, {
        itemCount: 1,
        totalBytes: 12,
      });
      return id;
    });

    const uploaderListing = await t.query(api.folders.list, {
      anonymousClaim: uploader.anonymousClaim,
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(uploaderListing.entries[0]).toMatchObject({
      _id: entryId,
      canDelete: true,
    });
    const adminListing = await authed.query(api.folders.list, {
      galleryId,
      folderId: gallery!.rootFolderId!,
    });
    expect(adminListing.entries[0]).toMatchObject({
      _id: entryId,
      canDelete: false,
    });
    await expect(
      authed.mutation(api.entries.setMarkdownMode, {
        entryId,
        markdown: true,
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      authed.mutation(api.entries.remove, { entryId }),
    ).rejects.toThrow("Unauthorized");

    await expect(
      t.mutation(api.entries.setMarkdownMode, {
        anonymousClaim: uploader.anonymousClaim,
        entryId,
        markdown: true,
      }),
    ).resolves.toEqual({ name: "mine.md" });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).resolves.toMatchObject({ name: "mine.md", extension: "md" });
    await expect(
      t.mutation(api.entries.setMarkdownMode, {
        anonymousClaim: uploader.anonymousClaim,
        entryId,
        markdown: false,
      }),
    ).resolves.toEqual({ name: "mine.txt" });

    await t.mutation(api.entries.remove, {
      anonymousClaim: uploader.anonymousClaim,
      entryId,
    });
    const deleted = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      jobs: await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .take(10),
    }));
    expect(deleted.entry?.state).toBe("deleted");
    expect(deleted.jobs).toHaveLength(1);
  });

  test("gallery and folder settings control every supported thumbnail order", async () => {
    const t = setupTest();
    const owner = await seedProfile(t, {
      email: "sort-owner@example.com",
      admin: true,
    });
    const ownerClient = asUser(
      t,
      owner.googleSubject,
      "sort-owner@example.com",
    );
    const galleryId = await ownerClient.mutation(api.galleries.create, {
      name: "Sorted gallery",
      slug: "sorted-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "sorted-gallery",
      hosts: [{ host: "sorted.example.com", rootPath: "/" }],
    });
    const rootFolderId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      const folderId = gallery!.rootFolderId!;
      for (const entry of [
        { name: "beta.jpg", size: 30, sortTimestamp: 300 },
        { name: "Alpha.jpg", size: 20, sortTimestamp: 100 },
        { name: "charlie.jpg", size: 10, sortTimestamp: 200 },
      ]) {
        await ctx.db.insert("entries", {
          galleryId,
          folderId,
          ownerProfileId: owner.profileId,
          name: entry.name,
          nameKey: entry.name.toLowerCase(),
          mimeType: "image/jpeg",
          extension: "jpg",
          mediaKind: "image",
          size: entry.size,
          sha256: entry.sortTimestamp.toString(16).padStart(64, "0"),
          storageKind: "shared",
          storageKey: `public/shared/sorted-gallery/${entry.name}`,
          sortTimestamp: entry.sortTimestamp,
          state: "ready",
          createdAt: entry.sortTimestamp,
          updatedAt: entry.sortTimestamp,
        });
      }
      return folderId;
    });
    const names = async () =>
      (
        await ownerClient.query(api.entries.listGalleryPage, {
          galleryId,
          folderId: rootFolderId,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) => entry.name);

    await expect(names()).resolves.toEqual([
      "Alpha.jpg",
      "beta.jpg",
      "charlie.jpg",
    ]);
    for (const [sortOrder, expected] of [
      ["nameDesc", ["charlie.jpg", "beta.jpg", "Alpha.jpg"]],
      ["sizeAsc", ["charlie.jpg", "Alpha.jpg", "beta.jpg"]],
      ["sizeDesc", ["beta.jpg", "Alpha.jpg", "charlie.jpg"]],
      ["dateAsc", ["Alpha.jpg", "charlie.jpg", "beta.jpg"]],
      ["dateDesc", ["beta.jpg", "charlie.jpg", "Alpha.jpg"]],
    ] as const) {
      await ownerClient.mutation(api.galleries.update, {
        galleryId,
        sortOrder,
      });
      await expect(names()).resolves.toEqual(expected);
    }

    await ownerClient.mutation(api.folders.update, {
      folderId: rootFolderId,
      name: "Sorted gallery",
      accessPolicy: "inherit",
      discoverability: "listed",
      sortOrder: "nameAsc",
    });
    await expect(names()).resolves.toEqual([
      "Alpha.jpg",
      "beta.jpg",
      "charlie.jpg",
    ]);
    await ownerClient.mutation(api.folders.update, {
      folderId: rootFolderId,
      name: "Sorted gallery",
      accessPolicy: "inherit",
      discoverability: "listed",
      sortOrder: null,
    });
    await expect(names()).resolves.toEqual([
      "beta.jpg",
      "charlie.jpg",
      "Alpha.jpg",
    ]);
  });

  test("gallery pagination and durable select-all deletion cross the old 128 item limit", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const owner = await seedProfile(t, {
        email: "owner@example.com",
        admin: true,
      });
      const ownerClient = asUser(
        t,
        owner.googleSubject,
        "owner@example.com",
      );
      const galleryId = await ownerClient.mutation(api.galleries.create, {
        name: "Large gallery",
        slug: "large-gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "large-gallery",
        hosts: [{ host: "large.example.com", rootPath: "/" }],
      });
      const rootFolderId = await t.run(async (ctx) => {
        const gallery = await ctx.db.get("galleries", galleryId);
        const folderId = gallery!.rootFolderId!;
        for (let index = 0; index < 175; index += 1) {
          const sha256 = index.toString(16).padStart(64, "0");
          await ctx.db.insert("entries", {
            galleryId,
            folderId,
            ownerProfileId: owner.profileId,
            name: `photo-${index}.jpg`,
            nameKey: `photo-${index}.jpg`,
            mimeType: "image/jpeg",
            extension: "jpg",
            mediaKind: "image",
            size: 10,
            sha256,
            storageKind: "shared",
            storageKey: `public/shared/large-gallery/${sha256}.jpg`,
            state: "ready",
            createdAt: index + 1,
            updatedAt: index + 1,
          });
        }
        await seedGalleryStats(ctx, galleryId, {
          itemCount: 175,
          totalBytes: 1_750,
        });
        await seedFolderStats(ctx, galleryId, folderId, {
          itemCount: 175,
          totalBytes: 1_750,
        });
        return folderId;
      });

      const firstPage = await ownerClient.query(api.entries.listGalleryPage, {
        galleryId,
        folderId: rootFolderId,
        paginationOpts: { numItems: 100, cursor: null },
      });
      expect(firstPage.page).toHaveLength(100);
      expect(firstPage.isDone).toBe(false);
      const secondPage = await ownerClient.query(api.entries.listGalleryPage, {
        galleryId,
        folderId: rootFolderId,
        paginationOpts: {
          numItems: 100,
          cursor: firstPage.continueCursor,
        },
      });
      expect(secondPage.page).toHaveLength(75);
      expect(secondPage.isDone).toBe(true);
      await expect(
        ownerClient.query(api.entries.countFolderEntries, {
          galleryId,
          folderId: rootFolderId,
        }),
      ).resolves.toEqual({ count: 175, exact: true });

      const excludedEntryId = firstPage.page[0]._id;
      const operationId = await ownerClient.mutation(
        api.bulkOperations.startDelete,
        {
          galleryId,
          folderId: rootFolderId,
          selection: {
            kind: "folder",
            excludedEntryIds: [excludedEntryId],
          },
        },
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const result = await t.run(async (ctx) => ({
        operation: await ctx.db.get("bulkOperations", operationId),
        excluded: await ctx.db.get("entries", excludedEntryId),
        ready: await ctx.db
          .query("entries")
          .withIndex("by_folderId_and_state", (q) =>
            q.eq("folderId", rootFolderId).eq("state", "ready"),
          )
          .collect(),
        deleteJobs: await ctx.db.query("storageDeleteJobs").collect(),
        stats: await galleryStatsOf(ctx, galleryId),
      }));
      expect(result.operation).toMatchObject({
        status: "complete",
        discoveryComplete: true,
        totalItems: 174,
        completedItems: 174,
        failedItems: 0,
      });
      expect(result.excluded?.state).toBe("ready");
      expect(result.ready.map((entry) => entry._id)).toEqual([
        excludedEntryId,
      ]);
      expect(result.deleteJobs).toHaveLength(174);
      expect(result.stats).toMatchObject({ itemCount: 1, totalBytes: 10 });
      await expect(
        t.run(async (ctx) => folderStatsOf(ctx, rootFolderId)),
      ).resolves.toMatchObject({ itemCount: 1, totalBytes: 10 });
      await expect(
        ownerClient.query(api.entries.countFolderEntries, {
          galleryId,
          folderId: rootFolderId,
        }),
      ).resolves.toEqual({ count: 1, exact: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("gallery owners can queue bulk moves and complete them across galleries", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const authed = asUser(t, admin.googleSubject, "admin@example.com");
    const sourceGalleryId = await authed.mutation(api.galleries.create, {
      name: "Move source",
      slug: "move-source",
      kind: "image",
      storageKind: "shared",
      storageRoot: "move-source",
      hosts: [{ host: "source.example.com", rootPath: "/" }],
    });
    const destinationGalleryId = await authed.mutation(api.galleries.create, {
      name: "Move destination",
      slug: "move-destination",
      kind: "image",
      storageKind: "shared",
      storageRoot: "move-destination",
      hosts: [{ host: "destination.example.com", rootPath: "/" }],
    });
    const [sourceGallery, destinationGallery] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get("galleries", sourceGalleryId),
        ctx.db.get("galleries", destinationGalleryId),
      ]),
    );
    const destinationFolder = await authed.mutation(api.folders.create, {
      galleryId: destinationGalleryId,
      parentId: destinationGallery!.rootFolderId!,
      name: "Chosen folder",
      accessPolicy: "public",
      discoverability: "listed",
    });
    if (destinationFolder.kind !== "complete") {
      throw new Error("Shared gallery unexpectedly required filesystem I/O");
    }
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId: sourceGalleryId,
      folderId: sourceGallery!.rootFolderId!,
      name: "moving.jpg",
      mimeType: "image/jpeg",
      size: 45,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 45,
        sha256: "f".repeat(64),
        storageKey: `public/shared/move-source/ff/ff/${"f".repeat(64)}.jpg`,
    });

    await expect(
      t.run(async (ctx) => folderStatsOf(ctx, sourceGallery!.rootFolderId!)),
    ).resolves.toMatchObject({ itemCount: 1, totalBytes: 45 });
    await expect(
      authed.query(api.galleries.listOwnedImageGalleries, {}),
    ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _id: sourceGalleryId }),
          expect.objectContaining({ _id: destinationGalleryId }),
        ]),
      );
    const operationId = await authed.mutation(api.bulkOperations.startMove, {
      sourceGalleryId,
      sourceFolderId: sourceGallery!.rootFolderId!,
      destinationGalleryId,
      destinationFolderId: destinationFolder.folderId,
      selection: { kind: "ids", entryIds: [entryId] },
    });
    await t.mutation(internal.bulkOperations.process, { operationId });
    await expect(
      t.run(async (ctx) => ctx.db.get("bulkOperations", operationId)),
    ).resolves.toMatchObject({
      status: "processing",
      discoveryComplete: true,
      totalItems: 1,
      completedItems: 0,
    });
    const sourceListing = await authed.query(api.folders.list, {
      galleryId: sourceGalleryId,
      folderId: sourceGallery!.rootFolderId!,
    });
    expect(sourceListing.entries).toHaveLength(0);

    const claim = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    if (claim.kind !== "entryMove") {
      throw new Error(`Expected an entry move, received ${claim.kind}`);
    }
    const destinationStorageKey = `public/shared/move-destination/ff/ff/${"f".repeat(64)}.jpg`;
    await t.mutation(internal.storageGateway.completeEntryMove, {
      jobId: claim.jobId,
      storageKey: destinationStorageKey,
    });
    const completed = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      source: await galleryStatsOf(ctx, sourceGalleryId),
      destination: await galleryStatsOf(ctx, destinationGalleryId),
      sourceFolder: await folderStatsOf(ctx, sourceGallery!.rootFolderId!),
      destinationFolder: await folderStatsOf(ctx, destinationFolder.folderId),
      operation: await ctx.db.get("bulkOperations", operationId),
      deleteJobs: await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .take(10),
    }));
    expect(completed.entry).toMatchObject({
      galleryId: destinationGalleryId,
      folderId: destinationFolder.folderId,
      storageKey: destinationStorageKey,
      state: "ready",
    });
    expect(completed.entry?.migrationState).toBeUndefined();
    expect(completed.source).toMatchObject({ itemCount: 0, totalBytes: 0 });
    expect(completed.destination).toMatchObject({
      itemCount: 1,
      totalBytes: 45,
    });
    expect(completed.sourceFolder).toMatchObject({ itemCount: 0, totalBytes: 0 });
    expect(completed.destinationFolder).toMatchObject({
      itemCount: 1,
      totalBytes: 45,
    });
    expect(completed.operation).toMatchObject({
      status: "complete",
      totalItems: 1,
      completedItems: 1,
      failedItems: 0,
    });
    expect(completed.deleteJobs).toMatchObject([
      {
        storageKey: `public/shared/move-source/ff/ff/${"f".repeat(64)}.jpg`,
        deleteEntry: false,
      },
    ]);
  });

  test("gallery owners can move folders and their subtrees within a gallery", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const owner = await seedProfile(t, {
        email: "owner@example.com",
        admin: true,
      });
      const editor = await seedProfile(t, { email: "editor@example.com" });
      const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
      const editorClient = asUser(t, editor.googleSubject, "editor@example.com");
      const galleryId = await ownerClient.mutation(api.galleries.create, {
        name: "Folder move gallery",
        slug: "folder-move-gallery",
        kind: "image",
        storageKind: "shared",
        storageRoot: "folder-move",
        hosts: [{ host: "folder-move.example.com", rootPath: "/" }],
      });
      const rootFolderId = await t.run(async (ctx) => {
        await ctx.db.insert("galleryRoles", {
          galleryId,
          profileId: editor.profileId,
          role: "editor",
        });
        const gallery = await ctx.db.get("galleries", galleryId);
        return gallery!.rootFolderId!;
      });
      const createFolder = async (parentId: typeof rootFolderId, name: string) => {
        const result = await ownerClient.mutation(api.folders.create, {
          galleryId,
          parentId,
          name,
          accessPolicy: "public" as const,
          discoverability: "listed" as const,
        });
        if (result.kind !== "complete") {
          throw new Error("Shared gallery unexpectedly required filesystem I/O");
        }
        return result.folderId;
      };
      const tripsId = await createFolder(rootFolderId, "Trips");
      const japanId = await createFolder(tripsId, "Japan");
      const archiveId = await createFolder(rootFolderId, "Archive");

      await expect(
        editorClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: archiveId,
          folderIds: [tripsId],
        }),
      ).rejects.toThrow("Unauthorized");
      await expect(
        ownerClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: archiveId,
          folderIds: [rootFolderId],
        }),
      ).rejects.toThrow("The root folder cannot be moved");
      await expect(
        ownerClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: japanId,
          folderIds: [tripsId],
        }),
      ).rejects.toThrow("Trips cannot be moved into itself");

      await expect(
        ownerClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: archiveId,
          folderIds: [tripsId],
        }),
      ).resolves.toEqual({ kind: "complete", moved: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const moved = await t.run(async (ctx) => ({
        trips: await ctx.db.get("folders", tripsId),
        japan: await ctx.db.get("folders", japanId),
      }));
      expect(moved.trips).toMatchObject({
        parentId: archiveId,
        ancestorIds: [rootFolderId, archiveId],
      });
      expect(moved.japan).toMatchObject({
        ancestorIds: [rootFolderId, archiveId, tripsId],
      });

      await expect(
        ownerClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: archiveId,
          folderIds: [tripsId],
        }),
      ).resolves.toEqual({ kind: "complete", moved: 0 });

      const conflictingId = await createFolder(rootFolderId, "Trips");
      await expect(
        ownerClient.mutation(api.folders.moveMany, {
          galleryId,
          destinationFolderId: archiveId,
          folderIds: [conflictingId],
        }),
      ).rejects.toThrow("A folder named Trips already exists in the destination");
    } finally {
      vi.useRealTimers();
    }
  });

  test("user-backed folder moves commit after the filesystem operation and repath entries", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      const owner = await seedProfile(t, {
        email: "owner@example.com",
        admin: true,
      });
      const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
      const galleryId = await ownerClient.mutation(api.galleries.create, {
        name: "Movedir gallery",
        slug: "movedir-gallery",
        kind: "image",
        storageKind: "user",
        storageRoot: "movedir-studio",
        hosts: [{ host: "movedir.example.com", rootPath: "/" }],
      });
      const { rootFolderId, shootsId, archiveId, entryId } = await t.run(
        async (ctx) => {
          const gallery = await ctx.db.get("galleries", galleryId);
          const rootFolderId = gallery!.rootFolderId!;
          const shootsId = await ctx.db.insert("folders", {
            galleryId,
            parentId: rootFolderId,
            ancestorIds: [rootFolderId],
            name: "Shoots",
            slug: "shoots",
            accessPolicy: "public",
            discoverability: "listed",
            filesystemIdentity: "4:40",
          });
          const archiveId = await ctx.db.insert("folders", {
            galleryId,
            parentId: rootFolderId,
            ancestorIds: [rootFolderId],
            name: "Archive",
            slug: "archive",
            accessPolicy: "public",
            discoverability: "listed",
            filesystemIdentity: "4:41",
          });
          const entryId = await ctx.db.insert("entries", {
            galleryId,
            folderId: shootsId,
            ownerProfileId: owner.profileId,
            name: "portrait.jpg",
            nameKey: "portrait.jpg",
            mimeType: "image/jpeg",
            extension: "jpg",
            mediaKind: "image",
            size: 20,
            sha256: "d".repeat(64),
            storageKind: "user",
            storageKey: "public/users/movedir-studio/Shoots/portrait.jpg",
            state: "ready",
            createdAt: 1,
            updatedAt: 1,
          });
          return { rootFolderId, shootsId, archiveId, entryId };
        },
      );

      const result = await ownerClient.mutation(api.folders.moveMany, {
        galleryId,
        destinationFolderId: archiveId,
        folderIds: [shootsId],
      });
      if (result.kind !== "filesystem") {
        throw new Error("Expected a filesystem operation");
      }
      expect(result.moved).toBe(1);
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].folderId).toBe(shootsId);
      const beforeCommit = await t.run(async (ctx) =>
        ctx.db.get("folders", shootsId),
      );
      expect(beforeCommit).toMatchObject({ parentId: rootFolderId });

      const claim = await t.mutation(
        internal.filesystemSync.claimFilesystemOperation,
        {
          operationId: result.operations[0].operationId,
          token: result.operations[0].token,
        },
      );
      expect(claim).toMatchObject({
        kind: "move",
        sourceSegments: ["Shoots"],
        destinationSegments: ["Archive", "Shoots"],
      });
      await t.mutation(internal.filesystemSync.completeFilesystemOperation, {
        operationId: result.operations[0].operationId,
        identity: "4:40",
        modifiedAt: 1234,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const committed = await t.run(async (ctx) => ({
        folder: await ctx.db.get("folders", shootsId),
        entry: await ctx.db.get("entries", entryId),
      }));
      expect(committed.folder).toMatchObject({
        parentId: archiveId,
        ancestorIds: [rootFolderId, archiveId],
      });
      expect(committed.entry).toMatchObject({
        storageKey: "public/users/movedir-studio/Archive/Shoots/portrait.jpg",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("cron dismisses finished bulk operations idle for an hour", async () => {
    const t = setupTest();
    const admin = await seedProfile(t, { admin: true });
    const authed = asUser(t, admin.googleSubject);
    const galleryId = await authed.mutation(api.galleries.create, {
      name: "Sweep",
      slug: "sweep",
      kind: "image",
      storageKind: "shared",
      storageRoot: "sweep",
      hosts: [{ host: "sweep.example.com", rootPath: "/" }],
    });
    const rootFolderId = await t.run(async (ctx) => {
      const gallery = await ctx.db.get("galleries", galleryId);
      if (gallery?.rootFolderId === undefined) {
        throw new Error("gallery root folder missing");
      }
      return gallery.rootFolderId;
    });
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const rows = await t.run(async (ctx) => {
      const insert = (
        status: "queued" | "complete" | "failed",
        updatedAt: number,
        dismissedAt?: number,
      ) =>
        ctx.db.insert("bulkOperations", {
          actorProfileId: admin.profileId,
          kind: "delete",
          sourceGalleryId: galleryId,
          sourceFolderId: rootFolderId,
          selectionKind: "folder",
          cutoffCreatedAt: updatedAt,
          nextIndex: 0,
          discoveryComplete: true,
          status,
          totalItems: 1,
          completedItems: status === "complete" ? 1 : 0,
          failedItems: status === "failed" ? 1 : 0,
          conflictItems: 0,
          createdAt: updatedAt,
          updatedAt,
          ...(dismissedAt === undefined ? {} : { dismissedAt }),
        });
      return {
        staleComplete: await insert("complete", now - 2 * hour),
        staleFailed: await insert("failed", now - 2 * hour),
        freshComplete: await insert("complete", now - hour / 2),
        staleRunning: await insert("queued", now - 2 * hour),
        alreadyDismissed: await insert("complete", now - 2 * hour, now - hour),
      };
    });

    const dismissed = await t.mutation(
      internal.bulkOperations.dismissStale,
      {},
    );
    expect(dismissed).toBe(2);

    const after = await t.run(async (ctx) => ({
      staleComplete: await ctx.db.get("bulkOperations", rows.staleComplete),
      staleFailed: await ctx.db.get("bulkOperations", rows.staleFailed),
      freshComplete: await ctx.db.get("bulkOperations", rows.freshComplete),
      staleRunning: await ctx.db.get("bulkOperations", rows.staleRunning),
      alreadyDismissed: await ctx.db.get(
        "bulkOperations",
        rows.alreadyDismissed,
      ),
    }));
    expect(after.staleComplete?.dismissedAt).toBeDefined();
    expect(after.staleFailed?.dismissedAt).toBeDefined();
    expect(after.freshComplete?.dismissedAt).toBeUndefined();
    expect(after.staleRunning?.dismissedAt).toBeUndefined();
    expect(after.alreadyDismissed?.dismissedAt).toBe(now - hour);
    expect(
      await t.mutation(internal.bulkOperations.dismissStale, {}),
    ).toBe(0);
  });
});
