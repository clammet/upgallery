import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { resolveDefaultFileTypeIcon } from "../lib/defaultFileTypeIcons";
import styles from "../styles/gallery.module.css";

export function FileGlyph(props: {
  extension: string;
  galleryId: Id<"galleries">;
}) {
  const overrides = useQuery(api.fileTypeIcons.list, {
    galleryId: props.galleryId,
  });
  const extension = props.extension
    .trim()
    .toLocaleLowerCase()
    .replace(/^\./, "");
  const override = overrides?.find((item) => item.extension === extension);
  const resolved = override ?? resolveDefaultFileTypeIcon(extension);
  if (resolved.thumbnailUrl) {
    return (
      <img
        className={styles.fileThumb}
        src={resolved.thumbnailUrl}
        alt={resolved.label}
        loading="lazy"
      />
    );
  }
  return (
    <span className={styles.fileGlyph} title={resolved.label}>
      {resolved.icon}
    </span>
  );
}
