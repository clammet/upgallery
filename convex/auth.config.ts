import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      domain: "https://accounts.google.com",
      applicationID: process.env.AUTH_GOOGLE_ID!,
    },
  ],
} satisfies AuthConfig;
