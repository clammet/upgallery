import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { GIT_COMMIT } from "./buildInfo";
import { requireSystemAdmin } from "./lib/permissions";

const DEFAULT_LIGHTBOX_PRELOAD_AHEAD = 2;
const DEFAULT_LIGHTBOX_PRELOAD_BEHIND = 0;
const MAX_LIGHTBOX_PRELOAD_COUNT = 20;
const lightboxPreloadSettingsValidator = v.object({
  ahead: v.number(),
  behind: v.number(),
});

function validateLightboxPreloadCount(
  value: number,
  direction: "forward" | "behind",
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_LIGHTBOX_PRELOAD_COUNT
  ) {
    throw new Error(
      `Lightbox ${direction} preload count must be an integer between 0 and ${MAX_LIGHTBOX_PRELOAD_COUNT}`,
    );
  }
}

// Public because gallery visitors need these non-secret rendering settings.
// Keeping this query narrow avoids exposing the rest of system administration.
export const lightboxPreloadSettings = query({
  args: {},
  returns: lightboxPreloadSettingsValidator,
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("systemSettings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    return {
      ahead: settings?.lightboxPreloadAhead ?? DEFAULT_LIGHTBOX_PRELOAD_AHEAD,
      behind:
        settings?.lightboxPreloadBehind ?? DEFAULT_LIGHTBOX_PRELOAD_BEHIND,
    };
  },
});

export const updateLightboxPreloadSettings = mutation({
  args: {
    ahead: v.number(),
    behind: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireSystemAdmin(ctx);
    validateLightboxPreloadCount(args.ahead, "forward");
    validateLightboxPreloadCount(args.behind, "behind");
    const existing = await ctx.db
      .query("systemSettings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const settings = {
      lightboxPreloadAhead: args.ahead,
      lightboxPreloadBehind: args.behind,
    };
    if (existing === null) {
      await ctx.db.insert("systemSettings", { key: "global", ...settings });
    } else {
      await ctx.db.patch("systemSettings", existing._id, settings);
    }
    await ctx.db.insert("auditEvents", {
      actorProfileId: actor._id,
      action: "system.lightbox_preload.updated",
      detail: `ahead:${args.ahead},behind:${args.behind}`,
      createdAt: Date.now(),
    });
    return null;
  },
});

// Reported by the storage API and worker on an interval through the
// secret-authorized storage gateway. Liveness is judged by the reader from
// `at`, so a process that stops reporting simply goes stale.
export const reportServiceStatus = internalMutation({
  args: {
    component: v.string(),
    commit: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (
      args.component.length < 1 ||
      args.component.length > 64 ||
      (args.commit !== undefined && args.commit.length > 64)
    ) {
      throw new Error("Invalid service status report");
    }
    const commit = args.commit === "" ? undefined : args.commit;
    const existing = await ctx.db
      .query("serviceHeartbeats")
      .withIndex("by_component", (q) => q.eq("component", args.component))
      .unique();
    if (existing === null) {
      await ctx.db.insert("serviceHeartbeats", {
        component: args.component,
        commit,
        at: Date.now(),
      });
    } else {
      await ctx.db.patch("serviceHeartbeats", existing._id, {
        commit,
        at: Date.now(),
      });
    }
    return null;
  },
});

export const deploymentStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    const services = await ctx.db.query("serviceHeartbeats").take(16);
    return {
      convexCommit: GIT_COMMIT || null,
      services: services.map((service) => ({
        component: service.component,
        commit: service.commit ?? null,
        at: service.at,
      })),
    };
  },
});
