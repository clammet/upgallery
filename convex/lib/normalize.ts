export const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_HOSTS_PER_GALLERY = 16;
export const MAX_FOLDER_DEPTH = 32;

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function normalizeHost(host: string): string {
  return host.trim().toLocaleLowerCase().replace(/:\d+$/, "");
}

export function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function normalizeStorageRoot(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (
    normalized.length === 0 ||
    normalized.length > 200 ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/^[a-zA-Z0-9/_-]+$/.test(normalized)
  ) {
    throw new Error(
      "Internal storage path must be relative and contain only letters, numbers, /, _ and -.",
    );
  }
  return normalized;
}

export function normalizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length < 2 || slug.length > 80) {
    throw new Error(
      "Internal slug must contain between 2 and 80 URL-safe characters.",
    );
  }
  return slug;
}

export function cleanFileName(value: string): string {
  const name = value
    .normalize("NFKC")
    .replaceAll(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim();
  if (name.length === 0 || name.length > 240) {
    throw new Error("File name must contain between 1 and 240 characters.");
  }
  return name;
}

export function cleanFilesystemSegment(value: string): string {
  const name = value.normalize("NFKC").trim();
  if (
    name.length === 0 ||
    name.length > 240 ||
    name === "." ||
    name === ".." ||
    /[\u0000-\u001f\u007f/\\]/.test(name)
  ) {
    throw new Error(
      "Filesystem names must contain 1–240 characters and cannot contain /, \\, control characters, . or ..",
    );
  }
  return name;
}

export function filesystemSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "folder";
}

export function cleanDescription(value: string | undefined): string | undefined {
  const description = value?.trim();
  if (!description) {
    return undefined;
  }
  if (description.length > 10_000) {
    throw new Error("Description cannot exceed 10,000 characters.");
  }
  return description;
}
