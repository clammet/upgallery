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
  folderSegments?: string[];
  fileName?: string;
}): string {
  if (input.galleryKind === "image" && input.storageKind === "user") {
    if (input.thumbnail) {
      return [
        "public",
        "users",
        input.storageRoot,
        ".upgallery",
        "thumbnails",
        input.sha256.slice(0, 2),
        input.sha256.slice(2, 4),
        `${input.sha256}.thumb.jpg`,
      ].join("/");
    }
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
  const suffix = input.thumbnail ? ".thumb.jpg" : `.${input.extension}`;
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

export function publicMediaPath(storageKey: string): string {
  if (!storageKey.startsWith("public/")) {
    throw new Error("Protected files do not have direct media URLs");
  }
  return `/media/${storageKey.slice("public/".length)}`;
}
