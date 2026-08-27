import { isValidAnonymousClaim } from "@clammet/convex-googly-auth";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { googlyAuth } from "./auth";
import { ensureCurrentProfile } from "./ensureProfile";
import { profileByIdentityId } from "./profiles";

type ReadCtx = QueryCtx | MutationCtx;
export type Role = "owner" | "editor" | "viewer";
export type SystemRole = "none" | "editor" | "viewer";

export type FolderAccessResolution = {
  role: Role | null;
  canView: boolean;
  canUpload: boolean;
  shouldList: boolean;
};

const roleRank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

function isMutationCtx(ctx: ReadCtx): ctx is MutationCtx {
  return "runMutation" in ctx;
}

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
  if (profile !== null) {
    return profile;
  }
  if (!isMutationCtx(ctx)) {
    throw new Error("Not authenticated");
  }
  const profileId = await ensureCurrentProfile(ctx, { anonymousClaim });
  const ensured = await ctx.db.get("profiles", profileId);
  if (ensured === null) {
    throw new Error("Profile could not be created");
  }
  return ensured;
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
  anonymousClaim?: string,
): Promise<Role | null> {
  return (
    await resolveFolderAccess(
      ctx,
      galleryId,
      folder,
      profile,
      anonymousClaim,
    )
  ).role;
}

export async function resolveFolderAccess(
  ctx: ReadCtx,
  galleryId: Id<"galleries">,
  folder: Doc<"folders"> | null,
  profile: Doc<"profiles"> | null,
  anonymousClaim?: string,
): Promise<FolderAccessResolution> {
  const gallery = await ctx.db.get("galleries", galleryId);
  let system: Role | null = null;
  let granted: Role | null = null;

  if (profile === null) {
    if (isValidAnonymousClaim(anonymousClaim)) {
      system = systemRole(gallery?.anonymousRole);
    }
  } else if (profile.isSystemAdmin) {
    granted = "owner";
  } else if (profile.isAnonymous) {
    system = systemRole(gallery?.anonymousRole);
  } else {
    system = systemRole(gallery?.authenticatedRole);
    const grants = await ctx.db
      .query("galleryRoles")
      .withIndex("by_galleryId_and_profileId", (q) =>
        q.eq("galleryId", galleryId).eq("profileId", profile._id),
      )
      .take(128);

    for (const grant of grants) {
      const applies =
        grant.folderId === undefined ||
        (folder !== null &&
          (grant.folderId === folder._id ||
            folder.ancestorIds.includes(grant.folderId)));
      if (
        applies &&
        (granted === null || roleRank[grant.role] > roleRank[granted])
      ) {
        granted = grant.role;
      }
    }
  }

  const accessPolicy = await effectiveFolderAccessPolicy(ctx, folder);
  const discoverability =
    folder === null ? "listed" : folder.discoverability;
  const inheritedSystem = accessPolicy === "restricted" ? null : system;
  const publicFloor: Role | null =
    accessPolicy === "public" ? "viewer" : null;
  const role = maxRole(granted, inheritedSystem, publicFloor);

  return {
    role,
    canView: roleAtLeast(role, "viewer"),
    canUpload: roleAtLeast(role, "editor"),
    shouldList:
      discoverability === "listed" ||
      roleAtLeast(role, "editor"),
  };
}

async function effectiveFolderAccessPolicy(
  ctx: ReadCtx,
  folder: Doc<"folders"> | null,
): Promise<Doc<"folders">["accessPolicy"]> {
  if (folder === null) return "inherit";
  if (folder.accessPolicy !== "inherit") return folder.accessPolicy;

  const ancestors = await Promise.all(
    folder.ancestorIds.map((ancestorId) => ctx.db.get("folders", ancestorId)),
  );
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === null || ancestor.galleryId !== folder.galleryId) continue;
    if (ancestor.accessPolicy !== "inherit") return ancestor.accessPolicy;
  }
  return "inherit";
}

function maxRole(...roles: Array<Role | null>): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (role !== null && (best === null || roleRank[role] > roleRank[best])) {
      best = role;
    }
  }
  return best;
}

function systemRole(role: SystemRole | undefined): Role | null {
  const effective = role ?? "viewer";
  return effective === "none" ? null : effective;
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
  anonymousClaim?: string,
): Promise<boolean> {
  const access = await resolveFolderAccess(
    ctx,
    folder.galleryId,
    folder,
    profile,
    anonymousClaim,
  );
  return access.canView;
}

export async function shouldListFolder(
  ctx: ReadCtx,
  folder: Doc<"folders">,
  profile: Doc<"profiles"> | null,
  anonymousClaim?: string,
): Promise<boolean> {
  const access = await resolveFolderAccess(
    ctx,
    folder.galleryId,
    folder,
    profile,
    anonymousClaim,
  );
  return access.shouldList && access.canView;
}

// Select mode, bulk move, and bulk delete are owner tools. The gallery-level
// editorBulkActions switch extends them to editors, including visitors admitted
// by a system permission; gallery administration stays with named owners.
export function canManageGallery(
  gallery: Doc<"galleries">,
  role: Role | null,
): boolean {
  return (
    roleAtLeast(role, "owner") ||
    (gallery.editorBulkActions === true && roleAtLeast(role, "editor"))
  );
}

export async function assertCanManageGallery(
  ctx: ReadCtx,
  gallery: Doc<"galleries">,
  folder: Doc<"folders"> | null,
  anonymousClaim?: string,
): Promise<void> {
  const profile = await getCurrentProfile(ctx, anonymousClaim);
  const role = await getEffectiveRole(
    ctx,
    gallery._id,
    folder,
    profile,
    anonymousClaim,
  );
  if (!canManageGallery(gallery, role)) {
    throw new Error("Unauthorized");
  }
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
  const role = await getEffectiveRole(
    ctx,
    gallery._id,
    folder,
    profile,
    anonymousClaim,
  );
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
  const role = await getEffectiveRole(
    ctx,
    gallery._id,
    folder,
    profile,
    anonymousClaim,
  );
  if (!canManageGallery(gallery, role)) {
    throw new Error("Unauthorized");
  }
  return profile;
}
