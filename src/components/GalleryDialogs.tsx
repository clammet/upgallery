import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { RotateCcw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Dialog } from "./Dialog";
import { TrashIcon } from "./ActionIcons";
import { anonymousClaim } from "../lib/authClient";
import { friendlyError } from "../lib/errors";
import { filterFolderTree } from "../lib/folderSearch";
import { metadataLocation, metadataRows, openStreetMapUrls, parseMetadataJson } from "../lib/metadata";
import { GALLERY_SORT_OPTIONS, type GallerySortOrder } from "../lib/gallerySort";
import styles from "../styles/gallery.module.css";
import layout from "../styles/layout.module.css";

type FolderPreviewMode = "first" | "random" | "first3" | "random3" | "custom";
type FolderAccessPolicy = Doc<"folders">["accessPolicy"];
type FolderDiscoverability = Doc<"folders">["discoverability"];

export function GalleryMetadataDialog(props: {
  entryName: string;
  metadataJson?: string;
  uploader?: string;
  canRemoveLocation: boolean;
  onClose: () => void;
  onRemoveLocation: () => Promise<void>;
}) {
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeRequested, setRemoveRequested] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const metadata =
    props.metadataJson === undefined
      ? null
      : parseMetadataJson(props.metadataJson);
  const rows = metadataRows(metadata ?? {}, props.uploader);
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

