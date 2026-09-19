// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { galleryThemeProperties } from "../src/lib/theme";

// Exercise the actual pre-paint script, including its on-disk cache format.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bootstrap = html.match(/<script id="gallery-theme-bootstrap">([\s\S]*?)<\/script>/)![1];
const key = "upgallery:themes:v1";
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
    first.theme.save(dark);
    const returning = browser({ storage: first.storage });
    expect(Object.fromEntries(returning.styles)).toEqual(dark);
    expect(returning.styles.get("--gallery-radius")).toBe("0px");
    expect(returning.storage.get(key)).not.toContain("display: none");

    const light = galleryThemeProperties({ mode: "light" });
    returning.theme.save(light);
    expect(Object.fromEntries(returning.styles)).toEqual(light);
    expect(Object.fromEntries(browser({ storage: first.storage }).styles)).toEqual(light);
    expect(JSON.parse(first.storage.get(key)!)).toHaveLength(1);
  });

  test("isolates addresses and clears the old theme during navigation", () => {
    const app = browser();
    const dark = galleryThemeProperties({ mode: "dark" });
    app.theme.save(dark);
    app.location.pathname = "/up/files";
    app.theme.restore();
    expect(app.styles.size).toBe(0);
    const light = galleryThemeProperties({ mode: "light" });
    app.theme.save(light);
    app.location.pathname = "/g/photos";
    app.theme.restore();
    expect(Object.fromEntries(app.styles)).toEqual(dark);
    expect(browser({ storage: app.storage, path: "/g/photos-other" }).styles.size).toBe(0);
    expect(browser({ storage: app.storage, path: "/g/photos/unvisited" }).styles.size).toBe(0);
    expect(Object.fromEntries(browser({ storage: app.storage, path: "/up/files" }).styles)).toEqual(light);
  });

  test.each(["/admin", "/admin/settings", "/auth/callback"])("never restores or saves a gallery theme for %s", (path) => {
    const values = galleryThemeProperties({ mode: "dark" });
    const storage = new Map([[key, JSON.stringify([{ path, savedAt: Date.now(), values }])]]);
    const app = browser({ storage, path });
    expect(app.styles.size).toBe(0);
    app.theme.save(values);
    expect(app.styles.size).toBe(0);
  });

  test("removes stale routes without deleting other galleries", () => {
    const app = browser();
    app.theme.save(galleryThemeProperties({}));
    app.location.pathname = "/up/files";
    app.theme.save(galleryThemeProperties({ mode: "dark" }));
    app.location.pathname = "/g/photos";
    app.theme.clear();
    expect(app.styles.size).toBe(0);
    expect(browser({ storage: app.storage }).styles.size).toBe(0);
    expect(browser({ storage: app.storage, path: "/up/files" }).styles.get("color-scheme")).toBe("dark");
  });

  test.each([
    "not json", "null", "{}", "[null]",
    JSON.stringify([{ path: "/g/photos", savedAt: Date.now(), values: {} }]),
    JSON.stringify([{ path: "/g/photos", savedAt: Date.now() - maxAge, values: galleryThemeProperties({}) }]),
    JSON.stringify([{ path: "/g/photos", savedAt: Date.now() + maxAge, values: galleryThemeProperties({}) }]),
  ])("ignores an invalid or expired cache (%#)", (value) => {
    const app = browser({ storage: new Map([[key, value]]) });
    expect(app.styles.size).toBe(0);
    app.theme.save(galleryThemeProperties({}));
    expect(app.styles.get("color-scheme")).toBe("light");
  });

  test("live themes still apply when browser storage is unavailable", () => {
    const app = browser({ unavailable: true });
    app.theme.save(galleryThemeProperties({ mode: "dark" }));
    expect(app.styles.get("color-scheme")).toBe("dark");
    app.theme.clear();
    expect(app.styles.size).toBe(0);
  });

  test("bounds the cache to the 20 most recently saved addresses", () => {
    const app = browser();
    for (let index = 0; index < 25; index++) {
      app.location.pathname = `/g/gallery-${index}`;
      app.theme.save(galleryThemeProperties({}));
    }
    const entries = JSON.parse(app.storage.get(key)!);
    expect(entries).toHaveLength(20);
    expect(entries[0].path).toBe("/g/gallery-24");
    expect(entries[19].path).toBe("/g/gallery-5");
  });

  test("only applies known theme properties from storage", () => {
    const values = { ...galleryThemeProperties({}), display: "none", "--unknown": "red" };
    const storage = new Map([[key, JSON.stringify([{ path: "/g/photos", savedAt: Date.now(), values }])]]);
    const app = browser({ storage });
    expect(app.styles.has("display")).toBe(false);
    expect(app.styles.has("--unknown")).toBe(false);
    expect(app.styles.get("color-scheme")).toBe("light");
  });
});
