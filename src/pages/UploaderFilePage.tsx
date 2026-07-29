import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { friendlyError } from "../lib/errors";
import { storageApi } from "../lib/files";
import { getOrCreateAnonymousClaim } from "../lib/anonymousClaim";
import {
  isHeifImage,
  shouldUseNativeHeifPreview,
} from "../lib/media";
import styles from "../styles/uploader.module.css";
import layout from "../styles/layout.module.css";

export function UploaderFilePage(props: {
  gallery: Doc<"galleries">;
  entryId: Id<"entries">;
}) {
  const entry = useQuery(api.entries.getForUploaderView, {
    anonymousClaim: getOrCreateAnonymousClaim(),
    galleryId: props.gallery._id,
    entryId: props.entryId,
  });
  const createTicket = useMutation(api.entries.createDownloadTicket);
  const requestPreview = useMutation(api.entries.requestPreview);
  const attemptedEntry = useRef<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [opening, setOpening] = useState(false);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFile = useCallback(
    async (suppliedPassword?: string) => {
      setOpening(true);
      setError(null);
      let remainsPending = false;
      try {
        const needsConvertedPreview =
          entry !== undefined &&
          entry !== null &&
          isHeifImage(entry.mimeType, entry.name) &&
          !shouldUseNativeHeifPreview(entry.mimeType, entry.name);
        const token = needsConvertedPreview
          ? await requestPreview({
              anonymousClaim: getOrCreateAnonymousClaim(),
              galleryId: props.gallery._id,
              entryId: props.entryId,
              password: suppliedPassword || undefined,
            }).then((result) => {
              if (result.status === "pending") {
                remainsPending = true;
                setPreviewRequested(true);
                return null;
              }
              if (!("token" in result) || result.token === undefined) {
                throw new Error("Preview ticket was not created");
              }
              return result.token;
            })
          : await createTicket({
              anonymousClaim: getOrCreateAnonymousClaim(),
              galleryId: props.gallery._id,
              entryId: props.entryId,
              password: suppliedPassword || undefined,
              disposition: "inline",
            }).then((result) => result.token);
        if (token === null) return;
        setSourceUrl(
          storageApi(
            `/api/storage/files/${props.entryId}?ticket=${encodeURIComponent(token)}`,
          ),
        );
        setPreviewRequested(false);
        setPassword("");
      } catch (reason) {
        setError(friendlyError(reason, "Could not open file"));
      } finally {
        if (!remainsPending) setOpening(false);
      }
    },
    [
      createTicket,
      entry,
      props.entryId,
      props.gallery._id,
      requestPreview,
    ],
  );

  useEffect(() => {
    if (entry?.previewError !== undefined && previewRequested) {
      setOpening(false);
      setError(entry.previewError);
      return;
    }
    const attemptKey =
      entry === undefined || entry === null
        ? null
        : `${props.entryId}:${entry.previewKey ?? "original"}`;
    if (
      entry === undefined ||
      entry === null ||
      (entry.passwordProtected && !previewRequested) ||
      attemptKey === null ||
      attemptedEntry.current === attemptKey ||
      (previewRequested && entry.previewKey === undefined)
    ) {
      return;
    }
    attemptedEntry.current = attemptKey;
    void openFile(entry.passwordProtected ? password : undefined);
  }, [entry, openFile, password, previewRequested, props.entryId]);

  if (entry === undefined) {
    return (
      <PageFrame gallery={props.gallery}>
        <p className={styles.viewerStatus}>Preparing file…</p>
      </PageFrame>
    );
  }
  if (entry === null) {
    return (
      <PageFrame gallery={props.gallery}>
        <div className={styles.viewerStatus}>
          <h1>File not found</h1>
          <p>This file is unavailable or you do not have access.</p>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame gallery={props.gallery}>
      {sourceUrl ? (
        <section className={styles.fileViewer}>
          <iframe
            src={sourceUrl}
            title={entry.name}
            sandbox="allow-downloads"
          />
        </section>
      ) : entry.passwordProtected ? (
        <form
          className={styles.viewerForm}
          onSubmit={(event) => {
            event.preventDefault();
            void openFile(password);
          }}
        >
          <h1>{entry.name}</h1>
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
          {error ? <span className={layout.formError}>{error}</span> : null}
          <button type="submit" disabled={opening}>
            {opening ? "Opening…" : "View file"}
          </button>
        </form>
      ) : (
        <div className={styles.viewerStatus}>
          <p>{error ?? "Preparing file…"}</p>
          {error ? (
            <button type="button" onClick={() => void openFile()} disabled={opening}>
              Try again
            </button>
          ) : null}
        </div>
      )}
    </PageFrame>
  );
}
