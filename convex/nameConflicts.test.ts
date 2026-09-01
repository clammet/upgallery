/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import authComponent from "@clammet/convex-googly-auth/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { autoRenamedFileName, entryNameKey } from "./lib/normalize";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

function setupTest() {
  const t = convexTest(schema, modules);
  authComponent.register(t);
  return t;
}

async function seedAdmin(t: TestConvex<typeof schema>) {
  profileSequence += 1;
  const email = `admin-${profileSequence}@example.com`;
  const googleSubject = `https://accounts.google.com|conflict-admin-${profileSequence}`;
  const authed = t.withIdentity({
    subject: googleSubject.split("|")[1]!,
    issuer: "https://accounts.google.com",
    tokenIdentifier: googleSubject,
    email,
    name: "Test Admin",
  });
  const profileId = await authed.mutation(api.profiles.ensureCurrent, {});
  await t.run(async (ctx) => {
    await ctx.db.patch("profiles", profileId, { isSystemAdmin: true });
  });
  return { authed, profileId };
}

async function createGallery(
  t: TestConvex<typeof schema>,
  authed: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  input: { slug: string; kind: "image" | "uploader" },
) {
  const galleryId = await authed.mutation(api.galleries.create, {
    name: input.slug,
    slug: input.slug,
    kind: input.kind,
    storageKind: "shared",
    storageRoot: input.slug,
    hosts: [{ host: `${input.slug}.example.com`, rootPath: "/" }],
  });
  const gallery = await t.run(async (ctx) => ctx.db.get("galleries", galleryId));
  return { galleryId, rootFolderId: gallery!.rootFolderId! };
}

// Drives one upload through intent, claim, and completion the way the
// storage server does, returning the stored entry.
async function uploadFile(
  t: TestConvex<typeof schema>,
  authed: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  input: {
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
    name: string;
    sha: string;
    conflict?: "replace" | "rename";
  },
) {
  const intent = await authed.mutation(api.entries.createUploadIntent, {
    galleryId: input.galleryId,
    folderId: input.folderId,
    name: input.name,
    mimeType: "image/jpeg",
    size: 10,
    conflict: input.conflict,
  });
  const claim = await t.mutation(internal.storageGateway.claimUpload, intent);
  const sha256 = input.sha.repeat(64);
  const completed = await t.mutation(internal.storageGateway.completeUpload, {
    intentId: intent.intentId,
    actualMimeType: "image/jpeg",
    extension: "jpg",
    mediaKind: "image",
    size: 10,
    sha256,
    storageKey: `public/shared/root/${sha256}.jpg`,
  });
  const entry = await t.run(async (ctx) =>
    ctx.db.get("entries", completed.entryId),
  );
  return { claim, completed, entry: entry! };
}

async function readyNames(t: TestConvex<typeof schema>, folderId: Id<"folders">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", folderId).eq("state", "ready"),
        )
        .collect()
    )
      .map((entry) => entry.name)
      .sort(),
  );
}

describe("autoRenamedFileName", () => {
  test("adds a counter before the extension and replaces an existing one", () => {
    expect(autoRenamedFileName("photo.jpg", 2)).toBe("photo (2).jpg");
    expect(autoRenamedFileName("photo (2).jpg", 3)).toBe("photo (3).jpg");
    expect(autoRenamedFileName("README", 2)).toBe("README (2)");
    expect(autoRenamedFileName(".hidden", 2)).toBe(".hidden (2)");
    expect(autoRenamedFileName("archive.tar.gz", 4)).toBe("archive.tar (4).gz");
  });

  test("keeps renamed names within the file name limit", () => {
    const renamed = autoRenamedFileName(`${"a".repeat(240)}.jpg`, 12);
    expect(renamed.length).toBeLessThanOrEqual(240);
    expect(renamed.endsWith(" (12).jpg")).toBe(true);
  });

  test("name keys fold case", () => {
    expect(entryNameKey("Photo.JPG")).toBe("photo.jpg");
  });
});

