import { createElement, type ReactNode } from "react";
import { createGooglyAuthClient } from "@clammet/convex-googly-auth/react";
import { getConfig } from "../config";

type AuthClient = ReturnType<typeof createGooglyAuthClient>;

let client: AuthClient | null = null;

function getAuthClient(): AuthClient {
  if (client !== null) return client;
  const config = getConfig();
  client = createGooglyAuthClient({
    convexSiteUrl: config.CONVEX_SITE_URL,
    googleClientId: config.GOOGLE_CLIENT_ID,
    storagePrefix: "upgallery",
  });
  return client;
}

export const authClient = {
  GoogleAuthProvider({ children }: { children: ReactNode }) {
    return createElement(getAuthClient().GoogleAuthProvider, null, children);
  },
  useGoogleAuth() {
    return getAuthClient().useGoogleAuth();
  },
  useConvexGooglyAuth() {
    return getAuthClient().useConvexGooglyAuth();
  },
  handleAuthCallback() {
    return getAuthClient().handleAuthCallback();
  },
  clearAnonymousClaim() {
    getAuthClient().clearAnonymousClaim();
  },
};

export function anonymousClaim(): string | undefined {
  return getAuthClient().getOrCreateAnonymousClaim() ?? undefined;
}
