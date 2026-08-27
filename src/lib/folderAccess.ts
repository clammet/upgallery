import type { Doc } from "../../convex/_generated/dataModel";

export type FolderAccessPolicy = "inherit" | "public" | "restricted";
export type FolderDiscoverability = "listed" | "unlisted";

type FolderAccessFields = Pick<
  Doc<"folders">,
  "parentId" | "accessPolicy" | "discoverability"
>;

export function folderAccessPolicyOf(
  folder: FolderAccessFields,
): FolderAccessPolicy {
  if (folder.parentId === undefined) return "inherit";
  return folder.accessPolicy;
}

export function folderDiscoverabilityOf(
  folder: FolderAccessFields,
): FolderDiscoverability {
  if (folder.parentId === undefined) return "listed";
  return folder.discoverability;
}
