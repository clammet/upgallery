import { useEffect, useRef } from "react";
import { authClient } from "../lib/authClient";
import { PageFrame } from "./PageFrame";

export function AuthCallbackPage() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const result = authClient.handleAuthCallback();
    const destination = new URL(result.redirect, window.location.origin);
    if (result.error !== null) {
      destination.searchParams.set("authError", result.error);
    }
    window.location.replace(
      `${destination.pathname}${destination.search}${destination.hash}`,
    );
  }, []);

  return (
    <PageFrame>
      <p>Signing in…</p>
    </PageFrame>
  );
}
