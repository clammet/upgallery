import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256 } from "./crypto";

type ReadCtx = QueryCtx | MutationCtx;
export type Role = "owner" | "editor" | "viewer";

const roleRank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export async function getCurrentProfile(
  ctx: ReadCtx,
  anonymousClaim?: string,
): Promise<Doc<"profiles"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity !== null) {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_googleSubject", (q) =>
        q.eq("googleSubject", identity.tokenIdentifier),
      )
      .unique();
    return profile;
  }
  if (
    anonymousClaim === undefined ||
    !/^[a-f0-9]{64}$/.test(anonymousClaim)
  ) {
    return null;
  }
  const anonymousClaimHash = await sha256(anonymousClaim);
  return await ctx.db
    .query("profiles")
    .withIndex("by_anonymousClaimHash", (q) =>
      q.eq("anonymousClaimHash", anonymousClaimHash),
    )
    .unique();
}

export async function requireCurrentProfile(
  ctx: ReadCtx,
  anonymousClaim?: string,
): Promise<Doc<"profiles">> {
  const profile = await getCurrentProfile(ctx, anonymousClaim);
  if (profile === null) {
    throw new Error("Not authenticated");
  }
  if (profile.mergedIntoProfileId !== undefined) {
    const target = await ctx.db.get("profiles", profile.mergedIntoProfileId);
    if (target !== null) {
      return target;
    }
  }
  return profile;
}

export async function requireSystemAdmin(
  ctx: ReadCtx,
): Promise<Doc<"profiles">> {
  const profile = await requireCurrentProfile(ctx);
  if (!profile.isSystemAdmin) {
    throw new Error("Unauthorized");
  }
  return profile;
}

export async function getEffectiveRole(
  ctx: ReadCtx,
  galleryId: Id<"galleries">,
  folder: Doc<"folders"> | null,
  profile: Doc<"profiles"> | null,
): Promise<Role | null> {
  if (profile === null) {
    return null;
  }
  if (profile.isSystemAdmin) {
    return "owner";
  }
  const grants = await ctx.db
    .query("galleryRoles")
    .withIndex("by_galleryId_and_profileId", (q) =>
      q.eq("galleryId", galleryId).eq("profileId", profile._id),
    )
    .take(128);

  let best: Role | null = null;
  for (const grant of grants) {
    const applies =
      grant.folderId === undefined ||
      (folder !== null &&
        (grant.folderId === folder._id ||
          folder.ancestorIds.includes(grant.folderId)));
    if (applies && (best === null || roleRank[grant.role] > roleRank[best])) {
      best = grant.role;
    }
  }
  return best;
}

export function roleAtLeast(
  role: Role | null,
  minimum: "viewer" | "editor" | "owner",
): boolean {
  return role !== null && roleRank[role] >= roleRank[minimum];
}

export async function canViewFolder(
  ctx: ReadCtx,
  folder: Doc<"folders">,
  profile: Doc<"profiles"> | null,
): Promise<boolean> {
  if (folder.privacy === "public" || folder.privacy === "unlisted") {
    return true;
  }
  const role = await getEffectiveRole(ctx, folder.galleryId, folder, profile);
  return roleAtLeast(role, "viewer");
}

export async function shouldListFolder(
  ctx: ReadCtx,
  folder: Doc<"folders">,
  profile: Doc<"profiles"> | null,
): Promise<boolean> {
  if (folder.privacy === "public") {
    return true;
  }
  const role = await getEffectiveRole(ctx, folder.galleryId, folder, profile);
  return roleAtLeast(role, "viewer");
}

export async function isOwningProfile(
  ctx: ReadCtx,
  ownerProfileId: Id<"profiles">,
  currentProfileId: Id<"profiles">,
): Promise<boolean> {
  if (ownerProfileId === currentProfileId) {
    return true;
  }
  const alias = await ctx.db
    .query("profileAliases")
    .withIndex("by_sourceProfileId", (q) =>
      q.eq("sourceProfileId", ownerProfileId),
    )
    .unique();
  return alias?.targetProfileId === currentProfileId;
}

export async function requireGalleryRole(
  ctx: ReadCtx,
  gallery: Doc<"galleries">,
  folder: Doc<"folders"> | null,
  minimum: "viewer" | "editor" | "owner",
): Promise<Doc<"profiles">> {
  const profile = await requireCurrentProfile(ctx);
  const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
  if (!roleAtLeast(role, minimum)) {
    throw new Error("Unauthorized");
  }
  return profile;
}
