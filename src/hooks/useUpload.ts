import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { storageApi } from "../lib/files";
import { friendlyError, RequestError } from "../lib/errors";
import { anonymousClaim } from "../lib/authClient";
import type { ConflictPolicy } from "../lib/transfers";

export type UploadInput = {
  file: File;
  galleryId: Id<"galleries">;
  folderId: Id<"folders">;
  description?: string;
  password?: string;
  removeLocationData?: boolean;
  unlisted?: boolean;
  /**
   * What to do when the folder already holds this name. Without it the
   * upload is refused with an entry_exists error before any bytes are sent.
   */
  conflict?: ConflictPolicy;
  onProgress?: (fraction: number) => void;
};

export type UploadResult = {
  entryId: Id<"entries">;
  /** The stored name; differs from the file's when it was auto-renamed. */
  name: string;
};

/**
 * Returns a function that uploads one file. It holds no React state, so a
 * component that runs many uploads (the gallery's bulk drop) does not
 * re-render when each one starts or finishes. Use `useUpload` when the
 * caller wants `uploading`/`error` for a form.
 */
export function useUploader() {
  const createIntent = useMutation(api.entries.createUploadIntent);
  return useCallback(
    async (input: UploadInput): Promise<UploadResult> => {
      const intent = await createIntent({
        anonymousClaim: anonymousClaim(),
        galleryId: input.galleryId,
        folderId: input.folderId,
        name: input.file.name,
        description: input.description || undefined,
        mimeType: input.file.type || "application/octet-stream",
        size: input.file.size,
        password: input.password || undefined,
        removeLocationData: input.removeLocationData || undefined,
        unlisted: input.unlisted || undefined,
        conflict: input.conflict,
      });
      const form = new FormData();
      form.append("file", input.file, input.file.name);
      return await new Promise<UploadResult>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", storageApi("/api/storage/upload"));
        request.responseType = "json";
        request.setRequestHeader("x-upload-intent", intent.intentId);
        request.setRequestHeader("x-upload-token", intent.token);
        request.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable && event.total > 0) {
            input.onProgress?.(event.loaded / event.total);
          }
        });
        request.addEventListener("load", () => {
          const body: unknown = request.response;
          const record =
            typeof body === "object" && body !== null ? body : {};
          if (request.status >= 200 && request.status < 300) {
            resolve({
              entryId: (
                "entryId" in record && typeof record.entryId === "string"
                  ? record.entryId
                  : ""
              ) as Id<"entries">,
              name:
                "name" in record && typeof record.name === "string"
                  ? record.name
                  : input.file.name,
            });
            return;
          }
          reject(
            new RequestError(
              "error" in record && typeof record.error === "string"
                ? record.error
                : "Upload failed",
              "code" in record && typeof record.code === "string"
                ? record.code
                : undefined,
            ),
          );
        });
        request.addEventListener("error", () =>
          reject(new Error("Upload failed")),
        );
        request.addEventListener("abort", () =>
          reject(new Error("Upload cancelled")),
        );
        request.send(form);
      });
    },
    [createIntent],
  );
}

/** `useUploader` plus `uploading`/`error` state for single-file forms. */
export function useUpload() {
  const uploadFile = useUploader();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (input: UploadInput) => {
      setUploading(true);
      setError(null);
      try {
        return await uploadFile(input);
      } catch (reason) {
        setError(friendlyError(reason, "Upload failed"));
        throw reason;
      } finally {
        setUploading(false);
      }
    },
    [uploadFile],
  );

  return { upload, uploading, error, clearError: () => setError(null) };
}
