import type { Id } from "../_generated/dataModel";

/**
 * Materialized subtree key for a folder: its ancestor ids and its own id
 * joined with "/", with a trailing "/". Every descendant folder's key starts
 * with its ancestors' keys, so a single index range over
 * entries.folderPathKey — greater than a folder's key, less than the key
 * plus "￿" — selects the entries in that folder's strict descendants.
 *
 * Built from ids, not names, so folder renames never touch it. Folder moves
 * repair the subtree's keys through folders.reparentSubtree.
 */
export function folderPathKey(folder: {
  _id: Id<"folders">;
  ancestorIds: Array<Id<"folders">>;
}): string {
  return [...folder.ancestorIds, folder._id, ""].join("/");
}
