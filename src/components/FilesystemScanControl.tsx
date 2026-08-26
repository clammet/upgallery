import { useEffect, useState } from "react";
import { FolderSearch, RefreshCw } from "lucide-react";
import { storageApi } from "../lib/files";
import styles from "../styles/layout.module.css";

export type FilesystemSyncInfo = {
  status: "idle" | "queued" | "running";
  lastFinishedAt?: number;
  hasError: boolean;
};

export function FilesystemScanControl(props: {
  galleryId: string;
  folderId: string;
  sync: FilesystemSyncInfo;
  disabled?: boolean;
  onError?: (message: string) => void;
  onQueued?: () => void;
}) {
  const [optimisticQueued, setOptimisticQueued] = useState(false);
  const status = optimisticQueued ? "queued" : props.sync.status;

  useEffect(() => {
    if (!optimisticQueued) return;
    if (props.sync.status !== "idle") {
      setOptimisticQueued(false);
      return;
    }
    const timeout = window.setTimeout(() => setOptimisticQueued(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [optimisticQueued, props.sync.status]);

  if (status === "running") {
    return (
      <span
        className={`${styles.scanControl} ${styles.syncSpinner}`}
        role="status"
        aria-label="Folder scan in progress"
        title="Folder scan in progress"
      >
        <RefreshCw aria-hidden="true" size={18} />
      </span>
    );
  }
  if (status === "queued") {
    return (
      <span
        className={`${styles.scanControl} ${styles.scanQueued}`}
        role="status"
        aria-label="Folder scan queued"
        title="Folder scan queued"
      >
        <RefreshCw aria-hidden="true" size={18} />
      </span>
    );
  }
  return (
    <button
      className={`${styles.iconButton} ${styles.scanControl}`}
      type="button"
      disabled={props.disabled}
      aria-label="Scan folder"
      title={
        props.disabled
          ? "Folder scanning is unavailable during storage migration"
          : props.sync.hasError
            ? "Scan folder again"
            : "Scan folder"
      }
      onClick={() => {
        setOptimisticQueued(true);
        void requestFilesystemScan(props.galleryId, props.folderId)
          .then(() => props.onQueued?.())
          .catch((reason: unknown) => {
            setOptimisticQueued(false);
            props.onError?.(
              reason instanceof Error ? reason.message : "Could not queue scan",
            );
          });
      }}
    >
      <FolderSearch aria-hidden="true" size={18} />
    </button>
  );
}

async function requestFilesystemScan(galleryId: string, folderId: string) {
  const response = await fetch(storageApi("/api/storage/sync-user-directory"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ galleryId, folderId }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return;
  const message =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : "Could not queue scan";
  throw new Error(message);
}
