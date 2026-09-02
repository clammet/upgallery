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

// Runs the client half of a mutation that returned a filesystem operation
// capability: the storage server performs the file/folder work and marks the
// operation complete. A "complete" result needs no follow-up.
export async function completeFilesystemOperation(result: {
  kind: "complete" | "filesystem";
  operationId?: string;
  token?: string;
}): Promise<{ folderId: string | null } | null> {
  if (result.kind === "complete") return null;
  if (result.operationId === undefined || result.token === undefined) {
    throw new Error("Filesystem operation capability is missing");
  }
  const response = await fetch(
    storageApi("/api/storage/user-folder-operation"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: result.operationId,
        token: result.token,
      }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Filesystem operation failed";
    throw new Error(message);
  }
  return {
    folderId:
      typeof body === "object" &&
      body !== null &&
      "folderId" in body &&
      typeof body.folderId === "string"
        ? body.folderId
        : null,
  };
}
