export function uploaderFileUrl(
  routeRoot: string,
  entryId: string,
  fileName: string,
): string {
  const root = routeRoot === "/" ? "" : routeRoot.replace(/\/+$/, "");
  return `${root}/files/${encodeURIComponent(entryId)}/${encodeURIComponent(fileName)}`;
}

export function uploaderFileEntryId(
  path: string,
  routeRoot: string,
): string | null {
  const root = routeRoot === "/" ? "" : routeRoot.replace(/\/+$/, "");
  const prefix = `${root}/files/`;
  if (!path.startsWith(prefix)) return null;
  const entryId = path.slice(prefix.length).split("/", 1)[0];
  if (!entryId) return null;
  try {
    return decodeURIComponent(entryId);
  } catch {
    return null;
  }
}
