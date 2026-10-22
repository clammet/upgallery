import { useEffect, useMemo, useState, type RefObject } from "react";
import { useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { anonymousClaim } from "../lib/authClient";

type Preview = FunctionReturnType<typeof api.folders.previews>[number];
const BATCH_SIZE = 12;

// Only subscribe to previews near the viewport. Each batch is bounded, and the
// basic listing never waits for these more expensive descendant-image probes.
export function useFolderPreviews(input: {
  gallery: Doc<"galleries">;
  folderId: Id<"folders">;
  folders: Array<Doc<"folders">> | undefined;
  grid: RefObject<HTMLDivElement | null>;
  suspended: boolean;
  seed: number;
}) {
  const [visible, setVisible] = useState<{ folderId: string; ids: Set<string> }>(
    () => ({ folderId: input.folderId, ids: new Set() }),
  );
  useEffect(() => {
    if (input.suspended || input.grid.current === null) return;
    const elements = input.grid.current.querySelectorAll<HTMLElement>("[data-preview-folder]");
    const reveal = (ids: string[]) => setVisible((previous) => {
      const current = previous.folderId === input.folderId ? previous.ids : new Set<string>();
      if (ids.every((id) => current.has(id))) return previous;
      return { folderId: input.folderId, ids: new Set([...current, ...ids]) };
    });
    if (typeof IntersectionObserver === "undefined") {
      reveal(Array.from(elements, (element) => element.dataset.previewFolder!));
      return;
    }
    const observer = new IntersectionObserver((observations) => {
      const ids = observations.filter((item) => item.isIntersecting)
        .map((item) => (item.target as HTMLElement).dataset.previewFolder!);
      if (ids.length > 0) reveal(ids);
    }, { rootMargin: "400px 0px" });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [input.folderId, input.folders, input.grid, input.suspended]);

  const queries = useMemo(() => {
    const folders = input.suspended || visible.folderId !== input.folderId ? [] :
      (input.folders ?? []).filter((folder) => visible.ids.has(folder._id));
    const batches: Record<string, { query: typeof api.folders.previews; args: {
      anonymousClaim?: string; galleryId: Id<"galleries">; folderIds: Id<"folders">[]; previewSeed?: number;
    } }> = {};
    for (let start = 0; start < folders.length; start += BATCH_SIZE) {
      const batch = folders.slice(start, start + BATCH_SIZE);
      const random = batch.some((folder) =>
        (folder.previewMode ?? input.gallery.folderPreviewMode ?? "first").startsWith("random"));
      batches[String(start)] = {
        query: api.folders.previews,
        args: {
          anonymousClaim: anonymousClaim(),
          galleryId: input.gallery._id,
          folderIds: batch.map((folder) => folder._id),
          ...(random ? { previewSeed: input.seed } : {}),
        },
      };
    }
    return batches;
  }, [input.folderId, input.folders, input.gallery._id, input.gallery.folderPreviewMode,
    input.seed, input.suspended, visible]);
  const results = useQueries(queries);
  const previews = new Map<Id<"folders">, Preview>();
  for (const result of Object.values(results)) {
    if (result instanceof Error) throw result;
    for (const preview of (result ?? []) as Preview[]) previews.set(preview.folderId, preview);
  }
  return previews;
}
