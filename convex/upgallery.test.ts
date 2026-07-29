/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { sha256 } from "./lib/crypto";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

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
  const anonymousClaimHash =
    anonymousClaim === undefined ? undefined : await sha256(anonymousClaim);
  return await t.run(async (ctx) => {
    const profileId = await ctx.db.insert("profiles", {
      googleSubject,
      displayName: input.anonymous ? "Anonymous" : "Test User",
      email: input.email,
      isAnonymous: input.anonymous ?? false,
      isSystemAdmin: input.admin ?? false,
      anonymousClaimHash,
      lastSeenAt: Date.now(),
    });
    return { googleSubject, profileId, anonymousClaim };
  });
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
    const previousSiteUrl = process.env.SITE_URL;
    process.env.SITE_URL = "https://primary.example.com";
    try {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        const galleryId = await ctx.db.insert("galleries", {
          name: "Tenant gallery",
          slug: "tenant-gallery",
          kind: "image",
          storageKind: "shared",
          storageRoot: "tenant",
          maxFileSize: 1024,
          uploaderAccess: "sso",
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
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "https://primary.example.com",
        }),
      ).resolves.toBe(true);
      await expect(
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "https://photos.example.com",
        }),
      ).resolves.toBe(true);
      await expect(
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "https://attacker.example",
        }),
      ).resolves.toBe(false);
      await expect(
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "http://photos.example.com",
        }),
      ).resolves.toBe(false);
      await expect(
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "https://photos.example.com/not-an-origin",
        }),
      ).resolves.toBe(false);
      process.env.SITE_URL = "http://localhost:5173";
      await expect(
        t.query(internal.googleAuthSessions.isAllowedWebOrigin, {
          origin: "http://localhost:5173",
        }),
      ).resolves.toBe(true);
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env.SITE_URL;
      } else {
        process.env.SITE_URL = previousSiteUrl;
      }
    }
  });

  test("a system admin creates a routed gallery with a root owner grant", async () => {
    const t = convexTest(schema, modules);
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
      return { gallery, roles, hosts };
    });

    expect(created.gallery?.rootFolderId).toBeDefined();
    expect(created.roles).toMatchObject([{ role: "owner" }]);
    expect(created.hosts).toMatchObject([
      { host: "photos.example.com", rootPath: "/" },
    ]);
  });

  test("anonymous uploader access creates a capability without storing its plaintext", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const galleryId = await asUser(
      t,
      admin.googleSubject,
      "admin@example.com",
    ).mutation(
      api.galleries.create,
      {
        name: "Drop box",
        slug: "drop-box",
        kind: "uploader",
        storageKind: "shared",
        storageRoot: "drop-box",
        hosts: [{ host: "up.example.com", rootPath: "/up" }],
      },
    );
    const gallery = await t.run(async (ctx) =>
      ctx.db.get("galleries", galleryId),
    );
    const anonymous = await seedProfile(t, { anonymous: true });
    const result = await t.mutation(api.entries.createUploadIntent, {
      anonymousClaim: anonymous.anonymousClaim,
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

    expect(result.token.length).toBeGreaterThan(32);
    expect(intent?.tokenHash).not.toBe(result.token);
    expect(intent?.passwordHash).not.toBe("secret");
    expect(intent?.ownerProfileId).toBe(anonymous.profileId);
  });

  test("uploader file and attachment serves share one counted view metric", async () => {
    const t = convexTest(schema, modules);
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
    const entryId = await t.mutation(
      internal.storageGateway.completeUpload,
      {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 123,
        sha256: "d".repeat(64),
        storageKey: `protected/uploaders/counted-files/dd/dd/${"d".repeat(64)}.jpg`,
        thumbnailKey: `protected/uploaders/counted-files/dd/dd/${"d".repeat(64)}.thumb.jpg`,
      },
    );
    const visitor = await seedProfile(t, { anonymous: true });

    await expect(
      t.query(api.entries.getForUploaderView, {
        anonymousClaim: visitor.anonymousClaim,
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
        anonymousClaim: visitor.anonymousClaim,
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
        anonymousClaim: visitor.anonymousClaim,
        galleryId,
        folderId: gallery!.rootFolderId!,
        entryIds: [entryId],
      },
    );
    expect(thumbnailTicket).toBeDefined();
    await t.mutation(internal.storageGateway.claimDownload, {
      token: thumbnailTicket!.token,
    });

    const counter = await t.run(async (ctx) =>
      ctx.db
        .query("entryCounters")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .unique(),
    );
    expect(counter).toMatchObject({ views: 1, downloads: 0 });
  });

  test("Google sign-in upgrades an anonymous profile without losing ownership", async () => {
    const t = convexTest(schema, modules);
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
      googleSubject,
      email: "merged@example.com",
      isAnonymous: false,
    });
    expect(mergedProfile?.anonymousClaimHash).toBeUndefined();
  });

  test("a private folder is hidden from an unrelated anonymous profile", async () => {
    const t = convexTest(schema, modules);
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
    const privateFolder = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: gallery!.rootFolderId!,
      name: "Members only",
      privacy: "private",
    });
    if (privateFolder.kind !== "complete") {
      throw new Error("Shared storage folder unexpectedly required I/O");
    }
    const stranger = await seedProfile(t, { anonymous: true });

    await expect(
      t.query(api.folders.list, {
        anonymousClaim: stranger.anonymousClaim,
        galleryId,
        folderId: privateFolder.folderId,
      }),
    ).rejects.toThrow("Unauthorized");
  });

  test("a user-backed directory is reconciled incrementally and skips an unchanged mtime", async () => {
    const t = convexTest(schema, modules);
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
    if (firstClaim.kind !== "ready") throw new Error("Sync was unexpectedly busy");
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
      await t.mutation(
        internal.filesystemSync.compareFilesystemDirectory,
        {
          galleryId,
          folderId,
          syncId: firstClaim.syncId,
          modifiedAt: 1000,
        },
      ),
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
    await t.mutation(
      internal.filesystemSync.reconcileFilesystemFile,
      {
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
          "public/users/alice/photos/.upgallery/thumbnails/aa/aa/thumb.jpg",
      },
    );
    await t.mutation(
      internal.filesystemSync.completeFilesystemSync,
      {
        galleryId,
        folderId,
        syncId: firstClaim.syncId,
        modifiedAt: 1000,
      },
    );

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
    if (secondClaim.kind !== "ready") throw new Error("Sync was unexpectedly busy");
    expect(secondClaim.knownChildFolderIds).toContain(newFolderId);
    expect(
      await t.mutation(
        internal.filesystemSync.compareFilesystemDirectory,
        {
          galleryId,
          folderId,
          syncId: secondClaim.syncId,
          modifiedAt: 1000,
        },
      ),
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
    const t = convexTest(schema, modules);
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
      privacy: "unlisted",
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
      privacy: "unlisted",
      filesystemIdentity: "2:20",
    });
  });

  test("image upload completion queues durable media processing", async () => {
    const t = convexTest(schema, modules);
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
    const entryId = await t.mutation(
      internal.storageGateway.completeUpload,
      {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 123,
        sha256: "c".repeat(64),
        storageKey: `public/shared/media-queue/cc/cc/${"c".repeat(64)}.jpg`,
      },
    );
    const job = await t.run(async (ctx) =>
      ctx.db
        .query("mediaProcessingJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .unique(),
    );
    expect(job).toMatchObject({
      status: "queued",
      attempts: 0,
      expectedSha256: "c".repeat(64),
    });

    const claim = await t.mutation(
      internal.storageJobs.claimMediaProcessing,
      {},
    );
    if (claim.kind !== "ready") throw new Error("Expected media work");
    await t.mutation(internal.storageJobs.completeMediaProcessing, {
      jobId: claim.jobId,
      thumbnailKey: `public/shared/media-queue/cc/cc/${"c".repeat(64)}.thumb.jpg`,
      metadataJson: "{\"Make\":\"Test\"}",
    });
    const completed = await t.run(async (ctx) => ({
      entry: await ctx.db.get("entries", entryId),
      jobs: await ctx.db
        .query("mediaProcessingJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId))
        .take(10),
    }));
    expect(completed.entry?.thumbnailKey).toContain(".thumb.jpg");
    expect(completed.entry?.metadataJson).toBe("{\"Make\":\"Test\"}");
    expect(completed.jobs).toHaveLength(0);
  });

  test("durable storage jobs reclaim expired leases", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const profileId = await ctx.db.insert("profiles", {
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
        uploaderAccess: "restricted",
        theme: {},
        itemCount: 1,
        totalBytes: 100,
      });
      const folderId = await ctx.db.insert("folders", {
        galleryId,
        ancestorIds: [],
        name: "Durable jobs",
        slug: "",
        privacy: "public",
      });
      await ctx.db.patch("galleries", galleryId, { rootFolderId: folderId });
      const entryId = await ctx.db.insert("entries", {
        galleryId,
        folderId,
        ownerProfileId: profileId,
        name: "photo.jpg",
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

    const queued = await t.mutation(
      internal.storageJobs.queueFilesystemSync,
      { galleryId: seeded.galleryId, folderId: seeded.folderId },
    );
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
    const t = convexTest(schema, modules);
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
      await ctx.db.patch("galleries", galleryId, {
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
      authed.mutation(api.entries.remove, { entryId }),
    ).rejects.toThrow("Unauthorized");

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

  test("gallery owners can queue bulk moves and complete them across galleries", async () => {
    const t = convexTest(schema, modules);
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
      privacy: "public",
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
    const entryId = await t.mutation(
      internal.storageGateway.completeUpload,
      {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 45,
        sha256: "f".repeat(64),
        storageKey: `public/shared/move-source/ff/ff/${"f".repeat(64)}.jpg`,
      },
    );

    await expect(authed.query(api.galleries.listOwnedImageGalleries)).resolves
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _id: sourceGalleryId }),
          expect.objectContaining({ _id: destinationGalleryId }),
        ]),
      );
    const move = await authed.mutation(api.entries.moveMany, {
      sourceGalleryId,
      destinationGalleryId,
      destinationFolderId: destinationFolder.folderId,
      entryIds: [entryId],
    });
    expect(move).toEqual({ queued: 1 });
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
      source: await ctx.db.get("galleries", sourceGalleryId),
      destination: await ctx.db.get("galleries", destinationGalleryId),
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
    expect(completed.deleteJobs).toMatchObject([
      {
        storageKey: `public/shared/move-source/ff/ff/${"f".repeat(64)}.jpg`,
        deleteEntry: false,
      },
    ]);
  });
});
