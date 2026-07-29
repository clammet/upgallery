import { describe, expect, test } from "vitest";
import {
  contentDispositionForDownload,
  contentTypeForDownload,
} from "../storage/httpHeaders";

describe("storage download headers", () => {
  test("serves text without a declared charset as UTF-8", () => {
    expect(contentTypeForDownload("text/plain")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(contentTypeForDownload("text/markdown; format=flowed")).toBe(
      "text/markdown; format=flowed; charset=utf-8",
    );
  });

  test("preserves explicit charsets and non-text media types", () => {
    expect(
      contentTypeForDownload("text/plain; charset=windows-1252"),
    ).toBe("text/plain; charset=windows-1252");
    expect(contentTypeForDownload("application/octet-stream")).toBe(
      "application/octet-stream",
    );
    expect(contentTypeForDownload("image/svg+xml")).toBe("image/svg+xml");
  });

  test("encodes Unicode and RFC 5987 delimiter characters in file names", () => {
    expect(
      contentDispositionForDownload("inline", "Lee’s (final).txt"),
    ).toBe(
      "inline; filename*=UTF-8''Lee%E2%80%99s%20%28final%29.txt",
    );
    expect(
      contentDispositionForDownload("attachment", "I'm here.txt"),
    ).toBe("attachment; filename*=UTF-8''I%27m%20here.txt");
  });
});
