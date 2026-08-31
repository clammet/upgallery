/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import authComponent from "@clammet/convex-googly-auth/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  cleanFilesystemSegment,
  validateFilesystemSegment,
} from "./lib/normalize";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

function setupTest() {
  const t = convexTest(schema, modules);
  authComponent.register(t);
  return t;
}

function asUser(t: TestConvex<typeof schema>, googleSubject: string) {
  return t.withIdentity({
    subject: googleSubject.split("|")[1]!,
    issuer: "https://accounts.google.com",
    tokenIdentifier: googleSubject,
    email: "admin@example.com",
    name: "Test User",
  });
}

async function seedAdmin(t: TestConvex<typeof schema>) {
  profileSequence += 1;
  const googleSubject = `https://accounts.google.com|fs-test-${profileSequence}`;
  const profileId = await asUser(t, googleSubject).mutation(
    api.profiles.ensureCurrent,
    {},
  );
  await t.run(async (ctx) => {
    await ctx.db.patch("profiles", profileId, { isSystemAdmin: true });
  });
  return { googleSubject, profileId };
}

async function createUserGallery(
  t: TestConvex<typeof schema>,
  googleSubject: string,
  slug: string,
) {
  const galleryId = await asUser(t, googleSubject).mutation(
    api.galleries.create,
    {
      name: slug,
      slug,
      kind: "image",
      storageKind: "user",
      storageRoot: slug,
      hosts: [{ host: `${slug}.example.com`, rootPath: "/" }],
    },
  );
  const gallery = await t.run(async (ctx) => ctx.db.get("galleries", galleryId));
  return { galleryId, rootFolderId: gallery!.rootFolderId! };
}

async function claimSync(
  t: TestConvex<typeof schema>,
  galleryId: Id<"galleries">,
  folderId: Id<"folders">,
) {
  const claim = await t.mutation(internal.filesystemSync.claimFilesystemSync, {
    galleryId,
    folderId,
  });
  if (claim.kind !== "ready") throw new Error("Sync was unexpectedly busy");
  return claim;
}

// Drives the batched completion the way the storage worker does and reports
// how many calls it took, so tests can assert the sweep actually paginated.
async function completeSync(
  t: TestConvex<typeof schema>,
  input: {
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
    syncId: string;
    modifiedAt: number;
  },
) {
  let cursor: string | undefined;
  let calls = 0;
  for (;;) {
    const result = await t.mutation(
      internal.filesystemSync.completeFilesystemSync,
      { ...input, cursor },
    );
    calls += 1;
    if (result.done) return calls;
    cursor = result.cursor;
    expect(cursor).toBeTypeOf("string");
  }
}

