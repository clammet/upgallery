import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
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
  FilesystemScanControl,
  type FilesystemSyncInfo,
} from "../components/FilesystemScanControl";
import { MediaThumbnail } from "../components/MediaThumbnail";
import {
  isEditableTarget,
  MediaViewer,
  shouldOpenMediaViewer,
  type MediaViewerItem,
  type MediaViewerLinkKind,
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
  conflictTransfer,
  createWorkQueue,
  discardTransfers,
  failTransfer,
  getTransfers,
  markTransferClientWork,
  parseTransferConcurrency,
  queueTransfer,
  registerConflictBatch,
  renameTransfer,
  reportTransferProgress,
  startTransfer,
  subscribeTransfers,
  type ConflictChoice,
  type ConflictPolicy,
} from "../lib/transfers";
import { useUploader } from "../hooks/useUpload";
import { useStableCallback } from "../hooks/useStableCallback";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { friendlyError, isEntryExistsError } from "../lib/errors";
import { anonymousClaim } from "../lib/authClient";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  galleryFolderHref,
  galleryFolderLocation,
  galleryFolderPathSegments,
} from "../lib/galleryRoutes";
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

// "Page 2/5 · 101-200 (100 per page)". The total is omitted until the count
// arrives and shown as a lower bound ("5+") when the folder was too large to
// count exactly.
function paginationLabel(input: {
  page: number;
  pageSize: number;
  shown: number;
  total: { count: number; exact: boolean } | undefined;
}): string {
  const first = (input.page - 1) * input.pageSize + 1;
  const last = first + input.shown - 1;
  let pages = "";
  if (input.total !== undefined) {
    // The count can lag a page fetch, so never show a page past the total.
    const totalPages = Math.max(
      input.page,
      Math.ceil(input.total.count / input.pageSize),
    );
    pages = `/${totalPages.toLocaleString()}${input.total.exact ? "" : "+"}`;
  }
  return (
    `Page ${input.page.toLocaleString()}${pages} · ` +
    `${first.toLocaleString()}-${last.toLocaleString()} ` +
    `(${input.pageSize.toLocaleString()} per page)`
  );
}

type FolderPreviewMode =
  | "first"
  | "random"
  | "first3"
  | "random3"
  | "custom";
type FolderAccessPolicy = Doc<"folders">["accessPolicy"];
type FolderDiscoverability = Doc<"folders">["discoverability"];

type FolderPreviewData = {
  folderId: Id<"folders">;
  mode: FolderPreviewMode;
  customUrl?: string;
  entries: Array<{
    _id: Id<"entries">;
    name: string;
    thumbnailKey?: string;
    thumbnailState?: "pending" | "failed";
  }>;
};

type GalleryEntry = Doc<"entries"> & {
  passwordProtected: boolean;
  canDelete: boolean;
  views: number;
  uploader: string;
};

type EntrySelection =
  | { kind: "ids"; entryIds: Array<Id<"entries">> }
  | { kind: "folder"; excludedEntryIds: Array<Id<"entries">> };

