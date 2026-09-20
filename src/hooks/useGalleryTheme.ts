import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { galleryThemeProperties } from "../lib/theme";

// Use the resolved route on this host, not the canonical link (which may point
// to a different host or path). A direct visit to a subfolder warms its whole gallery.
export function useGalleryTheme(
  gallery: Doc<"galleries"> | undefined,
  routeRoot: string | undefined,
) {
  const { pathname } = useLocation();
  const theme = gallery?.theme;
  useLayoutEffect(() => {
    if (theme && routeRoot !== undefined) {
      window.upgalleryTheme?.save(routeRoot, galleryThemeProperties(theme));
    }
  }, [theme, routeRoot, pathname]);
}