describe("name conflicts", () => {
  test("image gallery uploads refuse, replace, or rename a name the folder already holds", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "unique-names",
      kind: "image",
    });
    const original = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "Photo.jpg",
      sha: "a",
    });
    expect(original.entry).toMatchObject({
      name: "Photo.jpg",
      nameKey: "photo.jpg",
    });

    // A case variant is the same name: refused before any bytes are sent.
    await expect(
      authed.mutation(api.entries.createUploadIntent, {
        galleryId,
        folderId: rootFolderId,
        name: "photo.JPG",
        mimeType: "image/jpeg",
        size: 10,
      }),
    ).rejects.toMatchObject({ data: { code: "entry_exists", name: "photo.JPG" } });

    // Auto rename picks the first free "(n)" variant, settled at claim time.
    const renamed = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "photo.JPG",
      sha: "b",
      conflict: "rename",
    });
    expect(renamed.claim.name).toBe("photo (2).JPG");
    expect(renamed.completed.name).toBe("photo (2).JPG");
    expect(renamed.entry).toMatchObject({
      name: "photo (2).JPG",
      nameKey: "photo (2).jpg",
    });
    const again = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "photo.jpg",
      sha: "c",
      conflict: "rename",
    });
    expect(again.entry.name).toBe("photo (3).jpg");

    // Replace keeps the existing entry (and its id) but takes the new file
    // and name, and queues the displaced original for cleanup.
    const statsBefore = await t.run(async (ctx) =>
      ctx.db
        .query("galleryStats")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
        .unique(),
    );
    const replaced = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "PHOTO.jpg",
      sha: "d",
      conflict: "replace",
    });
    expect(replaced.claim.replacesStorageKey).toBeUndefined();
    expect(replaced.entry._id).toBe(original.entry._id);
    expect(replaced.entry).toMatchObject({
      name: "PHOTO.jpg",
      nameKey: "photo.jpg",
      sha256: "d".repeat(64),
      state: "ready",
    });
    const cleanup = await t.run(async (ctx) => ({
      deleteJobs: await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", original.entry._id))
        .collect(),
      stats: await ctx.db
        .query("galleryStats")
        .withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId))
        .unique(),
    }));
    expect(cleanup.deleteJobs).toMatchObject([
      {
        storageKey: original.entry.storageKey,
        deleteOriginal: true,
        deleteEntry: false,
      },
    ]);
    expect(cleanup.stats?.itemCount).toBe(statsBefore!.itemCount);
    expect(await readyNames(t, rootFolderId)).toEqual([
      "PHOTO.jpg",
      "photo (2).JPG",
      "photo (3).jpg",
    ]);
  });

  test("a name taken while the upload was in flight fails completion without a policy", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "upload-race",
      kind: "image",
    });
    const intent = await authed.mutation(api.entries.createUploadIntent, {
      galleryId,
      folderId: rootFolderId,
      name: "race.jpg",
      mimeType: "image/jpeg",
      size: 10,
    });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    // While the first upload is still claimed, a second intent for the same
    // name is refused: the claimed name is reserved.
    await expect(
      authed.mutation(api.entries.createUploadIntent, {
        galleryId,
        folderId: rootFolderId,
        name: "RACE.jpg",
        mimeType: "image/jpeg",
        size: 10,
      }),
    ).rejects.toMatchObject({ data: { code: "entry_exists" } });
    await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "Race.JPG",
      sha: "e",
      conflict: "rename",
    });
    await expect(
      t.mutation(internal.storageGateway.completeUpload, {
        intentId: intent.intentId,
        actualMimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        size: 10,
        sha256: "f".repeat(64),
        storageKey: `public/shared/root/${"f".repeat(64)}.jpg`,
      }),
    ).resolves.toMatchObject({ name: "race.jpg" });
    expect(await readyNames(t, rootFolderId)).toEqual([
      "Race (2).JPG",
      "race.jpg",
    ]);
  });

  test("uploader galleries still accept duplicate names", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "dupes-ok",
      kind: "uploader",
    });
    const first = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "notes.txt",
      sha: "1",
    });
    const second = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "Notes.txt",
      sha: "2",
    });
    expect(first.entry._id).not.toBe(second.entry._id);
    expect(await readyNames(t, rootFolderId)).toEqual(["Notes.txt", "notes.txt"]);
  });

  test("renames refuse another file's name in any case but allow re-casing your own", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "rename-check",
      kind: "image",
    });
    const first = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "first.jpg",
      sha: "a",
    });
    await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "second.jpg",
      sha: "b",
    });
    await expect(
      authed.mutation(api.entries.rename, {
        galleryId,
        entryId: first.entry._id,
        name: "SECOND.jpg",
      }),
    ).rejects.toThrow("A file with that name already exists here");
    await expect(
      authed.mutation(api.entries.rename, {
        galleryId,
        entryId: first.entry._id,
        name: "FIRST.jpg",
      }),
    ).resolves.toMatchObject({ kind: "complete", name: "FIRST.jpg" });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", first.entry._id)),
    ).resolves.toMatchObject({ name: "FIRST.jpg", nameKey: "first.jpg" });
  });

  test("bulk moves park conflicting items until a policy queues them", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "move-conflicts",
      kind: "image",
    });
    const destination = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: rootFolderId,
      name: "Destination",
      accessPolicy: "public",
      discoverability: "listed",
    });
    if (destination.kind !== "complete") throw new Error("Expected a folder");
    const occupant = await uploadFile(t, authed, {
      galleryId,
      folderId: destination.folderId,
      name: "DUPE.jpg",
      sha: "0",
    });
    const dupe = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "dupe.jpg",
      sha: "1",
    });
    const other = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "other.jpg",
      sha: "2",
    });
    const second = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "second.jpg",
      sha: "3",
    });

    const operationId = await authed.mutation(api.bulkOperations.startMove, {
      sourceGalleryId: galleryId,
      sourceFolderId: rootFolderId,
      destinationGalleryId: galleryId,
      destinationFolderId: destination.folderId,
      selection: {
        kind: "ids",
        entryIds: [dupe.entry._id, other.entry._id],
      },
    });
    await t.mutation(internal.bulkOperations.process, { operationId });
    // other.jpg is queued; dupe.jpg is parked and stays usable where it is.
    let listed = await authed.query(api.bulkOperations.listMine, {});
    expect(listed).toMatchObject([
      {
        _id: operationId,
        status: "processing",
        totalItems: 2,
        conflictItems: 1,
        conflicts: [{ entryId: dupe.entry._id, name: "dupe.jpg" }],
      },
    ]);
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", dupe.entry._id)),
    ).resolves.toMatchObject({ folderId: rootFolderId, state: "ready" });
    expect(
      (await t.run(async (ctx) => ctx.db.get("entries", dupe.entry._id)))
        ?.moveJobId,
    ).toBeUndefined();

    // Finish the clean move; the operation now waits only on the conflict.
    const otherClaim = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    if (otherClaim.kind !== "entryMove") throw new Error("Expected a move");
    expect(otherClaim).toMatchObject({ fileName: "other.jpg", replace: false });
    await t.mutation(internal.storageGateway.completeEntryMove, {
      jobId: otherClaim.jobId,
      storageKey: other.entry.storageKey,
    });
    listed = await authed.query(api.bulkOperations.listMine, {});
    expect(listed[0]).toMatchObject({
      status: "conflict",
      completedItems: 1,
      conflictItems: 1,
    });

    // Auto rename: the parked item is queued under a free name.
    const conflictJobId = listed[0]!.conflicts[0]!.jobId;
    await authed.mutation(api.bulkOperations.resolveConflict, {
      jobId: conflictJobId,
      policy: "rename",
    });
    listed = await authed.query(api.bulkOperations.listMine, {});
    expect(listed[0]).toMatchObject({
      status: "processing",
      conflictItems: 0,
      conflicts: [],
    });
    const renameClaim = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    if (renameClaim.kind !== "entryMove") throw new Error("Expected a move");
    expect(renameClaim).toMatchObject({
      entryId: dupe.entry._id,
      fileName: "dupe (2).jpg",
      replace: false,
    });
    await t.mutation(internal.storageGateway.completeEntryMove, {
      jobId: renameClaim.jobId,
      storageKey: dupe.entry.storageKey,
    });
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", dupe.entry._id)),
    ).resolves.toMatchObject({
      folderId: destination.folderId,
      name: "dupe (2).jpg",
      nameKey: "dupe (2).jpg",
    });
    expect(
      (await authed.query(api.bulkOperations.listMine, {}))[0],
    ).toMatchObject({ status: "complete", completedItems: 2 });

    // Replace all: a second operation's parked item replaces the occupant.
    await authed.mutation(api.entries.rename, {
      galleryId,
      entryId: second.entry._id,
      name: "Dupe.JPG",
    });
    const secondOperationId = await authed.mutation(
      api.bulkOperations.startMove,
      {
        sourceGalleryId: galleryId,
        sourceFolderId: rootFolderId,
        destinationGalleryId: galleryId,
        destinationFolderId: destination.folderId,
        selection: { kind: "ids", entryIds: [second.entry._id] },
      },
    );
    await t.mutation(internal.bulkOperations.process, {
      operationId: secondOperationId,
    });
    expect(
      (await authed.query(api.bulkOperations.listMine, {})).find(
        (operation) => operation._id === secondOperationId,
      ),
    ).toMatchObject({ status: "conflict", conflictItems: 1 });
    await expect(
      authed.mutation(api.bulkOperations.resolveConflicts, {
        policy: "replace",
      }),
    ).resolves.toBe(1);
    await t.mutation(internal.bulkOperations.applyConflictPolicy, {
      operationId: secondOperationId,
    });
    const replaceClaim = await t.mutation(
      internal.storageGateway.claimMaintenance,
      {},
    );
    if (replaceClaim.kind !== "entryMove") throw new Error("Expected a move");
    expect(replaceClaim).toMatchObject({
      entryId: second.entry._id,
      fileName: "Dupe.JPG",
      replace: true,
    });
    await t.mutation(internal.storageGateway.completeEntryMove, {
      jobId: replaceClaim.jobId,
      storageKey: second.entry.storageKey,
    });
    const after = await t.run(async (ctx) => ({
      occupant: await ctx.db.get("entries", occupant.entry._id),
      moved: await ctx.db.get("entries", second.entry._id),
      occupantDelete: await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", occupant.entry._id))
        .collect(),
    }));
    expect(after.occupant).toMatchObject({ state: "deleted" });
    expect(after.occupantDelete).toMatchObject([
      { deleteEntry: true, deleteOriginal: true },
    ]);
    expect(after.moved).toMatchObject({
      folderId: destination.folderId,
      name: "Dupe.JPG",
    });
    expect(await readyNames(t, destination.folderId)).toEqual([
      "Dupe.JPG",
      "dupe (2).jpg",
      "other.jpg",
    ]);
    expect(
      (await authed.query(api.bulkOperations.listMine, {})).find(
        (operation) => operation._id === secondOperationId,
      ),
    ).toMatchObject({ status: "complete", completedItems: 1 });
  });

  test("parked items survive Clear and leave the operation on Skip", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createGallery(t, authed, {
      slug: "dismiss-conflicts",
      kind: "image",
    });
    const destination = await authed.mutation(api.folders.create, {
      galleryId,
      parentId: rootFolderId,
      name: "Target",
      accessPolicy: "public",
      discoverability: "listed",
    });
    if (destination.kind !== "complete") throw new Error("Expected a folder");
    await uploadFile(t, authed, {
      galleryId,
      folderId: destination.folderId,
      name: "same.jpg",
      sha: "a",
    });
    const moving = await uploadFile(t, authed, {
      galleryId,
      folderId: rootFolderId,
      name: "SAME.jpg",
      sha: "b",
    });
    const operationId = await authed.mutation(api.bulkOperations.startMove, {
      sourceGalleryId: galleryId,
      sourceFolderId: rootFolderId,
      destinationGalleryId: galleryId,
      destinationFolderId: destination.folderId,
      selection: { kind: "ids", entryIds: [moving.entry._id] },
    });
    await t.mutation(internal.bulkOperations.process, { operationId });
    expect(
      (await authed.query(api.bulkOperations.listMine, {}))[0],
    ).toMatchObject({ status: "conflict", conflictItems: 1 });
    // Clear leaves an operation that still waits on conflicts alone.
    await expect(
      authed.mutation(api.bulkOperations.dismissFinished, {}),
    ).resolves.toBe(0);
    expect(
      (await authed.query(api.bulkOperations.listMine, {}))[0],
    ).toMatchObject({ status: "conflict", conflictItems: 1 });
    // Skip withdraws the parked item from the operation, which then counts
    // as complete and can be cleared.
    await expect(
      authed.mutation(api.bulkOperations.resolveConflicts, { policy: "skip" }),
    ).resolves.toBe(1);
    await t.mutation(internal.bulkOperations.applyConflictPolicy, {
      operationId,
    });
    expect(
      (await authed.query(api.bulkOperations.listMine, {}))[0],
    ).toMatchObject({
      status: "complete",
      totalItems: 0,
      conflictItems: 0,
      conflicts: [],
    });
    await expect(
      authed.mutation(api.bulkOperations.dismissFinished, {}),
    ).resolves.toBe(1);
    expect(await authed.query(api.bulkOperations.listMine, {})).toEqual([]);
    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query("entryMoveJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", moving.entry._id))
        .collect(),
    );
    expect(jobs).toEqual([]);
    await expect(
      t.run(async (ctx) => ctx.db.get("entries", moving.entry._id)),
    ).resolves.toMatchObject({ folderId: rootFolderId, state: "ready" });
  });
});

