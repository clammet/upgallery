import { describe, expect, test } from "vitest";
import {
  galleryFolderHref,
  galleryFolderLocation,
  galleryFolderPathSegments,
  publicGalleryRoute,
} from "../src/lib/galleryRoutes";

describe("gallery folder routes", () => {
  test("builds ID and friendly variants from the same gallery root", () => {
    const common = {
      routeRoot: "/gallery",
      folderId: "folder-id",
      folderNames: ["pix", "Firewurx", "2014-01-01", "huge"],
    };
    expect(
      galleryFolderHref({ ...common, friendlyFolderUrls: false }),
    ).toBe("/gallery?folder=folder-id");
    expect(
      galleryFolderHref({ ...common, friendlyFolderUrls: true }),
    ).toBe("/gallery/pix/Firewurx/2014-01-01/huge");
  });

  test("encodes and parses folder names without changing their case", () => {
    const href = galleryFolderHref({
      routeRoot: "/g/clam-gallery",
      folderId: "folder-id",
      folderNames: ["Event Photos", "München & Zürich"],
      friendlyFolderUrls: true,
    });
    expect(href).toBe(
      "/g/clam-gallery/Event%20Photos/M%C3%BCnchen%20%26%20Z%C3%BCrich",
    );
    expect(galleryFolderPathSegments(href, "/g/clam-gallery")).toEqual([
      "Event Photos",
      "München & Zürich",
    ]);
  });

  test("canonicalizes either input form while preserving other query state", () => {
    expect(
      galleryFolderLocation({
        routeRoot: "/gallery",
        folderId: "folder-id",
        folderNames: ["pix"],
        friendlyFolderUrls: true,
        currentSearch: "?folder=folder-id&item=image-id",
      }),
    ).toEqual({ pathname: "/gallery/pix", search: "?item=image-id" });
    expect(
      galleryFolderLocation({
        routeRoot: "/gallery",
        folderId: "folder-id",
        folderNames: ["pix"],
        friendlyFolderUrls: false,
        currentSearch: "?item=image-id",
      }),
    ).toEqual({
      pathname: "/gallery",
      search: "?item=image-id&folder=folder-id",
    });
  });

  test("builds the configured public route and preserves a local dev port", () => {
    expect(
      publicGalleryRoute(
        { host: "gallery.example.com", rootPath: "/gallery" },
        { protocol: "https:", host: "gallery.example.com:4173" },
      ),
    ).toEqual({
      origin: "https://gallery.example.com:4173",
      routeRoot: "/gallery",
    });
    expect(
      publicGalleryRoute(
        { host: "photos.example.com", rootPath: "/family" },
        { protocol: "https:", host: "app.example.com" },
      ),
    ).toEqual({
      origin: "https://photos.example.com",
      routeRoot: "/family",
    });
  });
});
