import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { codeLanguageForFile } from "../lib/codeLanguages";
import { loadTextPreview } from "../lib/textPreview";
import type { ThemeMode } from "../lib/theme";
import styles from "../styles/codePreview.module.css";

const MAX_HIGHLIGHTED_CHARACTERS = 300_000;

export function highlightCode(code: string, language: string): string {
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

export default function CodePreview(props: {
  fileName: string;
  mimeType: string;
  sourceUrl: string;
  themeMode: ThemeMode;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const language = codeLanguageForFile(props.fileName, props.mimeType);

  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setError(null);

    void loadTextPreview(props.sourceUrl)
      .then((content) => {
        if (!cancelled) setCode(content);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "This code file could not be displayed.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [props.sourceUrl]);

  const highlighted = useMemo(() => {
    if (
      code === null ||
      language === null ||
      code.length > MAX_HIGHLIGHTED_CHARACTERS
    ) {
      return null;
    }
    return highlightCode(code, language);
  }, [code, language]);

  const themeClass =
    props.themeMode === "dark" ? styles.themeDark : styles.themeLight;

  if (error !== null) {
    return (
      <div className={`${styles.shell} ${themeClass}`} data-code-preview>
        <p className={styles.status} role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (code === null) {
    return (
      <div className={`${styles.shell} ${themeClass}`} data-code-preview>
        <p className={styles.status} role="status">
          Loading code…
        </p>
      </div>
    );
  }

  return (
    <div
      className={`${styles.shell} ${themeClass} ${
        highlighted === null ? styles.shellWithNotice : ""
      }`}
      data-code-preview
    >
      {highlighted === null ? (
        <p className={styles.notice} role="status">
          Syntax colouring is disabled for this large file.
        </p>
      ) : null}
      <pre className={styles.preview}>
        {highlighted === null ? (
          <code className={styles.code}>{code}</code>
        ) : (
          <code
            className={styles.code}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </pre>
    </div>
  );
}
