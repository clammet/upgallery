const HEIF_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
]);

export function isHeifImage(mimeType: string, fileName: string): boolean {
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    HEIF_MIME_TYPES.has(normalizedMimeType) ||
    /\.(?:heic|heics|heif|heifs|hif)$/i.test(fileName)
  );
}

export function isSafariBrowser(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return (
    /Safari/i.test(userAgent) &&
    !/(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPiOS|Android)/i.test(userAgent)
  );
}

export function shouldUseNativeHeifPreview(
  mimeType: string,
  fileName: string,
  userAgent?: string,
): boolean {
  return isHeifImage(mimeType, fileName) && isSafariBrowser(userAgent);
}
