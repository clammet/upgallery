export function googleOAuthCallbackUrl(requestUrl: string): string {
  const request = new URL(requestUrl);
  if (
    (request.protocol !== "http:" && request.protocol !== "https:") ||
    request.username !== "" ||
    request.password !== ""
  ) {
    throw new Error("Invalid OAuth request URL");
  }
  return new URL("/auth/google/callback", request.origin).toString();
}
