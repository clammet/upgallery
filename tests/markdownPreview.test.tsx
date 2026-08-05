import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  MarkdownContent,
} from "../src/components/MarkdownPreview";
import { readTextPreviewResponse } from "../src/lib/textPreview";

describe("safe Markdown previews", () => {
  test("renders CommonMark formatting as React elements", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent markdown={"# Heading\n\nSome **bold** text."} />,
    );

    expect(markup).toContain("<h1>Heading</h1>");
    expect(markup).toContain("<strong>bold</strong>");
  });

  test("ignores raw HTML, blocks script URLs, and does not load Markdown images", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        markdown={[
          '<script>alert("xss")</script>',
          "[unsafe](javascript:alert(1))",
          "![tracker](https://attacker.example/pixel.png)",
        ].join("\n\n")}
      />,
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("attacker.example");
    expect(markup).toContain("[Image omitted: tracker]");
  });

  test("rejects a response whose declared size exceeds the preview limit", async () => {
    const response = new Response("small", {
      headers: { "content-length": "100" },
    });

    await expect(readTextPreviewResponse(response, 10)).rejects.toThrow(
      "too large",
    );
  });
});
