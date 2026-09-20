import { useLayoutEffect, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { AuthControls } from "./AuthControls";
import { TransferStatus } from "./TransferStatus";
import { galleryThemeProperties } from "../lib/theme";
import styles from "../styles/layout.module.css";

type Props = {
  gallery?: Doc<"galleries">;
  galleryRoot?: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  children: ReactNode;
};

export function PageFrame({
  gallery,
  galleryRoot,
  breadcrumb,
  actions,
  children,
  loading = false,
}: Props) {
  const { pathname } = useLocation();
  const theme = gallery?.theme;
  useLayoutEffect(() => {
    // Resolved routes save live themes with their gallery root in useGalleryTheme.
    if (theme) return;
    if (loading) {
      window.upgalleryTheme?.restore();
    } else {
      window.upgalleryTheme?.clear();
    }
  }, [theme, pathname, loading]);
  const { "color-scheme": colorScheme, ...properties } =
    gallery ? galleryThemeProperties(gallery.theme) : {};
  const style = { ...properties, colorScheme } as CSSProperties;
  return (
    <div
      className={styles.page}
      style={style}
      data-gallery={gallery?.slug}
    >
      {theme?.customCss ? <style>{theme.customCss}</style> : null}
      <header className={styles.header}>
        <Link
          to={
            gallery
              ? galleryRoot ??
                `/${gallery.kind === "uploader" ? "up" : "g"}/${gallery.slug}`
              : "/"
          }
          className={styles.brand}
        >
          {gallery?.name ?? "upgallery"}
        </Link>
        <div className={styles.breadcrumb}>{breadcrumb}</div>
        <div className={styles.headerActions}>{actions}<AuthControls gallery={gallery} /></div>
      </header>
      <main className={styles.main}>
        <TransferStatus />
        {children}
      </main>
      <footer className={styles.footer}>upgallery</footer>
    </div>
  );
}
