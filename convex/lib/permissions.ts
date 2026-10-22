import { isValidAnonymousClaim } from "@clammet/convex-googly-auth";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { googlyAuth } from "./auth";
import { ensureCurrentProfile } from "./ensureProfile";
import { profileByIdentityId } from "./profiles";

type ReadCtx = QueryCtx | MutationCtx;
export type Role = "owner" | "editor" | "viewer";
export type SystemRole = "none" | "editor" | "viewer";

/**
 * The refusal every access check throws. The code lets the browser tell a
 * permission problem from any other failure and offer a login instead of an
 * error page; the message keeps logs and test output readable.
 */
export function unauthorizedError(): ConvexError<{
  code: "unauthorized";
  message: string;
}> {
  return new ConvexError({ code: "unauthorized" as const, message: "Unauthorized" });
}

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
    throw unauthorizedError();
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

/** One request's access state. Never retain this across queries or mutations. */
export function createFolderAccessResolver(
  ctx: ReadCtx,
  gallery: Doc<"galleries">,
  profile: Doc<"profiles"> | null,
  anonymousClaim?: string,
) {
  const folders = new Map<Id<"folders">, Promise<Doc<"folders"> | null>>();
  const policies = new Map<Id<"folders">, Promise<Doc<"folders">["accessPolicy"]>>();
  const resolutions = new Map<Id<"folders">, Promise<FolderAccessResolution>>();
  let grants: Promise<Array<Doc<"galleryRoles">>> | undefined;

  function folder(id: Id<"folders">) {
    let result = folders.get(id);
    if (result === undefined) {
      result = ctx.db.get("folders", id);
      folders.set(id, result);
    }
    return result;
  }

  function policy(value: Doc<"folders">): Promise<Doc<"folders">["accessPolicy"]> {
    const existing = policies.get(value._id);
    if (existing !== undefined) return existing;
    const result = (async () => {
      if (value.accessPolicy !== "inherit") return value.accessPolicy;
      // Search nearest ancestors first and stop once the policy is known.
      for (let index = value.ancestorIds.length - 1; index >= 0; index -= 1) {
        const ancestor = await folder(value.ancestorIds[index]!);
        if (ancestor === null || ancestor.galleryId !== gallery._id) continue;
        if (ancestor.accessPolicy !== "inherit") return ancestor.accessPolicy;
      }
      return "inherit" as const;
    })();
    policies.set(value._id, result);
    return result;
  }

  async function calculate(value: Doc<"folders"> | null): Promise<FolderAccessResolution> {
    if (value !== null && value.galleryId !== gallery._id) {
      return { role: null, canView: false, canUpload: false, shouldList: false };
    }
    let system: Role | null = null;
    let granted: Role | null = null;
    if (profile === null) {
      if (isValidAnonymousClaim(anonymousClaim)) system = systemRole(gallery.anonymousRole);
    } else if (profile.isSystemAdmin) {
      granted = "owner";
    } else if (profile.isAnonymous) {
      system = systemRole(gallery.anonymousRole);
    } else {
      system = systemRole(gallery.authenticatedRole);
      grants ??= ctx.db.query("galleryRoles")
        .withIndex("by_galleryId_and_profileId", (q) =>
          q.eq("galleryId", gallery._id).eq("profileId", profile._id),
        ).take(128);
      for (const grant of await grants) {
        if (grant.folderId === undefined || (value !== null &&
          (grant.folderId === value._id || value.ancestorIds.includes(grant.folderId)))) {
          granted = maxRole(granted, grant.role);
        }
      }
    }
    const accessPolicy = value === null ? "inherit" : await policy(value);
    const role = maxRole(
      granted,
      accessPolicy === "restricted" ? null : system,
      accessPolicy === "public" ? "viewer" : null,
    );
    return {
      role,
      canView: roleAtLeast(role, "viewer"),
      canUpload: roleAtLeast(role, "editor"),
      shouldList: value === null || value.discoverability === "listed" || roleAtLeast(role, "editor"),
    };
  }

  function resolve(value: Doc<"folders"> | null) {
    if (value === null) return calculate(null);
    folders.set(value._id, Promise.resolve(value));
    let result = resolutions.get(value._id);
    if (result === undefined) {
      result = calculate(value);
      resolutions.set(value._id, result);
    }
    return result;
  }

  return {
    folder,
    resolve,
    async shouldList(value: Doc<"folders">) {
      const access = await resolve(value);
      return value.filesystemMissingAt === undefined && access.canView && access.shouldList;
    },
  };
}

export type FolderAccessResolver = ReturnType<typeof createFolderAccessResolver>;

export async function resolveFolderAccess(
  ctx: ReadCtx,
  galleryId: Id<"galleries">,
  folder: Doc<"folders"> | null,
  profile: Doc<"profiles"> | null,
  anonymousClaim?: string,
): Promise<FolderAccessResolution> {
  const gallery = await ctx.db.get("galleries", galleryId);
  if (gallery === null || gallery.deletedAt !== undefined) {
    return { role: null, canView: false, canUpload: false, shouldList: false };
  }
  return createFolderAccessResolver(ctx, gallery, profile, anonymousClaim).resolve(folder);
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
    throw unauthorizedError();
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
    throw unauthorizedError();
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
    throw unauthorizedError();
  }
  return profile;
}
