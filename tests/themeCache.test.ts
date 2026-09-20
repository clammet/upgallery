// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { galleryThemeProperties } from "../src/lib/theme";

// Exercise the actual pre-paint script, including its on-disk cache format.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bootstrap = html.match(/<script id="gallery-theme-bootstrap">([\s\S]*?)<\/script>/)![1];
const key = "upgallery:themes:v2";
const maxAge = 30 * 24 * 60 * 60 * 1000;

function browser(options: {
  path?: string;
  storage?: Map<string, string>;
  unavailable?: boolean;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const styles = new Map<string, string>();
  const location = { pathname: options.path ?? "/g/photos" };
  const window = {} as Window;
  runInNewContext(bootstrap, {
    window,
    location,
    document: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => styles.set(name, value),
          removeProperty: (name: string) => styles.delete(name),
        },
      },
    },
    localStorage: {
      getItem(name: string) {
        if (options.unavailable) throw new Error("Storage unavailable");
        return storage.get(name) ?? null;
      },
      setItem(name: string, value: string) {
        if (options.unavailable) throw new Error("Storage unavailable");
        storage.set(name, value);
      },
    },
  });
  return { storage, styles, location, theme: window.upgalleryTheme! };
}

describe("gallery startup theme cache", () => {
  test("restores colors and layout before React, then replaces them with live settings", () => {
    const first = browser();
    expect(first.styles.size).toBe(0);
    const dark = galleryThemeProperties({
      mode: "dark", background: "#123456", radius: 0, density: "comfortable",
      thumbnailFrameSize: 320, customCss: "body { display: none }",
    });
    first.theme.save("/g/photos", dark);
    const returning = browser({ storage: first.storage });
    expect(Object.fromEntries(returning.styles)).toEqual(dark);
    expect(returning.styles.get("--gallery-radius")).toBe("0px");
    expect(returning.storage.get(key)).not.toContain("display: none");

    const light = galleryThemeProperties({ mode: "light" });
    returning.theme.save("/g/photos", light);
    expect(Object.fromEntries(returning.styles)).toEqual(light);
    expect(Object.fromEntries(browser({ storage: first.storage }).styles)).toEqual(light);
    expect(JSON.parse(first.storage.get(key)!)).toHaveLength(1);
  });

  test("isolates addresses and clears the old theme during navigation", () => {
    const app = browser();
    const dark = galleryThemeProperties({ mode: "dark" });
    app.theme.save("/g/photos", dark);
    app.location.pathname = "/up/files";
    app.theme.restore();
    expect(app.styles.size).toBe(0);
    const light = galleryThemeProperties({ mode: "light" });
    app.theme.save("/up/files", light);
    app.location.pathname = "/g/photos";
    app.theme.restore();
    expect(Object.fromEntries(app.styles)).toEqual(dark);
    expect(browser({ storage: app.storage, path: "/g/photos-other" }).styles.size).toBe(0);
    expect(Object.fromEntries(browser({ storage: app.storage, path: "/g/photos/unvisited" }).styles)).toEqual(dark);
    expect(Object.fromEntries(browser({ storage: app.storage, path: "/up/files" }).styles)).toEqual(light);
  });

  test.each(["/g/photos", "/gallery", "/"])("a direct subfolder visit caches the whole gallery at %s", (rootPath) => {
    const prefix = rootPath === "/" ? "" : rootPath;
    const app = browser({ path: `${prefix}/first/deep/folder` });
    const values = galleryThemeProperties({ mode: "dark", background: "#123456" });
    app.theme.save(rootPath, values);
    for (const path of [rootPath, `${prefix}/never-visited`, `${prefix}/other/deep/folder/`]) {
      expect(Object.fromEntries(browser({ storage: app.storage, path }).styles)).toEqual(values);
    }
    app.location.pathname = `${prefix}/another-folder`;
    app.theme.save(rootPath, galleryThemeProperties({ mode: "light" }));
    expect(JSON.parse(app.storage.get(key)!)).toHaveLength(1);
    expect(browser({ storage: app.storage, path: `${prefix}/first/deep/folder` }).styles.get("color-scheme")).toBe("light");
  });

  test("prefers the most specific gallery root regardless of cache write order", () => {
    const app = browser({ path: "/gallery/nested/folder" });
    app.theme.save("/gallery/nested", galleryThemeProperties({ mode: "dark" }));
    app.location.pathname = "/gallery";
    app.theme.save("/gallery/", galleryThemeProperties({ mode: "light" }));
    expect(browser({ storage: app.storage, path: "/gallery/nested/new" }).styles.get("color-scheme")).toBe("dark");
    expect(browser({ storage: app.storage, path: "/gallery/nested-other" }).styles.get("color-scheme")).toBe("light");
    expect(browser({ storage: app.storage, path: "/gallery-other" }).styles.size).toBe(0);
  });

  test("a host-root theme does not bleed into explicit galleries, administration, or auth", () => {
    const app = browser({ path: "/" });
    app.theme.save("/", galleryThemeProperties({ mode: "dark" }));
    for (const path of ["/g/other", "/g/other/folder", "/up/files", "/admin", "/auth/callback"]) {
      expect(browser({ storage: app.storage, path }).styles.size).toBe(0);
    }
    app.location.pathname = "/admin";
    app.theme.clear();
    expect(browser({ storage: app.storage, path: "/new-folder" }).styles.get("color-scheme")).toBe("dark");
  });

  test("clearing a stale subpath removes only its most specific gallery", () => {
    const app = browser({ path: "/gallery" });
    app.theme.save("/gallery", galleryThemeProperties({ mode: "light" }));
    app.location.pathname = "/gallery/nested";
    app.theme.save("/gallery/nested", galleryThemeProperties({ mode: "dark" }));
    app.location.pathname = "/gallery/nested/deep";
    app.theme.clear();
    expect(app.styles.size).toBe(0);
    const entries = JSON.parse(app.storage.get(key)!);
    expect(entries).toHaveLength(1);
    expect(entries[0].rootPath).toBe("/gallery");
  });

  test("does not interpret old per-path cache entries as gallery roots", () => {
    const storage = new Map([["upgallery:themes:v1", JSON.stringify([
      { path: "/gallery/subfolder", savedAt: Date.now(), values: galleryThemeProperties({ mode: "dark" }) },
    ])]]);
    const app = browser({ storage, path: "/gallery/subfolder" });
    expect(app.styles.size).toBe(0);
    app.theme.save("/gallery", galleryThemeProperties({ mode: "dark" }));
    expect(browser({ storage, path: "/gallery/sibling" }).styles.get("color-scheme")).toBe("dark");
  });

  test.each(["/admin", "/admin/settings", "/auth/callback"])("never restores or saves a gallery theme for %s", (path) => {
    const values = galleryThemeProperties({ mode: "dark" });
    const storage = new Map([[key, JSON.stringify([{ rootPath: path, savedAt: Date.now(), values }])]]);
    const app = browser({ storage, path });
    expect(app.styles.size).toBe(0);
    app.theme.save(path, values);
    expect(app.styles.size).toBe(0);
  });

  test("removes stale routes without deleting other galleries", () => {
    const app = browser();
    app.theme.save("/g/photos", galleryThemeProperties({}));
    app.location.pathname = "/up/files";
    app.theme.save("/up/files", galleryThemeProperties({ mode: "dark" }));
    app.location.pathname = "/g/photos";
    app.theme.clear();
    expect(app.styles.size).toBe(0);
    expect(browser({ storage: app.storage }).styles.size).toBe(0);
    expect(browser({ storage: app.storage, path: "/up/files" }).styles.get("color-scheme")).toBe("dark");
  });

  test.each([
    "not json", "null", "{}", "[null]",
    JSON.stringify([{ rootPath: "/g/photos", savedAt: Date.now(), values: {} }]),
    JSON.stringify([{ rootPath: "/g/photos", savedAt: Date.now() - maxAge, values: galleryThemeProperties({}) }]),
    JSON.stringify([{ rootPath: "/g/photos", savedAt: Date.now() + maxAge, values: galleryThemeProperties({}) }]),
  ])("ignores an invalid or expired cache (%#)", (value) => {
    const app = browser({ storage: new Map([[key, value]]) });
    expect(app.styles.size).toBe(0);
    app.theme.save("/g/photos", galleryThemeProperties({}));
    expect(app.styles.get("color-scheme")).toBe("light");
  });

  test("live themes still apply when browser storage is unavailable", () => {
    const app = browser({ unavailable: true });
    app.theme.save("/g/photos", galleryThemeProperties({ mode: "dark" }));
    expect(app.styles.get("color-scheme")).toBe("dark");
    app.theme.clear();
    expect(app.styles.size).toBe(0);
  });

  test("bounds the cache to the 20 most recently saved gallery roots", () => {
    const app = browser();
    for (let index = 0; index < 25; index++) {
      app.location.pathname = `/g/gallery-${index}`;
      app.theme.save(app.location.pathname, galleryThemeProperties({}));
    }
    const entries = JSON.parse(app.storage.get(key)!);
    expect(entries).toHaveLength(20);
    expect(entries[0].rootPath).toBe("/g/gallery-24");
    expect(entries[19].rootPath).toBe("/g/gallery-5");
  });

  test("only applies known theme properties from storage", () => {
    const values = { ...galleryThemeProperties({}), display: "none", "--unknown": "red" };
    const storage = new Map([[key, JSON.stringify([{ rootPath: "/g/photos", savedAt: Date.now(), values }])]]);
    const app = browser({ storage });
    expect(app.styles.has("display")).toBe(false);
    expect(app.styles.has("--unknown")).toBe(false);
    expect(app.styles.get("color-scheme")).toBe("light");
  });
});
