import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cleanFilesystemSegment } from "./normalize";

type DbCtx = QueryCtx | MutationCtx;

export async function getFilesystemFolderSegments(
  ctx: DbCtx,
  gallery: Doc<"galleries">,
  folder: Doc<"folders">,
): Promise<string[]> {
  if (gallery.rootFolderId === undefined) {
    throw new Error("Gallery root folder is not configured");
  }
  const ancestors = await Promise.all(
    folder.ancestorIds
      .filter((ancestorId) => ancestorId !== gallery.rootFolderId)
      .map((ancestorId) => ctx.db.get("folders", ancestorId)),
  );
  const segments: string[] = [];
  for (const ancestor of ancestors) {
    if (ancestor === null || ancestor.galleryId !== gallery._id) {
      throw new Error("Folder ancestry is invalid");
    }
    segments.push(cleanFilesystemSegment(ancestor.name));
  }
  if (folder._id !== gallery.rootFolderId) {
    segments.push(cleanFilesystemSegment(folder.name));
  }
  return segments;
}

export function getFilesystemStorageKey(
  gallery: Doc<"galleries">,
  folderSegments: string[],
  fileName: string,
): string {
  return [
    "public",
    "users",
    ...gallery.storageRoot.split("/"),
    ...folderSegments.map(cleanFilesystemSegment),
    cleanFilesystemSegment(fileName),
  ].join("/");
}
