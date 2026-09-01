import { describe, expect, test } from "vitest";
import {
  mediaViewerGeometry,
  mediaViewerMediaChanged,
} from "../src/components/MediaViewer";

describe("media viewer media identity", () => {
  const identity = {
    itemId: "entry-1",
    mediaKind: "image" as const,
    mimeType: "image/jpeg",
    sourceUrl: "/media/image.jpg",
    sourceRevision: 0,
  };

  test("preserves media state when realtime data recreates the same item", () => {
    expect(mediaViewerMediaChanged(identity, { ...identity })).toBe(false);
  });

  test("resets media state for a different source or explicit reload", () => {
    expect(
      mediaViewerMediaChanged(identity, {
        ...identity,
        sourceUrl: "/media/replacement.jpg",
      }),
    ).toBe(true);
    expect(
      mediaViewerMediaChanged(identity, {
        ...identity,
        sourceRevision: 1,
      }),
    ).toBe(true);
  });
});

describe("media viewer information layout", () => {
  test("adds the information column without shrinking a preview when space is available", () => {
    const closed = mediaViewerGeometry(
      { width: 600, height: 400 },
      "image",
      { width: 1200, height: 800 },
      1,
      false,
      0,
    );
    const open = mediaViewerGeometry(
      { width: 600, height: 400 },
      "image",
      { width: 1200, height: 800 },
      1,
      true,
      100,
    );

    expect(open.width).toBe(closed.width);
    expect(open.infoWidth).toBe(320);
    expect(open.viewerWidth).toBe(closed.viewerWidth + 320);
  });

  test("reserves the information width and reduces the preview fit scale when space is tight", () => {
    const geometry = mediaViewerGeometry(
      { width: 1200, height: 800 },
      "image",
      { width: 800, height: 900 },
      1,
      true,
      300,
    );

    expect(geometry.infoWidth).toBe(320);
    expect(geometry.width).toBe(446);
    expect(geometry.viewerWidth).toBe(768);
    expect(geometry.fitScale).toBeCloseTo(446 / 1200);
  });

  test("grows only for taller metadata and caps the panel at the viewport limit", () => {
    const short = mediaViewerGeometry(
      { width: 400, height: 200 },
      "image",
      { width: 1200, height: 900 },
      1,
      true,
      120,
    );
    const tall = mediaViewerGeometry(
      { width: 400, height: 200 },
      "image",
      { width: 1200, height: 900 },
      1,
      true,
      600,
    );
    const overflowing = mediaViewerGeometry(
      { width: 400, height: 200 },
      "image",
      { width: 1200, height: 900 },
      1,
      true,
      1200,
    );

    expect(short.height).toBe(200);
    expect(tall.height).toBe(600);
    expect(overflowing.height).toBe(804);
  });

  test("uses the available viewport width for text previews", () => {
    const geometry = mediaViewerGeometry(
      null,
      "text",
      { width: 1920, height: 1080 },
      1,
      false,
      0,
    );

    expect(geometry.width).toBe(1886);
    expect(geometry.viewerWidth).toBe(1888);
  });
});
