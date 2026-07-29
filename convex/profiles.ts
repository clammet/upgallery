import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { env } from "./_generated/server";
import { sha256 } from "./lib/crypto";
import { normalizeEmail } from "./lib/normalize";
import { requireSystemAdmin } from "./lib/permissions";

function validAnonymousClaim(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/.test(value);
}

export const ensureCurrent = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const now = Date.now();
    const claim = validAnonymousClaim(args.anonymousClaim)
      ? await sha256(args.anonymousClaim)
      : undefined;

    if (identity === null) {
      if (claim === undefined) {
        throw new Error("A valid anonymous claim is required");
      }
      const existing = await ctx.db
        .query("profiles")
        .withIndex("by_anonymousClaimHash", (q) =>
          q.eq("anonymousClaimHash", claim),
        )
        .unique();
      if (existing !== null) {
        await ctx.db.patch("profiles", existing._id, { lastSeenAt: now });
        return existing.mergedIntoProfileId ?? existing._id;
      }
      return await ctx.db.insert("profiles", {
        displayName: "Anonymous",
        isAnonymous: true,
        isSystemAdmin: false,
        anonymousClaimHash: claim,
        lastSeenAt: now,
      });
    }

    const googleSubject = identity.tokenIdentifier;
    const email =
      typeof identity.email === "string"
        ? normalizeEmail(identity.email)
        : undefined;
    const isDefaultAdmin =
      email !== undefined &&
      env.DEFAULT_ADMIN_EMAIL !== undefined &&
      email === normalizeEmail(env.DEFAULT_ADMIN_EMAIL);

    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_googleSubject", (q) =>
        q.eq("googleSubject", googleSubject),
      )
      .unique();
    const claimProfile =
      claim === undefined
        ? null
        : await ctx.db
            .query("profiles")
            .withIndex("by_anonymousClaimHash", (q) =>
              q.eq("anonymousClaimHash", claim),
            )
            .unique();

    if (
      claimProfile !== null &&
      claimProfile.isAnonymous &&
      claimProfile._id !== existing?._id
    ) {
      if (existing === null) {
        await ctx.db.patch("profiles", claimProfile._id, {
          googleSubject,
          displayName: identity.name,
          email,
          image: identity.pictureUrl,
          isAnonymous: false,
          isSystemAdmin: isDefaultAdmin,
          anonymousClaimHash: undefined,
          lastSeenAt: now,
        });
        return claimProfile._id;
      }
      const oldAlias = await ctx.db
        .query("profileAliases")
        .withIndex("by_sourceProfileId", (q) =>
          q.eq("sourceProfileId", claimProfile._id),
        )
        .unique();
      if (oldAlias === null) {
        await ctx.db.insert("profileAliases", {
          sourceProfileId: claimProfile._id,
          targetProfileId: existing._id,
        });
      }
      await ctx.db.patch("profiles", claimProfile._id, {
        anonymousClaimHash: undefined,
        mergedIntoProfileId: existing._id,
        lastSeenAt: now,
      });
    }

    if (existing !== null) {
      await ctx.db.patch("profiles", existing._id, {
        displayName: identity.name ?? existing.displayName,
        email,
        image: identity.pictureUrl,
        isAnonymous: false,
        isSystemAdmin: existing.isSystemAdmin || isDefaultAdmin,
        lastSeenAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("profiles", {
      googleSubject,
      displayName: identity.name,
      email,
      image: identity.pictureUrl,
      isAnonymous: false,
      isSystemAdmin: isDefaultAdmin,
      lastSeenAt: now,
    });
  },
});

export const current = query({
  args: {
    anonymousClaim: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    let profile =
      identity === null
        ? null
        : await ctx.db
            .query("profiles")
            .withIndex("by_googleSubject", (q) =>
              q.eq("googleSubject", identity.tokenIdentifier),
            )
            .unique();
    if (
      profile === null &&
      identity === null &&
      validAnonymousClaim(args.anonymousClaim)
    ) {
      const claim = await sha256(args.anonymousClaim);
      profile = await ctx.db
        .query("profiles")
        .withIndex("by_anonymousClaimHash", (q) =>
          q.eq("anonymousClaimHash", claim),
        )
        .unique();
    }
    if (profile?.mergedIntoProfileId !== undefined) {
      return await ctx.db.get("profiles", profile.mergedIntoProfileId);
    }
    return profile;
  },
});

export const listForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    return await ctx.db.query("profiles").order("desc").take(200);
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
