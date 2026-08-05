import { useEffect, useState } from "react";
import { loadTextPreview } from "../lib/textPreview";
import styles from "../styles/plainTextPreview.module.css";

export default function PlainTextPreview(props: { sourceUrl: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);

    void loadTextPreview(props.sourceUrl)
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "This text file could not be displayed.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [props.sourceUrl]);

  if (error !== null) {
    return (
      <div className={styles.preview} data-text-preview>
        <p className={styles.status} role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (text === null) {
    return (
      <div className={styles.preview} data-text-preview>
        <p className={styles.status} role="status">
          Loading text…
        </p>
      </div>
    );
  }

  return (
    <pre className={styles.preview} data-text-preview>
      {text}
    </pre>
  );
}
