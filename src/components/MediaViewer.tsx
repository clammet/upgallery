import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  Link2,
  X,
} from "lucide-react";
import { MoveIcon, TrashIcon } from "./ActionIcons";
import { friendlyError } from "../lib/errors";
import {
  shouldRenderAsPlainText,
  shouldRenderTextAsMarkdown,
} from "../lib/media";
import { shouldRenderAsCode } from "../lib/codeLanguages";
import type { ThemeMode } from "../lib/theme";
import {
  metadataLocation,
  metadataRows,
  openStreetMapUrls,
  parseMetadataJson,
} from "../lib/metadata";
import { MarkdownToggle } from "./MarkdownToggle";
import styles from "../styles/viewer.module.css";

const MarkdownPreview = lazy(() => import("./MarkdownPreview"));
const PlainTextPreview = lazy(() => import("./PlainTextPreview"));
const CodePreview = lazy(() => import("./CodePreview"));

export type MediaViewerItem = {
  id: string;
  title: string;
  href: string;
  mediaKind:
    | "image"
    | "video"
    | "audio"
    | "text"
    | "archive"
    | "document"
    | "other";
  mimeType: string;
  sourceUrl?: string;
  passwordProtected?: boolean;
  canToggleMarkdown?: boolean;
  previewReady?: boolean;
  previewError?: string;
  metadataJson?: string;
  uploader?: string;
};

export type MediaViewerLinkKind = "lightbox" | "direct";

