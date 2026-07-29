import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { Dialog } from "../components/Dialog";
import { FileGlyph } from "../components/FileGlyph";
import {
  MediaViewer,
  shouldOpenMediaViewer,
  type MediaViewerItem,
} from "../components/MediaViewer";
import { TrashIcon } from "../components/ActionIcons";
import { formatBytes, storageApi } from "../lib/files";
import { useUpload } from "../hooks/useUpload";
import { getOrCreateAnonymousClaim } from "../lib/anonymousClaim";
import {
  metadataLocation,
  metadataRows,
  openStreetMapUrls,
  parseMetadataJson,
} from "../lib/metadata";
import { uploaderFileUrl } from "../lib/uploaderRoutes";
import { friendlyError } from "../lib/errors";
import {
  isHeifImage,
  shouldUseNativeHeifPreview,
} from "../lib/media";
import styles from "../styles/uploader.module.css";
import layout from "../styles/layout.module.css";

export function UploaderPage(props: {
  gallery: Doc<"galleries">;
  rootFolder: Doc<"folders">;
  routeRoot: string;
}) {
  const listing = useQuery(api.folders.list, {
    anonymousClaim: getOrCreateAnonymousClaim(),
    galleryId: props.gallery._id,
    folderId: props.rootFolder._id,
  });
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [metadataJson, setMetadataJson] = useState<string | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [viewerEntryId, setViewerEntryId] = useState<string | null>(null);
  const thumbnailRequest = useRef("");
  const createThumbnailTickets = useMutation(
    api.entries.createThumbnailTickets,
  );
  const createDownloadTicket = useMutation(api.entries.createDownloadTicket);
  const requestPreview = useMutation(api.entries.requestPreview);
  const { upload, uploading, error } = useUpload();
  const previewUrl = useMemo(
    () => (file?.type.startsWith("image/") ? URL.createObjectURL(file) : null),
    [file],
  );

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const dropped = event.dataTransfer?.files[0];
      if (dropped) {
        setFile(dropped);
        setTextPreview(null);
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLInputElement
      ) {
        return;
      }
      const pastedFile = event.clipboardData?.files[0];
      if (pastedFile) {
        event.preventDefault();
        setFile(pastedFile);
        setTextPreview(null);
        return;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        event.preventDefault();
        const name = `clipboard-${new Date().toISOString().replaceAll(":", "-")}.txt`;
        setFile(new File([text], name, { type: "text/plain" }));
        setTextPreview(text.slice(0, 500));
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
  }, []);

  const thumbnailEntryIds =
    listing?.entries
      .filter(
        (entry) =>
          entry.thumbnailKey !== undefined && !entry.passwordProtected,
      )
      .map((entry) => entry._id) ?? [];
  const thumbnailRequestKey = `${props.gallery._id}:${props.rootFolder._id}:${thumbnailEntryIds.join(",")}`;
  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      (listing?.entries ?? []).map((entry) => ({
        id: entry._id,
        title: entry.name,
        href: uploaderFileUrl(props.routeRoot, entry._id, entry.name),
        mediaKind: entry.mediaKind,
        mimeType: entry.mimeType,
        passwordProtected: entry.passwordProtected,
        previewReady:
          !isHeifImage(entry.mimeType, entry.name) ||
          shouldUseNativeHeifPreview(entry.mimeType, entry.name) ||
          entry.previewKey !== undefined,
        previewError: entry.previewError,
      })),
    [listing?.entries, props.routeRoot],
  );
  const viewerIndex =
    viewerEntryId === null
      ? -1
      : viewerItems.findIndex((item) => item.id === viewerEntryId);
  const resolveViewerSource = useCallback(
    async (item: MediaViewerItem, suppliedPassword?: string) => {
      if (
        isHeifImage(item.mimeType, item.title) &&
        !shouldUseNativeHeifPreview(item.mimeType, item.title)
      ) {
        const result = await requestPreview({
          anonymousClaim: getOrCreateAnonymousClaim(),
          galleryId: props.gallery._id,
          entryId: item.id as Id<"entries">,
          password: suppliedPassword || undefined,
        });
        if (result.status === "pending") return null;
        if (!("token" in result) || result.token === undefined) {
          throw new Error("Preview ticket was not created");
        }
        return storageApi(
          `/api/storage/files/${item.id}?ticket=${encodeURIComponent(result.token)}`,
        );
      }
      const { token } = await createDownloadTicket({
        anonymousClaim: getOrCreateAnonymousClaim(),
        galleryId: props.gallery._id,
        entryId: item.id as Id<"entries">,
        password: suppliedPassword || undefined,
        disposition: "inline",
      });
      return storageApi(
        `/api/storage/files/${item.id}?ticket=${encodeURIComponent(token)}`,
      );
    },
    [createDownloadTicket, props.gallery._id, requestPreview],
  );

  useEffect(() => {
    if (listing === undefined || thumbnailRequest.current === thumbnailRequestKey) {
      return;
    }
    thumbnailRequest.current = thumbnailRequestKey;
    if (thumbnailEntryIds.length === 0) {
      setThumbnailUrls({});
      return;
    }
    void createThumbnailTickets({
      anonymousClaim: getOrCreateAnonymousClaim(),
      galleryId: props.gallery._id,
      folderId: props.rootFolder._id,
      entryIds: thumbnailEntryIds,
    })
      .then((tickets) => {
        if (thumbnailRequest.current !== thumbnailRequestKey) return;
        setThumbnailUrls(
          Object.fromEntries(
            tickets.map(({ entryId, token }) => [
              entryId,
              storageApi(
                `/api/storage/files/${entryId}?ticket=${encodeURIComponent(token)}`,
              ),
            ]),
          ),
        );
      })
      .catch(() => {
        if (thumbnailRequest.current === thumbnailRequestKey) {
          setThumbnailUrls({});
        }
      });
  }, [createThumbnailTickets, thumbnailRequestKey]);

  if (listing === undefined) {
    return <PageFrame gallery={props.gallery}><p>Loading…</p></PageFrame>;
  }

  return (
    <PageFrame gallery={props.gallery}>
      {listing.access.canUpload ? (
        <form
          className={styles.uploadForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            void upload({
              file,
              galleryId: props.gallery._id,
              folderId: props.rootFolder._id,
              description,
              password,
            }).then(() => {
              setFile(null);
              setDescription("");
              setPassword("");
              setTextPreview(null);
            });
          }}
        >
          <label className={styles.filePicker}>
            <span>{file ? file.name : "Choose a file, drop it here, or paste"}</span>
            <input
              type="file"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setTextPreview(null);
              }}
            />
          </label>
          {previewUrl ? <img className={styles.preview} src={previewUrl} alt="Upload preview" /> : null}
          {textPreview ? <pre className={styles.textPreview}>{textPreview}</pre> : null}
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <label>Password <small>(optional)</small><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error ? <p className={layout.formError}>{error}</p> : null}
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Uploading…" : "Submit"}
          </button>
        </form>
      ) : (
        <p className={layout.notice}>Log in with an allowed account to upload.</p>
      )}

      <div className={styles.entryList}>
        {listing.entries.map((entry) => (
          <UploaderEntry
            key={entry._id}
            entry={entry}
            routeRoot={props.routeRoot}
            thumbnailUrl={thumbnailUrls[entry._id]}
            onOpen={() => setViewerEntryId(entry._id)}
            onMetadata={() =>
              entry.metadataJson && setMetadataJson(entry.metadataJson)
            }
          />
        ))}
      </div>
      {metadataJson ? (
        <MetadataDialog
          metadataJson={metadataJson}
          onClose={() => setMetadataJson(null)}
        />
      ) : null}
      {viewerIndex >= 0 ? (
        <MediaViewer
          items={viewerItems}
          initialIndex={viewerIndex}
          resolveSource={resolveViewerSource}
          onClose={() => setViewerEntryId(null)}
        />
      ) : null}
    </PageFrame>
  );
}

