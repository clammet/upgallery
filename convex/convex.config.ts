import { defineApp } from "convex/server";
import { v } from "convex/values";
import googlyAuth from "convex-googly-auth/convex.config.js";

const app = defineApp({
  env: {
    AUTH_GOOGLE_ID: v.string(),
    AUTH_GOOGLE_SECRET: v.string(),
    DEFAULT_ADMIN_EMAIL: v.optional(v.string()),
    SITE_URL: v.string(),
    STORAGE_INTERNAL_SECRET: v.optional(v.string()),
  },
});

app.use(googlyAuth);

export default app;
