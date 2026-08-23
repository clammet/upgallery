import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { googlyAuth } from "./lib/auth";
import { ensureCurrentProfile } from "./lib/ensureProfile";
import {
  isPlaceholderProfile,
  profileByIdentityId,
  publicProfile,
} from "./lib/profiles";
import { requireCurrentProfile, requireSystemAdmin } from "./lib/permissions";

const MAX_DISPLAY_NAME_LENGTH = 80;

const ensureCurrentArgs = { anonymousClaim: v.optional(v.string()) };

export const ensureCurrent = mutation({
  args: ensureCurrentArgs,
  returns: v.id("profiles"),
  handler: ensureCurrentProfile,
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

export const updatePreferences = mutation({
  args: {
    anonymousClaim: v.optional(v.string()),
    displayName: v.optional(v.string()),
    infiniteScroll: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const profile = await requireCurrentProfile(ctx, args.anonymousClaim);
    if (profile.isAnonymous) {
      throw new Error("Log in to change account preferences");
    }
    const displayName = args.displayName?.trim();
    if (displayName !== undefined) {
      if (displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
        throw new Error(
          `Display name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`,
        );
      }
    }
    await ctx.db.patch("profiles", profile._id, {
      ...(displayName === undefined
        ? {}
        : { displayName, displayNameCustom: true }),
      ...(args.infiniteScroll === undefined
        ? {}
        : { infiniteScroll: args.infiniteScroll }),
    });
    return null;
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
    if (target === null || target.isAnonymous || isPlaceholderProfile(target)) {
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
