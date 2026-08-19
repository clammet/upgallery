const MAX_DROPPED_FILES = 500;

export type DroppedFile = {
  file: File;
  /** Folder names between the drop target and the file, outermost first. */
  pathSegments: string[];
};

/**
 * Reads files (including folder contents) from a drop's DataTransfer.
 * Must be invoked synchronously from the drop event handler — the items
 * become inaccessible once the handler returns.
 */
export function collectDroppedFiles(
  dataTransfer: DataTransfer,
): Promise<DroppedFile[]> {
  const entries: FileSystemEntry[] = [];
  const flatFiles: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry !== null) {
      entries.push(entry);
    } else {
      // Some drag sources (e.g. images dragged out of another page)
      // produce file items with no filesystem entry.
      const file = item.getAsFile();
      if (file !== null) flatFiles.push(file);
    }
  }
  return (async () => {
    const collected: DroppedFile[] = flatFiles.map((file) => ({
      file,
      pathSegments: [],
    }));
    for (const entry of entries) {
      await collectEntry(entry, [], collected);
    }
    return collected;
  })();
}

/**
 * Returns true when the drop contains a folder. Must be invoked
 * synchronously from the drop event handler.
 */
export function dropContainsDirectory(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(
    (item) =>
      item.kind === "file" && item.webkitGetAsEntry()?.isDirectory === true,
  );
}

async function collectEntry(
  entry: FileSystemEntry,
  pathSegments: string[],
  collected: DroppedFile[],
): Promise<void> {
  if (collected.length >= MAX_DROPPED_FILES) {
    throw new Error(
      `Folder drops are limited to ${MAX_DROPPED_FILES} files`,
    );
  }
  // Skip hidden items inside dropped folders (.DS_Store and friends).
  if (pathSegments.length > 0 && entry.name.startsWith(".")) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    collected.push({ file, pathSegments });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    for (const child of batch) {
      await collectEntry(child, [...pathSegments, entry.name], collected);
    }
  }
}
