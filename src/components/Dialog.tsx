import type { ReactNode } from "react";
import { X } from "lucide-react";
import styles from "../styles/layout.module.css";

export function Dialog(props: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={props.onClose}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.dialogHeader}>
          <h2>{props.title}</h2>
          <button type="button" className={styles.iconButton} onClick={props.onClose} aria-label="Close">
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        {props.children}
      </section>
    </div>
  );
}
