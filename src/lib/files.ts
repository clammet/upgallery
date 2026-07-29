export const defaultFileIcons: Record<string, { icon: string; label: string }> = {
  pdf: { icon: "PDF", label: "PDF document" },
  zip: { icon: "ZIP", label: "ZIP archive" },
  gz: { icon: "GZ", label: "Gzip archive" },
  tar: { icon: "TAR", label: "Tar archive" },
  txt: { icon: "TXT", label: "Text file" },
  md: { icon: "MD", label: "Markdown file" },
  doc: { icon: "DOC", label: "Word document" },
  docx: { icon: "DOC", label: "Word document" },
  xls: { icon: "XLS", label: "Spreadsheet" },
  xlsx: { icon: "XLS", label: "Spreadsheet" },
  ppt: { icon: "PPT", label: "Presentation" },
  pptx: { icon: "PPT", label: "Presentation" },
  mp3: { icon: "AUD", label: "Audio file" },
  wav: { icon: "AUD", label: "Audio file" },
};

export function publicMediaUrl(
  storageKey: string,
  filesystemModifiedAt?: number,
): string {
  if (!storageKey.startsWith("public/")) {
    throw new Error("Protected storage keys cannot be served directly");
  }
  const encodedPath = storageKey
    .slice("public/".length)
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
