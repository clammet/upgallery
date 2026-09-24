/** Filter an ordered folder tree while keeping each match's parent chain. */
export function filterFolderTree<
  T extends { _id: string; name: string; ancestorIds: readonly string[] },
>(folders: T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return folders;

  const visibleIds = new Set<string>();
  for (const folder of folders) {
    if (!folder.name.toLowerCase().includes(query)) continue;
    visibleIds.add(folder._id);
    for (const ancestorId of folder.ancestorIds) visibleIds.add(ancestorId);
  }
  return folders.filter((folder) => visibleIds.has(folder._id));
}
