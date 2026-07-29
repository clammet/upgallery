/**
 * Google OAuth authentication for Convex.
 *
 * Google issues the ID token and Convex verifies its signature, issuer, and
 * audience from `convex/auth.config.ts`. The browser performs an additional
 * claim check before storing a token, but that is defense-in-depth only.
 *
 * Google refresh tokens stay in the `googleAuthSessions` Convex table. The
 * browser receives a signed, opaque session token and exchanges it for a new
 * short-lived ID token through `/auth/refresh`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const TOKEN_KEY = "upgallery_google_token";
const SESSION_KEY = "upgallery_google_session";
const OAUTH_NONCE_KEY = "upgallery_oauth_nonce";

function authConfig() {
  const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL?.replace(
    /\/+$/,
    "",
  );
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!convexSiteUrl || !googleClientId) {
    throw new Error(
      "VITE_CONVEX_SITE_URL and VITE_GOOGLE_CLIENT_ID are required",
    );
  }
  return { convexSiteUrl, googleClientId };
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(decodeBase64Url(part));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JWT part");
  }
  return value as Record<string, unknown>;
}

export function validateGoogleJwt(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    if (header.alg !== "RS256") return false;
    if (
      payload.iss !== "https://accounts.google.com" &&
      payload.iss !== "accounts.google.com"
    ) {
      return false;
    }
    if (payload.aud !== authConfig().googleClientId) return false;
    if (
      typeof payload.exp !== "number" ||
      payload.exp * 1000 <= Date.now() + 30_000
    ) {
      return false;
    }
    return typeof payload.sub === "string" && payload.sub.length > 0;
  } catch {
    return false;
  }
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshIdToken(): Promise<string | null> {
  if (refreshPromise !== null) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const sessionToken = localStorage.getItem(SESSION_KEY);
      if (sessionToken === null) return null;
      const response = await fetch(`${authConfig().convexSiteUrl}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken }),
      });
      if (response.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(TOKEN_KEY);
        return null;
      }
      if (!response.ok) return null;
      const value: unknown = await response.json();
      if (
        typeof value === "object" &&
        value !== null &&
        "idToken" in value &&
        typeof value.idToken === "string" &&
        validateGoogleJwt(value.idToken)
      ) {
        localStorage.setItem(TOKEN_KEY, value.idToken);
        return value.idToken;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

interface GoogleAuthContextValue {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  signIn: (redirectTo?: string) => void;
  signOut: () => void;
  refreshAuth: () => Promise<string | null>;
}

const GoogleAuthContext = createContext<GoogleAuthContextValue>({
  isLoading: true,
  isAuthenticated: false,
  token: null,
  signIn: () => undefined,
  signOut: () => undefined,
  refreshAuth: async () => null,
});

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function safeRelativeUrl(value: string | undefined): string {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 2_048
  ) {
    return "/";
  }
  return value;
}

export function GoogleAuthProvider(props: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored !== null && validateGoogleJwt(stored)) return stored;
    if (stored !== null) localStorage.removeItem(TOKEN_KEY);
    return null;
  });
  const [isLoading, setIsLoading] = useState(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    const hasValidToken = stored !== null && validateGoogleJwt(stored);
    return !hasValidToken && localStorage.getItem(SESSION_KEY) !== null;
  });

  useEffect(() => {
    if (token !== null || localStorage.getItem(SESSION_KEY) === null) return;
    void refreshIdToken().then((newToken) => {
      if (newToken !== null) setToken(newToken);
      setIsLoading(false);
    });
  }, [token]);

  useEffect(() => {
    if (token === null || localStorage.getItem(SESSION_KEY) === null) return;
    try {
      const payload = decodeJwtPart(token.split(".")[1]);
      if (typeof payload.exp !== "number") return;
      const refreshIn = payload.exp * 1000 - Date.now() - 5 * 60 * 1000;
      if (refreshIn <= 0) {
        void refreshIdToken().then((newToken) => {
          if (newToken !== null) setToken(newToken);
        });
        return;
      }
      const timeout = window.setTimeout(() => {
        void refreshIdToken().then((newToken) => {
          if (newToken !== null) setToken(newToken);
        });
      }, refreshIn);
      return () => window.clearTimeout(timeout);
    } catch {
      return;
    }
  }, [token]);

  const refreshAuth = useCallback(async () => {
    const refreshed = await refreshIdToken();
    if (refreshed !== null) setToken(refreshed);
    return refreshed;
  }, []);

  const signIn = useCallback((redirectTo?: string) => {
    const nonce = crypto.randomUUID();
    sessionStorage.setItem(OAUTH_NONCE_KEY, nonce);
    const startUrl = new URL(
      "/auth/google/start",
      `${authConfig().convexSiteUrl}/`,
    );
    startUrl.searchParams.set("nonce", nonce);
    startUrl.searchParams.set("origin", window.location.origin);
    startUrl.searchParams.set(
      "redirect",
      safeRelativeUrl(redirectTo ?? currentRelativeUrl()),
    );
    window.location.assign(startUrl.toString());
  }, []);

  const signOut = useCallback(() => {
    const sessionToken = localStorage.getItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setToken(null);
    setIsLoading(false);
    if (sessionToken !== null) {
      void fetch(`${authConfig().convexSiteUrl}/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken }),
      }).catch(() => undefined);
    }
  }, []);

  const value = useMemo<GoogleAuthContextValue>(
    () => ({
      isLoading,
      isAuthenticated: token !== null,
      token,
      signIn,
      signOut,
      refreshAuth,
    }),
    [isLoading, refreshAuth, signIn, signOut, token],
  );
  return (
    <GoogleAuthContext.Provider value={value}>
      {props.children}
    </GoogleAuthContext.Provider>
  );
}

export function useGoogleAuth() {
  return useContext(GoogleAuthContext);
}

export function useConvexGoogleAuth() {
  const { isLoading, isAuthenticated, token, refreshAuth } = useGoogleAuth();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const current = tokenRef.current;
      if (
        current !== null &&
        validateGoogleJwt(current) &&
        !forceRefreshToken
      ) {
        return current;
      }
      const refreshed = await refreshAuth();
      if (refreshed !== null) return refreshed;
      const fallback = tokenRef.current;
      return fallback !== null && validateGoogleJwt(fallback) ? fallback : null;
    },
    [refreshAuth],
  );
  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [fetchAccessToken, isAuthenticated, isLoading],
  );
}

export { OAUTH_NONCE_KEY, SESSION_KEY, TOKEN_KEY, safeRelativeUrl };
