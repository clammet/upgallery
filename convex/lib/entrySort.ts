import type { Doc } from "../_generated/dataModel";

type SortTimestampInput = Pick<
  Doc<"entries">,
  | "createdAt"
  | "filesystemModifiedAt"
  | "metadataJson"
  | "sortFallbackTimestamp"
>;

function parseCapturedAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // ffprobe commonly emits +1000 while Date.parse expects +10:00 on some
  // runtimes. EXIF without a zone is treated as UTC for stable ordering.
  const normalizedZone = trimmed.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const exifMatch = normalizedZone.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  const timestamp = exifMatch
    ? Date.UTC(
        Number(exifMatch[1]),
        Number(exifMatch[2]) - 1,
        Number(exifMatch[3]),
        Number(exifMatch[4]),
        Number(exifMatch[5]),
        Number(exifMatch[6]),
      )
    : Date.parse(normalizedZone);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function entrySortTimestamp(input: SortTimestampInput): number {
  if (input.metadataJson !== undefined) {
    try {
      const metadata: unknown = JSON.parse(input.metadataJson);
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        "DateTimeOriginal" in metadata
      ) {
        const capturedAt = parseCapturedAt(metadata.DateTimeOriginal);
        if (capturedAt !== undefined) return capturedAt;
      }
    } catch {
      // Invalid metadata falls through to the durable file timestamps.
    }
  }
  return (
    input.sortFallbackTimestamp ??
    input.filesystemModifiedAt ??
    input.createdAt
  );
}
