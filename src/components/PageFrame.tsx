import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { AuthControls } from "./AuthControls";
import { TransferStatus } from "./TransferStatus";
import { THEME_MODE_DEFAULTS } from "../lib/theme";
import styles from "../styles/layout.module.css";

type Props = {
  gallery?: Doc<"galleries">;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageFrame({ gallery, breadcrumb, actions, children }: Props) {
  const theme = gallery?.theme;
  const mode = theme?.mode ?? "light";
  const modeDefaults = THEME_MODE_DEFAULTS[mode];
  const style = {
    "--gallery-accent": gallery ? theme?.accent ?? modeDefaults.accent : undefined,
    "--gallery-secondary": gallery
      ? theme?.secondary ?? modeDefaults.secondary
      : undefined,
    "--gallery-bg": gallery ? theme?.background ?? modeDefaults.background : undefined,
    "--gallery-fg": gallery ? theme?.foreground ?? modeDefaults.foreground : undefined,
    "--gallery-surface": gallery ? theme?.surface ?? modeDefaults.surface : undefined,
    "--gallery-muted": gallery ? theme?.muted ?? modeDefaults.muted : undefined,
    "--gallery-header-divider": gallery
      ? theme?.headerDivider ?? modeDefaults.headerDivider
      : undefined,
    "--gallery-cell-border": gallery
      ? theme?.cellBorder ?? modeDefaults.cellBorder
      : undefined,
    "--shadow": gallery ? modeDefaults.shadow : undefined,
    "--gallery-radius": theme?.radius === undefined ? undefined : `${theme.radius}px`,
    "--gallery-gap": theme?.density === "comfortable" ? "1rem" : "0.5rem",
    "--thumbnail-frame-size":
      theme?.thumbnailFrameSize === undefined
        ? undefined
        : `${theme.thumbnailFrameSize}px`,
    colorScheme: gallery ? mode : undefined,
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