type NaturalSize = {
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type PointerGesture = {
  pointerId: number;
  pointerType: string;
  mode: "pan" | "swipe";
  startX: number;
  startY: number;
  panX: number;
  panY: number;
};

const ZOOM_EPSILON = 0.002;
const INFO_COLUMN_WIDTH = 320;
const MIN_PREVIEW_WIDTH = 96;
const VIEWER_BORDER_WIDTH = 2;

function viewportSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function mediaViewerGeometry(
  naturalSize: NaturalSize | null,
  mediaKind: MediaViewerItem["mediaKind"],
  viewport: ReturnType<typeof viewportSize>,
  scale: number,
  infoOpen: boolean,
  infoContentHeight: number,
) {
  const maxViewerWidth = Math.max(
    MIN_PREVIEW_WIDTH + VIEWER_BORDER_WIDTH,
    viewport.width - 32,
  );
  const maxViewerContentWidth = maxViewerWidth - VIEWER_BORDER_WIDTH;
  const maxHeight = Math.max(160, viewport.height - 96);
  const infoWidth = infoOpen
    ? Math.min(
        INFO_COLUMN_WIDTH,
        Math.max(0, maxViewerContentWidth - MIN_PREVIEW_WIDTH),
      )
    : 0;
  const maxWidth = Math.max(
    Math.min(MIN_PREVIEW_WIDTH, maxViewerContentWidth),
    maxViewerContentWidth - infoWidth,
  );

  let preview: { width: number; height: number; fitScale: number };

  if (naturalSize !== null) {
    const fitScale = Math.min(
      1,
      maxWidth / naturalSize.width,
      maxHeight / naturalSize.height,
    );
    const visibleScale = Math.min(1, Math.max(fitScale, scale));
    const width = Math.min(
      maxWidth,
      Math.max(Math.min(300, maxWidth), naturalSize.width * visibleScale),
    );
    const height = Math.min(
      maxHeight,
      Math.max(Math.min(160, maxHeight), naturalSize.height * visibleScale),
    );
    preview = {
      width,
      height,
      fitScale,
    };
  } else if (mediaKind === "audio") {
    preview = {
      width: Math.min(560, maxWidth),
      height: Math.min(160, maxHeight),
      fitScale: 1,
    };
  } else {
    preview = {
      width: Math.min(1120, maxWidth),
      height: maxHeight,
      fitScale: 1,
    };
  }

  return {
    ...preview,
    height: infoOpen
      ? Math.min(maxHeight, Math.max(preview.height, infoContentHeight))
      : preview.height,
    infoWidth,
    viewerWidth: preview.width + infoWidth + VIEWER_BORDER_WIDTH,
  };
}

export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function fileNameStemEnd(fileName: string): number {
  const finalDot = fileName.lastIndexOf(".");
  return finalDot > 0 && finalDot < fileName.length - 1
    ? finalDot
    : fileName.length;
}

export function shouldOpenMediaViewer(event: {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function MediaViewer(props: {
  items: MediaViewerItem[];
  initialIndex: number;
  themeMode: ThemeMode;
  onClose: () => void;
  resolveSource?: (
    item: MediaViewerItem,
    password?: string,
  ) => Promise<string | null>;
  onMarkdownModeChange?: (
    item: MediaViewerItem,
    markdown: boolean,
  ) => Promise<void>;
  onActiveItemChange?: (item: MediaViewerItem) => void;
  onTitleChange?: (item: MediaViewerItem, title: string) => Promise<void>;
  onCopyLink?: (
    item: MediaViewerItem,
    kind: MediaViewerLinkKind,
  ) => Promise<void>;
  onMove?: (item: MediaViewerItem) => void;
  onDelete?: (item: MediaViewerItem) => void;
  // True while another dialog sits on top of the viewer, so Escape and the
  // arrow keys belong to that dialog rather than to the viewer.
  shortcutsSuspended?: boolean;
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(props.initialIndex, 0), props.items.length - 1),
  );
  const activeItem = props.items[index];
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);
  const [viewport, setViewport] = useState(viewportSize);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [markdownTogglePending, setMarkdownTogglePending] = useState(false);
  const [markdownToggleError, setMarkdownToggleError] = useState<string | null>(
    null,
  );
  const [markdownReloadRequest, setMarkdownReloadRequest] = useState<{
    itemId: string;
    markdown: boolean;
  } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titlePending, setTitlePending] = useState(false);
  const [titleFeedback, setTitleFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [copyPending, setCopyPending] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoContentHeight, setInfoContentHeight] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const infoContentRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleEditFormRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const resolvedSources = useRef(new Map<string, string>());
  const pendingResolutions = useRef(new Map<string, string | null>());
  const unlockedPasswords = useRef(new Map<string, string>());
  const previousActiveItemId = useRef<string | null>(null);
  const previousFitScale = useRef<number | null>(null);
  const gesture = useRef<PointerGesture | null>(null);

  const geometry = useMemo(
    () =>
      mediaViewerGeometry(
        naturalSize,
        activeItem?.mediaKind ?? "other",
        viewport,
        scale,
        infoOpen,
        infoContentHeight,
      ),
    [
      activeItem?.mediaKind,
      infoContentHeight,
      infoOpen,
      naturalSize,
      scale,
      viewport,
    ],
  );
  const fitScale = geometry.fitScale;
  const zoomed = naturalSize !== null && scale > fitScale + ZOOM_EPSILON;
  const canZoom =
    naturalSize !== null && fitScale < 1 - ZOOM_EPSILON;
  const rendersMarkdown =
    activeItem !== undefined &&
    shouldRenderTextAsMarkdown(activeItem.mediaKind, activeItem.title);
  const rendersPlainText =
    activeItem !== undefined &&
    shouldRenderAsPlainText(activeItem.mediaKind, activeItem.title);
  const rendersCode =
    activeItem !== undefined &&
    shouldRenderAsCode(activeItem.title, activeItem.mimeType);
  const showsTextPreview =
    sourceUrl !== null && (rendersMarkdown || rendersPlainText || rendersCode);
  const canChangeMarkdown =
    activeItem?.canToggleMarkdown === true &&
    props.onMarkdownModeChange !== undefined;
  const metadata = useMemo(
    () =>
      activeItem?.metadataJson === undefined
        ? null
        : parseMetadataJson(activeItem.metadataJson),
    [activeItem?.metadataJson],
  );
  const infoRows = useMemo(
    () => metadataRows(metadata ?? {}, activeItem?.uploader),
    [activeItem?.uploader, metadata],
  );
  const location = useMemo(
    () => (metadata === null ? null : metadataLocation(metadata)),
    [metadata],
  );
  const mapUrls = useMemo(
    () => (location === null ? null : openStreetMapUrls(location)),
    [location],
  );
  const cancelTitleEdit = useCallback(() => {
    setEditingTitle(false);
    setTitleDraft(activeItem?.title ?? "");
    setTitleFeedback(null);
  }, [activeItem?.title]);

  const moveBy = useCallback(
    (direction: -1 | 1) => {
      const nextIndex = Math.min(
        Math.max(index + direction, 0),
        props.items.length - 1,
      );
      if (nextIndex === index) return;
      setIndex(nextIndex);
      const nextItem = props.items[nextIndex];
      if (nextItem !== undefined) props.onActiveItemChange?.(nextItem);
    },
    [index, props.items, props.onActiveItemChange],
  );

  useEffect(() => {
    setIndex(
      Math.min(Math.max(props.initialIndex, 0), props.items.length - 1),
    );
  }, [props.initialIndex, props.items.length]);

  useEffect(() => {
    if (props.items.length === 0) {
      props.onClose();
      return;
    }
    setIndex((current) => Math.min(current, props.items.length - 1));
  }, [props.items.length, props.onClose]);

  useEffect(() => {
    const onResize = () => setViewport(viewportSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    if (props.shortcutsSuspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.key === " " && activeItem !== undefined) {
        event.preventDefault();
        window.open(activeItem.href, "_blank", "noopener,noreferrer");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveBy(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveBy(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, moveBy, props.onClose, props.shortcutsSuspended]);

  useEffect(() => {
    if (activeItem === undefined) return;
    let cancelled = false;
    const itemChanged = previousActiveItemId.current !== activeItem.id;
    previousActiveItemId.current = activeItem.id;
    const cachedSource =
      activeItem.sourceUrl ?? resolvedSources.current.get(activeItem.id);
    const resolutionPending = pendingResolutions.current.has(activeItem.id);
    const pendingPassword =
      pendingResolutions.current.get(activeItem.id) ?? undefined;

    setSourceUrl(cachedSource ?? null);
    setLoadError(null);
    if (itemChanged) {
      setPassword("");
      setMarkdownToggleError(null);
      setEditingTitle(false);
      setTitleDraft(activeItem.title);
      setTitlePending(false);
      setTitleFeedback(null);
      setCopyPending(false);
    }
    setNaturalSize(null);
    setScale(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    previousFitScale.current = null;
    gesture.current = null;

    if (cachedSource !== undefined) {
      pendingResolutions.current.delete(activeItem.id);
      setLoading(false);
      return;
    }
    if (resolutionPending && activeItem.previewError !== undefined) {
      pendingResolutions.current.delete(activeItem.id);
      setLoading(false);
      setLoadError(activeItem.previewError);
      return;
    }
    if (resolutionPending && activeItem.previewReady !== true) {
      setLoading(true);
      return;
    }
    if (activeItem.passwordProtected && !resolutionPending) {
      setLoading(false);
      return;
    }
    if (props.resolveSource === undefined) {
      setLoading(false);
      setLoadError("This file could not be opened.");
      return;
    }

    setLoading(true);
    let remainsPending = false;
    void props
      .resolveSource(activeItem, pendingPassword)
      .then((url) => {
        if (cancelled) return;
        if (url === null) {
          if (pendingPassword !== undefined) {
            unlockedPasswords.current.set(activeItem.id, pendingPassword);
          }
          remainsPending = true;
          pendingResolutions.current.set(
            activeItem.id,
            pendingPassword ?? null,
          );
          setLoading(true);
          return;
        }
        pendingResolutions.current.delete(activeItem.id);
        if (pendingPassword !== undefined) {
          unlockedPasswords.current.set(activeItem.id, pendingPassword);
        }
        resolvedSources.current.set(activeItem.id, url);
        setSourceUrl(url);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          pendingResolutions.current.delete(activeItem.id);
          setLoadError(friendlyError(reason, "Could not open the file"));
        }
      })
      .finally(() => {
        if (!cancelled && !remainsPending) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeItem, props.resolveSource, sourceRevision]);

  useEffect(() => {
    if (activeItem !== undefined && !editingTitle) {
      setTitleDraft(activeItem.title);
    }
  }, [activeItem, editingTitle]);

  useLayoutEffect(() => {
    if (!infoOpen) {
      setInfoContentHeight(0);
      return;
    }
    const content = infoContentRef.current;
    if (content === null) return;
    const measure = () => {
      const nextHeight = Math.ceil(content.getBoundingClientRect().height);
      setInfoContentHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [activeItem?.id, infoOpen]);

  useLayoutEffect(() => {
    if (!editingTitle || activeItem === undefined) return;
    const input = titleInputRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(0, fileNameStemEnd(activeItem.title));
  }, [activeItem?.id, editingTitle]);

  useEffect(() => {
    if (!editingTitle || titlePending) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        titleEditFormRef.current?.contains(event.target)
      ) {
        return;
      }
      cancelTitleEdit();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [cancelTitleEdit, editingTitle, titlePending]);

  useEffect(() => {
    if (
      activeItem === undefined ||
      markdownReloadRequest === null ||
      activeItem.id !== markdownReloadRequest.itemId ||
      rendersMarkdown !== markdownReloadRequest.markdown
    ) {
      return;
    }

    setMarkdownReloadRequest(null);
    setMarkdownTogglePending(false);
    const unlockedPassword = unlockedPasswords.current.get(activeItem.id);
    if (activeItem.passwordProtected && unlockedPassword === undefined) {
      return;
    }
    resolvedSources.current.delete(activeItem.id);
    pendingResolutions.current.set(
      activeItem.id,
      unlockedPassword ?? null,
    );
    setSourceUrl(null);
    setSourceRevision((current) => current + 1);
  }, [activeItem, markdownReloadRequest, rendersMarkdown]);

  useLayoutEffect(() => {
    if (naturalSize === null) return;
    const previous = previousFitScale.current;
    setScale((current) => {
      if (previous === null || current <= previous + ZOOM_EPSILON) {
        return fitScale;
      }
      return Math.min(1, Math.max(fitScale, current));
    });
    previousFitScale.current = fitScale;
  }, [activeItem?.id, fitScale, naturalSize]);

  const clampPan = useCallback(
    (
      point: Point,
      atScale = scale,
      stageSize?: { width: number; height: number },
    ): Point => {
      if (
        naturalSize === null ||
        (stageSize === undefined && stageRef.current === null)
      ) {
        return { x: 0, y: 0 };
      }
      const stageWidth = stageSize?.width ?? stageRef.current!.clientWidth;
      const stageHeight = stageSize?.height ?? stageRef.current!.clientHeight;
      const maxX = Math.max(
        0,
        (naturalSize.width * atScale - stageWidth) / 2,
      );
      const maxY = Math.max(
        0,
        (naturalSize.height * atScale - stageHeight) / 2,
      );
      return {
        x: Math.min(maxX, Math.max(-maxX, point.x)),
        y: Math.min(maxY, Math.max(-maxY, point.y)),
      };
    },
    [naturalSize, scale],
  );

  useLayoutEffect(() => {
    setPan((current) => {
      const next = clampPan(current);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [clampPan, geometry.height, geometry.width, scale]);

  if (activeItem === undefined) return null;

  const setMediaNaturalSize = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setNaturalSize({ width, height });
  };

  const openWithPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (props.resolveSource === undefined) return;
    setLoading(true);
    setLoadError(null);
    let remainsPending = false;
    try {
      const url = await props.resolveSource(activeItem, password);
      if (url === null) {
        unlockedPasswords.current.set(activeItem.id, password);
        remainsPending = true;
        pendingResolutions.current.set(activeItem.id, password || null);
        return;
      }
      pendingResolutions.current.delete(activeItem.id);
      unlockedPasswords.current.set(activeItem.id, password);
      resolvedSources.current.set(activeItem.id, url);
      setSourceUrl(url);
      setPassword("");
    } catch (reason) {
      pendingResolutions.current.delete(activeItem.id);
      setLoadError(friendlyError(reason, "Could not open the file"));
    } finally {
      if (!remainsPending) setLoading(false);
    }
  };

  const changeMarkdownMode = async (markdown: boolean) => {
    if (props.onMarkdownModeChange === undefined) return;
    setMarkdownTogglePending(true);
    setMarkdownToggleError(null);
    try {
      await props.onMarkdownModeChange(activeItem, markdown);
      setMarkdownReloadRequest({ itemId: activeItem.id, markdown });
    } catch (reason) {
      setMarkdownToggleError(
        friendlyError(reason, "Could not change Markdown rendering"),
      );
      setMarkdownTogglePending(false);
    }
  };

  const saveTitle = async (event: FormEvent) => {
    event.preventDefault();
    if (props.onTitleChange === undefined) return;
    setTitlePending(true);
    setTitleFeedback(null);
    try {
      await props.onTitleChange(activeItem, titleDraft);
      setEditingTitle(false);
      setTitleFeedback({ kind: "success", message: "Filename updated" });
    } catch (reason) {
      setTitleFeedback({
        kind: "error",
        message: friendlyError(reason, "Could not update the filename"),
      });
    } finally {
      setTitlePending(false);
    }
  };

  const copyLink = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (props.onCopyLink === undefined || copyPending) return;
    const kind: MediaViewerLinkKind =
      event.metaKey || event.ctrlKey ? "direct" : "lightbox";
    setCopyPending(true);
    setTitleFeedback(null);
    try {
      await props.onCopyLink(activeItem, kind);
      setTitleFeedback({
        kind: "success",
        message: kind === "direct" ? "Direct link copied" : "Link copied",
      });
    } catch (reason) {
      setTitleFeedback({
        kind: "error",
        message: friendlyError(reason, "Could not copy the link"),
      });
    } finally {
      setCopyPending(false);
    }
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!canZoom || naturalSize === null) return;
    event.preventDefault();
    const nextScale = Math.min(
      1,
      Math.max(fitScale, scale * Math.exp(-event.deltaY * 0.0015)),
    );
    if (Math.abs(nextScale - scale) < 0.0001) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = {
      x: event.clientX - (bounds.left + bounds.width / 2),
      y: event.clientY - (bounds.top + bounds.height / 2),
    };
    const ratio = nextScale / scale;
    const nextGeometry = mediaViewerGeometry(
      naturalSize,
      activeItem.mediaKind,
      viewport,
      nextScale,
      infoOpen,
      infoContentHeight,
    );
    const nextPan = clampPan(
      {
        x: pointer.x - (pointer.x - pan.x) * ratio,
        y: pointer.y - (pointer.y - pan.y) * ratio,
      },
      nextScale,
      nextGeometry,
    );
    setScale(nextScale);
    setPan(nextScale <= fitScale + ZOOM_EPSILON ? { x: 0, y: 0 } : nextPan);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest(
          "button, a, input, textarea, select, [data-markdown-preview], [data-text-preview]",
        ))
    ) {
      return;
    }
    const mode = zoomed ? "pan" : event.pointerType === "touch" ? "swipe" : null;
    if (mode === null) return;
    gesture.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (mode === "pan") setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (
      current === null ||
      current.pointerId !== event.pointerId ||
      current.mode !== "pan"
    ) {
      return;
    }
    event.preventDefault();
    setPan(
      clampPan({
        x: current.panX + event.clientX - current.startX,
        y: current.panY + event.clientY - current.startY,
      }),
    );
  };

  const finishPointerGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.mode !== "swipe" || current.pointerType !== "touch") return;
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      moveBy(deltaX < 0 ? 1 : -1);
    }
  };

  const mediaStyle =
    naturalSize === null
      ? undefined
      : ({
          width: `${naturalSize.width}px`,
          height: `${naturalSize.height}px`,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
        } satisfies CSSProperties);
  const viewerStyle = {
    "--viewer-width": `${geometry.viewerWidth}px`,
    "--viewer-preview-width": `${geometry.width}px`,
    "--viewer-content-height": `${geometry.height}px`,
    "--viewer-info-width": `${geometry.infoWidth}px`,
  } as CSSProperties;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        className={styles.viewer}
        style={viewerStyle}
        role="dialog"
        aria-modal="true"
        aria-label={activeItem.title}
      >
        <header className={styles.titlebar}>
          <div className={styles.titleGroup}>
            {editingTitle ? (
              <form
                ref={titleEditFormRef}
                className={styles.titleEditForm}
                onSubmit={saveTitle}
              >
                <input
                  ref={titleInputRef}
                  aria-label="Filename"
                  disabled={titlePending}
                  maxLength={240}
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    cancelTitleEdit();
                  }}
                />
                <button
                  className={styles.titleButton}
                  type="submit"
                  disabled={titlePending || titleDraft.trim().length === 0}
                  aria-label="Save filename"
                  title="Save filename"
                >
                  <Check aria-hidden="true" size={17} />
                </button>
              </form>
            ) : (
              <h2 id="media-viewer-title" title={activeItem.title}>
                {props.onTitleChange !== undefined ? (
                  <button
                    className={styles.titleTextButton}
                    type="button"
                    onClick={() => {
                      setTitleDraft(activeItem.title);
                      setTitleFeedback(null);
                      setEditingTitle(true);
                    }}
                    aria-label={`Rename ${activeItem.title}`}
                    title="Edit filename"
                  >
                    {activeItem.title}
                  </button>
                ) : (
                  activeItem.title
                )}
              </h2>
            )}
            {props.onCopyLink !== undefined && !editingTitle ? (
              <button
                className={styles.titleButton}
                type="button"
                onClick={(event) => void copyLink(event)}
                disabled={copyPending}
                aria-label={`Copy link to ${activeItem.title}`}
                title="Copy lightbox link (Cmd/Ctrl-click for direct link)"
              >
                {titleFeedback?.kind === "success" &&
                (titleFeedback.message === "Link copied" ||
                  titleFeedback.message === "Direct link copied") ? (
                  <Check aria-hidden="true" size={17} />
                ) : (
                  <Link2 aria-hidden="true" size={17} />
                )}
              </button>
            ) : null}
          </div>
          <span className={styles.position}>
            {index + 1} / {props.items.length}
          </span>
          {canChangeMarkdown ? (
            <MarkdownToggle
              checked={rendersMarkdown}
              disabled={markdownTogglePending || loading}
              error={markdownToggleError}
              onChange={(markdown) => void changeMarkdownMode(markdown)}
            />
          ) : null}
          {props.onMove ? (
            <button
              className={styles.titleButton}
              type="button"
              onClick={() => props.onMove?.(activeItem)}
              aria-label={`Move ${activeItem.title}`}
              title="Move to…"
            >
              <MoveIcon />
            </button>
          ) : null}
          {props.onDelete ? (
            <button
              className={styles.titleButton}
              type="button"
              onClick={() => props.onDelete?.(activeItem)}
              aria-label={`Delete ${activeItem.title}`}
              title="Delete"
            >
              <TrashIcon />
            </button>
          ) : null}
          <button
            className={`${styles.titleButton} ${infoOpen ? styles.titleButtonActive : ""}`}
            type="button"
            onClick={() => setInfoOpen((current) => !current)}
            aria-controls="media-viewer-info"
            aria-expanded={infoOpen}
            aria-label={`${infoOpen ? "Hide" : "Show"} information for ${activeItem.title}`}
            title={`${infoOpen ? "Hide" : "Show"} information`}
          >
            <Info aria-hidden="true" size={18} />
          </button>
          <a
            className={styles.titleButton}
            href={activeItem.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${activeItem.title} in a new tab`}
            title="Open in new tab (Space)"
          >
            <ExternalLink aria-hidden="true" size={17} />
          </a>
          <button
            ref={closeButtonRef}
            className={styles.titleButton}
            type="button"
            onClick={props.onClose}
            aria-label="Close viewer"
            title="Close"
          >
            <X aria-hidden="true" size={19} />
          </button>
          {titleFeedback ? (
            <span
              className={`${styles.titleFeedback} ${titleFeedback.kind === "error" ? styles.titleFeedbackError : ""}`}
              role="status"
            >
              {titleFeedback.message}
            </span>
          ) : null}
        </header>

        <div className={styles.viewerBody}>
          <div
            ref={stageRef}
            className={`${styles.stage} ${showsTextPreview ? styles.stageTextPreview : ""} ${zoomed ? styles.stageZoomed : ""} ${dragging ? styles.stageDragging : ""}`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishPointerGesture}
            onPointerCancel={finishPointerGesture}
          >
            {loading ? (
              <div className={styles.status} role="status" aria-live="polite">
                <span className={styles.spinner} aria-hidden="true" />
                <p>
                  {activeItem.previewReady === false
                    ? "Preparing full-resolution preview…"
                    : "Preparing file…"}
                </p>
              </div>
            ) : sourceUrl === null && activeItem.passwordProtected ? (
              <form className={styles.passwordForm} onSubmit={openWithPassword}>
                <p>This file is password protected.</p>
                <label>
                  Password
                  <input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </label>
                {loadError ? (
                  <span className={styles.error}>{loadError}</span>
                ) : null}
                <button type="submit">View file</button>
              </form>
            ) : loadError ? (
              <div className={styles.status}>
                <p>{loadError}</p>
                <a
                  href={activeItem.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in a new tab
                </a>
              </div>
            ) : sourceUrl !== null && rendersCode ? (
              <Suspense
                fallback={
                  <div className={styles.status} role="status">
                    <p>Preparing syntax highlighter…</p>
                  </div>
                }
              >
                <CodePreview
                  fileName={activeItem.title}
                  mimeType={activeItem.mimeType}
                  sourceUrl={sourceUrl}
                  themeMode={props.themeMode}
                />
              </Suspense>
            ) : sourceUrl !== null && activeItem.mediaKind === "image" ? (
              <img
                className={`${styles.zoomMedia} ${naturalSize === null ? styles.mediaLoading : ""}`}
                src={sourceUrl}
                alt={activeItem.title}
                draggable={false}
                style={mediaStyle}
                onLoad={(event) => {
                  setLoadError(null);
                  setMediaNaturalSize(
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                  );
                }}
                onError={() =>
                  setLoadError(
                    "This image could not be displayed in the browser.",
                  )
                }
              />
            ) : sourceUrl !== null && activeItem.mediaKind === "video" ? (
              <video
                className={`${styles.zoomMedia} ${naturalSize === null ? styles.mediaLoading : ""}`}
                src={sourceUrl}
                controls
                playsInline
                style={mediaStyle}
                onLoadedMetadata={(event) =>
                  setMediaNaturalSize(
                    event.currentTarget.videoWidth,
                    event.currentTarget.videoHeight,
                  )
                }
              />
            ) : sourceUrl !== null && activeItem.mediaKind === "audio" ? (
              <audio className={styles.audio} src={sourceUrl} controls />
            ) : sourceUrl !== null && rendersMarkdown ? (
              <Suspense
                fallback={
                  <div className={styles.status} role="status">
                    <p>Preparing Markdown renderer…</p>
                  </div>
                }
              >
                <MarkdownPreview sourceUrl={sourceUrl} />
              </Suspense>
            ) : sourceUrl !== null && rendersPlainText ? (
              <Suspense
                fallback={
                  <div className={styles.status} role="status">
                    <p>Preparing text renderer…</p>
                  </div>
                }
              >
                <PlainTextPreview sourceUrl={sourceUrl} />
              </Suspense>
            ) : sourceUrl !== null &&
              (activeItem.mediaKind === "text" ||
                activeItem.mimeType === "application/pdf") ? (
              <iframe
                className={styles.document}
                src={sourceUrl}
                title={activeItem.title}
                sandbox="allow-downloads"
              />
            ) : sourceUrl !== null ? (
              <div className={styles.status}>
                <p>This file type cannot be previewed in the browser.</p>
                <a
                  href={activeItem.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open original
                </a>
              </div>
            ) : null}
          </div>
          {infoOpen ? (
            <aside
              id="media-viewer-info"
              className={styles.infoPanel}
              aria-label={`Information for ${activeItem.title}`}
            >
              <div ref={infoContentRef} className={styles.infoContent}>
                <h3>Information</h3>
                {infoRows.length > 0 ? (
                  <dl className={styles.infoList}>
                    {infoRows.map((row) => (
                      <div className={styles.infoRow} key={row.key}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className={styles.infoUnavailable}>
                    Metadata is unavailable.
                  </p>
                )}
                {mapUrls ? (
                  <figure className={styles.infoMap}>
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
            </aside>
          ) : null}
        </div>

        {props.items.length > 1 ? (
          <>
            <button
              className={`${styles.navigation} ${styles.previous}`}
              type="button"
              onClick={() => moveBy(-1)}
              disabled={index === 0}
              aria-label="Previous item"
              title="Previous"
            >
              <ChevronLeft aria-hidden="true" size={28} />
            </button>
            <button
              className={`${styles.navigation} ${styles.next}`}
              type="button"
              onClick={() => moveBy(1)}
              disabled={index === props.items.length - 1}
              aria-label="Next item"
              title="Next"
            >
              <ChevronRight aria-hidden="true" size={28} />
            </button>
          </>
        ) : null}
      </section>
    </div>
  );
}
