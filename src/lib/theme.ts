import type { GalleryTheme } from "./gallerySettings";

export type ThemeMode = "light" | "dark";

declare global {
  interface Window {
    // Installed by the inline script in index.html before the first paint.
    upgalleryTheme?: {
      restore(): void;
      save(rootPath: string, values: Record<string, string>): void;
      clear(): void;
    };
  }
}

export const THEME_MODE_DEFAULTS = {
  light: {
    accent: "#126b5a",
    secondary: "#d3a04b",
    background: "#f3f5f1",
    foreground: "#17201d",
    surface: "#ffffff",
    muted: "#65716c",
    headerDivider: "#d0d5d1",
    cellBorder: "#d0d5d1",
    shadow: "0 8px 32px rgb(15 28 23 / 8%)",
  },
  dark: {
    accent: "#69c5ae",
    secondary: "#e0b668",
    background: "#111714",
    foreground: "#e8eee9",
    surface: "#18201c",
    muted: "#9eaaa4",
    headerDivider: "#3c423f",
    cellBorder: "#3c423f",
    shadow: "0 8px 32px rgb(0 0 0 / 25%)",
  },
} as const satisfies Record<
  ThemeMode,
  {
    accent: string;
    secondary: string;
    background: string;
    foreground: string;
    surface: string;
    muted: string;
    headerDivider: string;
    cellBorder: string;
    shadow: string;
  }
>;

export function galleryThemeProperties(theme: GalleryTheme): Record<string, string> {
  const mode = theme.mode ?? "light";
  const modeDefaults = THEME_MODE_DEFAULTS[mode];
  return {
    "--gallery-accent": theme.accent ?? modeDefaults.accent,
    "--gallery-secondary": theme.secondary ?? modeDefaults.secondary,
    "--gallery-bg": theme.background ?? modeDefaults.background,
    "--gallery-fg": theme.foreground ?? modeDefaults.foreground,
    "--gallery-surface": theme.surface ?? modeDefaults.surface,
    "--gallery-muted": theme.muted ?? modeDefaults.muted,
    "--gallery-header-divider": theme.headerDivider ?? modeDefaults.headerDivider,
    "--gallery-cell-border": theme.cellBorder ?? modeDefaults.cellBorder,
    "--shadow": modeDefaults.shadow,
    "--gallery-radius": `${theme.radius ?? 5}px`,
    "--gallery-gap": theme.density === "comfortable" ? "1rem" : "0.5rem",
    "--thumbnail-frame-size": `${theme.thumbnailFrameSize ?? 218}px`,
    "color-scheme": mode,
  };
}
