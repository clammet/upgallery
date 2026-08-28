import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { GIT_COMMIT } from "./buildInfo";
import { requireSystemAdmin } from "./lib/permissions";

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
