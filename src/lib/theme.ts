export type ThemeMode = "light" | "dark";

export const THEME_MODE_DEFAULTS = {
  light: {
    accent: "#126b5a",
    secondary: "#d3a04b",
    background: "#f3f5f1",
    foreground: "#17201d",
    surface: "#ffffff",
    muted: "#65716c",
    shadow: "0 8px 32px rgb(15 28 23 / 8%)",
  },
  dark: {
    accent: "#69c5ae",
    secondary: "#e0b668",
    background: "#111714",
    foreground: "#e8eee9",
    surface: "#18201c",
    muted: "#9eaaa4",
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
    shadow: string;
  }
>;
