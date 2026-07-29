import { useEffect } from "react";
import {
  OAUTH_NONCE_KEY,
  SESSION_KEY,
  TOKEN_KEY,
  safeRelativeUrl,
  validateGoogleJwt,
} from "../lib/googleAuth";
import { PageFrame } from "./PageFrame";

export function AuthCallbackPage() {
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token");
    const sessionToken = fragment.get("session");
    const oauthError = fragment.get("error");
    const state = new URLSearchParams(fragment.get("state") ?? "");
    const nonce = state.get("nonce");
    const origin = state.get("origin");
    const redirect = safeRelativeUrl(state.get("redirect") ?? undefined);
    const storedNonce = sessionStorage.getItem(OAUTH_NONCE_KEY);
    sessionStorage.removeItem(OAUTH_NONCE_KEY);

    if (
      storedNonce === null ||
      nonce !== storedNonce ||
      origin !== window.location.origin
    ) {
      console.warn("OAuth state verification failed; discarding credentials");
      window.location.replace("/");
      return;
    }
    if (oauthError !== null) {
      const destination = new URL(redirect, window.location.origin);
      destination.searchParams.set("authError", oauthError);
      window.location.replace(
        `${destination.pathname}${destination.search}${destination.hash}`,
      );
      return;
    }
    if (token === null || !validateGoogleJwt(token)) {
      console.warn("Google ID token failed client-side validation");
      window.location.replace("/");
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    if (sessionToken !== null) {
      localStorage.setItem(SESSION_KEY, sessionToken);
    }
    window.location.replace(redirect);
  }, []);

  return (
    <PageFrame>
      <p>Signing in…</p>
    </PageFrame>
  );
}
