import { v } from "convex/values";
import { env, internalMutation, internalQuery } from "./_generated/server";
import { normalizeHost } from "./lib/normalize";

export const create = internalMutation({
  args: {
    sessionToken: v.string(),
    refreshToken: v.string(),
    googleSubject: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("googleAuthSessions", {
      sessionToken: args.sessionToken,
      refreshToken: args.refreshToken,
      googleSubject: args.googleSubject,
      createdAt: Date.now(),
    });
  },
});

export const getBySessionToken = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("googleAuthSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
  },
});

export const getRefreshTokenByGoogleSubject = internalQuery({
  args: { googleSubject: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("googleAuthSessions")
      .withIndex("by_googleSubject", (q) =>
        q.eq("googleSubject", args.googleSubject),
      )
      .order("desc")
      .first();
    return session === null ? null : { refreshToken: session.refreshToken };
  },
});

export const removeBySessionToken = internalMutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("googleAuthSessions")
      .withIndex("by_sessionToken", (q) =>
        q.eq("sessionToken", args.sessionToken),
      )
      .unique();
    if (session !== null) {
      await ctx.db.delete("googleAuthSessions", session._id);
    }
    return null;
  },
});

export const isAllowedWebOrigin = internalQuery({
  args: { origin: v.string() },
  handler: async (ctx, args) => {
    let requested: URL;
    let canonical: URL;
    try {
      requested = new URL(args.origin);
      canonical = new URL(env.SITE_URL);
    } catch {
      return false;
    }
    if (requested.origin !== args.origin || requested.origin === "null") {
      return false;
    }
    if (requested.origin === canonical.origin) {
      return true;
    }
    const isLocalDevelopment =
      requested.protocol === "http:" &&
      requested.hostname === "localhost";
    if (requested.protocol !== "https:" && !isLocalDevelopment) {
      return false;
    }
    const matches = await ctx.db
      .query("galleryHosts")
      .withIndex("by_host", (q) =>
        q.eq("host", normalizeHost(requested.host)),
      )
      .take(1);
    return matches.length > 0;
  },
});
