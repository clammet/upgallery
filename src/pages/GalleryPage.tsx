import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  ExternalLink,
  Folder,
  FolderPlus,
  Info,
  RefreshCw,
  Settings,
  Upload,
  X,
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
import { collectDroppedFiles, type DroppedFile } from "../lib/dropUpload";
import {
  beginTransfer,
  clearFinishedTransfers,
  completeTransfer,
  failTransfer,
  getTransfers,
  markTransferClientWork,
  parseTransferConcurrency,
  reportTransferProgress,
  runWithConcurrency,
  subscribeTransfers,
} from "../lib/transfers";
import { useUpload } from "../hooks/useUpload";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
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

const uploadConcurrency = parseTransferConcurrency(
  import.meta.env.VITE_UPLOAD_CONCURRENCY,
);

const ENTRY_DRAG_TYPE = "application/x-upgallery-entry-ids";
const FOLDER_DRAG_TYPE = "application/x-upgallery-folder-ids";

function hasInternalDrag(dataTransfer: DataTransfer | null): boolean {
  return (
    dataTransfer !== null &&
    (dataTransfer.types.includes(ENTRY_DRAG_TYPE) ||
      dataTransfer.types.includes(FOLDER_DRAG_TYPE))
  );
}

function readDraggedIds<T extends string>(
  transferred: string,
  fallback: T[],
): T[] {
  if (fallback.length > 0) return fallback;
  if (!transferred) return [];
  try {
    const parsed: unknown = JSON.parse(transferred);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFolder = searchParams.get("folder");
  const viewerEntryId = searchParams.get("item");
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
  const removeFolders = useMutation(api.folders.removeMany);
  const removeEntries = useMutation(api.entries.removeMany);
  const moveEntries = useMutation(api.entries.moveMany);
  const moveFolders = useMutation(api.folders.moveMany);
  const requestPreview = useMutation(api.entries.requestPreview);
  const removeLocationData = useMutation(api.entries.removeLocationData);
  const refreshMetadata = useMutation(api.entries.refreshMetadata);
  const renameEntry = useMutation(api.entries.rename);
  const fileInput = useRef<HTMLInputElement>(null);
  const draggedEntryIds = useRef<Array<Id<"entries">>>([]);
  const draggedFolderIds = useRef<Array<Id<"folders">>>([]);
  // Listing-based proof that a transfer's work landed despite a reported
  // failure, keyed by transfer id. Only checked against the folder the
  // transfer started in.
  const transferResolutions = useRef(
    new Map<
      number,
      {
        folderId: Id<"folders">;
        condition:
          | { kind: "entryGone"; entryId: Id<"entries"> }
          | { kind: "folderGone"; folderId: Id<"folders"> }
          | { kind: "entryAppeared"; name: string };
      }
    >(),
  );
  const { upload } = useUpload();
  const [folderDialog, setFolderDialog] = useState<"create" | "settings" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEntryIds, setSelectedEntryIds] = useState<
    Set<Id<"entries">>
  >(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<
    Set<Id<"folders">>
  >(new Set());
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [moveDialog, setMoveDialog] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [draggingItems, setDraggingItems] = useState(false);
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
          metadataJson: entry.metadataJson,
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
  const viewerItem = viewerIndex >= 0 ? viewerItems[viewerIndex] : undefined;
  useDocumentTitle(
    viewerItem !== undefined
      ? `${props.gallery.name} - ${viewerItem.title}`
      : listing !== undefined && folderId !== props.rootFolder._id
        ? `${props.gallery.name} - ${listing.folder.name}`
        : props.gallery.name,
  );
  const setViewerEntry = useCallback(
    (entryId: string | null, replace: boolean) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (entryId === null) next.delete("item");
          else next.set("item", entryId);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );
  const copyViewerLink = useCallback(async (item: MediaViewerItem) => {
    const url = new URL(window.location.href);
    url.searchParams.set("item", item.id);
    await copyTextToClipboard(url.toString());
  }, []);
  const changeViewerTitle = useCallback(
    async (item: MediaViewerItem, title: string) => {
      const result = await renameEntry({
        galleryId: props.gallery._id,
        entryId: item.id as Id<"entries">,
        name: title,
      });
      await completeFilesystemOperation(result);
    },
    [props.gallery._id, renameEntry],
  );
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
    if (listing !== undefined && viewerEntryId !== null && viewerIndex < 0) {
      setViewerEntry(null, true);
    }
  }, [listing, setViewerEntry, viewerEntryId, viewerIndex]);

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
    await uploadDropped(
      Array.from(files).map((file) => ({ file, pathSegments: [] })),
    );
  };

  const uploadDropped = async (dropped: DroppedFile[]) => {
    if (!listing?.access.canUpload) return;
    const folderPrivacy = listing.folder.privacy;
    const ensureFolder = async (
      parentId: Id<"folders">,
      name: string,
    ): Promise<Id<"folders">> => {
      const result = await createFolder({
        galleryId: props.gallery._id,
        parentId,
        name,
        privacy: folderPrivacy,
        existingOk: true,
      });
      if (result.kind === "complete") return result.folderId;
      const completed = await completeFilesystemOperation(result);
      if (completed?.folderId == null) {
        throw new Error("Folder could not be created");
      }
      return completed.folderId as Id<"folders">;
    };
    // Memoized as promises so concurrent uploads into the same new folder
    // share a single create call (and share its failure).
    const folderIds = new Map<string, Promise<Id<"folders">>>();
    const resolveTargetFolder = async (
      pathSegments: string[],
    ): Promise<Id<"folders">> => {
      let parentId = folderId;
      let path = "";
      for (const segment of pathSegments) {
        path = path === "" ? segment : `${path}/${segment}`;
        let pending = folderIds.get(path);
        if (pending === undefined) {
          pending = ensureFolder(parentId, segment);
          folderIds.set(path, pending);
          // Evict failures so a retried upload re-attempts the create.
          const memoizedPath = path;
          pending.catch(() => folderIds.delete(memoizedPath));
        }
        parentId = await pending;
      }
      return parentId;
    };
    const tasks = dropped.map((item) => ({
      ...item,
      transferId: beginTransfer(item.file.name, "upload"),
    }));
    // A lost success response is only provable for same-folder uploads of
    // names the listing doesn't already have.
    const existingNames = new Set(listing.entries.map((entry) => entry.name));
    for (const task of tasks) {
      if (
        task.pathSegments.length === 0 &&
        !existingNames.has(task.file.name)
      ) {
        transferResolutions.current.set(task.transferId, {
          folderId,
          condition: { kind: "entryAppeared", name: task.file.name },
        });
      }
    }
    const runTask = async (task: (typeof tasks)[number]): Promise<void> => {
      try {
        const targetFolderId = await resolveTargetFolder(task.pathSegments);
        await upload({
          file: task.file,
          galleryId: props.gallery._id,
          folderId: targetFolderId,
          onProgress: (fraction) =>
            reportTransferProgress(task.transferId, fraction),
        });
        completeTransfer(task.transferId);
      } catch (reason) {
        failTransfer(
          task.transferId,
          friendlyError(reason, "Upload failed"),
          () => void runTask(task),
        );
      }
    };
    await runWithConcurrency(tasks, uploadConcurrency, runTask);
  };

  useEffect(() => {
    const canUpload = listing?.access.canUpload === true;
    const canManage = listing?.access.canManage === true;
    const canDragMove =
      canManage && (selectMode || props.gallery.quickMove === true);
    if (!canUpload && !canManage) return;
    const onDragOver = (event: DragEvent) => {
      if (canDragMove && hasInternalDrag(event.dataTransfer)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        return;
      }
      if (!canUpload) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (hasInternalDrag(event.dataTransfer)) {
        event.preventDefault();
        draggedEntryIds.current = [];
        draggedFolderIds.current = [];
        setDraggingItems(false);
        return;
      }
      if (!canUpload) return;
      event.preventDefault();
      if (event.dataTransfer === null) return;
      // collectDroppedFiles must run synchronously while the items are live.
      void collectDroppedFiles(event.dataTransfer)
        .then((dropped) =>
          dropped.length > 0 ? uploadDropped(dropped) : undefined,
        )
        .catch((reason: unknown) => {
          setActionError(
            friendlyError(reason, "Could not read the dropped items"),
          );
        });
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
  }, [
    listing?.access.canUpload,
    listing?.access.canManage,
    props.gallery.quickMove,
    folderId,
    selectMode,
  ]);

  useEffect(() => {
    setNotice(null);
    setActionError(null);
    // Keep the whole status list intact while bulk work is still running.
    if (!getTransfers().some((item) => item.status === "active")) {
      clearFinishedTransfers();
    }
    setSelectedEntryIds(new Set());
    setSelectedFolderIds(new Set());
    setDeleteDialog(false);
    setMoveDialog(false);
  }, [folderId]);

  // A failed row can be resolved out-of-band: the storage worker retries
  // folder deletes on its own, and a success response can be lost while the
  // operation still landed. When the live listing proves the work happened,
  // flip the stale error row to success so its retry button goes away.
  useEffect(() => {
    if (listing === undefined) return;
    const evaluate = () => {
      const rows = new Map(getTransfers().map((item) => [item.id, item]));
      const listedEntryIds = new Set(listing.entries.map((entry) => entry._id));
      const listedEntryNames = new Set(
        listing.entries.map((entry) => entry.name),
      );
      const listedFolderIds = new Set(
        listing.folders.map((folder) => folder._id),
      );
      const provenIds: number[] = [];
      for (const [transferId, resolution] of transferResolutions.current) {
        const row = rows.get(transferId);
        if (row === undefined || row.status === "success") {
          transferResolutions.current.delete(transferId);
          continue;
        }
        if (row.status !== "error" || resolution.folderId !== folderId) {
          continue;
        }
        const condition = resolution.condition;
        const proven =
          condition.kind === "entryGone"
            ? !listedEntryIds.has(condition.entryId)
            : condition.kind === "folderGone"
              ? !listedFolderIds.has(condition.folderId)
              : listedEntryNames.has(condition.name);
        if (proven) {
          transferResolutions.current.delete(transferId);
          provenIds.push(transferId);
        }
      }
      for (const transferId of provenIds) {
        completeTransfer(transferId);
      }
    };
    evaluate();
    return subscribeTransfers(evaluate);
  }, [listing, folderId]);

  useEffect(() => {
    if (listing === undefined) return;
    const availableEntries = new Set(listing.entries.map((entry) => entry._id));
    setSelectedEntryIds((current) => {
      const next = new Set(
        [...current].filter((id) => availableEntries.has(id)),
      );
      return next.size === current.size ? current : next;
    });
    const availableFolders = new Set(
      listing.folders.map((folder) => folder._id),
    );
    setSelectedFolderIds((current) => {
      const next = new Set(
        [...current].filter((id) => availableFolders.has(id)),
      );
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

  const canManage = listing.access.canManage;
  // Dragging always works inside select mode; the per-gallery quick-move
  // option extends it to normal browsing.
  const canDragMove =
    canManage && (selectMode || props.gallery.quickMove === true);
  const selectedIds = [...selectedEntryIds];
  const selectedFolderIdList = [...selectedFolderIds];
  const selectedCount = selectedIds.length + selectedFolderIdList.length;
  const selectionSummary = [
    selectedFolderIdList.length > 0
      ? `${selectedFolderIdList.length} folder${selectedFolderIdList.length === 1 ? "" : "s"}`
      : null,
    selectedIds.length > 0
      ? `${selectedIds.length} file${selectedIds.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");

  const queueMove = async (
    entryIds: Array<Id<"entries">>,
    destinationGalleryId: Id<"galleries">,
    destinationFolderId: Id<"folders">,
  ) => {
    if (entryIds.length === 0) return;
    setActionPending(true);
    setActionError(null);
    const entryNames = new Map(
      listing.entries.map((entry) => [entry._id, entry.name]),
    );
    const transfers = entryIds.map((entryId) => ({
      entryId,
      transferId: beginTransfer(
        entryNames.get(entryId) ?? "File",
        "move",
        null,
      ),
    }));
    for (const transfer of transfers) {
      transferResolutions.current.set(transfer.transferId, {
        folderId,
        condition: { kind: "entryGone", entryId: transfer.entryId },
      });
    }
    const retryMove = (entryId: Id<"entries">, transferId: number) => {
      moveEntries({
        sourceGalleryId: props.gallery._id,
        destinationGalleryId,
        destinationFolderId,
        entryIds: [entryId],
      })
        .then(() => completeTransfer(transferId))
        .catch((reason: unknown) => {
          failTransfer(
            transferId,
            friendlyError(reason, "Could not move the file"),
            () => retryMove(entryId, transferId),
          );
        });
    };
    try {
      const result = await moveEntries({
        sourceGalleryId: props.gallery._id,
        destinationGalleryId,
        destinationFolderId,
        entryIds,
      });
      for (const transfer of transfers) {
        completeTransfer(transfer.transferId);
      }
      setSelectedEntryIds(new Set());
      setMoveDialog(false);
      setNotice(
        result.queued === 0
          ? "The selected files are already in that folder."
          : `${result.queued} file${result.queued === 1 ? "" : "s"} queued to move.`,
      );
    } catch (reason) {
      const message = friendlyError(
        reason,
        "Could not move the selected files",
      );
      for (const transfer of transfers) {
        failTransfer(transfer.transferId, message, () =>
          retryMove(transfer.entryId, transfer.transferId),
        );
      }
      setActionError(message);
      throw reason;
    } finally {
      setActionPending(false);
    }
  };

  const queueFolderMove = async (
    folderIds: Array<Id<"folders">>,
    destinationFolderId: Id<"folders">,
  ) => {
    if (folderIds.length === 0) return;
    setActionPending(true);
    setActionError(null);
    const folderNames = new Map(
      listing.folders.map((folder) => [folder._id, folder.name]),
    );
    const transfers = new Map(
      folderIds.map((movedFolderId) => [
        movedFolderId,
        beginTransfer(folderNames.get(movedFolderId) ?? "Folder", "move", null),
      ]),
    );
    for (const [movedFolderId, transferId] of transfers) {
      transferResolutions.current.set(transferId, {
        folderId,
        condition: { kind: "folderGone", folderId: movedFolderId },
      });
    }
    try {
      const result = await moveFolders({
        galleryId: props.gallery._id,
        destinationFolderId,
        folderIds,
      });
      const errors: string[] = [];
      if (result.kind === "filesystem") {
        // From here the directory renames are driven by this tab.
        for (const transferId of transfers.values()) {
          markTransferClientWork(transferId);
        }
        for (const operation of result.operations) {
          const transferId = transfers.get(operation.folderId);
          transfers.delete(operation.folderId);
          try {
            await completeFilesystemOperation({
              kind: "filesystem",
              operationId: operation.operationId,
              token: operation.token,
            });
            if (transferId !== undefined) {
              completeTransfer(transferId);
            }
          } catch (reason) {
            const message = friendlyError(
              reason,
              "Could not move the folder",
            );
            if (transferId !== undefined) {
              failTransfer(transferId, message, () =>
                retryFilesystemOperation(
                  transferId,
                  operation.operationId,
                  operation.token,
                ),
              );
            }
            errors.push(message);
          }
        }
      }
      for (const transferId of transfers.values()) {
        completeTransfer(transferId);
      }
      // Every transfer is settled now; a throw below must not re-fail them.
      transfers.clear();
      if (errors.length > 0) {
        setActionError(errors[0]);
        throw new Error(errors[0]);
      }
      setSelectedFolderIds(new Set());
      setMoveDialog(false);
      setNotice(
        result.moved === 0
          ? "The selected folders are already in that folder."
          : `${result.moved} folder${result.moved === 1 ? "" : "s"} moved.`,
      );
    } catch (reason) {
      const message = friendlyError(
        reason,
        "Could not move the selected folders",
      );
      for (const [movedFolderId, transferId] of transfers) {
        failTransfer(transferId, message, () =>
          retryFolderMove(movedFolderId, destinationFolderId, transferId),
        );
      }
      setActionError(message);
      throw reason;
    } finally {
      setActionPending(false);
    }
  };

  const retryFolderMove = (
    movedFolderId: Id<"folders">,
    destinationFolderId: Id<"folders">,
    transferId: number,
  ) => {
    moveFolders({
      galleryId: props.gallery._id,
      destinationFolderId,
      folderIds: [movedFolderId],
    })
      .then(async (result) => {
        if (result.kind === "filesystem") {
          markTransferClientWork(transferId);
          for (const operation of result.operations) {
            await completeFilesystemOperation({
              kind: "filesystem",
              operationId: operation.operationId,
              token: operation.token,
            });
          }
        }
        completeTransfer(transferId);
      })
      .catch((reason: unknown) => {
        failTransfer(
          transferId,
          friendlyError(reason, "Could not move the folder"),
          () => retryFolderMove(movedFolderId, destinationFolderId, transferId),
        );
      });
  };

  const retryFilesystemOperation = (
    transferId: number,
    operationId: Id<"filesystemOperations">,
    token: string,
  ) => {
    markTransferClientWork(transferId);
    completeFilesystemOperation({ kind: "filesystem", operationId, token })
      .then(() => completeTransfer(transferId))
      .catch((reason: unknown) => {
        failTransfer(
          transferId,
          friendlyError(reason, "Could not delete the folder"),
          () => retryFilesystemOperation(transferId, operationId, token),
        );
      });
  };

  const retryFolderDelete = (
    deletedFolderId: Id<"folders">,
    transferId: number,
  ) => {
    removeFolders({
      galleryId: props.gallery._id,
      folderIds: [deletedFolderId],
    })
      .then(async (result) => {
        if (result.kind === "filesystem") {
          markTransferClientWork(transferId);
          for (const operation of result.operations) {
            await completeFilesystemOperation({
              kind: "filesystem",
              operationId: operation.operationId,
              token: operation.token,
            });
          }
        }
        completeTransfer(transferId);
      })
      .catch((reason: unknown) => {
        failTransfer(
          transferId,
          friendlyError(reason, "Could not delete the folder"),
          () => retryFolderDelete(deletedFolderId, transferId),
        );
      });
  };

  const retryEntryDelete = (entryId: Id<"entries">, transferId: number) => {
    removeEntries({ galleryId: props.gallery._id, entryIds: [entryId] })
      .then(() => completeTransfer(transferId))
      .catch((reason: unknown) => {
        failTransfer(
          transferId,
          friendlyError(reason, "Could not delete the file"),
          () => retryEntryDelete(entryId, transferId),
        );
      });
  };

  const startItemDrag = (
    event: ReactDragEvent<HTMLElement>,
    entryIds: Array<Id<"entries">>,
    folderIds: Array<Id<"folders">>,
  ) => {
    draggedEntryIds.current = entryIds;
    draggedFolderIds.current = folderIds;
    event.dataTransfer.effectAllowed = "move";
    if (entryIds.length > 0) {
      event.dataTransfer.setData(ENTRY_DRAG_TYPE, JSON.stringify(entryIds));
    }
    if (folderIds.length > 0) {
      event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify(folderIds));
    }
    // Chromium cancels a drag whose source re-renders during dragstart, so
    // any state update has to wait until the drag is underway.
    window.setTimeout(() => setDraggingItems(true), 0);
  };

  const endItemDrag = () => {
    draggedEntryIds.current = [];
    draggedFolderIds.current = [];
    setDraggingItems(false);
  };

  const beginEntryDrag = (
    event: ReactDragEvent<HTMLElement>,
    entryId: Id<"entries">,
  ) => {
    const dragsSelection = selectMode && selectedEntryIds.has(entryId);
    if (selectMode && !dragsSelection) {
      window.setTimeout(() => {
        setSelectedEntryIds(new Set([entryId]));
        setSelectedFolderIds(new Set());
      }, 0);
    }
    startItemDrag(
      event,
      dragsSelection ? selectedIds : [entryId],
      dragsSelection ? selectedFolderIdList : [],
    );
  };

  const beginFolderDrag = (
    event: ReactDragEvent<HTMLElement>,
    dragFolderId: Id<"folders">,
  ) => {
    const dragsSelection = selectMode && selectedFolderIds.has(dragFolderId);
    if (selectMode && !dragsSelection) {
      window.setTimeout(() => {
        setSelectedEntryIds(new Set());
        setSelectedFolderIds(new Set([dragFolderId]));
      }, 0);
    }
    startItemDrag(
      event,
      dragsSelection ? selectedIds : [],
      dragsSelection ? selectedFolderIdList : [dragFolderId],
    );
  };

  const dropDraggedItems = (
    event: ReactDragEvent<HTMLElement>,
    destinationGalleryId: Id<"galleries">,
    destinationFolderId: Id<"folders">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const entryIds = readDraggedIds<Id<"entries">>(
      event.dataTransfer.getData(ENTRY_DRAG_TYPE),
      draggedEntryIds.current,
    );
    const folderIds = readDraggedIds<Id<"folders">>(
      event.dataTransfer.getData(FOLDER_DRAG_TYPE),
      draggedFolderIds.current,
    );
    endItemDrag();
    if (folderIds.includes(destinationFolderId)) return;
    if (entryIds.length > 0) {
      void queueMove(
        entryIds,
        destinationGalleryId,
        destinationFolderId,
      ).catch(() => undefined);
    }
    if (folderIds.length > 0) {
      void queueFolderMove(folderIds, destinationFolderId).catch(
        () => undefined,
      );
    }
  };

  const dragOverFolderTarget = (
    event: ReactDragEvent<HTMLElement>,
    targetFolderId: Id<"folders">,
  ) => {
    if (
      !hasInternalDrag(event.dataTransfer) ||
      draggedFolderIds.current.includes(targetFolderId)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const breadcrumbs = listing.breadcrumbs.map((crumb, index) => (
    <span
      className={draggingItems ? styles.breadcrumbDropTarget : undefined}
      key={crumb._id}
      onDragOver={
        canDragMove
          ? (event) => dragOverFolderTarget(event, crumb._id)
          : undefined
      }
      onDrop={
        canDragMove
          ? (event) =>
              dropDraggedItems(event, props.gallery._id, crumb._id)
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
                  setSelectedFolderIds(new Set());
                  setDeleteDialog(false);
                  setMoveDialog(false);
                }}
                aria-label={selectMode ? "Exit select mode" : "Enter select mode"}
                aria-pressed={selectMode}
                title={selectMode ? "Exit select mode" : "Select items"}
              >
                <SelectListIcon />
              </button>
              {selectMode && selectedCount > 0 ? (
                <>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setDeleteDialog(true)}
                    aria-label={`Delete ${selectionSummary}`}
                    title="Delete selected"
                  >
                    <TrashIcon />
                  </button>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setMoveDialog(true)}
                    aria-label={`Move ${selectionSummary}`}
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
      {(actionError || notice) && (
        <div
          className={`${actionError ? layout.errorNotice : layout.notice} ${layout.noticeBar}`}
        >
          <span>{actionError ?? notice}</span>
          <button
            className={layout.iconButton}
            type="button"
            onClick={() => {
              setActionError(null);
              setNotice(null);
            }}
            aria-label="Dismiss message"
            title="Dismiss"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}
      {selectMode ? (
        <p className={styles.selectionHint}>
          {selectedCount === 0
            ? "Select files or folders, then delete, move, or drag them onto a folder."
            : `${selectionSummary} selected`}
        </p>
      ) : null}
      <div className={styles.grid}>
        {listing.folders.map((folder) => (
          <GalleryFolderCard
            key={folder._id}
            folder={folder}
            preview={folderPreviews.get(folder._id)}
            selectMode={selectMode}
            selected={selectedFolderIds.has(folder._id)}
            dropTarget={
              draggingItems && !draggedFolderIds.current.includes(folder._id)
            }
            draggable={canDragMove}
            onToggle={() => {
              setSelectedFolderIds((current) => {
                const next = new Set(current);
                if (next.has(folder._id)) next.delete(folder._id);
                else next.add(folder._id);
                return next;
              });
            }}
            onDragStart={
              canDragMove
                ? (event) => beginFolderDrag(event, folder._id)
                : undefined
            }
            onDragEnd={canDragMove ? endItemDrag : undefined}
            onDragOver={
              canDragMove
                ? (event) => dragOverFolderTarget(event, folder._id)
                : undefined
            }
            onDrop={
              canDragMove
                ? (event) =>
                    dropDraggedItems(
                      event,
                      props.gallery._id,
                      folder._id,
                    )
                : undefined
            }
          />
        ))}
        {listing.entries.map((entry) => (
          <GalleryEntryCard
            key={entry._id}
            entry={entry}
            selectMode={selectMode}
            selected={selectedEntryIds.has(entry._id)}
            draggable={canDragMove}
            onOpen={() => setViewerEntry(entry._id, false)}
            onMetadata={() => setMetadataEntryId(entry._id)}
            onToggle={() => {
              setSelectedEntryIds((current) => {
                const next = new Set(current);
                if (next.has(entry._id)) next.delete(entry._id);
                else next.add(entry._id);
                return next;
              });
            }}
            onDragStart={(event) => beginEntryDrag(event, entry._id)}
            onDragEnd={endItemDrag}
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
          themeMode={props.gallery.theme.mode ?? "light"}
          onActiveItemChange={(item) => setViewerEntry(item.id, true)}
          onCopyLink={copyViewerLink}
          onTitleChange={
            listing.access.canEditFolder ? changeViewerTitle : undefined
          }
          resolveSource={resolveViewerSource}
          onClose={() => setViewerEntry(null, true)}
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
            await completeFilesystemOperation(result);
            setFolderDialog(null);
            setNotice("Folder created");
          }}
        />
      ) : null}
      {folderDialog === "settings" ? (
        <FolderForm
          title="Folder settings"
          headerExtra={
            listing.access.canAdminGallery ? (
              <Link
                className={layout.dialogHeaderLink}
                to={`/admin?gallery=${props.gallery._id}`}
                title="Open gallery admin settings"
              >
                Gallery admin <ExternalLink aria-hidden="true" size={14} />
              </Link>
            ) : undefined
          }
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
            await completeFilesystemOperation(result);
            setFolderDialog(null);
            setNotice("Folder updated");
          }}
        />
      ) : null}
      {deleteDialog ? (
        <Dialog
          title="Delete selected items?"
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
              const deleteSelection = async () => {
                const errors: string[] = [];
                if (selectedFolderIdList.length > 0) {
                  const folderNames = new Map(
                    listing.folders.map((folder) => [
                      folder._id,
                      folder.name,
                    ]),
                  );
                  const folderTransfers = new Map(
                    selectedFolderIdList.map((deletedFolderId) => [
                      deletedFolderId,
                      beginTransfer(
                        folderNames.get(deletedFolderId) ?? "Folder",
                        "delete",
                        null,
                      ),
                    ]),
                  );
                  for (const [
                    deletedFolderId,
                    transferId,
                  ] of folderTransfers) {
                    transferResolutions.current.set(transferId, {
                      folderId,
                      condition: {
                        kind: "folderGone",
                        folderId: deletedFolderId,
                      },
                    });
                  }
                  try {
                    const result = await removeFolders({
                      galleryId: props.gallery._id,
                      folderIds: selectedFolderIdList,
                    });
                    if (result.kind === "filesystem") {
                      // From here the rmdirs are driven by this tab.
                      for (const transferId of folderTransfers.values()) {
                        markTransferClientWork(transferId);
                      }
                      for (const operation of result.operations) {
                        const transferId = folderTransfers.get(
                          operation.folderId,
                        );
                        folderTransfers.delete(operation.folderId);
                        try {
                          await completeFilesystemOperation({
                            kind: "filesystem",
                            operationId: operation.operationId,
                            token: operation.token,
                          });
                          if (transferId !== undefined) {
                            completeTransfer(transferId);
                          }
                        } catch (reason) {
                          const message = friendlyError(
                            reason,
                            "Could not delete the folder",
                          );
                          if (transferId !== undefined) {
                            failTransfer(transferId, message, () =>
                              retryFilesystemOperation(
                                transferId,
                                operation.operationId,
                                operation.token,
                              ),
                            );
                          }
                          errors.push(message);
                        }
                      }
                    }
                    for (const transferId of folderTransfers.values()) {
                      completeTransfer(transferId);
                    }
                  } catch (reason) {
                    const message = friendlyError(
                      reason,
                      "Could not delete the selected folders",
                    );
                    for (const [
                      deletedFolderId,
                      transferId,
                    ] of folderTransfers) {
                      failTransfer(transferId, message, () =>
                        retryFolderDelete(deletedFolderId, transferId),
                      );
                    }
                    errors.push(message);
                  }
                }
                if (selectedIds.length > 0) {
                  const entryNames = new Map(
                    listing.entries.map((entry) => [entry._id, entry.name]),
                  );
                  const entryTransfers = selectedIds.map((entryId) => ({
                    entryId,
                    transferId: beginTransfer(
                      entryNames.get(entryId) ?? "File",
                      "delete",
                      null,
                    ),
                  }));
                  for (const transfer of entryTransfers) {
                    transferResolutions.current.set(transfer.transferId, {
                      folderId,
                      condition: {
                        kind: "entryGone",
                        entryId: transfer.entryId,
                      },
                    });
                  }
                  try {
                    await removeEntries({
                      galleryId: props.gallery._id,
                      entryIds: selectedIds,
                    });
                    for (const transfer of entryTransfers) {
                      completeTransfer(transfer.transferId);
                    }
                  } catch (reason) {
                    const message = friendlyError(
                      reason,
                      "Could not delete the selected files",
                    );
                    for (const transfer of entryTransfers) {
                      failTransfer(transfer.transferId, message, () =>
                        retryEntryDelete(transfer.entryId, transfer.transferId),
                      );
                    }
                    errors.push(message);
                  }
                }
                if (errors.length > 0) {
                  setActionError(errors[0]);
                } else {
                  setSelectedEntryIds(new Set());
                  setSelectedFolderIds(new Set());
                  setDeleteDialog(false);
                }
              };
              void deleteSelection().finally(() => setActionPending(false));
            }}
          >
            <p className={styles.deletePrompt}>
              Delete {selectionSummary}?{" "}
              {selectedFolderIdList.length > 0
                ? "Folders are deleted along with everything inside them. "
                : ""}
              This cannot be undone.
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
          selectedEntryCount={selectedIds.length}
          selectedFolderIds={selectedFolderIdList}
          selectionSummary={selectionSummary}
          pending={actionPending}
          onClose={() => {
            if (!actionPending) setMoveDialog(false);
          }}
          onMove={async (destinationGalleryId, destinationFolderId) => {
            if (selectedIds.length > 0) {
              await queueMove(
                selectedIds,
                destinationGalleryId,
                destinationFolderId,
              );
            }
            if (selectedFolderIdList.length > 0) {
              await queueFolderMove(
                selectedFolderIdList,
                destinationFolderId,
              );
            }
          }}
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

function GalleryFolderCard(props: {
  folder: Doc<"folders">;
  preview?: FolderPreviewData;
  selectMode: boolean;
  selected: boolean;
  dropTarget: boolean;
  draggable: boolean;
  onToggle: () => void;
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
}) {
  const content = (
    <>
      <FolderPreview preview={props.preview} />
      <span className={styles.folderName}>{props.folder.name}</span>
      {props.folder.privacy !== "public" ? (
        <small>{props.folder.privacy}</small>
      ) : null}
    </>
  );
  const dropTargetClass = props.dropTarget ? styles.folderDropTarget : "";
  if (!props.selectMode) {
    return (
      <Link
        className={`${styles.folderCard} ${dropTargetClass}`}
        to={`?folder=${props.folder._id}`}
        draggable={props.draggable}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
      >
        {content}
      </Link>
    );
  }
  return (
    <button
      className={`${styles.folderCard} ${styles.folderCardSelectable} ${props.selected ? styles.selectedCard : ""} ${dropTargetClass}`}
      type="button"
      onClick={props.onToggle}
      aria-label={`${props.selected ? "Deselect" : "Select"} folder ${props.folder.name}`}
      aria-pressed={props.selected}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      {content}
      <span
        className={`${styles.selectCircle} ${props.selected ? styles.selectCircleChecked : ""}`}
        aria-hidden="true"
      >
        {props.selected ? (
          <Check aria-hidden="true" size={14} strokeWidth={3} />
        ) : null}
      </span>
    </button>
  );
}

function GalleryEntryCard(props: {
  entry: Doc<"entries">;
  selectMode: boolean;
  selected: boolean;
  draggable: boolean;
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
      draggable={props.draggable}
      onDragStart={props.draggable ? props.onDragStart : undefined}
      onDragEnd={props.draggable ? props.onDragEnd : undefined}
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
  const ownedGalleries = useQuery(api.galleries.listOwnedImageGalleries);
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

  return (
    <Dialog title={`Move ${props.selectionSummary}`} onClose={props.onClose}>
      <form
        className={layout.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (galleryId === null || folderId === null) return;
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

async function completeFilesystemOperation(result: {
  kind: "complete" | "filesystem";
  operationId?: Id<"filesystemOperations">;
  token?: string;
}): Promise<{ folderId: string | null } | null> {
  if (result.kind === "complete") return null;
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
        : "Filesystem operation failed";
    throw new Error(message);
  }
  return {
    folderId:
      typeof body === "object" &&
      body !== null &&
      "folderId" in body &&
      typeof body.folderId === "string"
        ? body.folderId
        : null,
  };
}

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browsers that expose the API but deny it here.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is not available");
}

function FolderForm(props: {
  title: string;
  headerExtra?: ReactNode;
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
    <Dialog title={props.title} headerExtra={props.headerExtra} onClose={props.onClose}>
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
