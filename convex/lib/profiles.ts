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

export function placeholderIdentityId(normalizedEmail: string): string {
  return PLACEHOLDER_IDENTITY_PREFIX + normalizedEmail;
}

export function isPlaceholderProfile(profile: Doc<"profiles">): boolean {
  return profile.identityId.startsWith(PLACEHOLDER_IDENTITY_PREFIX);
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
  };
}
