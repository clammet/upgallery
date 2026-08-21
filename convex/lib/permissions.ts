import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { googlyAuth } from "./auth";
import { profileByIdentityId } from "./profiles";

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
  const identityId = await googlyAuth.resolveIdentity(ctx, { anonymousClaim });
  if (identityId === null) {
    return null;
  }
  return await profileByIdentityId(ctx, identityId);
}

export async function requireCurrentProfile(
  ctx: ReadCtx,
  anonymousClaim?: string,
): Promise<Doc<"profiles">> {
  const profile = await getCurrentProfile(ctx, anonymousClaim);
  if (profile === null) {
    throw new Error("Not authenticated");
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
  if (profile.isAnonymous) {
    const gallery = await ctx.db.get("galleries", galleryId);
    return gallery?.anonymousEdit === true ? "editor" : null;
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

// Select mode, bulk move, and bulk delete are owner tools. The gallery-level
// editorBulkActions switch extends them to editors, including anonymous
// visitors admitted by anonymousEdit; gallery administration stays with owners.
export function canManageGallery(
  gallery: Doc<"galleries">,
  role: Role | null,
): boolean {
  return (
    roleAtLeast(role, "owner") ||
    (gallery.editorBulkActions === true && roleAtLeast(role, "editor"))
  );
}

export function isOwningProfile(
  ownerProfileId: Id<"profiles">,
  currentProfileId: Id<"profiles">,
): boolean {
  return ownerProfileId === currentProfileId;
}

export async function requireGalleryRole(
  ctx: ReadCtx,
  gallery: Doc<"galleries">,
  folder: Doc<"folders"> | null,
  minimum: "viewer" | "editor" | "owner",
  anonymousClaim?: string,
): Promise<Doc<"profiles">> {
  const profile = await requireCurrentProfile(ctx, anonymousClaim);
  const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
  if (!roleAtLeast(role, minimum)) {
    throw new Error("Unauthorized");
  }
  return profile;
}

export async function requireGalleryManager(
  ctx: ReadCtx,
  gallery: Doc<"galleries">,
  folder: Doc<"folders"> | null,
  anonymousClaim?: string,
): Promise<Doc<"profiles">> {
  const profile = await requireCurrentProfile(ctx, anonymousClaim);
  const role = await getEffectiveRole(ctx, gallery._id, folder, profile);
  if (!canManageGallery(gallery, role)) {
    throw new Error("Unauthorized");
  }
  return profile;
}
