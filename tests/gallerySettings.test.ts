import { describe, expect, test } from "vitest";
import {
  buildTheme,
  diffGallerySettings,
  initialThemeJson,
  mibValue,
  parseHostRoutes,
  type GalleryTheme,
  type SettingsSnapshot,
} from "../src/lib/gallerySettings";
import { THEME_MODE_DEFAULTS } from "../src/lib/theme";

function snapshot(): SettingsSnapshot {
  return {
    name: "Studio",
    maxFileSizeMib: 100,
    maxFileSizeLimitMib: 200,
    folderPreviewMode: "first",
    folderPreviewSource: "",
    quickMove: false,
    infiniteScroll: true,
    paginationPageSize: 100,
    friendlyFolderUrls: false,
    sortOrder: "nameAsc",
    hosts: "photos.example.com|/",
    themeJson: initialThemeJson({}),
  };
}

function themeOf(current: SettingsSnapshot): GalleryTheme {
  return JSON.parse(current.themeJson) as GalleryTheme;
}

describe("gallery settings dirty-field detection", () => {
  test("an untouched form produces no update", () => {
    const initial = snapshot();
    const current = { ...initial };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual(
      {},
    );
  });

  test("a stored theme without explicit colors matches the mounted controls", () => {
    // The color pickers materialize unset colors as the mode defaults, so
    // the submitted theme of an untouched form must compare equal to the
    // snapshot built from a sparse stored theme.
    const defaults = THEME_MODE_DEFAULTS.light;
    const submitted = buildTheme({
      accent: defaults.accent,
      secondary: defaults.secondary,
      background: defaults.background,
      foreground: defaults.foreground,
      surface: defaults.surface,
      muted: defaults.muted,
      headerDivider: defaults.headerDivider,
      cellBorder: defaults.cellBorder,
      mode: "light",
      radius: 4,
      density: "compact",
      thumbnailFrameSize: 218,
      customCss: "",
    });
    expect(JSON.stringify(submitted)).toBe(initialThemeJson({}));
  });

  test("only the fields edited in this form are sent", () => {
    const initial = snapshot();
    const current = { ...initial, quickMove: true, name: "Renamed" };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      name: "Renamed",
      quickMove: true,
    });
  });

  test("custom folder preview settings are sent together", () => {
    const initial = snapshot();
    const current = {
      ...initial,
      folderPreviewMode: "custom" as const,
      folderPreviewSource: "cover.JPG",
    };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      folderPreviewMode: "custom",
      folderPreviewSource: "cover.JPG",
    });
  });

  test("gallery paging preferences are sent only when changed", () => {
    const initial = snapshot();
    const current = {
      ...initial,
      infiniteScroll: false,
      paginationPageSize: 250,
    };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      infiniteScroll: false,
      paginationPageSize: 250,
    });
  });

  test("friendly folder URLs are sent only when changed", () => {
    const initial = snapshot();
    const current = { ...initial, friendlyFolderUrls: true };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      friendlyFolderUrls: true,
    });
  });

  test("gallery sort order is sent only when changed", () => {
    const initial = snapshot();
    const current = { ...initial, sortOrder: "dateDesc" as const };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      sortOrder: "dateDesc",
    });
  });

  test("size fields convert MiB to bytes only when edited", () => {
    const initial = snapshot();
    const current = { ...initial, maxFileSizeMib: 50 };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      maxFileSize: 50 * 1024 * 1024,
    });
  });

  test("an edited theme is sent as one unit", () => {
    const initial = snapshot();
    const theme = { ...themeOf(initial), accent: "#123456" };
    const current = { ...initial, themeJson: JSON.stringify(theme) };
    expect(diffGallerySettings(initial, current, theme)).toEqual({ theme });
  });

  test("edited host routes parse into host and path pairs", () => {
    const initial = snapshot();
    const current = {
      ...initial,
      hosts: "a.example.com|/sub\nb.example.com",
    };
    expect(diffGallerySettings(initial, current, themeOf(current))).toEqual({
      hosts: [
        { host: "a.example.com", rootPath: "/sub" },
        { host: "b.example.com", rootPath: "/" },
      ],
    });
    expect(parseHostRoutes("")).toEqual([]);
  });

  test("byte sizes round to the same tenth of a MiB the form displays", () => {
    expect(mibValue(100 * 1024 * 1024)).toBe(100);
    expect(mibValue(100_000_000)).toBe(95.4);
  });
});
