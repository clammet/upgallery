import { describe, expect, test } from "vitest";
import {
  matchingGalleryRoot,
  galleryFolderHref,
  galleryFolderLocation,
  galleryFolderPathSegments,
  publicGalleryRoute,
  userBackedFileHref,
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

  test("builds user-backed file links in the gallery's filesystem namespace", () => {
    expect(
      userBackedFileHref({
        routeRoot: "/gallery",
        folderNames: ["pix", "Sesame Street"],
        fileName: "_MG_1461.jpg",
        filesystemModifiedAt: 1408429576000,
      }),
    ).toBe(
      "/gallery/pix/Sesame%20Street/_MG_1461.jpg?v=1408429576000",
    );
    expect(
      userBackedFileHref({
        routeRoot: "/",
        folderNames: [],
        fileName: "At the root.jpg",
      }),
    ).toBe("/At%20the%20root.jpg");
  });
});


describe("host gallery navigation", () => {
  test("keeps nested folders within the same route and distinguishes nested galleries", () => {
    const roots = ["/", "/photos", "/photos/shared"];
    expect(matchingGalleryRoot("/photos/trips/2026", roots)).toBe("/photos");
    expect(matchingGalleryRoot("/photos/shared/party", roots)).toBe("/photos/shared");
    expect(matchingGalleryRoot("/photos/shared/", roots)).toBe("/photos/shared");
    expect(matchingGalleryRoot("/photos/shared-other", roots)).toBe("/photos");
    expect(matchingGalleryRoot("/other/folder", roots)).toBe("/");
  });

  test("requires a complete route segment and handles a removed route", () => {
    expect(matchingGalleryRoot("/photos-old", ["/photos"])).toBeNull();
    expect(matchingGalleryRoot("/photos/folder", ["/videos"])).toBeNull();
    expect(matchingGalleryRoot("/", ["/"])).toBe("/");
    expect(matchingGalleryRoot("/", [])).toBeNull();
  });
});
