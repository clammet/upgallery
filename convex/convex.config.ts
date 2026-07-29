import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    AUTH_GOOGLE_ID: v.string(),
    AUTH_GOOGLE_SECRET: v.string(),
    DEFAULT_ADMIN_EMAIL: v.optional(v.string()),
    SITE_URL: v.string(),
    STORAGE_INTERNAL_SECRET: v.optional(v.string()),
  },
});
