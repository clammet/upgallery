import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { Dialog } from "../components/Dialog";
import { FileGlyph } from "../components/FileGlyph";
import { publicMediaUrl, formatBytes, storageApi } from "../lib/files";
import { useUpload } from "../hooks/useUpload";
import { friendlyError } from "../lib/errors";
import { getOrCreateAnonymousClaim } from "../lib/anonymousClaim";
import styles from "../styles/gallery.module.css";
import layout from "../styles/layout.module.css";

export function GalleryPage(props: {
  gallery: Doc<"galleries">;
  rootFolder: Doc<"folders">;
}) {
  const [searchParams] = useSearchParams();
  const requestedFolder = searchParams.get("folder");
  const folderId = (requestedFolder ?? props.rootFolder._id) as Id<"folders">;
  const listing = useQuery(api.folders.list, {
    anonymousClaim: getOrCreateAnonymousClaim(),
    galleryId: props.gallery._id,
    folderId,
  });
  const createFolder = useMutation(api.folders.create);
  const updateFolder = useMutation(api.folders.update);
  const fileInput = useRef<HTMLInputElement>(null);
  const { upload, uploading, error } = useUpload();
  const [folderDialog, setFolderDialog] = useState<"create" | "settings" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (props.gallery.storageKind !== "user") return;
    void fetch(storageApi("/api/storage/sync-user-directory"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        galleryId: props.gallery._id,
        folderId,
      }),
    }).catch(() => undefined);
  }, [props.gallery._id, props.gallery.storageKind, folderId]);

  const uploadFiles = async (files: FileList | File[]) => {
    if (!listing?.access.canUpload) return;
    for (const file of Array.from(files)) {
      try {
        await upload({
          file,
          galleryId: props.gallery._id,
          folderId,
        });
      } catch {
        break;
      }
    }
  };

  useEffect(() => {
    if (!listing?.access.canUpload) return;
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.files.length) {
        void uploadFiles(event.dataTransfer.files);
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (images.length > 0) {
        event.preventDefault();
        void uploadFiles(images);
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [listing?.access.canUpload, folderId]);

  if (listing === undefined) {
    return <PageFrame gallery={props.gallery}><p>Loading…</p></PageFrame>;
  }

  const breadcrumbs = listing.breadcrumbs.map((crumb, index) => (
    <span key={crumb._id}>
      {index > 0 ? <span className={layout.separator}>/</span> : null}
      <Link to={crumb._id === props.rootFolder._id ? "?" : `?folder=${crumb._id}`}>
        {crumb.name}
      </Link>
    </span>
  ));

  return (
    <PageFrame
      gallery={props.gallery}
      breadcrumb={breadcrumbs}
      actions={
        <>
          {listing.filesystemSync ? (
            <FilesystemSyncIndicator sync={listing.filesystemSync} />
          ) : null}
          {listing.access.canUpload ? (
            <>
              <input
              ref={fileInput}
              hidden
              multiple
              type="file"
              onChange={(event) => {
                if (event.target.files) void uploadFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button className={layout.iconButton} type="button" onClick={() => fileInput.current?.click()} aria-label="Upload files" title="Upload files">↑</button>
              <button className={layout.iconButton} type="button" onClick={() => setFolderDialog("create")} aria-label="New folder" title="New folder">＋</button>
            {listing.access.canEditFolder ? (
              <button className={layout.iconButton} type="button" onClick={() => setFolderDialog("settings")} aria-label="Folder settings" title="Folder settings">⚙</button>
              ) : null}
            </>
          ) : null}
        </>
      }
    >
      {(uploading || error || notice) && (
        <div className={error ? layout.errorNotice : layout.notice}>
          {error ?? notice ?? "Uploading…"}
        </div>
      )}
      <div className={styles.grid}>
        {listing.folders.map((folder) => (
          <Link
            className={styles.folderCard}
            key={folder._id}
            to={`?folder=${folder._id}`}
          >
            <span className={styles.folderIcon}>▰</span>
            <span>{folder.name}</span>
            {folder.privacy !== "public" ? (
              <small>{folder.privacy}</small>
            ) : null}
          </Link>
        ))}
        {listing.entries.map((entry) => (
          <a
            className={styles.fileCard}
            href={publicMediaUrl(
              entry.storageKey,
              entry.filesystemModifiedAt,
            )}
            key={entry._id}
            target="_blank"
            rel="noreferrer"
          >
            {entry.thumbnailKey ? (
              <img
                className={styles.fileThumb}
                src={publicMediaUrl(entry.thumbnailKey)}
                alt=""
                loading="lazy"
              />
            ) : entry.mediaKind === "image" ? (
              <img
                className={styles.fileThumb}
                src={publicMediaUrl(
                  entry.storageKey,
                  entry.filesystemModifiedAt,
                )}
                alt=""
                loading="lazy"
              />
            ) : (
              <FileGlyph extension={entry.extension} />
            )}
            <span className={styles.fileName}>{entry.name}</span>
            <small>{formatBytes(entry.size)}</small>
          </a>
        ))}
      </div>
      {listing.folders.length === 0 && listing.entries.length === 0 ? (
        <p className={styles.empty}>This folder is empty.</p>
      ) : null}

      {folderDialog === "create" ? (
        <FolderForm
          title="New folder"
          initialName=""
          initialPrivacy="public"
          onClose={() => setFolderDialog(null)}
          onSubmit={async (name, privacy) => {
            const result = await createFolder({
              galleryId: props.gallery._id,
              parentId: folderId,
              name,
              privacy,
            });
            await completeFilesystemFolderOperation(result);
            setFolderDialog(null);
            setNotice("Folder created");
          }}
        />
      ) : null}
      {folderDialog === "settings" ? (
        <FolderForm
          title="Folder settings"
          initialName={listing.folder.name}
          initialPrivacy={listing.folder.privacy}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (name, privacy) => {
            const result = await updateFolder({ folderId, name, privacy });
            await completeFilesystemFolderOperation(result);
            setFolderDialog(null);
            setNotice("Folder updated");
          }}
        />
      ) : null}
    </PageFrame>
  );
}

function FilesystemSyncIndicator(props: {
  sync: {
    isRunning: boolean;
    lastFinishedAt?: number;
    hasError: boolean;
  };
}) {
  const initialized = useRef(false);
  const previousFinishedAt = useRef<number | undefined>(undefined);
  const previousRunning = useRef(false);
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      previousFinishedAt.current = props.sync.lastFinishedAt;
      previousRunning.current = props.sync.isRunning;
      return;
    }
    if (props.sync.isRunning || props.sync.hasError) {
      setShowComplete(false);
    }
    const completed =
      !props.sync.isRunning &&
      !props.sync.hasError &&
      (previousRunning.current ||
        props.sync.lastFinishedAt !== previousFinishedAt.current);
    previousRunning.current = props.sync.isRunning;
    previousFinishedAt.current = props.sync.lastFinishedAt;
    if (!completed) return;
    setShowComplete(true);
    const timer = window.setTimeout(() => setShowComplete(false), 1600);
    return () => window.clearTimeout(timer);
  }, [
    props.sync.hasError,
    props.sync.isRunning,
    props.sync.lastFinishedAt,
  ]);

  if (props.sync.isRunning) {
    return (
      <span
        className={`${layout.syncIndicator} ${layout.syncSpinner}`}
        role="status"
        aria-label="background update in progress"
        title="background update in progress"
      >
        ↻
      </span>
    );
  }
  if (showComplete) {
    return (
      <span
        className={`${layout.syncIndicator} ${layout.syncComplete}`}
        role="status"
        aria-label="background update complete"
        title="background update complete"
      >
        ✓
      </span>
    );
  }
  return null;
}

