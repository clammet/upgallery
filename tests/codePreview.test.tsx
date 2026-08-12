import { describe, expect, test } from "vitest";
import { highlightCode } from "../src/components/CodePreview";

describe("syntax-highlighted code previews", () => {
  test("adds syntax tokens while escaping code that looks like HTML", () => {
    const highlighted = highlightCode(
      'const template = "<script>alert(1)</script>";',
      "javascript",
    );

    expect(highlighted).toContain("hljs-keyword");
    expect(highlighted).toContain("&lt;script&gt;");
    expect(highlighted).not.toContain("<script>");
  });
});
