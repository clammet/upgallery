const encoder = new TextEncoder();
const MAX_STATE_LENGTH = 4_096;
const MAX_ORIGIN_LENGTH = 512;
const MAX_REDIRECT_LENGTH = 2_048;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

export interface GoogleOAuthState {
  nonce: string;
  origin: string;
  redirect: string;
}

function isCanonicalOrigin(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.origin !== "null" &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

export function isSafeOAuthRedirect(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REDIRECT_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//")
  );
}

export function isValidGoogleOAuthState(
  state: GoogleOAuthState,
): boolean {
  return (
    NONCE_PATTERN.test(state.nonce) &&
    isCanonicalOrigin(state.origin) &&
    isSafeOAuthRedirect(state.redirect)
  );
}

function serializeUnsignedState(state: GoogleOAuthState): string {
  return new URLSearchParams({
    nonce: state.nonce,
    origin: state.origin,
    redirect: state.redirect,
  }).toString();
}

function base64UrlEncode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function getStateSigningKey(secret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    baseKey,
    encoder.encode("upgallery-google-oauth-state-v1"),
  );
  return await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createGoogleOAuthState(
  secret: string,
  state: GoogleOAuthState,
): Promise<string> {
  if (!isValidGoogleOAuthState(state)) {
    throw new Error("Invalid Google OAuth state");
  }
  const unsigned = serializeUnsignedState(state);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getStateSigningKey(secret),
    encoder.encode(unsigned),
  );
  return `${unsigned}&signature=${encodeURIComponent(
    base64UrlEncode(signature),
  )}`;
}

export async function verifyGoogleOAuthState(
  secret: string,
  serialized: string,
): Promise<GoogleOAuthState | null> {
  if (serialized.length === 0 || serialized.length > MAX_STATE_LENGTH) {
    return null;
  }
  const params = new URLSearchParams(serialized);
  const entries = [...params.entries()];
  if (
    entries.length !== 4 ||
    entries.some(
      ([name]) =>
        name !== "nonce" &&
        name !== "origin" &&
        name !== "redirect" &&
        name !== "signature",
    )
  ) {
    return null;
  }
  const nonce = params.get("nonce");
  const origin = params.get("origin");
  const redirect = params.get("redirect");
  const encodedSignature = params.get("signature");
  if (
    nonce === null ||
    origin === null ||
    redirect === null ||
    encodedSignature === null
  ) {
    return null;
  }
  const state = { nonce, origin, redirect };
  if (!isValidGoogleOAuthState(state)) {
    return null;
  }
  const signature = base64UrlDecode(encodedSignature);
  if (signature === null) {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await getStateSigningKey(secret),
    signature.buffer as ArrayBuffer,
    encoder.encode(serializeUnsignedState(state)),
  );
  return valid ? state : null;
}
