import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { AuthControls } from "./AuthControls";
import styles from "../styles/layout.module.css";

type Props = {
  gallery?: Doc<"galleries">;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageFrame({ gallery, breadcrumb, actions, children }: Props) {
  const theme = gallery?.theme;
  const style = {
    "--gallery-accent": theme?.accent,
    "--gallery-bg": theme?.background,
    "--gallery-fg": theme?.foreground,
    "--gallery-surface": theme?.surface,
    "--gallery-muted": theme?.muted,
    "--gallery-radius": theme?.radius === undefined ? undefined : `${theme.radius}px`,
    "--gallery-gap": theme?.density === "comfortable" ? "1rem" : "0.5rem",
    "--thumbnail-frame-size":
      theme?.thumbnailFrameSize === undefined
        ? undefined
        : `${theme.thumbnailFrameSize}px`,
  } as CSSProperties;
  return (
    <div
      className={styles.page}
      style={style}
      data-gallery={gallery?.slug}
    >
      {theme?.customCss ? <style>{theme.customCss}</style> : null}
      <header className={styles.header}>
        <Link to={gallery ? `/${gallery.kind === "uploader" ? "up" : "g"}/${gallery.slug}` : "/"} className={styles.brand}>
          {gallery?.name ?? "upgallery"}
        </Link>
        <div className={styles.breadcrumb}>{breadcrumb}</div>
        <div className={styles.headerActions}>{actions}<AuthControls /></div>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>upgallery</footer>
    </div>
  );
}
