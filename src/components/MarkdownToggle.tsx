import styles from "../styles/markdownToggle.module.css";

export function MarkdownToggle(props: {
  checked: boolean;
  disabled?: boolean;
  error?: string | null;
  label?: string;
  onChange: (checked: boolean) => void;
}) {
  const label = props.label ?? "Markdown";
  const title = props.error ?? `${props.checked ? "Disable" : "Enable"} Markdown rendering`;

  return (
    <button
      className={`${styles.toggle} ${props.checked ? styles.checked : ""} ${props.error ? styles.hasError : ""}`}
      type="button"
      aria-label={title}
      aria-pressed={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      title={title}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      <span>{label}</span>
      {props.error ? (
        <span className={styles.screenReaderAlert} role="alert">
          {props.error}
        </span>
      ) : null}
    </button>
  );
}
