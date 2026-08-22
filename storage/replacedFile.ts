import { stat, unlink } from "node:fs/promises";
import { absoluteStoragePath } from "./paths.js";

/**
 * Removes the file a replacement displaced. In user-backed galleries the
 * replaced file can sit on a case variant of the installed path; on a
 * case-insensitive filesystem that is the same file, so only a path that
 * resolves to a different inode is unlinked.
 */
export async function removeReplacedFile(
  replacedKey: string,
  installedPath: string,
): Promise<void> {
  const replacedPath = absoluteStoragePath(replacedKey);
  const [replaced, installed] = await Promise.all([
    stat(replacedPath).catch(() => null),
    stat(installedPath),
  ]);
  if (
    replaced === null ||
    (replaced.dev === installed.dev && replaced.ino === installed.ino)
  ) {
    return;
  }
  await unlink(replacedPath);
}
