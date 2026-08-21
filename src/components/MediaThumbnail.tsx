import { LoaderCircle } from "lucide-react";
import type { CSSProperties } from "react";
import { unknownFileTypeIcon } from "../lib/defaultFileTypeIcons";
import styles from "../styles/thumbnail.module.css";

export function MediaThumbnail(props: {
  src?: string;
  state?: "pending" | "failed";
  className: string;
  style?: CSSProperties;
}) {
  if (props.src !== undefined) {
    return (
      <img
        className={props.className}
        style={props.style}
        src={props.src}
        alt=""
        loading="lazy"
      />
    );
  }
  if (props.state === "pending") {
    return (
      <span
        className={`${props.className} ${styles.placeholder}`}
        style={props.style}
        title="Thumbnail processing"
      >
        <LoaderCircle
          className={styles.spinner}
          aria-label="Thumbnail processing"
        />
      </span>
    );
  }
  return (
    <span
      className={`${props.className} ${styles.placeholder} ${styles.unavailable}`}
      style={props.style}
      title="Thumbnail unavailable"
    >
      <img
        className={styles.unavailableIcon}
        src={unknownFileTypeIcon.thumbnailUrl}
        alt=""
        loading="lazy"
      />
    </span>
  );
}
