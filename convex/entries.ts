import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  canViewFolder,
  getCurrentProfile,
  getEffectiveRole,
  isOwningProfile,
  requireCurrentProfile,
  roleAtLeast,
} from "./lib/permissions";
import {
  cleanDescription,
  cleanFileName,
} from "./lib/normalize";
import {
  createPasswordHash,
  createToken,
  sha256,
  verifyPassword,
} from "./lib/crypto";
import { disposition } from "./lib/validators";

const MAX_PASSWORD_LENGTH = 256;

async function assertCanUpload(
  ctx: Parameters<typeof getCurrentProfile>[0],
  galleryId: Parameters<typeof getEffectiveRole>[1],
  folderId: Parameters<typeof getEffectiveRole>[2] extends infer _T
    ? import("./_generated/dataModel").Id<"folders">
    : never,
  anonymousClaim?: string,
) {
  const [gallery, folder, profile] = await Promise.all([
    ctx.db.get("galleries", galleryId),
    ctx.db.get("folders", folderId),
    getCurrentProfile(ctx, anonymousClaim),
  ]);
  if (
    gallery === null ||
    gallery.deletedAt !== undefined ||
    folder === null ||
    folder.galleryId !== gallery._id
  ) {
    throw new Error("Gallery folder not found");
  }
  if (gallery.pendingMigrationId !== undefined) {
    throw new Error("Uploads are paused while this gallery is migrating");
  }
  if (profile === null) {
    throw new Error("Not authenticated");
  }
  const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
  const allowed =
    gallery.kind === "image"
      ? roleAtLeast(role, "editor")
      : gallery.uploaderAccess === "anonymous"
        ? true
        : gallery.uploaderAccess === "sso"
          ? !profile.isAnonymous
          : roleAtLeast(role, "editor");
  if (!allowed) {
    throw new Error("Unauthorized");
  }
  return { gallery, folder, profile };
}

export const createUploadIntent = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    name: v.string(),
    description: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { gallery, profile } = await assertCanUpload(
      ctx,
      args.galleryId,
      args.folderId,
      args.anonymousClaim,
    );
    if (
      !Number.isSafeInteger(args.size) ||
      args.size < 0 ||
      args.size > gallery.maxFileSize
    ) {
      throw new Error(
        `File exceeds this gallery's ${gallery.maxFileSize}-byte limit`,
      );
    }
    if (args.mimeType.length > 200) {
      throw new Error("Invalid MIME type");
    }
    if (args.password !== undefined && gallery.kind !== "uploader") {
      throw new Error("Passwords are only supported by uploader galleries");
    }
    if (
      args.password !== undefined &&
      (args.password.length < 1 || args.password.length > MAX_PASSWORD_LENGTH)
    ) {
      throw new Error(
        `Password must contain between 1 and ${MAX_PASSWORD_LENGTH} characters`,
      );
    }
    const token = createToken();
    const password =
      args.password === undefined
        ? undefined
        : await createPasswordHash(args.password);
    const intentId = await ctx.db.insert("uploadIntents", {
      galleryId: gallery._id,
      folderId: args.folderId,
      ownerProfileId: profile._id,
      name: cleanFileName(args.name),
      description: cleanDescription(args.description),
      declaredMimeType: args.mimeType || "application/octet-stream",
      declaredSize: args.size,
      tokenHash: await sha256(token),
      passwordSalt: password?.salt,
      passwordHash: password?.hash,
      passwordIterations: password?.iterations,
      expiresAt: Date.now() + 15 * 60 * 1000,
      state: "pending",
      attempts: 0,
    });
    return { intentId, token };
  },
});

export const createDownloadTicket = mutation({
  args: {
    entryId: v.id("entries"),
    password: v.optional(v.string()),
    disposition,
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("entries", args.entryId);
    if (entry === null || entry.state !== "ready") {
      throw new Error("File not found");
    }
    const [gallery, folder, profile] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
      getCurrentProfile(ctx),
    ]);
    if (
      gallery === null ||
      gallery.deletedAt !== undefined ||
      folder === null ||
      !(await canViewFolder(ctx, folder, profile))
    ) {
      throw new Error("Unauthorized");
    }
    if (gallery.kind !== "uploader") {
      throw new Error("Image gallery files are served directly");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    const token = createToken();
    await ctx.db.insert("downloadTickets", {
      entryId: entry._id,
      tokenHash: await sha256(token),
      disposition: args.disposition,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return { token };
  },
});

export const updateMetadata = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    entryId: v.id("entries"),
    description: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const entry = await ctx.db.get("entries", args.entryId);
    if (entry === null || entry.state !== "ready") {
      throw new Error("File not found");
    }
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
    ]);
    if (gallery === null || folder === null) {
      throw new Error("Gallery not found");
    }
    const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
    const owns = await isOwningProfile(
      ctx,
      entry.ownerProfileId,
      profile._id,
    );
    if (!owns && !roleAtLeast(role, "editor")) {
      throw new Error("Unauthorized");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    await ctx.db.patch("entries", entry._id, {
      description: cleanDescription(args.description),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    entryId: v.id("entries"),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    const entry = await ctx.db.get("entries", args.entryId);
    if (entry === null || entry.state !== "ready") {
      return null;
    }
    const [gallery, folder] = await Promise.all([
      ctx.db.get("galleries", entry.galleryId),
      ctx.db.get("folders", entry.folderId),
    ]);
    if (gallery === null || folder === null) {
      throw new Error("Gallery not found");
    }
    const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
    const owns = await isOwningProfile(
      ctx,
      entry.ownerProfileId,
      profile._id,
    );
    if (!owns && !roleAtLeast(role, "editor")) {
      throw new Error("Unauthorized");
    }
    if (entry.passwordHash !== undefined) {
      if (
        args.password === undefined ||
        entry.passwordSalt === undefined ||
        entry.passwordIterations === undefined ||
        !(await verifyPassword(
          args.password,
          entry.passwordSalt,
          entry.passwordHash,
          entry.passwordIterations,
        ))
      ) {
        throw new Error("Incorrect password");
      }
    }
    await ctx.db.patch("entries", entry._id, {
      state: "deleted",
      deletedAt: Date.now(),
    });
    await ctx.db.patch("galleries", gallery._id, {
      itemCount: Math.max(0, gallery.itemCount - 1),
      totalBytes: Math.max(0, gallery.totalBytes - entry.size),
    });
    await ctx.db.insert("storageDeleteJobs", {
      entryId: entry._id,
      storageKey: entry.storageKey,
      thumbnailKey: entry.thumbnailKey,
      deleteEntry: true,
      status: "queued",
      attempts: 0,
      availableAt: 0,
    });
    return null;
  },
});
