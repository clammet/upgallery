import { describe, expect, test } from "vitest";
import {
  createGoogleOAuthState,
  isSafeOAuthRedirect,
  verifyGoogleOAuthState,
} from "./lib/googleOAuthState";
import { googleOAuthCallbackUrl } from "./lib/googleOAuthUrls";

const secret = "test-only-google-oauth-state-signing-secret";
const input = {
  nonce: "53eec567-1854-46e4-a1aa-9f97322a0a66",
  origin: "https://photos.example.com",
  redirect: "/albums/summer?view=grid#favorites",
};

describe("Google OAuth router state", () => {
  test("round-trips a signed tenant return destination", async () => {
    const state = await createGoogleOAuthState(secret, input);

    await expect(verifyGoogleOAuthState(secret, state)).resolves.toEqual(input);
  });

  test("rejects a changed return origin", async () => {
    const state = await createGoogleOAuthState(secret, input);
    const changed = state.replace(
      encodeURIComponent(input.origin),
      encodeURIComponent("https://attacker.example"),
    );

    await expect(verifyGoogleOAuthState(secret, changed)).resolves.toBeNull();
  });

  test("rejects cross-origin and oversized relative redirects", () => {
    expect(isSafeOAuthRedirect("/gallery/one")).toBe(true);
    expect(isSafeOAuthRedirect("//attacker.example/path")).toBe(false);
    expect(isSafeOAuthRedirect("https://attacker.example/path")).toBe(false);
    expect(isSafeOAuthRedirect(`/${"a".repeat(2_048)}`)).toBe(false);
  });
});

describe("Google OAuth router URLs", () => {
  test("uses the HTTP Action request origin for the callback", () => {
    expect(
      googleOAuthCallbackUrl(
        "http://localhost:3211/auth/google/start?nonce=test",
      ),
    ).toBe("http://localhost:3211/auth/google/callback");
    expect(
      googleOAuthCallbackUrl(
        "https://convex-actions.example.com/auth/google/callback?code=test",
      ),
    ).toBe("https://convex-actions.example.com/auth/google/callback");
  });

  test("rejects non-HTTP request URLs", () => {
    expect(() =>
      googleOAuthCallbackUrl("ftp://localhost:3211/auth/google/start"),
    ).toThrow("Invalid OAuth request URL");
  });
});