export function GalleryPage(props: {
  gallery: Doc<"galleries">;
  rootFolder: Doc<"folders">;
  routeRoot: string;
  canonicalOrigin?: string;
  canonicalRouteRoot?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedFolder = searchParams.get("folder");
  const viewerEntryId = searchParams.get("item");
  const requestedPath = galleryFolderPathSegments(
    location.pathname,
    props.routeRoot,
  );
  const pathFolderId = useQuery(
    api.folders.resolvePath,
    requestedFolder === null && (requestedPath?.length ?? 0) > 0
      ? {
          anonymousClaim: anonymousClaim(),
          galleryId: props.gallery._id,
          names: requestedPath!,
        }
      : "skip",
  );
  const resolvingPath =
    requestedFolder === null &&
    (requestedPath?.length ?? 0) > 0 &&
    pathFolderId === undefined;
  const invalidPath = requestedPath === null || pathFolderId === null;
  const folderId = (
    requestedFolder ?? pathFolderId ?? props.rootFolder._id
  ) as Id<"folders">;
  const [previewSeed] = useState(() => {
    const values = crypto.getRandomValues(new Uint32Array(1));
    return values[0];
  });
  const listing = useQuery(
    api.folders.list,
    resolvingPath || invalidPath
      ? "skip"
      : {
          anonymousClaim: anonymousClaim(),
          galleryId: props.gallery._id,
          folderId,
          previewSeed,
          includeEntries: false,
        },
  );
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
  });
  const pageSize = props.gallery.paginationPageSize ?? 100;
  // The gallery setting is a ceiling; a user who prefers paging gets paging
  // even where the gallery allows infinite scroll.
  const infiniteScroll =
    props.gallery.infiniteScroll !== false && profile?.infiniteScroll !== false;
  const [paginationCursor, setPaginationCursor] = useState<string | null>(null);
  const [paginationHistory, setPaginationHistory] = useState<
    Array<string | null>
  >([]);
  const entryPageArgs = {
    anonymousClaim: anonymousClaim(),
    galleryId: props.gallery._id,
    folderId,
  };
  const entryPages = usePaginatedQuery(
    api.entries.listGalleryPage,
    infiniteScroll && !resolvingPath && !invalidPath ? entryPageArgs : "skip",
    { initialNumItems: pageSize },
  );
  const pagedEntries = useQuery(
    api.entries.listGalleryPage,
    !resolvingPath && !invalidPath && !infiniteScroll
      ? {
          ...entryPageArgs,
          paginationOpts: {
            numItems: pageSize,
            cursor: paginationCursor,
          },
        }
      : "skip",
  );
  // Only the paged layout shows a page total; infinite scroll never needs it.
  const folderEntryCount = useQuery(
    api.entries.countFolderEntries,
    infiniteScroll || resolvingPath || invalidPath ? "skip" : entryPageArgs,
  );
  const entries = (infiniteScroll
    ? entryPages.results
    : (pagedEntries?.page ?? [])) as GalleryEntry[];
  const createFolder = useMutation(api.folders.create);
  const updateFolder = useMutation(api.folders.update);
  const removeFolders = useMutation(api.folders.removeMany);
  const moveFolders = useMutation(api.folders.moveMany);
  const startBulkDelete = useMutation(api.bulkOperations.startDelete);
  const startBulkMove = useMutation(api.bulkOperations.startMove);
  const requestPreview = useMutation(api.entries.requestPreview);
  const removeLocationData = useMutation(api.entries.removeLocationData);
  const refreshMetadata = useMutation(api.entries.refreshMetadata);
  const renameEntry = useMutation(api.entries.rename);
  const fileInput = useRef<HTMLInputElement>(null);
  const draggedEntryIds = useRef<Array<Id<"entries">>>([]);
  const draggedFolderIds = useRef<Array<Id<"folders">>>([]);
  const draggedEntrySelection = useRef<EntrySelection | null>(null);
  const draggedEntryCount = useRef(0);
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
  const upload = useUploader();
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
  const [allEntriesSelected, setAllEntriesSelected] = useState(false);
  const [excludedEntryIds, setExcludedEntryIds] = useState<
    Set<Id<"entries">>
  >(new Set());
  const selectableEntries = usePaginatedQuery(
    api.entries.listSelectableIds,
    allEntriesSelected && !resolvingPath && !invalidPath
      ? {
          anonymousClaim: anonymousClaim(),
          galleryId: props.gallery._id,
          folderId,
        }
      : "skip",
    { initialNumItems: 250 },
  );
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [moveDialog, setMoveDialog] = useState(false);
  // Set when the delete/move dialog was opened from the viewer: the dialog
  // then acts on this one entry instead of the select-mode selection.
  const [viewerActionEntryId, setViewerActionEntryId] =
    useState<Id<"entries"> | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [draggingItems, setDraggingItems] = useState(false);
  const [dragOverFolderId, setDragOverFolderId] =
    useState<Id<"folders"> | null>(null);
  const [metadataEntryId, setMetadataEntryId] =
    useState<Id<"entries"> | null>(null);
  // The entry the viewer is stepping away from after a delete or move, until
  // that navigation lands. While it is pending the "viewed entry disappeared"
  // effect below must not close the viewer.
  const viewerStepFrom = useRef<string | null>(null);
  const pageSentinel = useRef<HTMLDivElement>(null);

  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      entries.map((entry) => {
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
          downloadUrl: sourceUrl,
          mediaKind: entry.mediaKind,
          mimeType: entry.mimeType,
          previewReady:
            !heif || nativeHeifPreview || entry.previewKey !== undefined,
          previewError: nativeHeifPreview ? undefined : entry.previewError,
          metadataJson: entry.metadataJson,
          uploader: entry.uploader,
        };
      }),
    [entries],
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
  const friendlyFolderUrls = props.gallery.friendlyFolderUrls === true;
  const canonicalOrigin = props.canonicalOrigin ?? window.location.origin;
  const canonicalRouteRoot = props.canonicalRouteRoot ?? props.routeRoot;
  const canonicalGalleryRoot =
    canonicalOrigin === window.location.origin
      ? canonicalRouteRoot
      : new URL(canonicalRouteRoot, canonicalOrigin).toString();
  const canonicalFolderHref = (
    targetFolderId: Id<"folders"> | null,
    targetFolderNames: string[],
  ) => {
    const href = galleryFolderHref({
      routeRoot: canonicalRouteRoot,
      folderId: targetFolderId,
      folderNames: targetFolderNames,
      friendlyFolderUrls,
    });
    return canonicalOrigin === window.location.origin
      ? href
      : new URL(href, canonicalOrigin).toString();
  };
  const folderNames = useMemo(
    () => listing?.breadcrumbs.slice(1).map((crumb) => crumb.name) ?? [],
    [listing?.breadcrumbs],
  );
  const currentFolderLocation =
    listing === undefined
      ? null
      : galleryFolderLocation({
          routeRoot: canonicalRouteRoot,
          folderId:
            folderId === props.rootFolder._id ? null : folderId,
          folderNames,
          friendlyFolderUrls,
          currentSearch: location.search,
        });

  useEffect(() => {
    if (currentFolderLocation === null) return;
    const destination = new URL(
      `${currentFolderLocation.pathname}${currentFolderLocation.search}`,
      canonicalOrigin,
    );
    destination.hash = location.hash;
    if (destination.href === window.location.href) return;
    if (destination.origin !== window.location.origin) {
      window.location.replace(destination.href);
      return;
    }
    void navigate(
      { ...currentFolderLocation, hash: location.hash },
      { replace: true },
    );
  }, [
    canonicalOrigin,
    currentFolderLocation,
    location.hash,
    location.pathname,
    location.search,
    navigate,
  ]);

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
  const copyViewerLink = useCallback(
    async (item: MediaViewerItem, kind: MediaViewerLinkKind) => {
      const folderLocation = galleryFolderLocation({
        routeRoot: canonicalRouteRoot,
        folderId: folderId === props.rootFolder._id ? null : folderId,
        folderNames,
        friendlyFolderUrls,
        currentSearch: location.search,
      });
      const url = new URL(
        kind === "direct"
          ? item.href
          : `${folderLocation.pathname}${folderLocation.search}`,
        canonicalOrigin,
      );
      if (kind === "lightbox") url.searchParams.set("item", item.id);
      await copyTextToClipboard(url.toString());
    },
    [
      folderId,
      folderNames,
      friendlyFolderUrls,
      canonicalOrigin,
      canonicalRouteRoot,
      location.search,
      props.rootFolder._id,
    ],
  );
  const changeViewerTitle = useCallback(
    async (item: MediaViewerItem, title: string) => {
      const result = await renameEntry({
        anonymousClaim: anonymousClaim(),
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
      : entries.find((entry) => entry._id === metadataEntryId);

  useEffect(() => {
    if (viewerEntryId !== viewerStepFrom.current) viewerStepFrom.current = null;
    if (
      listing !== undefined &&
      viewerEntryId !== null &&
      viewerIndex < 0 &&
      viewerStepFrom.current === null
    ) {
      setViewerEntry(null, true);
    }
  }, [listing, setViewerEntry, viewerEntryId, viewerIndex]);

  // A dialog opened from the viewer loses its target if that entry vanishes
  // (deleted elsewhere, or just deleted here); drop it rather than fall back
  // to the select-mode selection.
  useEffect(() => {
    if (
      viewerActionEntryId !== null &&
      listing !== undefined &&
      !entries.some((entry) => entry._id === viewerActionEntryId)
    ) {
      setDeleteDialog(false);
      setMoveDialog(false);
      setViewerActionEntryId(null);
    }
  }, [entries, listing, viewerActionEntryId]);

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
    const ensureFolder = async (
      parentId: Id<"folders">,
      name: string,
    ): Promise<Id<"folders">> => {
      const result = await createFolder({
        anonymousClaim: anonymousClaim(),
        galleryId: props.gallery._id,
        parentId,
        name,
        accessPolicy: "inherit",
        discoverability: "listed",
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
      transferId: queueTransfer(item.file.name, "upload"),
    }));
    // A lost success response is only provable for same-folder uploads of
    // names the listing doesn't already have.
    const existingNames = new Set(
      entries.map((entry) => entry.name.toLowerCase()),
    );
    for (const task of tasks) {
      if (
        task.pathSegments.length === 0 &&
        !existingNames.has(task.file.name.toLowerCase())
      ) {
        transferResolutions.current.set(task.transferId, {
          folderId,
          condition: { kind: "entryAppeared", name: task.file.name },
        });
      }
    }
    // One conflict choice per drop. "Replace all" / "Auto rename all" /
    // "Skip" sets it for the files not started yet; a parked file re-runs
    // through the same queue once the user picks for it.
    let batchChoice: ConflictChoice | undefined;
    const queue = createWorkQueue(uploadConcurrency);
    const runTask = async (
      task: (typeof tasks)[number],
      policy: ConflictPolicy | undefined,
    ): Promise<void> => {
      try {
        startTransfer(task.transferId);
        const targetFolderId = await resolveTargetFolder(task.pathSegments);
        const result = await upload({
          file: task.file,
          galleryId: props.gallery._id,
          folderId: targetFolderId,
          conflict:
            policy ?? (batchChoice === "skip" ? undefined : batchChoice),
          onProgress: (fraction) =>
            reportTransferProgress(task.transferId, fraction),
        });
        renameTransfer(task.transferId, result.name);
        completeTransfer(task.transferId);
      } catch (reason) {
        if (isEntryExistsError(reason)) {
          if (policy === undefined && batchChoice === "skip") {
            discardTransfers([task.transferId]);
            return;
          }
          conflictTransfer(task.transferId, (chosen) =>
            queue.push(() => runTask(task, chosen)),
          );
          return;
        }
        failTransfer(
          task.transferId,
          friendlyError(reason, "Upload failed"),
          () => void runTask(task, policy),
        );
      }
    };
    const unregister = registerConflictBatch((choice) => {
      batchChoice = choice;
    });
    for (const task of tasks) {
      queue.push(() => runTask(task, undefined));
    }
    await queue.drain();
    unregister();
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
        draggedEntrySelection.current = null;
        draggedEntryCount.current = 0;
        setDraggingItems(false);
        setDragOverFolderId(null);
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
    setAllEntriesSelected(false);
    setExcludedEntryIds(new Set());
    setDeleteDialog(false);
    setMoveDialog(false);
    setViewerActionEntryId(null);
  }, [folderId]);

  useEffect(() => {
    setPaginationCursor(null);
    setPaginationHistory([]);
  }, [folderId, infiniteScroll, pageSize]);

  useEffect(() => {
    if (!allEntriesSelected || selectableEntries.status !== "CanLoadMore") {
      return;
    }
    selectableEntries.loadMore(250);
  }, [
    allEntriesSelected,
    selectableEntries.loadMore,
    selectableEntries.status,
  ]);

  useEffect(() => {
    if (
      !infiniteScroll ||
      entryPages.status !== "CanLoadMore" ||
      pageSentinel.current === null
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observations) => {
        if (observations.some((observation) => observation.isIntersecting)) {
          entryPages.loadMore(pageSize);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(pageSentinel.current);
    return () => observer.disconnect();
  }, [
    entryPages.loadMore,
    entryPages.status,
    infiniteScroll,
    pageSize,
  ]);

  // Cmd/Ctrl+A selects every selectable file in the folder, not merely the
  // pages whose thumbnails happen to be loaded.
  useEffect(() => {
    if (!selectMode || listing === undefined) return;
    const dialogOpen =
      deleteDialog || moveDialog || folderDialog !== null || viewerIndex >= 0;
    if (dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "a" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      setAllEntriesSelected(true);
      setExcludedEntryIds(new Set());
      setSelectedEntryIds(new Set());
      setSelectedFolderIds(
        new Set(listing.folders.map((folder) => folder._id)),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    deleteDialog,
    folderDialog,
    listing,
    moveDialog,
    selectMode,
    viewerIndex,
  ]);

  // A failed row can be resolved out-of-band: the storage worker retries
  // folder deletes on its own, and a success response can be lost while the
  // operation still landed. When the live listing proves the work happened,
  // flip the stale error row to success so its retry button goes away.
  useEffect(() => {
    if (listing === undefined) return;
    const evaluate = () => {
      const rows = new Map(getTransfers().map((item) => [item.id, item]));
      const listedEntryIds = new Set(entries.map((entry) => entry._id));
      const listedEntryNames = new Set(
        entries.map((entry) => entry.name),
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
  }, [entries, listing, folderId]);

  useEffect(() => {
    if (listing === undefined) return;
    const availableEntries = new Set(entries.map((entry) => entry._id));
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
  }, [entries, listing]);

  useEffect(() => {
    if (listing === undefined || !listing.access.canEditFolder) return;
    for (const entry of entries) {
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
  }, [entries, listing, props.gallery._id, refreshMetadata]);

  // Stable handlers for the memoized entry cards, so a listing update only
  // re-renders the cards whose entry changed. Declared before the loading
  // return below so the hook order is the same on every render; the drag
  // helpers they call are defined further down and only run after render.
  const openEntry = useStableCallback((entryId: Id<"entries">) =>
    setViewerEntry(entryId, false),
  );
  const openEntryMetadata = useStableCallback((entryId: Id<"entries">) =>
    setMetadataEntryId(entryId),
  );
  const toggleEntrySelection = useStableCallback((entryId: Id<"entries">) => {
    if (allEntriesSelected) {
      setExcludedEntryIds((current) => {
        const next = new Set(current);
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
      });
      return;
    }
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  });
  const cardDragStart = useStableCallback(
    (event: ReactDragEvent<HTMLElement>, entryId: Id<"entries">) =>
      beginEntryDrag(event, entryId),
  );
  const cardDragEnd = useStableCallback(() => endItemDrag());

  if (invalidPath) {
    return (
      <PageFrame gallery={props.gallery} galleryRoot={canonicalGalleryRoot}>
        <h1>Folder not found</h1>
        <p>This folder path does not exist or is not accessible.</p>
      </PageFrame>
    );
  }
  if (listing === undefined || profile === undefined || resolvingPath) {
    return (
      <PageFrame gallery={props.gallery} galleryRoot={canonicalGalleryRoot}>
        <p>Loading…</p>
      </PageFrame>
    );
  }

  const canManage = listing.access.canManage;
  // Dragging always works inside select mode; the per-gallery quick-move
  // option extends it to normal browsing.
  const canDragMove =
    canManage && (selectMode || props.gallery.quickMove === true);
  const selectedIds = [...selectedEntryIds];
  const selectedFolderIdList = [...selectedFolderIds];
  const selectedAllEntryCount =
    allEntriesSelected && selectableEntries.status === "Exhausted"
      ? (selectableEntries.results as Array<Id<"entries">>).filter(
          (entryId) => !excludedEntryIds.has(entryId),
        ).length
      : null;
  const selectedEntryCount = allEntriesSelected
    ? selectedAllEntryCount
    : selectedIds.length;
  const selectedCount =
    selectedEntryCount === null
      ? null
      : selectedEntryCount + selectedFolderIdList.length;
  const hasEntrySelection = allEntriesSelected || selectedIds.length > 0;
  const hasSelection = hasEntrySelection || selectedFolderIdList.length > 0;
  const selectionSummary = [
    selectedFolderIdList.length > 0
      ? `${selectedFolderIdList.length} folder${selectedFolderIdList.length === 1 ? "" : "s"}`
      : null,
    selectedEntryCount === null && allEntriesSelected
      ? "all files (counting…)"
      : (selectedEntryCount ?? 0) > 0
        ? `${selectedEntryCount} file${selectedEntryCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
  // What the delete/move dialogs act on: the single viewer entry when they
  // were opened from the viewer, otherwise the select-mode selection.
  const viewerActionEntry =
    viewerActionEntryId === null
      ? undefined
      : entries.find((entry) => entry._id === viewerActionEntryId);
  const actionEntrySelection: EntrySelection | null =
    viewerActionEntry !== undefined
      ? { kind: "ids", entryIds: [viewerActionEntry._id] }
      : allEntriesSelected
        ? {
            kind: "folder",
            excludedEntryIds: [...excludedEntryIds],
          }
        : selectedIds.length > 0
          ? { kind: "ids", entryIds: selectedIds }
          : null;
  const actionEntryCount =
    viewerActionEntry !== undefined ? 1 : selectedEntryCount;
  const actionFolderIds =
    viewerActionEntry !== undefined ? [] : selectedFolderIdList;
  const actionSummary =
    viewerActionEntry !== undefined ? viewerActionEntry.name : selectionSummary;
  const closeActionDialogs = () => {
    setDeleteDialog(false);
    setMoveDialog(false);
    setViewerActionEntryId(null);
  };
  // Once the viewed entry is deleted or moved away, step the viewer to its
  // neighbour instead of letting it close when the entry disappears.
  const stepViewerPast = (entryIds: Array<Id<"entries">>) => {
    if (viewerEntryId === null) return;
    const removed = new Set<string>(entryIds);
    if (!removed.has(viewerEntryId)) return;
    const current = entries.findIndex(
      (entry) => entry._id === viewerEntryId,
    );
    const after = entries
      .slice(current + 1)
      .find((entry) => !removed.has(entry._id));
    const before = entries
      .slice(0, Math.max(current, 0))
      .reverse()
      .find((entry) => !removed.has(entry._id));
    const next = after ?? before;
    viewerStepFrom.current = viewerEntryId;
    setViewerEntry(next?._id ?? null, true);
  };

  const queueMove = async (
    selection: EntrySelection,
    entryCount: number,
    destinationGalleryId: Id<"galleries">,
    destinationFolderId: Id<"folders">,
  ) => {
    if (entryCount === 0) return;
    setActionPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await startBulkMove({
        anonymousClaim: anonymousClaim(),
        sourceGalleryId: props.gallery._id,
        sourceFolderId: folderId,
        destinationGalleryId,
        destinationFolderId,
        selection,
      });
      if (selection.kind === "ids") stepViewerPast(selection.entryIds);
      setSelectedEntryIds(new Set());
      setAllEntriesSelected(false);
      setExcludedEntryIds(new Set());
      closeActionDialogs();
    } catch (reason) {
      const message = friendlyError(
        reason,
        "Could not move the selected files",
      );
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
    setNotice(null);
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
        anonymousClaim: anonymousClaim(),
        galleryId: props.gallery._id,
        destinationFolderId,
        folderIds,
      });
      if (result.moved === 0) {
        const transferIds = [...transfers.values()];
        for (const transferId of transferIds) {
          transferResolutions.current.delete(transferId);
        }
        discardTransfers(transferIds);
        transfers.clear();
        setSelectedFolderIds(new Set());
        closeActionDialogs();
        setNotice("The selected folders are already in that folder.");
        return;
      }
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
      closeActionDialogs();
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
      anonymousClaim: anonymousClaim(),
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
      anonymousClaim: anonymousClaim(),
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
    draggedEntrySelection.current = null;
    draggedEntryCount.current = 0;
    setDraggingItems(false);
    setDragOverFolderId(null);
  };

  const beginEntryDrag = (
    event: ReactDragEvent<HTMLElement>,
    entryId: Id<"entries">,
  ) => {
    const dragsAllSelection =
      selectMode &&
      allEntriesSelected &&
      !excludedEntryIds.has(entryId) &&
      selectedAllEntryCount !== null;
    const dragsSelection =
      dragsAllSelection ||
      (selectMode && !allEntriesSelected && selectedEntryIds.has(entryId));
    const entrySelection: EntrySelection = dragsAllSelection
      ? {
          kind: "folder",
          excludedEntryIds: [...excludedEntryIds],
        }
      : {
          kind: "ids",
          entryIds: dragsSelection ? selectedIds : [entryId],
        };
    draggedEntrySelection.current = entrySelection;
    draggedEntryCount.current = dragsAllSelection
      ? selectedAllEntryCount
      : entrySelection.kind === "ids"
        ? entrySelection.entryIds.length
        : 0;
    if (selectMode && !dragsSelection) {
      window.setTimeout(() => {
        setSelectedEntryIds(new Set([entryId]));
        setSelectedFolderIds(new Set());
        setAllEntriesSelected(false);
        setExcludedEntryIds(new Set());
      }, 0);
    }
    startItemDrag(
      event,
      // Keep one ID in DataTransfer for Chromium's internal-drag detection;
      // refs retain the full folder-wide selection.
      dragsAllSelection
        ? [entryId]
        : entrySelection.kind === "ids"
          ? entrySelection.entryIds
          : [entryId],
      dragsSelection ? selectedFolderIdList : [],
    );
  };

  const beginFolderDrag = (
    event: ReactDragEvent<HTMLElement>,
    dragFolderId: Id<"folders">,
  ) => {
    const dragsSelection = selectMode && selectedFolderIds.has(dragFolderId);
    if (dragsSelection && allEntriesSelected && selectedAllEntryCount !== null) {
      draggedEntrySelection.current = {
        kind: "folder",
        excludedEntryIds: [...excludedEntryIds],
      };
      draggedEntryCount.current = selectedAllEntryCount;
    } else if (dragsSelection && selectedIds.length > 0) {
      draggedEntrySelection.current = {
        kind: "ids",
        entryIds: selectedIds,
      };
      draggedEntryCount.current = selectedIds.length;
    } else {
      draggedEntrySelection.current = null;
      draggedEntryCount.current = 0;
    }
    if (selectMode && !dragsSelection) {
      window.setTimeout(() => {
        setSelectedEntryIds(new Set());
        setSelectedFolderIds(new Set([dragFolderId]));
        setAllEntriesSelected(false);
        setExcludedEntryIds(new Set());
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
    const entrySelection =
      draggedEntrySelection.current ??
      (entryIds.length > 0
        ? ({ kind: "ids", entryIds } satisfies EntrySelection)
        : null);
    const entryCount =
      draggedEntryCount.current ||
      (entrySelection?.kind === "ids" ? entrySelection.entryIds.length : 0);
    endItemDrag();
    if (folderIds.includes(destinationFolderId)) return;
    if (entrySelection !== null && entryCount > 0) {
      void queueMove(
        entrySelection,
        entryCount,
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
    setDragOverFolderId(targetFolderId);
  };

  const leaveFolderTarget = (
    event: ReactDragEvent<HTMLElement>,
    targetFolderId: Id<"folders">,
  ) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    setDragOverFolderId((current) =>
      current === targetFolderId ? null : current,
    );
  };

  const breadcrumbs = listing.breadcrumbs.map((crumb, index) => (
    <span
      className={
        draggingItems
          ? `${styles.breadcrumbDropTarget} ${dragOverFolderId === crumb._id ? styles.breadcrumbDropTargetActive : ""}`
          : undefined
      }
      key={crumb._id}
      onDragEnter={
        canDragMove
          ? (event) => dragOverFolderTarget(event, crumb._id)
          : undefined
      }
      onDragOver={
        canDragMove
          ? (event) => dragOverFolderTarget(event, crumb._id)
          : undefined
      }
      onDragLeave={
        canDragMove
          ? (event) => leaveFolderTarget(event, crumb._id)
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
      <Link
        to={canonicalFolderHref(
          crumb._id === props.rootFolder._id ? null : crumb._id,
          listing.breadcrumbs
            .slice(1, index + 1)
            .map((entry) => entry.name),
        )}
      >
        {crumb.name}
      </Link>
    </span>
  ));

  return (
    <PageFrame
      gallery={props.gallery}
      galleryRoot={canonicalGalleryRoot}
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
                  setAllEntriesSelected(false);
                  setExcludedEntryIds(new Set());
                  closeActionDialogs();
                }}
                aria-label={selectMode ? "Exit select mode" : "Enter select mode"}
                aria-pressed={selectMode}
                title={selectMode ? "Exit select mode" : "Select items"}
              >
                <SelectListIcon />
              </button>
              {selectMode && hasSelection ? (
                <>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setDeleteDialog(true)}
                    disabled={selectedCount === null}
                    aria-label={`Delete ${selectionSummary}`}
                    title="Delete selected"
                  >
                    <TrashIcon />
                  </button>
                  <button
                    className={layout.iconButton}
                    type="button"
                    onClick={() => setMoveDialog(true)}
                    disabled={selectedCount === null}
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
          {selectedCount === null
            ? selectionSummary
            : selectedCount === 0
            ? "Select files or folders (Ctrl/⌘+A selects all), then delete, move, or drag them onto a folder."
            : `${selectionSummary} selected`}
        </p>
      ) : null}
      <div
        className={`${styles.grid} ${draggingItems ? styles.gridDragging : ""}`}
      >
        {listing.folders.map((folder) => (
          <GalleryFolderCard
            key={folder._id}
            folder={folder}
            href={canonicalFolderHref(folder._id, [
              ...folderNames,
              folder.name,
            ])}
            preview={folderPreviews.get(folder._id)}
            selectMode={selectMode}
            selected={selectedFolderIds.has(folder._id)}
            dropTarget={
              draggingItems && !draggedFolderIds.current.includes(folder._id)
            }
            dragOver={dragOverFolderId === folder._id}
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
            onDragEnter={
              canDragMove
                ? (event) => dragOverFolderTarget(event, folder._id)
                : undefined
            }
            onDragOver={
              canDragMove
                ? (event) => dragOverFolderTarget(event, folder._id)
                : undefined
            }
            onDragLeave={
              canDragMove
                ? (event) => leaveFolderTarget(event, folder._id)
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
        {entries.map((entry) => (
          <GalleryEntryCard
            key={entry._id}
            entry={entry}
            selectMode={selectMode}
            selected={
              allEntriesSelected
                ? !excludedEntryIds.has(entry._id)
                : selectedEntryIds.has(entry._id)
            }
            draggable={canDragMove}
            onOpen={openEntry}
            onMetadata={openEntryMetadata}
            onToggle={toggleEntrySelection}
            onDragStart={cardDragStart}
            onDragEnd={cardDragEnd}
          />
        ))}
      </div>
      <div
        className={styles.pagination}
        ref={infiniteScroll ? pageSentinel : undefined}
      >
        {infiniteScroll ? (
          entryPages.status === "LoadingMore" ? (
            <span role="status">Loading {pageSize} more files…</span>
          ) : entryPages.status === "Exhausted" && entries.length > 0 ? (
            <span>{entries.length.toLocaleString()} files loaded</span>
          ) : null
        ) : pagedEntries === undefined ? (
          <span role="status">Loading page…</span>
        ) : entries.length > 0 ? (
          <>
            <button
              type="button"
              disabled={paginationHistory.length === 0}
              onClick={() => {
                const previous = paginationHistory.at(-1) ?? null;
                setPaginationHistory((current) => current.slice(0, -1));
                setPaginationCursor(previous);
              }}
            >
              Previous
            </button>
            <span>
              {paginationLabel({
                page: paginationHistory.length + 1,
                pageSize,
                shown: entries.length,
                total: folderEntryCount,
              })}
            </span>
            <button
              type="button"
              disabled={pagedEntries.isDone}
              onClick={() => {
                setPaginationHistory((current) => [
                  ...current,
                  paginationCursor,
                ]);
                setPaginationCursor(pagedEntries.continueCursor);
              }}
            >
              Next
            </button>
          </>
        ) : null}
      </div>
      {listing.folders.length === 0 &&
      entries.length === 0 &&
      (infiniteScroll
        ? entryPages.status === "Exhausted"
        : pagedEntries?.isDone === true) ? (
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
          onMove={
            canManage
              ? (item) => {
                  setViewerActionEntryId(item.id as Id<"entries">);
                  setMoveDialog(true);
                }
              : undefined
          }
          onDelete={
            canManage
              ? (item) => {
                  setViewerActionEntryId(item.id as Id<"entries">);
                  setDeleteDialog(true);
                }
              : undefined
          }
          shortcutsSuspended={deleteDialog || moveDialog}
          resolveSource={resolveViewerSource}
          onClose={() => setViewerEntry(null, true)}
        />
      ) : null}
      {metadataEntry !== undefined &&
      (metadataEntry.metadataJson !== undefined ||
        metadataEntry.uploader !== undefined) ? (
        <GalleryMetadataDialog
          entryName={metadataEntry.name}
          metadataJson={metadataEntry.metadataJson}
          uploader={metadataEntry.uploader}
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
          galleryId={props.gallery._id}
          initialName=""
          initialAccessPolicy="inherit"
          initialDiscoverability="listed"
          isRoot={false}
          initialPreviewMode={undefined}
          initialPreviewSource={undefined}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (
            name,
            accessPolicy,
            discoverability,
            previewMode,
            previewSource,
          ) => {
            const result = await createFolder({
              anonymousClaim: anonymousClaim(),
              galleryId: props.gallery._id,
              parentId: folderId,
              name,
              accessPolicy,
              discoverability,
              ...(previewMode === undefined ? {} : { previewMode }),
              previewSource: previewSource ?? null,
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
          galleryId={props.gallery._id}
          previewFolderId={folderId}
          headerExtra={
            <>
              {listing.access.canAdminGallery ? (
                <Link
                  className={layout.dialogHeaderLink}
                  to={`/admin?gallery=${props.gallery._id}`}
                  title="Open gallery admin settings"
                >
                  Gallery admin <ExternalLink aria-hidden="true" size={14} />
                </Link>
              ) : null}
              {listing.filesystemSync !== null ? (
                <FilesystemScanControl
                  galleryId={props.gallery._id}
                  folderId={folderId}
                  sync={listing.filesystemSync}
                  disabled={props.gallery.pendingMigrationId !== undefined}
                  onQueued={() => setNotice("Scan queued")}
                  onError={(error) => setActionError(error)}
                />
              ) : null}
            </>
          }
          initialName={listing.folder.name}
          initialAccessPolicy={listing.folder.accessPolicy}
          initialDiscoverability={listing.folder.discoverability}
          isRoot={listing.folder.parentId === undefined}
          initialPreviewMode={listing.folder.previewMode}
          initialPreviewSource={listing.folder.previewSource}
          onClose={() => setFolderDialog(null)}
          onSubmit={async (
            name,
            accessPolicy,
            discoverability,
            previewMode,
            previewSource,
          ) => {
            const result = await updateFolder({
              anonymousClaim: anonymousClaim(),
              folderId,
              name,
              accessPolicy,
              discoverability,
              ...(previewMode === undefined ? {} : { previewMode }),
              previewSource: previewSource ?? null,
            });
            await completeFilesystemOperation(result);
            setFolderDialog(null);
            setNotice("Folder updated");
          }}
        />
      ) : null}
      {deleteDialog ? (
        <Dialog
          title={
            viewerActionEntry !== undefined
              ? "Delete this file?"
              : "Delete selected items?"
          }
          onClose={() => {
            if (!actionPending) closeActionDialogs();
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
                if (actionFolderIds.length > 0) {
                  const folderNames = new Map(
                    listing.folders.map((folder) => [
                      folder._id,
                      folder.name,
                    ]),
                  );
                  const folderTransfers = new Map(
                    actionFolderIds.map((deletedFolderId) => [
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
                      anonymousClaim: anonymousClaim(),
                      galleryId: props.gallery._id,
                      folderIds: actionFolderIds,
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
                if (
                  actionEntrySelection !== null &&
                  actionEntryCount !== null &&
                  actionEntryCount > 0
                ) {
                  try {
                    await startBulkDelete({
                      anonymousClaim: anonymousClaim(),
                      galleryId: props.gallery._id,
                      folderId,
                      selection: actionEntrySelection,
                    });
                    if (actionEntrySelection.kind === "ids") {
                      stepViewerPast(actionEntrySelection.entryIds);
                    }
                  } catch (reason) {
                    const message = friendlyError(
                      reason,
                      "Could not delete the selected files",
                    );
                    errors.push(message);
                  }
                }
                if (errors.length > 0) {
                  setActionError(errors[0]);
                } else {
                  if (viewerActionEntry === undefined) {
                    setSelectedEntryIds(new Set());
                    setSelectedFolderIds(new Set());
                    setAllEntriesSelected(false);
                    setExcludedEntryIds(new Set());
                  }
                  closeActionDialogs();
                }
              };
              void deleteSelection().finally(() => setActionPending(false));
            }}
          >
            <p className={styles.deletePrompt}>
              Delete {actionSummary}?{" "}
              {actionFolderIds.length > 0
                ? "Folders are deleted along with everything inside them. "
                : ""}
              This cannot be undone.
            </p>
            <div className={layout.buttonRow}>
              <button
                type="button"
                onClick={closeActionDialogs}
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
          selectedEntryCount={actionEntryCount ?? 0}
          selectedFolderIds={actionFolderIds}
          selectionSummary={actionSummary}
          pending={actionPending}
          onClose={() => {
            if (!actionPending) closeActionDialogs();
          }}
          onMove={async (destinationGalleryId, destinationFolderId) => {
            if (
              actionEntrySelection !== null &&
              actionEntryCount !== null &&
              actionEntryCount > 0
            ) {
              await queueMove(
                actionEntrySelection,
                actionEntryCount,
                destinationGalleryId,
                destinationFolderId,
              );
            }
            if (actionFolderIds.length > 0) {
              await queueFolderMove(actionFolderIds, destinationFolderId);
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
      {props.preview?.customUrl !== undefined ? (
        <MediaThumbnail
          className={styles.folderPreviewSingle}
          src={props.preview.customUrl}
        />
      ) : null}
      {entries.map((entry, index) => (
        <MediaThumbnail
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
          src={
            entry.thumbnailKey === undefined
              ? undefined
              : publicMediaUrl(entry.thumbnailKey)
          }
          state={entry.thumbnailState}
        />
      ))}
    </span>
  );
}

function GalleryFolderCard(props: {
  folder: Doc<"folders">;
  href: string;
  preview?: FolderPreviewData;
  selectMode: boolean;
  selected: boolean;
  dropTarget: boolean;
  dragOver: boolean;
  draggable: boolean;
  onToggle: () => void;
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onDragEnter?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave?: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void;
}) {
  const content = (
    <>
      <FolderPreview preview={props.preview} />
      <span className={styles.folderName}>{props.folder.name}</span>
      {props.folder.accessPolicy !== "inherit" ? (
        <small>{props.folder.accessPolicy}</small>
      ) : null}
      {props.folder.discoverability === "unlisted" ? (
        <small>unlisted</small>
      ) : null}
    </>
  );
  const dropTargetClass = props.dropTarget ? styles.folderDropTarget : "";
  const dragOverClass = props.dragOver
    ? styles.folderDropTargetActive
    : "";
  if (!props.selectMode) {
    return (
      <Link
        className={`${styles.folderCard} ${dropTargetClass} ${dragOverClass}`}
        to={props.href}
        draggable={props.draggable}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onDragEnter={props.onDragEnter}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        {content}
      </Link>
    );
  }
  return (
    <button
      className={`${styles.folderCard} ${styles.folderCardSelectable} ${props.selected ? styles.selectedCard : ""} ${dropTargetClass} ${dragOverClass}`}
      type="button"
      onClick={props.onToggle}
      aria-label={`${props.selected ? "Deselect" : "Select"} folder ${props.folder.name}`}
      aria-pressed={props.selected}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragEnter={props.onDragEnter}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
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

// Memoized: the grid can hold hundreds of cards and the listing updates on
// every upload. Handlers take the entry id so the parent can pass stable
// functions and a card re-renders only when its own entry or flags change.
const GalleryEntryCard = memo(function GalleryEntryCard(props: {
  entry: GalleryEntry;
  selectMode: boolean;
  selected: boolean;
  draggable: boolean;
  onOpen: (entryId: Id<"entries">) => void;
  onMetadata: (entryId: Id<"entries">) => void;
  onToggle: (entryId: Id<"entries">) => void;
  onDragStart: (
    event: ReactDragEvent<HTMLElement>,
    entryId: Id<"entries">,
  ) => void;
  onDragEnd: () => void;
}) {
  const entryId = props.entry._id;
  const content = (
    <>
      <span className={styles.thumbnailFrame}>
        {props.entry.mediaKind === "image" ||
        props.entry.mediaKind === "video" ? (
          <MediaThumbnail
            className={styles.fileThumb}
            src={
              props.entry.thumbnailKey === undefined
                ? undefined
                : publicMediaUrl(props.entry.thumbnailKey)
            }
            state={props.entry.thumbnailState}
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
      onDragStart={
        props.draggable
          ? (event) => props.onDragStart(event, entryId)
          : undefined
      }
      onDragEnd={props.draggable ? props.onDragEnd : undefined}
    >
      {props.selectMode ? (
        <button
          className={styles.fileCardContent}
          type="button"
          onClick={() => props.onToggle(entryId)}
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
            props.onOpen(entryId);
          }}
        >
          {content}
        </a>
      )}
      {!props.selectMode &&
      (props.entry.metadataJson !== undefined ||
        props.entry.uploader !== undefined) ? (
        <button
          className={styles.cardMetadataButton}
          type="button"
          onClick={() => props.onMetadata(entryId)}
          title="View metadata"
          aria-label={`View metadata for ${props.entry.name}`}
        >
          <Info aria-hidden="true" size={15} />
        </button>
      ) : null}
    </article>
  );
});

function GalleryMetadataDialog(props: {
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
  sync: FilesystemSyncInfo;
}) {
  const initialized = useRef(false);
  const previousFinishedAt = useRef<number | undefined>(undefined);
  const previousActive = useRef(false);
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      previousFinishedAt.current = props.sync.lastFinishedAt;
      previousActive.current = props.sync.status !== "idle";
      return;
    }
    if (props.sync.status !== "idle" || props.sync.hasError) {
      setShowComplete(false);
    }
    const completed =
      props.sync.status === "idle" &&
      !props.sync.hasError &&
      (previousActive.current ||
        props.sync.lastFinishedAt !== previousFinishedAt.current);
    previousActive.current = props.sync.status !== "idle";
    previousFinishedAt.current = props.sync.lastFinishedAt;
    if (!completed) return;
    setShowComplete(true);
    const timer = window.setTimeout(() => setShowComplete(false), 1600);
    return () => window.clearTimeout(timer);
  }, [
    props.sync.hasError,
    props.sync.status,
    props.sync.lastFinishedAt,
  ]);

  if (props.sync.status === "running") {
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
  if (props.sync.status === "queued") {
    return (
      <span
        className={`${layout.syncIndicator} ${layout.scanQueued}`}
        role="status"
        aria-label="background update queued"
        title="background update queued"
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

function FolderForm(props: {
  title: string;
  headerExtra?: ReactNode;
  galleryId: Id<"galleries">;
  previewFolderId?: Id<"folders">;
  initialName: string;
  initialAccessPolicy: FolderAccessPolicy;
  initialDiscoverability: FolderDiscoverability;
  isRoot: boolean;
  initialPreviewMode?: FolderPreviewMode;
  initialPreviewSource?: string;
  onClose: () => void;
  onSubmit: (
    name: string,
    accessPolicy: FolderAccessPolicy,
    discoverability: FolderDiscoverability,
    previewMode?: FolderPreviewMode,
    previewSource?: string,
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
  return (
    <Dialog
      title={props.title}
      headerExtra={props.headerExtra}
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
        {error ? <p className={layout.formError}>{error}</p> : null}
        <button type="submit">Save</button>
      </form>
    </Dialog>
  );
}
