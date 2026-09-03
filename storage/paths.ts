import { dirname, extname, resolve, sep } from "node:path";
import { config } from "./config.js";

export function sanitizeExtension(fileName: string, mimeExtension?: string): string {
  const candidate = extname(fileName).slice(1).toLocaleLowerCase();
  const extension = /^[a-z0-9]{1,16}$/.test(candidate)
    ? candidate
    : /^[a-z0-9]{1,16}$/.test(mimeExtension ?? "")
      ? mimeExtension!
      : "bin";
  return extension;
}

export function buildStorageKey(input: {
  galleryKind: "image" | "uploader";
  storageKind: "shared" | "user";
  storageRoot: string;
  sha256: string;
  extension: string;
  thumbnail?: boolean;
  preview?: boolean;
  folderSegments?: string[];
  fileName?: string;
}): string {
  if (input.thumbnail && input.preview) {
    throw new Error("A storage key cannot be both a thumbnail and a preview");
  }
  if (input.thumbnail || input.preview) {
    return [
      "derivatives",
      input.galleryKind === "uploader" ? "up" : "gallery",
      ...(input.galleryKind === "image" ? [input.storageKind] : []),
      input.storageRoot,
      input.preview ? "previews" : "thumbnails",
      input.sha256.slice(0, 2),
      input.sha256.slice(2, 4),
      `${input.sha256}.${input.preview ? "preview" : "thumb"}.jpg`,
    ].join("/");
  }
  if (input.galleryKind === "image" && input.storageKind === "user") {
    if (input.fileName === undefined) {
      throw new Error("User-backed files require their original file name");
    }
    return userFilesystemStorageKey(
      input.storageRoot,
      input.folderSegments ?? [],
      input.fileName,
    );
  }
  const visibility = input.galleryKind === "image" ? "public" : "protected";
  const bucket =
    input.galleryKind === "uploader"
      ? "uploaders"
      : input.storageKind === "shared"
        ? "shared"
        : "users";
  const suffix = input.preview
    ? ".preview.jpg"
    : input.thumbnail
      ? ".thumb.jpg"
      : `.${input.extension}`;
  return [
    visibility,
    bucket,
    input.storageRoot,
    input.sha256.slice(0, 2),
    input.sha256.slice(2, 4),
    `${input.sha256}${suffix}`,
  ].join("/");
}

export function userFilesystemStorageKey(
  storageRoot: string,
  folderSegments: string[],
  fileName?: string,
): string {
  const segments = [
    "public",
    "users",
    ...storageRoot.split("/"),
    ...folderSegments,
    ...(fileName === undefined ? [] : [fileName]),
  ];
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new Error("Unsafe user filesystem path");
    }
  }
  return segments.join("/");
}

export function absoluteStoragePath(storageKey: string): string {
  if (
    storageKey.startsWith("/") ||
    storageKey.includes("\\") ||
    storageKey.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("Unsafe storage key");
  }
  const path = resolve(config.storageRoot, storageKey);
  const rootPrefix = `${config.storageRoot}${sep}`;
  if (!path.startsWith(rootPrefix)) {
    throw new Error("Storage key escapes the configured root");
  }
  return path;
}

export function storageDirectory(storageKey: string): string {
  return dirname(absoluteStoragePath(storageKey));
}

// Everything under public/ and the gallery derivatives is served straight
// from disk by the reverse proxy, which reads as "other". User-backed
// galleries are bind mounts of directories that belong to an SSH user; the
// host grants that user a default ACL on the directory, and an ACL entry is
// only as wide as the file's group bits (the ACL mask). Group write on these
// files is therefore what lets the directory's owner edit and delete what
// the storage service created there. The service's own group has no other
// members, so on shared roots the group bit changes nothing.
export function isDirectlyServedStorageKey(storageKey: string): boolean {
  return (
    storageKey.startsWith("public/") ||
    storageKey.startsWith("derivatives/gallery/")
  );
}

export function storageFileMode(storageKey: string): number {
  return isDirectlyServedStorageKey(storageKey) ? 0o664 : 0o600;
}

export function storageDirectoryMode(storageKey: string): number {
  return isDirectlyServedStorageKey(storageKey) ? 0o775 : 0o700;
}

// mkdir modes are still filtered by the process umask, and the node image's
// default of 022 would strip the group write bit storageDirectoryMode asks
// for. Every storage entry point calls this before touching the roots.
export function applyStorageUmask(): void {
  process.umask(0o002);
}

export function publicMediaPath(storageKey: string): string {
  if (storageKey.startsWith("derivatives/gallery/")) {
    return `/media/${storageKey}`;
  }
  if (!storageKey.startsWith("public/")) {
    throw new Error("Protected files do not have direct media URLs");
  }
  return `/media/${storageKey.slice("public/".length)}`;
}
