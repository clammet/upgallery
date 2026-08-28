export type GalleryFolderLocation = {
  pathname: string;
  search: string;
};

export type GalleryRoute = {
  origin: string;
  routeRoot: string;
};

export function publicGalleryRoute(
  route: { host: string; rootPath: string },
  current: { protocol: string; host: string },
): GalleryRoute {
  const currentHostname = current.host
    .toLocaleLowerCase()
    .replace(/:\d+$/, "");
  const origin =
    route.host === currentHostname
      ? `${current.protocol}//${current.host}`
      : `${current.protocol}//${route.host}`;
  return { origin, routeRoot: route.rootPath };
}

function normalizedRouteRoot(routeRoot: string): string {
  if (routeRoot === "/") return "";
  return routeRoot.replace(/\/+$/, "");
}

export function galleryFolderPathSegments(
  pathname: string,
  routeRoot: string,
): string[] | null {
  const root = normalizedRouteRoot(routeRoot);
  if (pathname === (root || "/")) return [];
  if (root !== "" && !pathname.startsWith(`${root}/`)) return null;
  const relative = (
    root === "" ? pathname.replace(/^\/+/, "") : pathname.slice(root.length + 1)
  ).replace(/\/+$/, "");
  if (relative === "") return [];
  try {
    const segments = relative.split("/").map(decodeURIComponent);
    return segments.some((segment) => segment === "") ? null : segments;
  } catch {
    return null;
  }
}

export function galleryFolderLocation(input: {
  routeRoot: string;
  folderId: string | null;
  folderNames: string[];
  friendlyFolderUrls: boolean;
  currentSearch?: string;
}): GalleryFolderLocation {
  const root = normalizedRouteRoot(input.routeRoot);
  const params = new URLSearchParams(input.currentSearch ?? "");
  params.delete("folder");

  let pathname = root || "/";
  if (input.folderId !== null) {
    if (input.friendlyFolderUrls) {
      pathname = `${root}/${input.folderNames.map(encodeURIComponent).join("/")}`;
    } else {
      params.set("folder", input.folderId);
    }
  }

  const search = params.toString();
  return { pathname, search: search === "" ? "" : `?${search}` };
}

export function galleryFolderHref(input: {
  routeRoot: string;
  folderId: string | null;
  folderNames: string[];
  friendlyFolderUrls: boolean;
}): string {
  const location = galleryFolderLocation(input);
  return `${location.pathname}${location.search}`;
}