function seedEntry(
  ctx: MutationCtx,
  input: {
    galleryId: Id<"galleries">;
    folderId: Id<"folders">;
    ownerProfileId: Id<"profiles">;
    storageRoot: string;
    name: string;
    identity: string;
    syncId?: string;
    thumbnailKey?: string;
  },
) {
  return ctx.db.insert("entries", {
    galleryId: input.galleryId,
    folderId: input.folderId,
    ownerProfileId: input.ownerProfileId,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    mimeType: "image/jpeg",
    extension: "jpg",
    mediaKind: "image" as const,
    size: 10,
    sha256: "a".repeat(64),
    storageKind: "user" as const,
    storageKey: `public/users/${input.storageRoot}/${input.name}`,
    thumbnailKey: input.thumbnailKey,
    filesystemModifiedAt: 900,
    filesystemIdentity: input.identity,
    filesystemSyncId: input.syncId,
    state: "ready" as const,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("filesystem scanner", () => {
  test("on-disk names must survive verbatim while user input is normalized", () => {
    // Real directory names from mounted galleries: fullwidth punctuation and
    // an ideographic space. NFKC folds all of these into ASCII, which made
    // the worker rebuild paths that did not exist on disk.
    for (const name of [
      "＜staging＞",
      "天真＝ガヴリール＝ホワイト",
      "夏目友人帳　参",
      "侵略！？イカ娘",
      " edge spaces ",
    ]) {
      expect(validateFilesystemSegment(name)).toBe(name);
      expect(name.normalize("NFKC").trim()).not.toBe(name);
    }
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "x".repeat(241)]) {
      expect(() => validateFilesystemSegment(name)).toThrow();
    }
    // User-typed names are still normalized before they reach a disk.
    expect(cleanFilesystemSegment("＜staging＞")).toBe("<staging>");
  });

  test("scanned directories and files keep fullwidth names verbatim", async () => {
    const t = setupTest();
    const admin = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createUserGallery(
      t,
      admin.googleSubject,
      "verbatim-mount",
    );
    const claim = await claimSync(t, galleryId, rootFolderId);

    const stagingId = await t.mutation(
      internal.filesystemSync.reconcileFilesystemDirectory,
      {
        galleryId,
        parentId: rootFolderId,
        syncId: claim.syncId,
        name: "＜staging＞",
        identity: "9:100",
      },
    );
    const staging = await t.run(async (ctx) => ctx.db.get("folders", stagingId));
    expect(staging?.name).toBe("＜staging＞");

    const fileName = "写真！　１.jpg";
    const storageKey = `public/users/verbatim-mount/${fileName}`;
    const check = await t.mutation(internal.filesystemSync.checkFilesystemFile, {
      galleryId,
      folderId: rootFolderId,
      syncId: claim.syncId,
      name: fileName,
      storageKey,
      size: 1234,
      modifiedAt: 900,
      identity: "9:101",
    });
    expect(check.kind).toBe("metadata");
    const entryId = await t.mutation(
      internal.filesystemSync.reconcileFilesystemFile,
      {
        galleryId,
        folderId: rootFolderId,
        syncId: claim.syncId,
        name: fileName,
        storageKey,
        size: 1234,
        modifiedAt: 900,
        identity: "9:101",
        mimeType: "image/jpeg",
        extension: "jpg",
        mediaKind: "image",
        sha256: "b".repeat(64),
      },
    );
    const imported = await t.run(async (ctx) => {
      const entry = await ctx.db.get("entries", entryId);
      const uploader =
        entry === null ? null : await ctx.db.get("profiles", entry.ownerProfileId);
      return { entry, uploader };
    });
    expect(imported.entry).toMatchObject({ name: fileName, storageKey });
    expect(imported.entry?.ownerProfileId).not.toBe(admin.profileId);
    expect(imported.uploader).toMatchObject({
      displayName: "Unknown",
      isAnonymous: false,
      isSystemAdmin: false,
    });

    await completeSync(t, {
      galleryId,
      folderId: rootFolderId,
      syncId: claim.syncId,
      modifiedAt: 1000,
    });
    // Both survived the sweep: they carry the completing sync's id.
    expect(
      await t.run(async (ctx) => ctx.db.get("entries", entryId)),
    ).not.toBeNull();
    expect(
      (await t.run(async (ctx) => ctx.db.get("folders", stagingId)))
        ?.filesystemMissingAt,
    ).toBeUndefined();

    // The child folder's own sync rebuilds its path from the stored name;
    // this is exactly where NFKC-mangled names produced ENOENT before.
    const childClaim = await claimSync(t, galleryId, stagingId);
    expect(childClaim.folderSegments).toEqual(["＜staging＞"]);
  });

  test("a folder tracked under an NFKC-mangled name heals through its identity", async () => {
    const t = setupTest();
    const admin = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createUserGallery(
      t,
      admin.googleSubject,
      "healing-mount",
    );
    // A document written before the fix: the on-disk name ＜staging＞ was
    // stored NFKC-folded, but the inode identity still matches.
    const damagedId = await t.run(async (ctx) =>
      ctx.db.insert("folders", {
        galleryId,
        parentId: rootFolderId,
        ancestorIds: [rootFolderId],
        name: "<staging>",
        slug: "staging",
        accessPolicy: "inherit",
        discoverability: "listed",
        filesystemIdentity: "9:100",
      }),
    );
    const claim = await claimSync(t, galleryId, rootFolderId);
    const reconciledId = await t.mutation(
      internal.filesystemSync.reconcileFilesystemDirectory,
      {
        galleryId,
        parentId: rootFolderId,
        syncId: claim.syncId,
        name: "＜staging＞",
        identity: "9:100",
      },
    );
    expect(reconciledId).toBe(damagedId);
    const healed = await t.run(async (ctx) => ctx.db.get("folders", damagedId));
    expect(healed?.name).toBe("＜staging＞");
  });

  test("deleting a folder targets its verbatim on-disk name", async () => {
    const t = setupTest();
    const admin = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createUserGallery(
      t,
      admin.googleSubject,
      "rmdir-mount",
    );
    const claim = await claimSync(t, galleryId, rootFolderId);
    const folderId = await t.mutation(
      internal.filesystemSync.reconcileFilesystemDirectory,
      {
        galleryId,
        parentId: rootFolderId,
        syncId: claim.syncId,
        name: "＜staging＞",
        identity: "9:100",
      },
    );
    await completeSync(t, {
      galleryId,
      folderId: rootFolderId,
      syncId: claim.syncId,
      modifiedAt: 1000,
    });

    const removal = await asUser(t, admin.googleSubject).mutation(
      api.folders.removeMany,
      { galleryId, folderIds: [folderId] },
    );
    if (removal.kind !== "filesystem") {
      throw new Error("Expected a filesystem delete operation");
    }
    const operation = removal.operations[0]!;
    const opClaim = await t.mutation(
      internal.filesystemSync.claimFilesystemOperation,
      { operationId: operation.operationId, token: operation.token },
    );
    // Normalizing here made rm target "<staging>", which rm -f treated as an
    // already-deleted path while the real ＜staging＞ directory survived.
    expect(opClaim.destinationSegments).toEqual(["＜staging＞"]);
  });

  test("directories with more than 500 tracked items sync completely", async () => {
    const t = setupTest();
    const admin = await seedAdmin(t);
    const { galleryId, rootFolderId } = await createUserGallery(
      t,
      admin.googleSubject,
      "large-mount",
    );
    // 501 tracked subfolders and 130 stale + 450 fresh entries: every one of
    // the old load-everything guards tripped at 500.
    const folderIds = await t.run(async (ctx) => {
      const ids: Id<"folders">[] = [];
      for (let index = 0; index < 501; index += 1) {
        ids.push(
          await ctx.db.insert("folders", {
            galleryId,
            parentId: rootFolderId,
            ancestorIds: [rootFolderId],
            name: `bulk ${index.toString().padStart(4, "0")}`,
            slug: `bulk-${index}`,
            accessPolicy: "inherit",
            discoverability: "listed",
            filesystemIdentity: `7:${index}`,
          }),
        );
      }
      return ids;
    });

    const claim = await claimSync(t, galleryId, rootFolderId);

    const staleEntryIds = await t.run(async (ctx) => {
      const stale: Id<"entries">[] = [];
      for (let index = 0; index < 130; index += 1) {
        stale.push(
          await seedEntry(ctx, {
            galleryId,
            folderId: rootFolderId,
            ownerProfileId: admin.profileId,
            storageRoot: "large-mount",
            name: `stale ${index.toString().padStart(4, "0")}.jpg`,
            identity: `8:${index}`,
            syncId: "a-previous-sync",
            thumbnailKey:
              index === 0
                ? "derivatives/gallery/user/large-mount/thumbnails/aa/bb/thumb.jpg"
                : undefined,
          }),
        );
      }
      for (let index = 0; index < 450; index += 1) {
        await seedEntry(ctx, {
          galleryId,
          folderId: rootFolderId,
          ownerProfileId: admin.profileId,
          storageRoot: "large-mount",
          name: `fresh ${index.toString().padStart(4, "0")}.jpg`,
          identity: `8:${1000 + index}`,
          syncId: claim.syncId,
        });
      }
      return stale;
    });

    // A new file with no storage-key match previously threw
    // "Directory contains too many tracked files" past 500 ready entries.
    const check = await t.mutation(internal.filesystemSync.checkFilesystemFile, {
      galleryId,
      folderId: rootFolderId,
      syncId: claim.syncId,
      name: "newcomer.jpg",
      storageKey: "public/users/large-mount/newcomer.jpg",
      size: 1,
      modifiedAt: 950,
      identity: "8:9999",
    });
    expect(check).toEqual({ kind: "metadata", entryId: undefined });

    // Known-children listing pages through all 501 subfolders.
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.query(
        internal.filesystemSync.listKnownChildFolders,
        { galleryId, folderId: rootFolderId, cursor },
      );
      listed.push(...page.folderIds);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(listed).toHaveLength(501);

    // Two subfolders are re-seen by this scan; the rest were not and must be
    // marked missing by the sweep.
    for (const index of [0, 500]) {
      const reconciled = await t.mutation(
        internal.filesystemSync.reconcileFilesystemDirectory,
        {
          galleryId,
          parentId: rootFolderId,
          syncId: claim.syncId,
          name: `bulk ${index.toString().padStart(4, "0")}`,
          identity: `7:${index}`,
        },
      );
      expect(reconciled).toBe(folderIds[index]);
    }

    const calls = await completeSync(t, {
      galleryId,
      folderId: rootFolderId,
      syncId: claim.syncId,
      modifiedAt: 2000,
    });
    // 580 ready entries and 501 children cannot fit one batch: the sweep
    // must have continued across calls.
    expect(calls).toBeGreaterThan(1);

    await t.run(async (ctx) => {
      for (const staleId of staleEntryIds) {
        expect(await ctx.db.get("entries", staleId)).toBeNull();
      }
      const remaining = [];
      for await (const entry of ctx.db
        .query("entries")
        .withIndex("by_folderId_and_state", (q) =>
          q.eq("folderId", rootFolderId).eq("state", "ready"),
        )) {
        remaining.push(entry);
      }
      expect(remaining).toHaveLength(450);
      expect(
        remaining.every((entry) => entry.filesystemSyncId === claim.syncId),
      ).toBe(true);

      // The stale entry with a thumbnail queued its derivative cleanup.
      const deleteJobs = await ctx.db
        .query("storageDeleteJobs")
        .withIndex("by_entryId", (q) => q.eq("entryId", staleEntryIds[0]!))
        .take(2);
      expect(deleteJobs).toHaveLength(1);

      const reSeen = new Set([folderIds[0], folderIds[500]]);
      for (const folderId of folderIds) {
        const folder = await ctx.db.get("folders", folderId);
        if (reSeen.has(folderId)) {
          expect(folder?.filesystemMissingAt).toBeUndefined();
        } else {
          expect(folder?.filesystemMissingAt).toBeTypeOf("number");
        }
      }

      const state = await ctx.db
        .query("filesystemSyncStates")
        .withIndex("by_folderId", (q) => q.eq("folderId", rootFolderId))
        .unique();
      expect(state).toMatchObject({ knownModifiedAt: 2000 });
      expect(state?.activeSyncId).toBeUndefined();
      expect(state?.error).toBeUndefined();
      expect(state?.lastCompletedAt).toBeTypeOf("number");
    });
  });
});
