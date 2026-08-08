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
        const response = await fetch(storageApi("/api/storage/upload"), {
          method: "POST",
          headers: {
            "x-upload-intent": intent.intentId,
            "x-upload-token": intent.token,
          },
          body: form,
        });
        const body: unknown = await response.json();
        if (!response.ok) {
          const message =
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
              ? body.error
              : "Upload failed";
          throw new Error(message);
        }
        return body;
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
