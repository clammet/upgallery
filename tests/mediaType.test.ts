import { describe, expect, test } from "vitest";
import {
  isHeifImage,
  isSafariBrowser,
  shouldUseNativeHeifPreview,
} from "../src/lib/media";

describe("HEIF image detection", () => {
  test("recognizes HEIC and HEIF MIME types", () => {
    expect(isHeifImage("image/heic", "photo.bin")).toBe(true);
    expect(isHeifImage("image/heif; profile=still", "photo.bin")).toBe(true);
    expect(isHeifImage("image/heic-sequence", "photo.bin")).toBe(true);
  });

  test("falls back to the file extension when MIME metadata is generic", () => {
    expect(isHeifImage("application/octet-stream", "PHOTO.HEIC")).toBe(true);
    expect(isHeifImage("application/octet-stream", "photo.heifs")).toBe(true);
    expect(isHeifImage("application/octet-stream", "camera.hif")).toBe(true);
    expect(isHeifImage("image/jpeg", "photo.jpg")).toBe(false);
  });

  test("uses the original HEIF only in Safari", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15";
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36";
    const iosChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/138.0 Mobile/15E148 Safari/604.1";

    expect(isSafariBrowser(safari)).toBe(true);
    expect(isSafariBrowser(chrome)).toBe(false);
    expect(isSafariBrowser(iosChrome)).toBe(false);
    expect(shouldUseNativeHeifPreview("image/heic", "photo.heic", safari)).toBe(
      true,
    );
    expect(shouldUseNativeHeifPreview("image/heic", "photo.heic", chrome)).toBe(
      false,
    );
  });
});
