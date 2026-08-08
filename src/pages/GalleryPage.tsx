import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  Folder,
  FolderPlus,
  Info,
  RefreshCw,
  Settings,
  Upload,
} from "lucide-react";
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
import {
  MoveIcon,
  SelectListIcon,
  TrashIcon,
} from "../components/ActionIcons";
import { publicMediaUrl, formatBytes, storageApi } from "../lib/files";
import { useUpload } from "../hooks/useUpload";
import { friendlyError } from "../lib/errors";
import { anonymousClaim } from "../lib/authClient";
import {
  isHeifImage,
  shouldUseNativeHeifPreview,
} from "../lib/media";
import {
  metadataLocation,
  metadataRows,
  openStreetMapUrls,
  parseMetadataJson,
} from "../lib/metadata";
import styles from "../styles/gallery.module.css";
import layout from "../styles/layout.module.css";

type FolderPreviewMode = "first" | "random" | "first3" | "random3";

type FolderPreviewData = {
  folderId: Id<"folders">;
  mode: FolderPreviewMode;
  entries: Array<{
    _id: Id<"entries">;
    name: string;
    storageKey: string;
    thumbnailKey?: string;
    filesystemModifiedAt?: number;
  }>;
};

export function GalleryPage(props: {
  gallery: Doc<"galleries">;
  rootFolder: Doc<"folders">;
}) {
  const [searchParams] = useSearchParams();
  const requestedFolder = searchParams.get("folder");
  const folderId = (requestedFolder ?? props.rootFolder._id) as Id<"folders">;
  const [previewSeed] = useState(() => {
    const values = crypto.getRandomValues(new Uint32Array(1));
    return values[0];
  });
  const listing = useQuery(api.folders.list, {
    anonymousClaim: anonymousClaim(),
    galleryId: props.gallery._id,
    folderId,
    previewSeed,
  });
  const createFolder = useMutation(api.folders.create);
  const updateFolder = useMutation(api.folders.update);
  const removeEntries = useMutation(api.entries.removeMany);
  const moveEntries = useMutation(api.entries.moveMany);
  const requestPreview = useMutation(api.entries.requestPreview);
  const removeLocationData = useMutation(api.entries.removeLocationData);
  const refreshMetadata = useMutation(api.entries.refreshMetadata);
  const fileInput = useRef<HTMLInputElement>(null);
  const draggedEntryIds = useRef<Array<Id<"entries">>>([]);
  const { upload, uploading, error } = useUpload();
  const [folderDialog, setFolderDialog] = useState<"create" | "settings" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEntryIds, setSelectedEntryIds] = useState<
    Set<Id<"entries">>
  >(new Set());
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [moveDialog, setMoveDialog] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [draggingEntries, setDraggingEntries] = useState(false);
  const [viewerEntryId, setViewerEntryId] = useState<string | null>(null);
  const [metadataEntryId, setMetadataEntryId] =
    useState<Id<"entries"> | null>(null);

  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      (listing?.entries ?? []).map((entry) => {
        const sourceUrl = publicMediaUrl(
          entry.storageKey,
          entry.filesystemModifiedAt,
        );
        const heif = isHeifImage(entry.mimeType, entry.name);
        const nativeHeifPreview = shouldUseNativeHeifPreview(
          entry.mimeType,
          entry.name,
        );
        const viewerSourceUrl = !heif || nativeHeifPreview
          ? sourceUrl
          : entry.previewKey === undefined
            ? undefined
            : publicMediaUrl(entry.previewKey);
        return {
          id: entry._id,
          title: entry.name,
          href: sourceUrl,
          sourceUrl: viewerSourceUrl,
          mediaKind: entry.mediaKind,
          mimeType: entry.mimeType,
          previewReady:
            !heif || nativeHeifPreview || entry.previewKey !== undefined,
          previewError: nativeHeifPreview ? undefined : entry.previewError,
        };
      }),
    [listing?.entries],
  );
  const resolveViewerSource = useCallback(
    async (item: MediaViewerItem) => {
      const result = await requestPreview({
        anonymousClaim: anonymousClaim(),
        galleryId: props.gallery._id,
        entryId: item.id as Id<"entries">,
      });
      return result.status === "pending"
        ? null
        : publicMediaUrl(result.previewKey);
    },
    [props.gallery._id, requestPreview],
  );
  const viewerIndex =
    viewerEntryId === null
      ? -1
      : viewerItems.findIndex((item) => item.id === viewerEntryId);
  const folderPreviews = useMemo(
    () =>
      new Map(
        (listing?.folderPreviews ?? []).map((preview) => [
          preview.folderId,
          preview,
        ]),
      ),
    [listing?.folderPreviews],
  );
  const metadataEntry =
    metadataEntryId === null
      ? undefined
      : listing?.entries.find((entry) => entry._id === metadataEntryId);

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
    if (!listing?.access.canUpload && !selectMode) return;
    const onDragOver = (event: DragEvent) => {
      if (
        selectMode &&
        event.dataTransfer?.types.includes(
          "application/x-upgallery-entry-ids",
        )
      ) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        return;
      }
      if (!listing?.access.canUpload) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (
        event.dataTransfer?.types.includes(
          "application/x-upgallery-entry-ids",
        )
      ) {
        event.preventDefault();
        draggedEntryIds.current = [];
        setDraggingEntries(false);
        return;
      }
      if (!listing?.access.canUpload) return;
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
  }, [listing?.access.canUpload, folderId, selectMode]);

  useEffect(() => {
    setSelectedEntryIds(new Set());
    setDeleteDialog(false);
    setMoveDialog(false);
  }, [folderId]);

  useEffect(() => {
    if (listing === undefined) return;
    const available = new Set(listing.entries.map((entry) => entry._id));
    setSelectedEntryIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [listing]);

  useEffect(() => {
    if (listing === undefined || !listing.access.canEditFolder) return;
    for (const entry of listing.entries) {
      if (
        entry.metadataVersion === undefined &&
        isHeifImage(entry.mimeType, entry.name)
      ) {
        void refreshMetadata({
          anonymousClaim: anonymousClaim(),
          galleryId: props.gallery._id,
          entryId: entry._id,
        }).catch(() => undefined);
      }
    }
  }, [listing, props.gallery._id, refreshMetadata]);

  if (listing === undefined) {
    return <PageFrame gallery={props.gallery}><p>Loading…</p></PageFrame>;
  }

  const selectedIds = [...selectedEntryIds];

  const queueMove = async (
    entryIds: Array<Id<"entries">>,
    destinationGalleryId: Id<"galleries">,
    destinationFolderId: Id<"folders">,
  ) => {
    if (entryIds.length === 0) return;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await moveEntries({
        sourceGalleryId: props.gallery._id,
        destinationGalleryId,
        destinationFolderId,
        entryIds,
      });
      setSelectedEntryIds(new Set());
      setMoveDialog(false);
      setNotice(
        result.queued === 0
          ? "The selected files are already in that folder."
          : `${result.queued} file${result.queued === 1 ? "" : "s"} queued to move.`,
      );
    } catch (reason) {
      setActionError(friendlyError(reason, "Could not move the selected files"));
      throw reason;
    } finally {
      setActionPending(false);
    }
  };

  const dropSelectedEntries = (
    event: ReactDragEvent<HTMLElement>,
    destinationGalleryId: Id<"galleries">,
    destinationFolderId: Id<"folders">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const transferred = event.dataTransfer.getData(
      "application/x-upgallery-entry-ids",
    );
    let entryIds = draggedEntryIds.current;
    if (entryIds.length === 0 && transferred) {
      try {
        entryIds = JSON.parse(transferred) as Array<Id<"entries">>;
      } catch {
        entryIds = [];
      }
    }
    draggedEntryIds.current = [];
    setDraggingEntries(false);
    void queueMove(
      entryIds,
      destinationGalleryId,
      destinationFolderId,
    ).catch(() => undefined);
  };

  const breadcrumbs = listing.breadcrumbs.map((crumb, index) => (
    <span
      className={draggingEntries ? styles.breadcrumbDropTarget : undefined}
      key={crumb._id}
      onDragOver={
        selectMode
          ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDrop={
        selectMode
          ? (event) =>
              dropSelectedEntries(event, props.gallery._id, crumb._id)
          : undefined
      }
    >
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
            <button className={layout.iconButton} type="button" onClick={() => fileInput.current?.click()} aria-label="Upload files" title="Upload files">
              <Upload aria-hidden="true" size={18} />
            </button>
            <button className={layout.iconButton} type="button" onClick={() => setFolderDialog("create")} aria-label="New folder" title="New folder">
              <FolderPlus aria-hidden="true" size={18} />
            </button>
            </>
          ) : null}
          {listing.access.canManage ? (
            <>
              <button
                className={`${layout.iconButton} ${selectMode ? styles.activeAction : ""}`}
                type="button"
                onClick={() => {
                  setSelectMode((current) => !current);
                  setSelectedEntryIds(new Set());
                  setDeleteDialog(false);
                  setMoveDialog(false);
                }}
                aria-label={selectMode ? "Exit select mode" : "Enter select mode"}
                aria-pressed={selectMode}
                title={selectMode ? "Exit select mode" : "Select files"}
              >
                <SelectListIcon />
              </button>
              {selectMode && selectedIds.length > 0 ? (
                <>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setDeleteDialog(true)}
                    aria-label={`Delete ${selectedIds.length} selected files`}
                    title="Delete selected"
                  >
                    <TrashIcon />
                  </button>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setMoveDialog(true)}
                    aria-label={`Move ${selectedIds.length} selected files`}
                    title="Move to…"
                  >
                    <MoveIcon />
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          {listing.access.canEditFolder ? (
            <button className={layout.iconButton} type="button" onClick={() => setFolderDialog("settings")} aria-label="Folder settings" title="Folder settings">
              <Settings aria-hidden="true" size={18} />
            </button>
          ) : null}
        </>
      }
    >
      {(uploading || error || actionError || notice) && (
        <div className={error || actionError ? layout.errorNotice : layout.notice}>
          {error ?? actionError ?? notice ?? "Uploading…"}
        </div>
      )}
      {selectMode ? (
        <p className={styles.selectionHint}>
          {selectedIds.length === 0
            ? "Select files, then delete, move, or drag them onto a folder."
            : `${selectedIds.length} selected`}
        </p>
      ) : null}
      <div className={styles.grid}>
        {listing.folders.map((folder) => (
          <Link
            className={`${styles.folderCard} ${draggingEntries ? styles.folderDropTarget : ""}`}
            key={folder._id}
            to={`?folder=${folder._id}`}
            onDragOver={
              selectMode
                ? (event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                : undefined
            }
            onDrop={
              selectMode
                ? (event) =>
                    dropSelectedEntries(
                      event,
                      props.gallery._id,
                      folder._id,
                    )
                : undefined
            }
          >
            <FolderPreview preview={folderPreviews.get(folder._id)} />
            <span className={styles.folderName}>{folder.name}</span>
            {folder.privacy !== "public" ? (
              <small>{folder.privacy}</small>
            ) : null}
          </Link>
        ))}
        {listing.entries.map((entry) => (
          <GalleryEntryCard
            key={entry._id}
            entry={entry}
            selectMode={selectMode}
            selected={selectedEntryIds.has(entry._id)}
            onOpen={() => setViewerEntryId(entry._id)}
            onMetadata={() => setMetadataEntryId(entry._id)}
            onToggle={() => {
              setSelectedEntryIds((current) => {
                const next = new Set(current);
                if (next.has(entry._id)) next.delete(entry._id);
                else next.add(entry._id);
                return next;
              });
            }}
            onDragStart={(event) => {
              const ids = selectedEntryIds.has(entry._id)
                ? selectedIds
                : [entry._id];
              if (!selectedEntryIds.has(entry._id)) {
                setSelectedEntryIds(new Set(ids));
              }
              draggedEntryIds.current = ids;
              setDraggingEntries(true);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "application/x-upgallery-entry-ids",
                JSON.stringify(ids),
              );
            }}
            onDragEnd={() => {
              draggedEntryIds.current = [];
              setDraggingEntries(false);
            }}
          />
        ))}
      </div>
      {listing.folders.length === 0 && listing.entries.length === 0 ? (
        <p className={styles.empty}>This folder is empty.</p>
      ) : null}
      {viewerIndex >= 0 ? (
        <MediaViewer
          items={viewerItems}
          initialIndex={viewerIndex}
          resolveSource={resolveViewerSource}
          onClose={() => setViewerEntryId(null)}
        />
      ) : null}
      {metadataEntry?.metadataJson ? (
        <GalleryMetadataDialog
          entryName={metadataEntry.name}
          metadataJson={metadataEntry.metadataJson}
          canRemoveLocation={
            listing.access.canEditFolder && metadataEntry.mediaKind === "image"
          }
          onClose={() => setMetadataEntryId(null)}
          onRemoveLocation={() =>
            removeLocationData({
                anonymousClaim: anonymousClaim(),
                galleryId: props.gallery._id,
                entryId: metadataEntry._id,
              }).then(() => undefined)
          }
        />
      ) : null}

      {folderDialog === "create" ? (
        <FolderForm
          title="New folder"
          initialName=""
          initialPrivacy="public"
          initialPreviewMode={undefined}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (name, privacy, previewMode) => {
            const result = await createFolder({
              galleryId: props.gallery._id,
              parentId: folderId,
              name,
              privacy,
              ...(previewMode === undefined ? {} : { previewMode }),
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
          initialPreviewMode={listing.folder.previewMode}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (name, privacy, previewMode) => {
            const result = await updateFolder({
              folderId,
              name,
              privacy,
              ...(previewMode === undefined ? {} : { previewMode }),
            });
            await completeFilesystemFolderOperation(result);
            setFolderDialog(null);
            setNotice("Folder updated");
          }}
        />
      ) : null}
      {deleteDialog ? (
        <Dialog
          title="Delete selected files?"
          onClose={() => {
            if (!actionPending) setDeleteDialog(false);
          }}
        >
          <form
            className={layout.form}
            onSubmit={(event) => {
              event.preventDefault();
              setActionPending(true);
              setActionError(null);
              void removeEntries({
                galleryId: props.gallery._id,
                entryIds: selectedIds,
              })
                .then((result) => {
                  setSelectedEntryIds(new Set());
                  setDeleteDialog(false);
                  setNotice(
                    `${result.removed} file${result.removed === 1 ? "" : "s"} deleted.`,
                  );
                })
                .catch((reason: unknown) => {
                  setActionError(
                    friendlyError(
                      reason,
                      "Could not delete the selected files",
                    ),
                  );
                })
                .finally(() => setActionPending(false));
            }}
          >
            <p className={styles.deletePrompt}>
              Delete {selectedIds.length} selected file
              {selectedIds.length === 1 ? "" : "s"}? This cannot be undone.
            </p>
            <div className={layout.buttonRow}>
              <button
                type="button"
                onClick={() => setDeleteDialog(false)}
                disabled={actionPending}
              >
                Cancel
              </button>
              <button
                className={styles.confirmDeleteButton}
                type="submit"
                disabled={actionPending}
              >
                {actionPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {moveDialog ? (
        <MoveDialog
          currentGalleryId={props.gallery._id}
          selectedCount={selectedIds.length}
          pending={actionPending}
          onClose={() => {
            if (!actionPending) setMoveDialog(false);
          }}
          onMove={(destinationGalleryId, destinationFolderId) =>
            queueMove(
              selectedIds,
              destinationGalleryId,
              destinationFolderId,
            )
          }
        />
      ) : null}
    </PageFrame>
  );
}

function FolderPreview(props: { preview?: FolderPreviewData }) {
  const [topIndex, setTopIndex] = useState<number | null>(null);
  const entries = props.preview?.entries ?? [];
  const isFan =
    (props.preview?.mode === "first3" ||
      props.preview?.mode === "random3") &&
    entries.length > 1;
  const defaultTopIndex = Math.max(0, entries.length - 1);
  const activeTopIndex = topIndex ?? defaultTopIndex;
  const cardPositions = [
    styles.folderPreviewCardLeft,
    styles.folderPreviewCardMiddle,
    styles.folderPreviewCardRight,
  ];

  return (
    <span
      className={styles.folderPreviewFrame}
      onMouseMove={
        isFan
          ? (event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const position = (event.clientX - bounds.left) / bounds.width;
              const nextIndex =
                position < 0.4 ? 0 : position < 0.8 ? 1 : 2;
              setTopIndex(Math.min(nextIndex, defaultTopIndex));
            }
          : undefined
      }
      onMouseLeave={isFan ? () => setTopIndex(null) : undefined}
    >
      <Folder
        className={styles.folderBackdrop}
        aria-hidden="true"
        strokeWidth={1.1}
      />
      {entries.map((entry, index) => (
        <img
          className={
            isFan
              ? `${styles.folderPreviewCard} ${cardPositions[index]}`
              : styles.folderPreviewSingle
          }
          style={
            isFan
              ? { zIndex: index === activeTopIndex ? 4 : index + 1 }
              : undefined
          }
          key={entry._id}
          src={publicMediaUrl(
            entry.thumbnailKey ?? entry.storageKey,
            entry.thumbnailKey === undefined
              ? entry.filesystemModifiedAt
              : undefined,
          )}
          alt=""
          loading="lazy"
        />
      ))}
    </span>
  );
}

function GalleryEntryCard(props: {
  entry: Doc<"entries">;
  selectMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onMetadata: () => void;
  onToggle: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const content = (
    <>
      <span className={styles.thumbnailFrame}>
        {props.entry.thumbnailKey ? (
          <img
            className={styles.fileThumb}
            src={publicMediaUrl(props.entry.thumbnailKey)}
            alt=""
            loading="lazy"
          />
        ) : props.entry.mediaKind === "image" ? (
          <img
            className={styles.fileThumb}
            src={publicMediaUrl(
              props.entry.storageKey,
              props.entry.filesystemModifiedAt,
            )}
            alt=""
            loading="lazy"
          />
        ) : (
          <FileGlyph
            extension={props.entry.extension}
            galleryId={props.entry.galleryId}
          />
        )}
        {props.selectMode ? (
          <span
            className={`${styles.selectCircle} ${props.selected ? styles.selectCircleChecked : ""}`}
            aria-hidden="true"
          >
            {props.selected ? (
              <Check aria-hidden="true" size={14} strokeWidth={3} />
            ) : null}
          </span>
        ) : null}
      </span>
      <span className={styles.fileName}>{props.entry.name}</span>
      <small>{formatBytes(props.entry.size)}</small>
    </>
  );
  return (
    <article
      className={`${styles.fileCard} ${props.selected ? styles.selectedCard : ""}`}
      draggable={props.selectMode}
      onDragStart={props.selectMode ? props.onDragStart : undefined}
      onDragEnd={props.selectMode ? props.onDragEnd : undefined}
    >
      {props.selectMode ? (
        <button
          className={styles.fileCardContent}
          type="button"
          onClick={props.onToggle}
          aria-label={`${props.selected ? "Deselect" : "Select"} ${props.entry.name}`}
          aria-pressed={props.selected}
        >
          {content}
        </button>
      ) : (
        <a
          className={styles.fileCardContent}
          href={publicMediaUrl(
            props.entry.storageKey,
            props.entry.filesystemModifiedAt,
          )}
          target="_blank"
          rel="noreferrer"
          onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
            if (!shouldOpenMediaViewer(event)) return;
            event.preventDefault();
            props.onOpen();
          }}
        >
          {content}
        </a>
      )}
      {!props.selectMode && props.entry.metadataJson ? (
        <button
          className={styles.cardMetadataButton}
          type="button"
          onClick={props.onMetadata}
          title="View metadata"
          aria-label={`View metadata for ${props.entry.name}`}
        >
          <Info aria-hidden="true" size={15} />
        </button>
      ) : null}
    </article>
  );
}

function GalleryMetadataDialog(props: {
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

function MoveDialog(props: {
  currentGalleryId: Id<"galleries">;
  selectedCount: number;
  pending: boolean;
  onClose: () => void;
  onMove: (
    galleryId: Id<"galleries">,
    folderId: Id<"folders">,
  ) => Promise<void>;
}) {
  const galleries = useQuery(api.galleries.listOwnedImageGalleries);
  const [galleryId, setGalleryId] = useState<Id<"galleries"> | null>(null);
  const [folderId, setFolderId] = useState<Id<"folders"> | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const folders = useQuery(
    api.folders.listOwnedMoveDestinations,
    galleryId === null ? "skip" : { galleryId },
  );

  useEffect(() => {
    if (galleries === undefined || galleries.length === 0) return;
    if (
      galleryId !== null &&
      galleries.some((gallery) => gallery._id === galleryId)
    ) {
      return;
    }
    const initial =
      galleries.find((gallery) => gallery._id === props.currentGalleryId) ??
      galleries[0];
    setGalleryId(initial._id);
    setFolderId(initial.rootFolderId);
  }, [galleries, galleryId, props.currentGalleryId]);

  useEffect(() => {
    if (galleryId === null || galleries === undefined) return;
    const gallery = galleries.find((candidate) => candidate._id === galleryId);
    if (gallery !== undefined) setFolderId(gallery.rootFolderId);
  }, [galleryId, galleries]);

  const orderedFolders = useMemo(() => {
    if (folders === undefined || galleryId === null) return [];
    const gallery = galleries?.find((candidate) => candidate._id === galleryId);
    if (gallery === undefined) return [];
    const children = new Map<string, typeof folders>();
    for (const folder of folders) {
      const key = folder.parentId ?? "";
      children.set(key, [...(children.get(key) ?? []), folder]);
    }
    for (const group of children.values()) {
      group.sort((left, right) => left.name.localeCompare(right.name));
    }
    const ordered: typeof folders = [];
    const visit = (parentId: string) => {
      for (const folder of children.get(parentId) ?? []) {
        ordered.push(folder);
        visit(folder._id);
      }
    };
    const root = folders.find(
      (folder) => folder._id === gallery.rootFolderId,
    );
    if (root !== undefined) {
      ordered.push(root);
      visit(root._id);
    }
    return ordered;
  }, [folders, galleries, galleryId]);

  return (
    <Dialog title={`Move ${props.selectedCount} selected file${props.selectedCount === 1 ? "" : "s"}`} onClose={props.onClose}>
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (galleryId === null || folderId === null) return;
          setDialogError(null);
          void props.onMove(galleryId, folderId).catch((reason: unknown) => {
            setDialogError(
              friendlyError(reason, "Could not move the selected files"),
            );
          });
        }}
      >
        <div className={styles.movePicker}>
          <section className={styles.moveColumn}>
            <h3>Gallery</h3>
            <div className={styles.moveOptions}>
              {galleries?.map((gallery) => (
                <button
                  className={gallery._id === galleryId ? styles.moveOptionSelected : ""}
                  type="button"
                  key={gallery._id}
                  onClick={() => setGalleryId(gallery._id)}
                  aria-pressed={gallery._id === galleryId}
                >
                  {gallery.name}
                </button>
              ))}
              {galleries?.length === 0 ? (
                <p>No owned image galleries are available.</p>
              ) : null}
            </div>
          </section>
          <section className={styles.moveColumn}>
            <h3>Folder</h3>
            <div className={styles.moveOptions}>
              {orderedFolders.map((folder) => (
                <button
                  className={folder._id === folderId ? styles.moveOptionSelected : ""}
                  style={{
                    paddingInlineStart: `${0.55 + folder.ancestorIds.length * 0.8}rem`,
                  }}
                  type="button"
                  key={folder._id}
                  onClick={() => setFolderId(folder._id)}
                  aria-pressed={folder._id === folderId}
                >
                  {folder.name}
                </button>
              ))}
            </div>
          </section>
        </div>
        {dialogError ? <p className={layout.formError}>{dialogError}</p> : null}
        <div className={layout.buttonRow}>
          <button type="button" onClick={props.onClose} disabled={props.pending}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              props.pending ||
              galleryId === null ||
              folderId === null ||
              galleries?.length === 0
            }
          >
            {props.pending ? "Moving…" : "Move here"}
          </button>
        </div>
      </form>
    </Dialog>
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
        <RefreshCw aria-hidden="true" size={18} />
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
        <Check aria-hidden="true" size={18} strokeWidth={2.5} />
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
  initialPreviewMode?: FolderPreviewMode;
  onClose: () => void;
  onSubmit: (
    name: string,
    privacy: "public" | "unlisted" | "private",
    previewMode?: FolderPreviewMode,
  ) => Promise<void>;
}) {
  const [name, setName] = useState(props.initialName);
  const [privacy, setPrivacy] = useState(props.initialPrivacy);
  const [previewMode, setPreviewMode] = useState<
    FolderPreviewMode | "inherit"
  >(props.initialPreviewMode ?? "inherit");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          void props
            .onSubmit(
              name,
              privacy,
              previewMode === "inherit" ? undefined : previewMode,
            )
            .catch((reason: unknown) => {
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
        <label>Folder preview
          <select
            value={previewMode}
            onChange={(event) =>
              setPreviewMode(
                event.target.value as FolderPreviewMode | "inherit",
              )
            }
          >
            <option value="inherit">Use gallery default</option>
            <option value="first">First image</option>
            <option value="random">Random</option>
            <option value="first3">First 3</option>
            <option value="random3">Random 3</option>
          </select>
        </label>
        {error ? <p className={layout.formError}>{error}</p> : null}
        <button type="submit">Save</button>
      </form>
    </Dialog>
  );
}
