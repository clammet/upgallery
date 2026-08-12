import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Eye, EyeOff, Info, LockKeyhole } from "lucide-react";
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
import { MarkdownToggle } from "../components/MarkdownToggle";
import { formatBytes, storageApi } from "../lib/files";
import { useUpload } from "../hooks/useUpload";
import { anonymousClaim } from "../lib/authClient";
import {
  fileHasLocationMetadata,
  metadataLocation,
  metadataRows,
  openStreetMapUrls,
  parseMetadataJson,
} from "../lib/metadata";
import { uploaderFileUrl } from "../lib/uploaderRoutes";
import { friendlyError } from "../lib/errors";
import {
  canToggleTextMarkdown,
  fileNameWithMarkdownMode,
  isHeifImage,
  shouldRenderTextAsMarkdown,
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
    anonymousClaim: anonymousClaim(),
    galleryId: props.gallery._id,
    folderId: props.rootFolder._id,
  });
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [removeLocationData, setRemoveLocationData] = useState(false);
  const [unlisted, setUnlisted] = useState(false);
  const [locationCheck, setLocationCheck] = useState<
    "idle" | "checking" | "found" | "not-found"
  >("idle");
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [metadataEntryId, setMetadataEntryId] =
    useState<Id<"entries"> | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [viewerEntryId, setViewerEntryId] = useState<string | null>(null);
  const thumbnailRequest = useRef("");
  const createThumbnailTickets = useMutation(
    api.entries.createThumbnailTickets,
  );
  const createDownloadTicket = useMutation(api.entries.createDownloadTicket);
  const requestPreview = useMutation(api.entries.requestPreview);
  const setEntryMarkdownMode = useMutation(api.entries.setMarkdownMode);
  const removeStoredLocationData = useMutation(
    api.entries.removeLocationData,
  );
  const refreshStoredMetadata = useMutation(api.entries.refreshMetadata);
  const { upload, uploading, error } = useUpload();
  const previewUrl = useMemo(
    () => (file?.type.startsWith("image/") ? URL.createObjectURL(file) : null),
    [file],
  );
  const imageSelected =
    file !== null &&
    (file.type.startsWith("image/") ||
      /\.(?:avif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(file.name));

  useEffect(() => {
    setRemoveLocationData(false);
    if (file === null || !imageSelected) {
      setLocationCheck("idle");
      return;
    }
    let active = true;
    setLocationCheck("checking");
    void fileHasLocationMetadata(file).then((hasLocation) => {
      if (active) setLocationCheck(hasLocation ? "found" : "not-found");
    });
    return () => {
      active = false;
    };
  }, [file, imageSelected]);

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
  const metadataEntry =
    metadataEntryId === null
      ? undefined
      : listing?.entries.find((entry) => entry._id === metadataEntryId);
  const thumbnailRequestKey = `${props.gallery._id}:${props.rootFolder._id}:${thumbnailEntryIds.join(",")}`;
  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      (listing?.entries ?? []).map((entry) => ({
        id: entry._id,
        title: entry.name,
        href: uploaderFileUrl(props.routeRoot, entry._id, entry.name),
        mediaKind: entry.mediaKind,
        mimeType: entry.mimeType,
        canToggleMarkdown:
          entry.canDelete &&
          canToggleTextMarkdown(entry.mediaKind, entry.name),
        passwordProtected: entry.passwordProtected,
        previewReady:
          !isHeifImage(entry.mimeType, entry.name) ||
          shouldUseNativeHeifPreview(entry.mimeType, entry.name) ||
          entry.previewKey !== undefined,
        previewError: entry.previewError,
        metadataJson: entry.metadataJson,
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
          anonymousClaim: anonymousClaim(),
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
        anonymousClaim: anonymousClaim(),
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
  const changeViewerMarkdownMode = useCallback(
    async (item: MediaViewerItem, markdown: boolean) => {
      await setEntryMarkdownMode({
        anonymousClaim: anonymousClaim(),
        entryId: item.id as Id<"entries">,
        markdown,
      });
    },
    [setEntryMarkdownMode],
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
      anonymousClaim: anonymousClaim(),
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

  useEffect(() => {
    if (listing === undefined) return;
    for (const entry of listing.entries) {
      if (
        entry.canDelete &&
        entry.metadataVersion === undefined &&
        isHeifImage(entry.mimeType, entry.name)
      ) {
        void refreshStoredMetadata({
          anonymousClaim: anonymousClaim(),
          galleryId: props.gallery._id,
          entryId: entry._id,
        }).catch(() => undefined);
      }
    }
  }, [listing, props.gallery._id, refreshStoredMetadata]);

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
              removeLocationData,
              unlisted,
            }).then(() => {
              setFile(null);
              setDescription("");
              setPassword("");
              setRemoveLocationData(false);
              setUnlisted(false);
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
          {textPreview !== null ? (
            <>
              <div className={styles.clipboardOptions}>
                <small>Clipboard text preview</small>
                <MarkdownToggle
                  checked={
                    file !== null &&
                    shouldRenderTextAsMarkdown("text", file.name)
                  }
                  disabled={uploading}
                  onChange={(markdown) => {
                    setFile((current) =>
                      current === null
                        ? null
                        : new File(
                            [current],
                            fileNameWithMarkdownMode(current.name, markdown),
                            {
                              type: current.type,
                              lastModified: current.lastModified,
                            },
                          ),
                    );
                  }}
                />
              </div>
              <pre className={styles.textPreview}>{textPreview}</pre>
            </>
          ) : null}
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <label>Password <small>(optional)</small><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={unlisted}
              onChange={(event) => setUnlisted(event.target.checked)}
            />
            <span>
              Unlisted <small>— only you can see it in the listing</small>
            </span>
          </label>
          {locationCheck === "checking" ? (
            <small className={styles.locationCheck}>
              Checking image for location data…
            </small>
          ) : null}
          {locationCheck === "found" ? (
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={removeLocationData}
                onChange={(event) =>
                  setRemoveLocationData(event.target.checked)
                }
              />
              <span>remove location data</span>
            </label>
          ) : null}
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
            onMetadata={() => setMetadataEntryId(entry._id)}
          />
        ))}
      </div>
      {metadataEntry?.metadataJson ? (
        <MetadataDialog
          entryName={metadataEntry.name}
          metadataJson={metadataEntry.metadataJson}
          canRemoveLocation={
            metadataEntry.canDelete && metadataEntry.mediaKind === "image"
          }
          onClose={() => setMetadataEntryId(null)}
          onRemoveLocation={() =>
            removeStoredLocationData({
              anonymousClaim: anonymousClaim(),
              galleryId: props.gallery._id,
              entryId: metadataEntry._id,
            }).then(() => undefined)
          }
        />
      ) : null}
      {viewerIndex >= 0 ? (
        <MediaViewer
          items={viewerItems}
          initialIndex={viewerIndex}
          themeMode={props.gallery.theme.mode ?? "light"}
          onMarkdownModeChange={changeViewerMarkdownMode}
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
            <span
              title={`${props.entry.views} ${props.entry.views === 1 ? "view" : "views"}`}
              aria-label={`${props.entry.views} ${props.entry.views === 1 ? "view" : "views"}`}
            >
              {props.entry.views}
              <Eye aria-hidden="true" size={13} />
            </span>
            {props.entry.passwordProtected ? (
              <span title="Password protected" aria-label="Password protected">
                <LockKeyhole aria-hidden="true" size={13} />
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
                <Info aria-hidden="true" size={14} />
              </button>
            ) : null}
            {props.entry.unlisted ? (
              <span
                title="Unlisted — visible only to you in the listing"
                aria-label="Unlisted — visible only to you in the listing"
              >
                <EyeOff aria-hidden="true" size={14} />
              </span>
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
                anonymousClaim: anonymousClaim(),
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
  entryName: string;
  metadataJson: string;
  canRemoveLocation: boolean;
  onClose: () => void;
  onRemoveLocation: () => Promise<void>;
}) {
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeRequested, setRemoveRequested] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const metadata = parseMetadataJson(props.metadataJson);
  const rows = metadata === null ? [] : metadataRows(metadata);
  const location = metadata === null ? null : metadataLocation(metadata);
  const mapUrls =
    location === null ? null : openStreetMapUrls(location);

  if (confirmRemoval) {
    return (
      <Dialog
        title="Remove location data?"
        onClose={() => {
          if (!removing) setConfirmRemoval(false);
        }}
      >
        <div className={layout.form}>
          <p className={styles.deletePrompt}>
            Permanently remove location data from{" "}
            <strong>{props.entryName}</strong>? The image file will be rewritten
            and this cannot be undone.
          </p>
          {removeError ? (
            <p className={layout.formError}>{removeError}</p>
          ) : null}
          <div className={layout.buttonRow}>
            <button
              type="button"
              onClick={() => setConfirmRemoval(false)}
              disabled={removing}
            >
              Cancel
            </button>
            <button
              className={styles.confirmDeleteButton}
              type="button"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                setRemoveError(null);
                void props
                  .onRemoveLocation()
                  .then(() => {
                    setRemoveRequested(true);
                    setConfirmRemoval(false);
                  })
                  .catch((reason: unknown) => {
                    setRemoveError(
                      friendlyError(reason, "Could not remove location data"),
                    );
                  })
                  .finally(() => setRemoving(false));
              }}
            >
              {removing ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Metadata" onClose={props.onClose}>
      {rows.length > 0 ? (
        <div className={styles.metadataContent}>
          {removeRequested ? (
            <p className={layout.notice}>
              {location === null
                ? "Location data removed."
                : "Removing location data…"}
            </p>
          ) : null}
          <div className={styles.metadataTableFrame}>
            <table className={styles.metadataTable}>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>
                      <span className={styles.metadataValue}>
                        <span>{row.value}</span>
                        {row.key === "GPSLatitude" &&
                        location !== null &&
                        props.canRemoveLocation ? (
                          <button
                            className={styles.locationDeleteButton}
                            type="button"
                            onClick={() => setConfirmRemoval(true)}
                            title="Remove location data"
                            aria-label={`Remove location data from ${props.entryName}`}
                          >
                            <TrashIcon />
                          </button>
                        ) : null}
                      </span>
                    </td>
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
