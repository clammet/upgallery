export function publicMediaUrl(
  storageKey: string,
  filesystemModifiedAt?: number,
): string {
  const publicPath = storageKey.startsWith("public/")
    ? storageKey.slice("public/".length)
    : storageKey.startsWith("derivatives/gallery/")
      ? storageKey
      : undefined;
  if (publicPath === undefined) {
    throw new Error("Protected storage keys cannot be served directly");
  }
  const encodedPath = publicPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const version =
    filesystemModifiedAt === undefined
      ? ""
      : `?v=${encodeURIComponent(filesystemModifiedAt)}`;
  return `/media/${encodedPath}${version}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function storageApi(path: string): string {
  return `${import.meta.env.VITE_STORAGE_API_URL ?? ""}${path}`;
}
