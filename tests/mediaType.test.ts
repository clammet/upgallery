import { describe, expect, test } from "vitest";
import {
  canToggleTextMarkdown,
  fileNameWithMarkdownMode,
  isHeifImage,
  isSafariBrowser,
  shouldRenderAsPlainText,
  shouldRenderTextAsMarkdown,
  shouldUseNativeHeifPreview,
} from "../src/lib/media";
import {
  codeLanguageForFile,
  shouldRenderAsCode,
} from "../src/lib/codeLanguages";

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

describe("Markdown text preview detection", () => {
  test("renders Markdown files without treating plain text as Markdown", () => {
    expect(shouldRenderTextAsMarkdown("text", "notes.txt")).toBe(false);
    expect(shouldRenderTextAsMarkdown("text", "README.MD")).toBe(true);
    expect(shouldRenderTextAsMarkdown("text", "guide.markdown")).toBe(true);
    expect(shouldRenderTextAsMarkdown("text", "styles.css")).toBe(false);
    expect(shouldRenderTextAsMarkdown("other", "notes.txt")).toBe(false);
    expect(shouldRenderAsPlainText("text", "notes.txt")).toBe(true);
    expect(shouldRenderAsPlainText("text", "NOTES.TXT")).toBe(true);
    expect(shouldRenderAsPlainText("text", "notes.md")).toBe(false);
    expect(shouldRenderAsPlainText("other", "notes.txt")).toBe(false);
  });

  test("toggles eligible text filenames between .txt and .md", () => {
    expect(canToggleTextMarkdown("text", "notes.txt")).toBe(true);
    expect(canToggleTextMarkdown("text", "notes.md")).toBe(true);
    expect(canToggleTextMarkdown("text", "notes.markdown")).toBe(true);
    expect(canToggleTextMarkdown("text", "notes.csv")).toBe(false);
    expect(canToggleTextMarkdown("image", "notes.txt")).toBe(false);
    expect(fileNameWithMarkdownMode("notes.txt", true)).toBe("notes.md");
    expect(fileNameWithMarkdownMode("README.MD", false)).toBe("README.txt");
    expect(fileNameWithMarkdownMode("guide.markdown", false)).toBe(
      "guide.txt",
    );
    expect(fileNameWithMarkdownMode("notes.csv", true)).toBe("notes.csv");
  });
});

describe("code preview detection", () => {
  test("maps source extensions to syntax highlighter languages", () => {
    expect(
      codeLanguageForFile("component.TSX", "application/octet-stream"),
    ).toBe("typescript");
    expect(codeLanguageForFile("script.py", "text/plain")).toBe("python");
    expect(codeLanguageForFile("Makefile", "text/plain")).toBe("makefile");
    expect(codeLanguageForFile("styles.scss", "text/x-scss")).toBe("scss");
  });

  test("uses code MIME types when a filename has no useful extension", () => {
    expect(codeLanguageForFile("payload", "application/ld+json")).toBe("json");
    expect(codeLanguageForFile("feed", "application/atom+xml")).toBe("xml");
    expect(shouldRenderAsCode("program", "text/javascript")).toBe(true);
  });

  test("does not replace the dedicated Markdown and plain-text previews", () => {
    expect(shouldRenderAsCode("README.md", "text/markdown")).toBe(false);
    expect(shouldRenderAsCode("notes.txt", "text/plain")).toBe(false);
    expect(shouldRenderAsCode("README.md", "application/json")).toBe(false);
  });
});