export function MoveDialog(props: {
  currentGalleryId: Id<"galleries">;
  selectedEntryCount: number;
  selectedFolderIds: Array<Id<"folders">>;
  selectionSummary: string;
  pending: boolean;
  onClose: () => void;
  onMove: (
    galleryId: Id<"galleries">,
    folderId: Id<"folders">,
  ) => Promise<void>;
}) {
  // Folders can only move within their own gallery, so a selection that
  // includes folders pins the gallery column to the current gallery.
  const movingFolders = props.selectedFolderIds.length > 0;
  const ownedGalleries = useQuery(api.galleries.listOwnedImageGalleries, {
    anonymousClaim: anonymousClaim(),
    galleryId: props.currentGalleryId,
  });
  const galleries = useMemo(
    () =>
      movingFolders
        ? ownedGalleries?.filter(
            (gallery) => gallery._id === props.currentGalleryId,
          )
        : ownedGalleries,
    [movingFolders, ownedGalleries, props.currentGalleryId],
  );
  const [galleryId, setGalleryId] = useState<Id<"galleries"> | null>(null);
  const [folderId, setFolderId] = useState<Id<"folders"> | null>(null);
  const [folderSearch, setFolderSearch] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const folders = useQuery(
    api.folders.listOwnedMoveDestinations,
    galleryId === null
      ? "skip"
      : { anonymousClaim: anonymousClaim(), galleryId },
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
    // A folder cannot move into itself or one of its descendants.
    const movedIds = new Set(props.selectedFolderIds);
    const destinations = folders.filter(
      (folder) =>
        !movedIds.has(folder._id) &&
        !folder.ancestorIds.some((ancestorId) => movedIds.has(ancestorId)),
    );
    const children = new Map<string, typeof folders>();
    for (const folder of destinations) {
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
    const root = destinations.find(
      (folder) => folder._id === gallery.rootFolderId,
    );
    if (root !== undefined) {
      ordered.push(root);
      visit(root._id);
    }
    return ordered;
  }, [folders, galleries, galleryId, props.selectedFolderIds]);

  const visibleFolders = useMemo(
    () => filterFolderTree(orderedFolders, folderSearch),
    [orderedFolders, folderSearch],
  );
  const destinationVisible = visibleFolders.some(
    (folder) => folder._id === folderId,
  );

  return (
    <Dialog title={`Move ${props.selectionSummary}`} onClose={props.onClose}>
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (
            props.pending ||
            galleryId === null ||
            folderId === null ||
            !destinationVisible
          ) return;
          setDialogError(null);
          void props.onMove(galleryId, folderId).catch((reason: unknown) => {
            setDialogError(
              friendlyError(reason, "Could not move the selected items"),
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
              {movingFolders && (galleries?.length ?? 0) > 0 ? (
                <p>Folders move within their own gallery.</p>
              ) : null}
            </div>
          </section>
          <section className={styles.moveColumn}>
            <h3>Folder</h3>
            <div className={styles.moveSearch}>
              <input
                type="search"
                aria-label="Search destination folders"
                placeholder="Search folders…"
                value={folderSearch}
                onChange={(event) => setFolderSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
            </div>
            <div className={styles.moveOptions}>
              {visibleFolders.map((folder) => (
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
              {folders !== undefined && visibleFolders.length === 0 ? (
                <p role="status">No matching folders.</p>
              ) : null}
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
              !destinationVisible ||
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

export function FolderForm(props: {
  title: string;
  headerExtra?: ReactNode;
  galleryId: Id<"galleries">;
  gallerySortOrder: GallerySortOrder;
  previewFolderId?: Id<"folders">;
  initialName: string;
  initialAccessPolicy: FolderAccessPolicy;
  initialDiscoverability: FolderDiscoverability;
  isRoot: boolean;
  initialPreviewMode?: FolderPreviewMode;
  initialPreviewSource?: string;
  initialSortOrder?: GallerySortOrder;
  onResetAccess?: () => Promise<void>;
  onClose: () => void;
  onSubmit: (
    name: string,
    accessPolicy: FolderAccessPolicy,
    discoverability: FolderDiscoverability,
    previewMode?: FolderPreviewMode,
    previewSource?: string,
    sortOrder?: GallerySortOrder,
  ) => Promise<void>;
}) {
  const [name, setName] = useState(props.initialName);
  const [accessPolicy, setAccessPolicy] = useState(
    props.initialAccessPolicy,
  );
  const [discoverability, setDiscoverability] = useState(
    props.initialDiscoverability,
  );
  const [previewMode, setPreviewMode] = useState<
    FolderPreviewMode | "inherit"
  >(props.initialPreviewMode ?? "inherit");
  const [previewSource, setPreviewSource] = useState(
    props.initialPreviewSource ?? "",
  );
  const [sortOrder, setSortOrder] = useState<GallerySortOrder | "inherit">(
    props.initialSortOrder ?? "inherit",
  );
  const previewFilenameSuggestions = useQuery(
    api.folders.previewFilenameSuggestions,
    previewMode === "custom" &&
      props.previewFolderId !== undefined &&
      previewSource.trim() !== ""
      ? {
          anonymousClaim: anonymousClaim(),
          galleryId: props.galleryId,
          folderId: props.previewFolderId,
          search: previewSource,
        }
      : "skip",
  );
  const [error, setError] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  return (
    <Dialog
      title={props.title}
      headerExtra={
        <>
          {props.onResetAccess === undefined ? null : (
            <button
              className={layout.iconButton}
              type="button"
              aria-label="Reset this and children folders to inherit"
              title="Reset this and children folders to inherit"
              disabled={resetPending}
              onClick={() => {
                setError(null);
                setResetPending(true);
                void props
                  .onResetAccess!()
                  .then(() => setAccessPolicy("inherit"))
                  .catch((reason: unknown) => {
                    setError(
                      friendlyError(reason, "Could not reset folder access"),
                    );
                  })
                  .finally(() => setResetPending(false));
              }}
            >
              <RotateCcw
                aria-hidden="true"
                className={resetPending ? layout.syncSpinner : undefined}
                size={18}
              />
            </button>
          )}
          {props.headerExtra}
        </>
      }
      onClose={props.onClose}
    >
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          void props
            .onSubmit(
              name,
              props.isRoot ? "inherit" : accessPolicy,
              props.isRoot ? "listed" : discoverability,
              previewMode === "inherit" ? undefined : previewMode,
              previewMode === "custom" ? previewSource.trim() : undefined,
              sortOrder === "inherit" ? undefined : sortOrder,
            )
            .catch((reason: unknown) => {
              setError(friendlyError(reason, "Could not save"));
            });
        }}
      >
        <label>
          Folder name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        {props.isRoot ? (
          <p className={layout.notice}>
            Root access is controlled by gallery permissions.
          </p>
        ) : (
          <>
            <label>
              Access override
              <select
                value={accessPolicy}
                onChange={(event) =>
                  setAccessPolicy(event.target.value as FolderAccessPolicy)
                }
              >
                <option value="inherit">Inherit parent access</option>
                <option value="public">Public — everyone can view</option>
                <option value="restricted">
                  Restricted — explicit grants only
                </option>
              </select>
            </label>
            <label>
              Discoverability
              <select
                value={discoverability}
                onChange={(event) =>
                  setDiscoverability(
                    event.target.value as FolderDiscoverability,
                  )
                }
              >
                <option value="listed">Listed</option>
                <option value="unlisted">
                  Unlisted — hidden from viewers
                </option>
              </select>
            </label>
          </>
        )}
        <label>
          Folder preview
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
            <option value="custom">Custom</option>
          </select>
        </label>
        {previewMode === "custom" ? (
          <label>
            Filename/URL
            <input
              value={previewSource}
              onChange={(event) => setPreviewSource(event.target.value)}
              list={`folder-preview-filenames-${props.previewFolderId ?? "new"}`}
              maxLength={2048}
              required
            />
            <datalist
              id={`folder-preview-filenames-${props.previewFolderId ?? "new"}`}
            >
              {(previewFilenameSuggestions ?? []).map((filename) => (
                <option value={filename} key={filename} />
              ))}
            </datalist>
          </label>
        ) : null}
        {props.previewFolderId !== undefined ? (
          <label>
            Thumbnail order
            <select
              value={sortOrder}
              onChange={(event) =>
                setSortOrder(
                  event.target.value as GallerySortOrder | "inherit",
                )
              }
            >
              <option value="inherit">
                Use gallery default — {GALLERY_SORT_OPTIONS.find(
                  (option) => option.value === props.gallerySortOrder,
                )?.label}
              </option>
              {GALLERY_SORT_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p className={layout.formError}>{error}</p> : null}
        <button type="submit">Save</button>
      </form>
    </Dialog>
  );
}
