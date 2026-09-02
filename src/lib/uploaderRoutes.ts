// Uploader files have no permanent direct-URL page; the shareable address of
// an upload is the listing page with the lightbox open on it.
export function uploaderItemUrl(routeRoot: string, entryId: string): string {
  const root = routeRoot === "/" ? "" : routeRoot.replace(/\/+$/, "");
  return `${root === "" ? "/" : root}?item=${encodeURIComponent(entryId)}`;
}
