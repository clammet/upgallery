import { describe, expect, test } from "vitest";
import { entrySortTimestamp } from "./lib/entrySort";

describe("entry date sorting", () => {
  test("prefers captured metadata and accepts image and video date formats", () => {
    expect(
      entrySortTimestamp({
        metadataJson: JSON.stringify({
          DateTimeOriginal: "2026:07:29 10:00:00",
        }),
        filesystemModifiedAt: 200,
        createdAt: 100,
      }),
    ).toBe(Date.UTC(2026, 6, 29, 10));
    expect(
      entrySortTimestamp({
        metadataJson: JSON.stringify({
          DateTimeOriginal: "2026-07-29T16:42:04+1000",
        }),
        filesystemModifiedAt: 200,
        createdAt: 100,
      }),
    ).toBe(Date.parse("2026-07-29T16:42:04+10:00"));
  });

  test("falls back to modified time, then upload time", () => {
    expect(
      entrySortTimestamp({
        metadataJson: '{"DateTimeOriginal":"not a date"}',
        filesystemModifiedAt: 200,
        createdAt: 100,
      }),
    ).toBe(200);
    expect(entrySortTimestamp({ createdAt: 100 })).toBe(100);
  });
});
