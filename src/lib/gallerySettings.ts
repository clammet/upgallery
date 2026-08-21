// Dirty-field detection for the gallery settings form. The form captures a
// snapshot of the values it was mounted with; saving diffs the submitted
// values against that snapshot and sends only the changed fields, so a
// long-open tab cannot overwrite settings that were changed elsewhere.
import { THEME_MODE_DEFAULTS, type ThemeMode } from "./theme";

export type UploaderAccess = "anonymous" | "sso" | "restricted";
export type FolderPreviewMode = "first" | "random" | "first3" | "random3";

export type GalleryTheme = {
  accent?: string;
  secondary?: string;
  background?: string;
  foreground?: string;
  surface?: string;
  muted?: string;
  mode?: ThemeMode;
  radius?: number;
  density?: "compact" | "comfortable";
  thumbnailFrameSize?: number;
  customCss?: string;
};

export type ThemeFormValues = {
  accent: string;
  secondary: string;
  background: string;
  foreground: string;
  surface: string;
  muted: string;
  mode: ThemeMode;
  radius: number;
  density: "compact" | "comfortable";
  thumbnailFrameSize: number;
  customCss: string;
};

export type SettingsSnapshot = {
  name: string;
  maxFileSizeMib: number;
  maxFileSizeLimitMib: number;
  uploaderAccess: UploaderAccess;
  folderPreviewMode: FolderPreviewMode;
  quickMove: boolean;
  infiniteScroll: boolean;
  paginationPageSize: number;
  hosts: string;
  themeJson: string;
};

export type GallerySettingsUpdate = {
  name?: string;
  maxFileSize?: number;
  maxFileSizeLimit?: number;
  uploaderAccess?: UploaderAccess;
  folderPreviewMode?: FolderPreviewMode;
  quickMove?: boolean;
  infiniteScroll?: boolean;
  paginationPageSize?: number;
  hosts?: Array<{ host: string; rootPath: string }>;
  theme?: GalleryTheme;
};

export function mibValue(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

// The theme is saved as one unit; normalize it identically for the mount
// snapshot and for submitted form data so an untouched form compares equal.
export function buildTheme(values: ThemeFormValues): GalleryTheme {
  return {
    accent: values.accent.toLowerCase() || undefined,
    secondary: values.secondary.toLowerCase() || undefined,
    background: values.background.toLowerCase() || undefined,
    foreground: values.foreground.toLowerCase() || undefined,
    surface: values.surface.toLowerCase() || undefined,
    muted: values.muted.toLowerCase() || undefined,
    mode: values.mode,
    radius: values.radius,
    density: values.density,
    thumbnailFrameSize: values.thumbnailFrameSize,
    customCss: values.customCss || undefined,
  };
}

// The theme exactly as the freshly mounted form controls would submit it:
// unset colors materialize as the mode defaults inside the color pickers.
export function initialThemeJson(theme: GalleryTheme): string {
  const mode = theme.mode ?? "light";
  const defaults = THEME_MODE_DEFAULTS[mode];
  return JSON.stringify(
    buildTheme({
      accent: theme.accent ?? defaults.accent,
      secondary: theme.secondary ?? defaults.secondary,
      background: theme.background ?? defaults.background,
      foreground: theme.foreground ?? defaults.foreground,
      surface: theme.surface ?? defaults.surface,
      muted: theme.muted ?? defaults.muted,
      mode,
      radius: theme.radius ?? 4,
      density: theme.density ?? "compact",
      thumbnailFrameSize: theme.thumbnailFrameSize ?? 218,
      customCss: theme.customCss ?? "",
    }),
  );
}

export function parseHostRoutes(
  text: string,
): Array<{ host: string; rootPath: string }> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [host, rootPath = "/"] = line.split("|");
      return { host: host.trim(), rootPath: rootPath.trim() };
    });
}

export function diffGallerySettings(
  initial: SettingsSnapshot,
  current: SettingsSnapshot,
  theme: GalleryTheme,
): GallerySettingsUpdate {
  return {
    ...(current.name === initial.name ? {} : { name: current.name }),
    ...(current.maxFileSizeMib === initial.maxFileSizeMib
      ? {}
      : { maxFileSize: Math.round(current.maxFileSizeMib * 1024 * 1024) }),
    ...(current.maxFileSizeLimitMib === initial.maxFileSizeLimitMib
      ? {}
      : {
          maxFileSizeLimit: Math.round(
            current.maxFileSizeLimitMib * 1024 * 1024,
          ),
        }),
    ...(current.uploaderAccess === initial.uploaderAccess
      ? {}
      : { uploaderAccess: current.uploaderAccess }),
    ...(current.folderPreviewMode === initial.folderPreviewMode
      ? {}
      : { folderPreviewMode: current.folderPreviewMode }),
    ...(current.quickMove === initial.quickMove
      ? {}
      : { quickMove: current.quickMove }),
    ...(current.infiniteScroll === initial.infiniteScroll
      ? {}
      : { infiniteScroll: current.infiniteScroll }),
    ...(current.paginationPageSize === initial.paginationPageSize
      ? {}
      : { paginationPageSize: current.paginationPageSize }),
    ...(current.hosts === initial.hosts
      ? {}
      : { hosts: parseHostRoutes(current.hosts) }),
    ...(current.themeJson === initial.themeJson ? {} : { theme }),
  };
}
