import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { entryNameKey } from "./normalize";
import { readSubtreeBytes } from "./folderStats";

export const FOLDER_LIST_LIMIT = 128;

// Share the same bounded list and order between the grid and viewer navigation.
export async function sortedChildFoldersResult(
  ctx: QueryCtx,
  gallery: Doc<"galleries">,
  parent: Doc<"folders">,
) {
  const sortOrder = parent.sortOrder ?? gallery.sortOrder ?? "nameAsc";
  const folders = await ctx.db.query("folders")
    .withIndex("by_galleryId_and_parentId", q => q.eq("galleryId", gallery._id).eq("parentId", parent._id))
    .take(FOLDER_LIST_LIMIT);
  const keyed = await Promise.all(folders.map(async (folder) => ({
    folder,
    bytes: sortOrder.startsWith("size") && folder.filesystemMissingAt === undefined
      ? await readSubtreeBytes(ctx, folder._id) : 0,
  })));
  // Older deployments may have no subtree totals yet. Keep their entire list
  // in filename order until initialization completes; unknown is never zero.
  const sizeSortPending = keyed.some(({ bytes }) => bytes === null);
  const effectiveOrder = sizeSortPending ? "nameAsc" : sortOrder;
  const value = ({ folder, bytes }: typeof keyed[number]): string | number => {
    if (effectiveOrder.startsWith("size")) return bytes!;
    if (effectiveOrder.startsWith("date")) return folder.modifiedAt ?? folder._creationTime;
    return entryNameKey(folder.name);
  };
  keyed.sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const comparison = a < b ? -1 : a > b ? 1 : left.folder._creationTime - right.folder._creationTime;
    return effectiveOrder.endsWith("Desc") ? -comparison : comparison;
  });
  return { folders: keyed.map(({ folder }) => folder), sizeSortPending };
}

export async function sortedChildFolders(ctx: QueryCtx, gallery: Doc<"galleries">, parent: Doc<"folders">) {
  return (await sortedChildFoldersResult(ctx, gallery, parent)).folders;
}
