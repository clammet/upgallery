import { createGooglyAuthClient } from "convex-googly-auth/react";

export const authClient = createGooglyAuthClient({
  convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  storagePrefix: "upgallery",
});

export function anonymousClaim(): string | undefined {
  return authClient.getOrCreateAnonymousClaim() ?? undefined;
}
