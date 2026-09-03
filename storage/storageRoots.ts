import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

// Startup guard for deployments whose storage roots are bind mounts. When a
// mount source is missing at boot (for example a block storage volume that
// mounts with nofail), Docker creates an empty directory in its place and the
// service would come up against an empty tree, then reconcile metadata
// against it. Each mounted root carries a sentinel file that the deployment
// writes after confirming the volume is mounted; a root without the sentinel
// is not the real storage and the process refuses to start.

export const DEFAULT_STORAGE_ROOT_SENTINEL = ".upgallery-storage-root";

export interface StorageRootGuardConfig {
  storageRoot: string;
  // Paths relative to storageRoot that are separately mounted. Empty
  // disables the guard (local development runs against one plain directory).
  mountRoots: readonly string[];
  sentinelName: string;
}

export function parseMountRoots(raw: string | undefined): string[] {
  const roots = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const root of roots) {
    if (isAbsolute(root) || root.split(/[\\/]/).includes("..")) {
      throw new Error(
        `STORAGE_MOUNT_ROOTS entry "${root}" must be a relative path without ".."`,
      );
    }
  }
  return [
    ...new Set(roots.map((root) => normalize(root).replace(/[\\/]+$/, ""))),
  ];
}

export function parseSentinelName(raw: string | undefined): string {
  const name = raw?.trim() || DEFAULT_STORAGE_ROOT_SENTINEL;
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("STORAGE_ROOT_SENTINEL must be a bare file name");
  }
  return name;
}

// Returns the sentinel paths that are missing or are not regular files, in
// mount root order. Empty means every configured root is present.
export async function findMissingStorageRootSentinels(
  guard: StorageRootGuardConfig,
): Promise<string[]> {
  const missing: string[] = [];
  for (const mountRoot of guard.mountRoots) {
    const sentinelPath = join(guard.storageRoot, mountRoot, guard.sentinelName);
    const metadata = await stat(sentinelPath).catch(() => null);
    if (metadata === null || !metadata.isFile()) {
      missing.push(sentinelPath);
    }
  }
  return missing;
}

// Exits the process when a configured mount root lacks its sentinel. Call
// before anything touches the storage tree.
export async function assertStorageRootsMounted(
  guard: StorageRootGuardConfig,
  serviceName: string,
): Promise<void> {
  if (guard.mountRoots.length === 0) {
    return;
  }
  const missing = await findMissingStorageRootSentinels(guard);
  if (missing.length === 0) {
    return;
  }
  console.error(
    [
      `${serviceName} refusing to start: storage root sentinel missing at`,
      ...missing.map((path) => `  ${path}`),
      `Each mounted storage root must contain "${guard.sentinelName}"` +
        ` (STORAGE_MOUNT_ROOTS=${guard.mountRoots.join(",")}` +
        ` under ${guard.storageRoot}${sep}).`,
      "The backing volume is probably not mounted. Starting anyway would",
      "treat an empty directory as the real storage.",
    ].join("\n"),
  );
  process.exit(1);
}