function UploaderEntry(props: {
  entry: Doc<"entries"> & {
    passwordProtected: boolean;
    canDelete: boolean;
    views: number;
  };
  routeRoot: string;
  thumbnailUrl?: string;
  onOpen: () => void;
  onMetadata: () => void;
}) {
  const removeEntry = useMutation(api.entries.remove);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileUrl = uploaderFileUrl(
    props.routeRoot,
    props.entry._id,
    props.entry.name,
  );
  return (
    <article className={styles.entry}>
      <a
        className={styles.previewLink}
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View ${props.entry.name}`}
        onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
          if (!shouldOpenMediaViewer(event)) return;
          event.preventDefault();
          props.onOpen();
        }}
      >
        <span className={styles.thumbnail}>
          {props.thumbnailUrl ? (
            <img src={props.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <FileGlyph
              extension={props.entry.extension}
              galleryId={props.entry.galleryId}
            />
          )}
        </span>
        <span className={styles.viewAction}>View</span>
      </a>
      <div className={styles.entryFooter}>
        <div className={styles.entryTitle}>
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={props.entry.name}
          >
            {props.entry.name}
          </a>
          {props.entry.description ? <p>{props.entry.description}</p> : null}
        </div>
        <div className={styles.entryMetadata}>
          <span>{formatBytes(props.entry.size)}</span>
          <span className={styles.metadataLine}>
            <span>
              {props.entry.views} {props.entry.views === 1 ? "view" : "views"}
            </span>
            {props.entry.passwordProtected ? (
              <span title="Password protected" aria-label="Password protected">
                🔒
              </span>
            ) : null}
            {props.entry.metadataJson ? (
              <button
                className={styles.metadataButton}
                type="button"
                onClick={props.onMetadata}
                title="View metadata"
                aria-label={`View metadata for ${props.entry.name}`}
              >
                ⓘ
              </button>
            ) : null}
            {props.entry.canDelete ? (
              <button
                className={`${styles.metadataButton} ${styles.deleteButton}`}
                type="button"
                onClick={() => setConfirmDelete(true)}
                title="Delete file"
                aria-label={`Delete ${props.entry.name}`}
              >
                <TrashIcon />
              </button>
            ) : null}
          </span>
        </div>
      </div>
      {confirmDelete ? (
        <Dialog
          title="Delete file?"
          onClose={() => {
            if (!deleting) {
              setConfirmDelete(false);
              setDeleteError(null);
              setDeletePassword("");
            }
          }}
        >
          <form
            className={layout.form}
            onSubmit={(event) => {
              event.preventDefault();
              setDeleting(true);
              setDeleteError(null);
              void removeEntry({
                anonymousClaim: getOrCreateAnonymousClaim(),
                entryId: props.entry._id,
                password: deletePassword || undefined,
              })
                .then(() => setConfirmDelete(false))
                .catch((reason: unknown) => {
                  setDeleteError(
                    friendlyError(reason, "Could not delete the file"),
                  );
                })
                .finally(() => setDeleting(false));
            }}
          >
            <p className={styles.deletePrompt}>
              Delete <strong>{props.entry.name}</strong>? This cannot be undone.
            </p>
            {props.entry.passwordProtected ? (
              <label>
                File password
                <input
                  type="password"
                  autoFocus
                  value={deletePassword}
                  onChange={(event) => setDeletePassword(event.target.value)}
                  required
                />
              </label>
            ) : null}
            {deleteError ? (
              <p className={layout.formError}>{deleteError}</p>
            ) : null}
            <div className={layout.buttonRow}>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className={styles.confirmDeleteButton}
                type="submit"
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </article>
  );
}

function MetadataDialog(props: {
  metadataJson: string;
  onClose: () => void;
}) {
  const metadata = parseMetadataJson(props.metadataJson);
  const rows = metadata === null ? [] : metadataRows(metadata);
  const location = metadata === null ? null : metadataLocation(metadata);
  const mapUrls =
    location === null ? null : openStreetMapUrls(location);

  return (
    <Dialog title="Metadata" onClose={props.onClose}>
      {rows.length > 0 ? (
        <div className={styles.metadataContent}>
          <div className={styles.metadataTableFrame}>
            <table className={styles.metadataTable}>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mapUrls ? (
            <figure className={styles.metadataMap}>
              <iframe
                src={mapUrls.embed}
                title="Media location on OpenStreetMap"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
              <figcaption>
                <a
                  href={mapUrls.full}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View larger map
                </a>
              </figcaption>
            </figure>
          ) : null}
        </div>
      ) : (
        <p className={styles.metadataUnavailable}>Metadata is unavailable.</p>
      )}
    </Dialog>
  );
}
