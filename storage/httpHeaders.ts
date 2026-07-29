import type { DownloadClaim } from "./convex.js";

const CHARSET_PARAMETER = /(?:^|;)\s*charset\s*=/i;
const RFC_5987_EXTRA_CHARACTERS = /['()*]/g;

export function contentTypeForDownload(mimeType: string): string {
  const normalized = mimeType.trim();
  const mediaType = normalized.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !mediaType?.startsWith("text/") ||
    CHARSET_PARAMETER.test(normalized)
  ) {
    return normalized;
  }
  return `${normalized.replace(/;\s*$/, "")}; charset=utf-8`;
}

export function contentDispositionForDownload(
  disposition: DownloadClaim["disposition"],
  fileName: string,
): string {
  const encodedFileName = encodeURIComponent(fileName).replace(
    RFC_5987_EXTRA_CHARACTERS,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition === "attachment" ? "attachment" : "inline"}; filename*=UTF-8''${encodedFileName}`;
}
