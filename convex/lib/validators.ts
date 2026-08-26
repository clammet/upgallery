import { v } from "convex/values";

export const galleryKind = v.union(
  v.literal("image"),
  v.literal("uploader"),
);

export const storageKind = v.union(
  v.literal("shared"),
  v.literal("user"),
);

export const privacy = v.union(
  v.literal("public"),
  v.literal("unlisted"),
  v.literal("private"),
);

export const galleryRole = v.union(
  v.literal("owner"),
  v.literal("editor"),
  v.literal("viewer"),
);

export const uploaderAccess = v.union(
  v.literal("anonymous"),
  v.literal("sso"),
  v.literal("restricted"),
);

export const folderPreviewMode = v.union(
  v.literal("first"),
  v.literal("random"),
  v.literal("first3"),
  v.literal("random3"),
);

export const entryState = v.union(
  v.literal("ready"),
  v.literal("deleted"),
);

export const thumbnailState = v.union(
  v.literal("pending"),
  v.literal("failed"),
);

export const uploadState = v.union(
  v.literal("pending"),
  v.literal("uploading"),
  v.literal("complete"),
  v.literal("failed"),
);

export const jobState = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("failed"),
);

export const mediaKind = v.union(
  v.literal("image"),
  v.literal("video"),
  v.literal("audio"),
  v.literal("text"),
  v.literal("archive"),
  v.literal("document"),
  v.literal("other"),
);

export const disposition = v.union(
  v.literal("inline"),
  v.literal("attachment"),
  v.literal("thumbnail"),
  v.literal("preview"),
);

export const themeValidator = v.object({
  accent: v.optional(v.string()),
  secondary: v.optional(v.string()),
  background: v.optional(v.string()),
  mode: v.optional(v.union(v.literal("light"), v.literal("dark"))),
  foreground: v.optional(v.string()),
  surface: v.optional(v.string()),
  muted: v.optional(v.string()),
  headerDivider: v.optional(v.string()),
  cellBorder: v.optional(v.string()),
  radius: v.optional(v.number()),
  density: v.optional(v.union(v.literal("compact"), v.literal("comfortable"))),
  thumbnailFrameSize: v.optional(v.number()),
  customCss: v.optional(v.string()),
});

// How an upload or move proceeds when a gallery folder already holds a file
// with the same name (case-insensitive). Absent means "ask first".
export const conflictPolicy = v.union(
  v.literal("replace"),
  v.literal("rename"),
);

// Operation-wide choice: the two policies above, or skip every conflicting
// item (it stays where it is and leaves the operation).
export const bulkConflictPolicy = v.union(conflictPolicy, v.literal("skip"));

// A move job parked because its destination already has the name; it waits
// for a conflict policy before it is queued.
export const entryMoveJobState = v.union(jobState, v.literal("conflict"));

// A bulk operation whose remaining items all wait on a conflict policy.
export const bulkOperationStatus = v.union(jobState, v.literal("conflict"));
