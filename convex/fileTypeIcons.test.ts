/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

async function seedProfile(
  t: TestConvex<typeof schema>,
  input: { email: string; admin?: boolean },
) {
  profileSequence += 1;
  const googleSubject =
    `https://accounts.google.com|file-icon-user-${profileSequence}`;
  const profileId = await t.run(async (ctx) => {
    return await ctx.db.insert("profiles", {
      googleSubject,
      displayName: "File Icon User",
      email: input.email,
      isAnonymous: false,
      isSystemAdmin: input.admin ?? false,
      lastSeenAt: Date.now(),
    });
  });
  return { googleSubject, profileId };
}

function asUser(
  t: TestConvex<typeof schema>,
  googleSubject: string,
  email: string,
) {
  return t.withIdentity({
    subject: googleSubject.split("|")[1]!,
    issuer: "https://accounts.google.com",
    tokenIdentifier: googleSubject,
    email,
    name: "File Icon User",
  });
}

describe("gallery file-type icon overrides", () => {
  test("owners can override and restore defaults without affecting other galleries", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedProfile(t, {
      email: "admin@example.com",
      admin: true,
    });
    const owner = await seedProfile(t, { email: "owner@example.com" });
    const outsider = await seedProfile(t, { email: "outsider@example.com" });
    const adminClient = asUser(t, admin.googleSubject, "admin@example.com");
    const ownerClient = asUser(t, owner.googleSubject, "owner@example.com");
    const outsiderClient = asUser(
      t,
      outsider.googleSubject,
      "outsider@example.com",
    );

    const galleryId = await adminClient.mutation(api.galleries.create, {
      name: "Owner gallery",
      slug: "owner-gallery",
      kind: "image",
      storageKind: "shared",
      storageRoot: "owner-gallery",
      hosts: [{ host: "owner.example.com", rootPath: "/" }],
    });
    const otherGalleryId = await adminClient.mutation(api.galleries.create, {
      name: "Other gallery",
      slug: "other-gallery",
      kind: "uploader",
      storageKind: "shared",
      storageRoot: "other-gallery",
      hosts: [{ host: "other.example.com", rootPath: "/" }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("galleryRoles", {
        galleryId,
        profileId: owner.profileId,
        role: "owner",
      });
    });

    await ownerClient.mutation(api.fileTypeIcons.upsert, {
      galleryId,
      extension: ".ZIP",
      icon: "PACKAGE",
      label: "Custom package",
      thumbnailUrl: "https://assets.example.com/package.png",
    });

    const overrides = await t.query(api.fileTypeIcons.list, { galleryId });
    expect(overrides).toMatchObject([
      {
        galleryId,
        extension: "zip",
        icon: "PACKAGE",
        label: "Custom package",
        thumbnailUrl: "https://assets.example.com/package.png",
      },
    ]);
    await expect(
      t.query(api.fileTypeIcons.list, { galleryId: otherGalleryId }),
    ).resolves.toEqual([]);
    await expect(
      outsiderClient.mutation(api.fileTypeIcons.upsert, {
        galleryId,
        extension: "zip",
        icon: "NOPE",
        label: "Unauthorized",
      }),
    ).rejects.toThrow("Unauthorized");

    const iconId = overrides[0]!._id as Id<"fileTypeIcons">;
    await ownerClient.mutation(api.fileTypeIcons.remove, { iconId });
    await expect(
      t.query(api.fileTypeIcons.list, { galleryId }),
    ).resolves.toEqual([]);
  });
});
