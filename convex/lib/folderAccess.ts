import type { Doc } from "../_generated/dataModel";

export type FolderAccessPolicy = "inherit" | "public" | "restricted";
export type FolderDiscoverability = "listed" | "unlisted";

type StoredFolderAccess = Pick<
  Doc<"folders">,
  "parentId" | "accessPolicy" | "discoverability"
>;

export function folderAccessPolicyOf(
  folder: StoredFolderAccess,
): FolderAccessPolicy {
  if (folder.parentId === undefined) return "inherit";
  return folder.accessPolicy;
}

export function folderDiscoverabilityOf(
  folder: StoredFolderAccess,
): FolderDiscoverability {
  if (folder.parentId === undefined) return "listed";
  return folder.discoverability;
}
