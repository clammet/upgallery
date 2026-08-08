import { v } from "convex/values";
import { env, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { googlyAuth } from "./lib/auth";
import { normalizeEmail } from "./lib/normalize";
import { profileByIdentityId, publicProfile } from "./lib/profiles";
import { requireSystemAdmin } from "./lib/permissions";

const roleRank = { viewer: 1, editor: 2, owner: 3 } as const;

async function absorbProfile(
  ctx: MutationCtx,
  mergedFromIdentityId: string,
  targetProfileId: Id<"profiles">,
): Promise<void> {
  const source = await profileByIdentityId(ctx, mergedFromIdentityId);
  if (source === null || source._id === targetProfileId) {
    return;
  }

  const target = await ctx.db.get("profiles", targetProfileId);
  if (target === null) {
    throw new Error("Target profile not found");
  }

  const targetGrants = await ctx.db
    .query("galleryRoles")
    .withIndex("by_profileId", (q) => q.eq("profileId", targetProfileId))
    .take(256);
  const sourceGrants = ctx.db
    .query("galleryRoles")
    .withIndex("by_profileId", (q) => q.eq("profileId", source._id));
  for await (const grant of sourceGrants) {
    const duplicate = targetGrants.find(
      (candidate) =>
        candidate.galleryId === grant.galleryId &&
        candidate.folderId === grant.folderId,
    );
    if (duplicate === undefined) {
      await ctx.db.patch("galleryRoles", grant._id, {
        profileId: targetProfileId,
      });
    } else {
      if (roleRank[grant.role] > roleRank[duplicate.role]) {
        await ctx.db.patch("galleryRoles", duplicate._id, { role: grant.role });
      }
      await ctx.db.delete("galleryRoles", grant._id);
    }
  }

  const entries = ctx.db
    .query("entries")
    .withIndex("by_ownerProfileId", (q) => q.eq("ownerProfileId", source._id));
  for await (const entry of entries) {
    await ctx.db.patch("entries", entry._id, {
      ownerProfileId: targetProfileId,
    });
  }

  const operations = ctx.db
    .query("filesystemOperations")
    .withIndex("by_actorProfileId", (q) => q.eq("actorProfileId", source._id));
  for await (const operation of operations) {
    await ctx.db.patch("filesystemOperations", operation._id, {
      actorProfileId: targetProfileId,
    });
  }

  const uploadIntents = ctx.db
    .query("uploadIntents")
    .withIndex("by_ownerProfileId", (q) => q.eq("ownerProfileId", source._id));
  for await (const intent of uploadIntents) {
    await ctx.db.patch("uploadIntents", intent._id, {
      ownerProfileId: targetProfileId,
    });
  }

  const moveJobs = ctx.db
    .query("entryMoveJobs")
    .withIndex("by_actorProfileId", (q) => q.eq("actorProfileId", source._id));
  for await (const job of moveJobs) {
    await ctx.db.patch("entryMoveJobs", job._id, {
      actorProfileId: targetProfileId,
    });
  }

  const auditEvents = ctx.db
    .query("auditEvents")
    .withIndex("by_actorProfileId", (q) => q.eq("actorProfileId", source._id));
  for await (const event of auditEvents) {
    await ctx.db.patch("auditEvents", event._id, {
      actorProfileId: targetProfileId,
    });
  }

  if (source.isSystemAdmin && !target.isSystemAdmin) {
    await ctx.db.patch("profiles", targetProfileId, { isSystemAdmin: true });
  }
  await ctx.db.delete("profiles", source._id);
}

export const ensureCurrent = mutation({
  args: { anonymousClaim: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await googlyAuth.ensureIdentity(ctx, args);
    const now = Date.now();
    const email =
      typeof result.identity?.email === "string"
        ? normalizeEmail(result.identity.email)
        : undefined;
    const isDefaultAdmin =
      email !== undefined &&
      env.DEFAULT_ADMIN_EMAIL !== undefined &&
      email === normalizeEmail(env.DEFAULT_ADMIN_EMAIL);
    const existing = await profileByIdentityId(ctx, result.identityId);

    let profileId: Id<"profiles">;
    if (existing === null) {
      profileId = await ctx.db.insert("profiles", {
        identityId: result.identityId,
        displayName: result.identity?.name ?? "Anonymous",
        email,
        image: result.identity?.pictureUrl,
        isAnonymous: result.identity === null,
        isSystemAdmin: isDefaultAdmin,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch("profiles", existing._id, {
        displayName: result.identity?.name ?? existing.displayName,
        email: result.identity === null ? existing.email : email,
        image:
          result.identity === null
            ? existing.image
            : result.identity.pictureUrl,
        isAnonymous: result.identity === null,
        isSystemAdmin: existing.isSystemAdmin || isDefaultAdmin,
        lastSeenAt: now,
      });
      profileId = existing._id;
    }

    if (result.mergedFromId !== null) {
      await absorbProfile(ctx, result.mergedFromId, profileId);
    }
    return profileId;
  },
});

export const current = query({
  args: { anonymousClaim: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identityId = await googlyAuth.resolveIdentity(ctx, args);
    if (identityId === null) {
      return null;
    }
    const profile = await profileByIdentityId(ctx, identityId);
    return profile === null ? null : publicProfile(profile);
  },
});

export const listForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    const profiles = await ctx.db.query("profiles").order("desc").take(200);
    return profiles.map(publicProfile);
  },
});

export const setSystemAdmin = mutation({
  args: {
    profileId: v.id("profiles"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await requireSystemAdmin(ctx);
    const target = await ctx.db.get("profiles", args.profileId);
    if (target === null || target.isAnonymous) {
      throw new Error("Only signed-in SSO profiles can be system admins");
    }
    if (actor._id === target._id && !args.enabled) {
      throw new Error("You cannot remove your own system administrator role");
    }
    await ctx.db.patch("profiles", target._id, {
      isSystemAdmin: args.enabled,
    });
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: args.enabled ? "system_admin.granted" : "system_admin.revoked",
      detail: target.email,
      createdAt: Date.now(),
    });
    return null;
  },
});
