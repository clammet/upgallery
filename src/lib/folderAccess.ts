import type { Doc } from "../../convex/_generated/dataModel";

export type FolderAccessPolicy = "inherit" | "public" | "restricted";
export type FolderDiscoverability = "listed" | "unlisted";

type FolderAccessFields = Pick<
  Doc<"folders">,
  "parentId" | "accessPolicy" | "discoverability" | "privacy"
>;

export function folderAccessPolicyOf(
  folder: FolderAccessFields,
): FolderAccessPolicy {
  if (folder.parentId === undefined) return "inherit";
  if (folder.accessPolicy !== undefined) return folder.accessPolicy;
  return folder.privacy === "private" ? "restricted" : "public";
}

export function folderDiscoverabilityOf(
  folder: FolderAccessFields,
): FolderDiscoverability {
  if (folder.parentId === undefined) return "listed";
  if (folder.discoverability !== undefined) return folder.discoverability;
  return folder.privacy === "unlisted" ? "unlisted" : "listed";
}
