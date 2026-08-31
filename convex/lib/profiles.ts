import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

export async function profileByIdentityId(
  ctx: ReadCtx,
  identityId: string,
): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_identityId", (q) => q.eq("identityId", identityId))
    .unique();
}

// Placeholder profiles hold grants for an invited email before its owner has
// ever signed in. Real identity ids are opaque component document ids and can
// never contain ":", so the prefix cannot collide and nothing can ever
// authenticate as a placeholder. The prefix is uppercase because emails are
// normalized to lowercase before prefixing, so no email-derived suffix can
// itself begin with the sentinel.
const PLACEHOLDER_IDENTITY_PREFIX = "PLACEHOLDER:";

// Files discovered directly on a user mount have no authenticated uploader.
// Real auth identity ids cannot contain a colon, so this profile can never be
// claimed by a signed-in user.
const UNKNOWN_UPLOADER_IDENTITY_ID = "SYSTEM:UNKNOWN_UPLOADER";

export function placeholderIdentityId(normalizedEmail: string): string {
  return PLACEHOLDER_IDENTITY_PREFIX + normalizedEmail;
}

export function isPlaceholderProfile(profile: Doc<"profiles">): boolean {
  return profile.identityId.startsWith(PLACEHOLDER_IDENTITY_PREFIX);
}

export function isUnknownUploaderProfile(profile: Doc<"profiles">): boolean {
  return profile.identityId === UNKNOWN_UPLOADER_IDENTITY_ID;
}

export async function ensureUnknownUploaderProfile(
  ctx: MutationCtx,
): Promise<Doc<"profiles">> {
  const existing = await profileByIdentityId(
    ctx,
    UNKNOWN_UPLOADER_IDENTITY_ID,
  );
  if (existing !== null) return existing;

  const profileId = await ctx.db.insert("profiles", {
    identityId: UNKNOWN_UPLOADER_IDENTITY_ID,
    displayName: "Unknown",
    isAnonymous: false,
    isSystemAdmin: false,
    lastSeenAt: 0,
  });
  const profile = await ctx.db.get("profiles", profileId);
  if (profile === null) throw new Error("Could not create Unknown uploader");
  return profile;
}

export function publicProfile(profile: Doc<"profiles">) {
  return {
    _id: profile._id,
    displayName: profile.displayName,
    email: profile.email,
    image: profile.image,
    isAnonymous: profile.isAnonymous,
    isPlaceholder: isPlaceholderProfile(profile),
    invitedAt: isPlaceholderProfile(profile) ? profile._creationTime : undefined,
    isSystemAdmin: profile.isSystemAdmin,
    lastSeenAt: profile.lastSeenAt,
    infiniteScroll: profile.infiniteScroll !== false,
  };
}

export function uploaderAttribution(profile: Doc<"profiles">): string {
  return (
    profile.displayName?.trim() ||
    profile.email?.trim() ||
    (profile.isAnonymous ? "Anonymous" : "Unknown")
  );
}