async function completeFilesystemFolderOperation(result: {
  kind: "complete" | "filesystem";
  operationId?: Id<"filesystemOperations">;
  token?: string;
}) {
  if (result.kind === "complete") return;
  if (result.operationId === undefined || result.token === undefined) {
    throw new Error("Filesystem operation capability is missing");
  }
  const response = await fetch(
    storageApi("/api/storage/user-folder-operation"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: result.operationId,
        token: result.token,
      }),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Filesystem folder operation failed";
    throw new Error(message);
  }
}

function FolderForm(props: {
  title: string;
  initialName: string;
  initialPrivacy: "public" | "unlisted" | "private";
  onClose: () => void;
  onSubmit: (
    name: string,
    privacy: "public" | "unlisted" | "private",
  ) => Promise<void>;
}) {
  const [name, setName] = useState(props.initialName);
  const [privacy, setPrivacy] = useState(props.initialPrivacy);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          void props.onSubmit(name, privacy).catch((reason: unknown) => {
            setError(friendlyError(reason, "Could not save"));
          });
        }}
      >
        <label>Folder name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Privacy
          <select value={privacy} onChange={(event) => setPrivacy(event.target.value as typeof privacy)}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </label>
        {error ? <p className={layout.formError}>{error}</p> : null}
        <button type="submit">Save</button>
      </form>
    </Dialog>
  );
}
