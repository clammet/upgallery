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

export function publicProfile(profile: Doc<"profiles">) {
  return {
    _id: profile._id,
    displayName: profile.displayName,
    email: profile.email,
    image: profile.image,
    isAnonymous: profile.isAnonymous,
    isSystemAdmin: profile.isSystemAdmin,
    lastSeenAt: profile.lastSeenAt,
  };
}
