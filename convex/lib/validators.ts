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
  background: v.optional(v.string()),
  foreground: v.optional(v.string()),
  surface: v.optional(v.string()),
  muted: v.optional(v.string()),
  radius: v.optional(v.number()),
  density: v.optional(v.union(v.literal("compact"), v.literal("comfortable"))),
  thumbnailFrameSize: v.optional(v.number()),
  customCss: v.optional(v.string()),
});
