import { describe, expect, test } from "vitest";
import { uploaderItemUrl } from "../src/lib/uploaderRoutes";

describe("uploader item URLs", () => {
  test("builds a lightbox link under the route root", () => {
    expect(uploaderItemUrl("/up/drop", "entry123")).toBe(
      "/up/drop?item=entry123",
    );
  });

  test("handles a root-mounted uploader and trailing slashes", () => {
    expect(uploaderItemUrl("/", "entry123")).toBe("/?item=entry123");
    expect(uploaderItemUrl("/uploads/", "entry123")).toBe(
      "/uploads?item=entry123",
    );
  });

  test("escapes the entry id", () => {
    expect(uploaderItemUrl("/up/drop", "a/b")).toBe("/up/drop?item=a%2Fb");
  });
});
