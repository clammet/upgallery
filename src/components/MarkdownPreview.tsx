import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { loadTextPreview } from "../lib/textPreview";
import styles from "../styles/markdownPreview.module.css";

const markdownComponents = {
  a({ node: _node, ...props }) {
    return (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
      />
    );
  },
  img({ alt }) {
    return (
      <span className={styles.omittedImage}>
        {alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}
      </span>
    );
  },
} satisfies Components;

const allowedElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

export function MarkdownContent(props: { markdown: string }) {
  return (
    <ReactMarkdown
      allowedElements={allowedElements}
      components={markdownComponents}
      skipHtml
    >
      {props.markdown}
    </ReactMarkdown>
  );
}

export function MarkdownPreview(props: {
  sourceUrl: string;
  className?: string;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    setError(null);

    void loadTextPreview(
      props.sourceUrl,
      "text/markdown, text/plain;q=0.9",
    )
      .then((content) => {
        if (!cancelled) setMarkdown(content);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "This text file could not be rendered as Markdown.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [props.sourceUrl]);

  const className = [styles.preview, props.className]
    .filter(Boolean)
    .join(" ");

  if (error !== null) {
    return (
      <div className={className} data-markdown-preview>
        <p className={styles.status} role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (markdown === null) {
    return (
      <div className={className} data-markdown-preview>
        <p className={styles.status} role="status">
          Rendering Markdown…
        </p>
      </div>
    );
  }

  return (
    <article className={className} data-markdown-preview>
      <MarkdownContent markdown={markdown} />
    </article>
  );
}

export default MarkdownPreview;
