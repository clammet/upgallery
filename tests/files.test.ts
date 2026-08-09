import { describe, expect, test } from "vitest";
import { publicMediaUrl } from "../src/lib/files";

describe("publicMediaUrl", () => {
  test("serves public originals and central gallery derivatives", () => {
    expect(publicMediaUrl("public/shared/family/image.jpg")).toBe(
      "/media/shared/family/image.jpg",
    );
    expect(
      publicMediaUrl(
        "derivatives/gallery/user/alice/photos/thumbnails/aa/bb/hash.thumb.jpg",
      ),
    ).toBe(
      "/media/derivatives/gallery/user/alice/photos/thumbnails/aa/bb/hash.thumb.jpg",
    );
  });

  test("rejects uploader originals and derivatives", () => {
    expect(() =>
      publicMediaUrl("protected/uploaders/support/aa/bb/archive.zip"),
    ).toThrow("Protected storage keys cannot be served directly");
    expect(() =>
      publicMediaUrl(
        "derivatives/up/support/thumbnails/aa/bb/hash.thumb.jpg",
      ),
    ).toThrow("Protected storage keys cannot be served directly");
  });
});