describe("uploader attribution", () => {
  test("gallery viewer resolves a direct-linked entry outside the current page", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const gallery = await createGallery(t, authed, {
      slug: "direct-linked-gallery-entry",
      kind: "image",
    });
    const first = await uploadFile(t, authed, {
      galleryId: gallery.galleryId,
      folderId: gallery.rootFolderId,
      name: "first.jpg",
      sha: "1",
    });
    const second = await uploadFile(t, authed, {
      galleryId: gallery.galleryId,
      folderId: gallery.rootFolderId,
      name: "second.jpg",
      sha: "2",
    });
    const page = await authed.query(api.entries.listGalleryPage, {
      galleryId: gallery.galleryId,
      folderId: gallery.rootFolderId,
      paginationOpts: { cursor: null, numItems: 1 },
    });
    const outsidePage = [first.entry, second.entry].find(
      (entry) => entry._id !== page.page[0]?._id,
    );
    expect(outsidePage).toBeDefined();

    await expect(
      authed.query(api.entries.getGalleryViewerEntry, {
        galleryId: gallery.galleryId,
        folderId: gallery.rootFolderId,
        requestedEntryId: outsidePage!._id,
      }),
    ).resolves.toMatchObject({
      _id: outsidePage!._id,
      name: outsidePage!.name,
      passwordProtected: false,
    });
    await expect(
      authed.query(api.entries.getGalleryViewerEntry, {
        galleryId: gallery.galleryId,
        folderId: gallery.rootFolderId,
        requestedEntryId: "not-a-convex-id",
      }),
    ).resolves.toBeNull();
  });

  test("gallery and uploader listings use the profile's latest display name", async () => {
    const t = setupTest();
    const { authed } = await seedAdmin(t);
    const imageGallery = await createGallery(t, authed, {
      slug: "attributed-gallery",
      kind: "image",
    });
    const uploaderGallery = await createGallery(t, authed, {
      slug: "attributed-uploader",
      kind: "uploader",
    });
    await uploadFile(t, authed, {
      galleryId: imageGallery.galleryId,
      folderId: imageGallery.rootFolderId,
      name: "gallery.jpg",
      sha: "1",
    });
    await uploadFile(t, authed, {
      galleryId: uploaderGallery.galleryId,
      folderId: uploaderGallery.rootFolderId,
      name: "uploader.jpg",
      sha: "2",
    });

    await authed.mutation(api.profiles.updatePreferences, {
      displayName: "Newest Display Name",
    });

    const galleryPage = await authed.query(api.entries.listGalleryPage, {
      galleryId: imageGallery.galleryId,
      folderId: imageGallery.rootFolderId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const uploaderListing = await authed.query(api.folders.list, {
      galleryId: uploaderGallery.galleryId,
      folderId: uploaderGallery.rootFolderId,
    });
    expect(galleryPage.page[0]?.uploader).toBe("Newest Display Name");
    expect(uploaderListing.entries[0]?.uploader).toBe("Newest Display Name");
  });
});
