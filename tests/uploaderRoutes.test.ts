import { describe, expect, test } from "vitest";
import {
  uploaderFileEntryId,
  uploaderFileUrl,
} from "../src/lib/uploaderRoutes";

describe("uploader file routes", () => {
  test("builds durable file URLs for fallback and mounted uploader routes", () => {
    expect(
      uploaderFileUrl("/up/drop-box", "entry123", "photo one.jpg"),
    ).toBe("/up/drop-box/files/entry123/photo%20one.jpg");
    expect(uploaderFileUrl("/", "entry123", "archive.zip")).toBe(
      "/files/entry123/archive.zip",
    );
  });

  test("extracts only file IDs beneath the configured route root", () => {
    expect(
      uploaderFileEntryId(
        "/uploads/files/entry123/photo%20one.jpg",
        "/uploads",
      ),
    ).toBe("entry123");
    expect(
      uploaderFileEntryId("/other/files/entry123/photo.jpg", "/uploads"),
    ).toBeNull();
    expect(uploaderFileEntryId("/uploads/files/", "/uploads")).toBeNull();
  });
});
