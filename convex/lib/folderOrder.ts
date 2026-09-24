import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { entryNameKey } from "./normalize";
import { readFolderStats } from "./folderStats";

export const FOLDER_LIST_LIMIT = 128;

// Sum per-folder counters rather than reading every file in the subtree.
async function subtreeBytes(
  ctx: QueryCtx,
  folder: Doc<"folders">,
): Promise<number> {
  const stats = await readFolderStats(ctx, folder._id);
  let bytes = stats?.totalBytes ?? 0;
  if (stats === null) {
    // Older folders may not have counters yet. Never silently treat them as empty.
    for await (const entry of ctx.db.query("entries").withIndex(
      "by_folderId_and_state",
      (q) => q.eq("folderId", folder._id).eq("state", "ready"),
    )) {
      bytes += entry.size;
    }
  }
  for await (const child of ctx.db.query("folders").withIndex(
    "by_galleryId_and_parentId",
    (q) => q.eq("galleryId", folder.galleryId).eq("parentId", folder._id),
  )) {
    if (child.filesystemMissingAt === undefined) {
      bytes += await subtreeBytes(ctx, child);
    }
  }
  return bytes;
}

// Share the same bounded list and order between the grid and viewer navigation.
export async function sortedChildFolders(
  ctx: QueryCtx,
  gallery: Doc<"galleries">,
  parent: Doc<"folders">,
) {
  const sortOrder = parent.sortOrder ?? gallery.sortOrder ?? "nameAsc";
  const folders = await ctx.db
    .query("folders")
    .withIndex("by_galleryId_and_parentId", (q) =>
      q.eq("galleryId", gallery._id).eq("parentId", parent._id),
    )
    .take(FOLDER_LIST_LIMIT);
  const keyed = await Promise.all(
    folders.map(async (folder) => {
      let value: string | number = entryNameKey(folder.name);
      if (sortOrder.startsWith("size")) {
        value = folder.filesystemMissingAt === undefined
          ? await subtreeBytes(ctx, folder)
          : 0;
      } else if (sortOrder.startsWith("date")) {
        const sync = folder.modifiedAt === undefined
          ? await ctx.db.query("filesystemSyncStates")
            .withIndex("by_folderId", (q) => q.eq("folderId", folder._id))
            .unique()
          : null;
        value = folder.modifiedAt ?? sync?.knownModifiedAt ?? folder._creationTime;
      }
      return { folder, value };
    }),
  );
  keyed.sort((left, right) => {
    const a = left.value;
    const b = right.value;
    const comparison = a < b
      ? -1
      : a > b
        ? 1
        : left.folder._creationTime - right.folder._creationTime;
    return sortOrder.endsWith("Desc") ? -comparison : comparison;
  });
  return keyed.map(({ folder }) => folder);
}
