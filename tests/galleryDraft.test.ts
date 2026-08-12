import { describe, expect, test } from "vitest";
import {
  firstPrefixAttempt,
  galleryNamePathSegment,
  generatedGalleryFields,
  nextPrefixAttempt,
} from "../src/lib/galleryDraft";

describe("new gallery draft fields", () => {
  test("derives the internal slug, internal storage path, and public URL path", () => {
    const segment = galleryNamePathSegment("  Family Photos  ");
    expect(generatedGalleryFields(segment, "a7")).toEqual({
      slug: "a7-family-photos",
      storageRoot: "a7-family-photos",
      rootPath: "/a7/family-photos",
    });
  });

  test("tries each prefix length three times before adding a hex character", () => {
    let sequence = 0;
    const deterministicHex = (length: number) =>
      (++sequence).toString(16).padStart(length, "0").slice(-length);

    const first = firstPrefixAttempt(deterministicHex);
    const second = nextPrefixAttempt(first, deterministicHex);
    const third = nextPrefixAttempt(second, deterministicHex);
    const fourth = nextPrefixAttempt(third, deterministicHex);
    const fifth = nextPrefixAttempt(fourth, deterministicHex);
    const sixth = nextPrefixAttempt(fifth, deterministicHex);
    const seventh = nextPrefixAttempt(sixth, deterministicHex);

    expect([first, second, third, fourth, fifth, sixth, seventh]).toMatchObject([
      { prefixLength: 2, attempt: 1 },
      { prefixLength: 2, attempt: 2 },
      { prefixLength: 2, attempt: 3 },
      { prefixLength: 3, attempt: 1 },
      { prefixLength: 3, attempt: 2 },
      { prefixLength: 3, attempt: 3 },
      { prefixLength: 4, attempt: 1 },
    ]);
  });
});
