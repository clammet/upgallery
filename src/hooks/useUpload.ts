import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { storageApi } from "../lib/files";
import { friendlyError } from "../lib/errors";
import { anonymousClaim } from "../lib/authClient";

export function useUpload() {
  const createIntent = useMutation(api.entries.createUploadIntent);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (input: {
      file: File;
      galleryId: Id<"galleries">;
      folderId: Id<"folders">;
      description?: string;
      password?: string;
      removeLocationData?: boolean;
      unlisted?: boolean;
      onProgress?: (fraction: number) => void;
    }) => {
      setUploading(true);
      setError(null);
      try {
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
        });
        const form = new FormData();
        form.append("file", input.file, input.file.name);
        return await new Promise<unknown>((resolve, reject) => {
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
            if (request.status >= 200 && request.status < 300) {
              resolve(body);
              return;
            }
            const message =
              typeof body === "object" &&
              body !== null &&
              "error" in body &&
              typeof body.error === "string"
                ? body.error
                : "Upload failed";
            reject(new Error(message));
          });
          request.addEventListener("error", () =>
            reject(new Error("Upload failed")),
          );
          request.addEventListener("abort", () =>
            reject(new Error("Upload cancelled")),
          );
          request.send(form);
        });
      } catch (reason) {
        const message = friendlyError(reason, "Upload failed");
        setError(message);
        throw reason;
      } finally {
        setUploading(false);
      }
    },
    [createIntent],
  );

  return { upload, uploading, error, clearError: () => setError(null) };
}
