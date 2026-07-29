import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { defaultFileIcons } from "../lib/files";
import styles from "../styles/gallery.module.css";

export function FileGlyph(props: { extension: string }) {
  const custom = useQuery(api.fileTypeIcons.list);
  const mapped = custom?.find((item) => item.extension === props.extension);
  const fallback = defaultFileIcons[props.extension] ?? {
    icon: props.extension.slice(0, 4).toLocaleUpperCase() || "FILE",
    label: "File",
  };
  if (mapped?.thumbnailUrl) {
    return <img className={styles.fileThumb} src={mapped.thumbnailUrl} alt={mapped.label} />;
  }
  return (
    <span className={styles.fileGlyph} title={mapped?.label ?? fallback.label}>
      {mapped?.icon ?? fallback.icon}
    </span>
  );
}
