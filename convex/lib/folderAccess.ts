import type { Doc } from "../_generated/dataModel";

export type FolderAccessPolicy = "inherit" | "public" | "restricted";
export type FolderDiscoverability = "listed" | "unlisted";
export type LegacyPrivacy = "public" | "unlisted" | "private";

type StoredFolderAccess = Pick<
  Doc<"folders">,
  "parentId" | "accessPolicy" | "discoverability" | "privacy"
>;

export function folderAccessPolicyOf(
  folder: StoredFolderAccess,
): FolderAccessPolicy {
  if (folder.parentId === undefined) return "inherit";
  if (folder.accessPolicy !== undefined) return folder.accessPolicy;
  if (folder.privacy === "private") return "restricted";
  if (folder.privacy === "public" || folder.privacy === "unlisted") {
    return "public";
  }
  return "inherit";
}

export function folderDiscoverabilityOf(
  folder: StoredFolderAccess,
): FolderDiscoverability {
  if (folder.parentId === undefined) return "listed";
  if (folder.discoverability !== undefined) return folder.discoverability;
  return folder.privacy === "unlisted" ? "unlisted" : "listed";
}

export function accessFieldsFromLegacyPrivacy(
  parentId: Doc<"folders">["parentId"],
  privacy: LegacyPrivacy | undefined,
): {
  accessPolicy: FolderAccessPolicy;
  discoverability: FolderDiscoverability;
} {
  if (parentId === undefined) {
    return { accessPolicy: "inherit", discoverability: "listed" };
  }
  return {
    accessPolicy: privacy === "private" ? "restricted" : "public",
    discoverability: privacy === "unlisted" ? "unlisted" : "listed",
  };
}
