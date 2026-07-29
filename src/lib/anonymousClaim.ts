const COOKIE_NAME = "upgallery_anonymous_claim";

function randomClaim(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getOrCreateAnonymousClaim(): string {
  const existing = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) {
    return existing;
  }
  const claim = randomClaim();
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${claim}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  return claim;
}

export function clearAnonymousClaim(): void {
  document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}
