import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { Dialog } from "../components/Dialog";
import { FileGlyph } from "../components/FileGlyph";
import { formatBytes, storageApi } from "../lib/files";
import { friendlyError } from "../lib/errors";
import { useUpload } from "../hooks/useUpload";
import { getOrCreateAnonymousClaim } from "../lib/anonymousClaim";
import styles from "../styles/uploader.module.css";
import galleryStyles from "../styles/gallery.module.css";
import layout from "../styles/layout.module.css";

export function UploaderPage(props: {
  gallery: Doc<"galleries">;
  rootFolder: Doc<"folders">;
}) {
  const listing = useQuery(api.folders.list, {
    anonymousClaim: getOrCreateAnonymousClaim(),
    galleryId: props.gallery._id,
    folderId: props.rootFolder._id,
  });
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [exif, setExif] = useState<string | null>(null);
  const { upload, uploading, error } = useUpload();
  const previewUrl = useMemo(
    () => (file?.type.startsWith("image/") ? URL.createObjectURL(file) : null),
    [file],
  );

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const dropped = event.dataTransfer?.files[0];
      if (dropped) {
        setFile(dropped);
        setTextPreview(null);
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLInputElement
      ) {
        return;
      }
      const pastedFile = event.clipboardData?.files[0];
      if (pastedFile) {
        event.preventDefault();
        setFile(pastedFile);
        setTextPreview(null);
        return;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        event.preventDefault();
        const name = `clipboard-${new Date().toISOString().replaceAll(":", "-")}.txt`;
        setFile(new File([text], name, { type: "text/plain" }));
        setTextPreview(text.slice(0, 500));
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
  }, []);

  if (listing === undefined) {
    return <PageFrame gallery={props.gallery}><p>Loading…</p></PageFrame>;
  }

  return (
    <PageFrame gallery={props.gallery}>
      {listing.access.canUpload ? (
        <form
          className={styles.uploadForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            void upload({
              file,
              galleryId: props.gallery._id,
              folderId: props.rootFolder._id,
              description,
              password,
            }).then(() => {
              setFile(null);
              setDescription("");
              setPassword("");
              setTextPreview(null);
            });
          }}
        >
          <label className={styles.filePicker}>
            <span>{file ? file.name : "Choose a file, drop it here, or paste"}</span>
            <input
              type="file"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setTextPreview(null);
              }}
            />
          </label>
          {previewUrl ? <img className={styles.preview} src={previewUrl} alt="Upload preview" /> : null}
          {textPreview ? <pre className={styles.textPreview}>{textPreview}</pre> : null}
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <label>Password <small>(optional)</small><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error ? <p className={layout.formError}>{error}</p> : null}
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Uploading…" : "Submit"}
          </button>
        </form>
      ) : (
        <p className={layout.notice}>Log in with an allowed account to upload.</p>
      )}

      <div className={styles.entryList}>
        {listing.entries.map((entry) => (
          <UploaderEntry
            key={entry._id}
            entry={entry}
            onExif={() => entry.exifJson && setExif(entry.exifJson)}
          />
        ))}
      </div>
      {exif ? (
        <Dialog title="EXIF metadata" onClose={() => setExif(null)}>
          <pre className={styles.exif}>{JSON.stringify(JSON.parse(exif), null, 2)}</pre>
        </Dialog>
      ) : null}
    </PageFrame>
  );
}

function UploaderEntry(props: {
  entry: Doc<"entries"> & {
    passwordProtected: boolean;
    views: number;
    downloads: number;
  };
  onExif: () => void;
}) {
  const createTicket = useMutation(api.entries.createDownloadTicket);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pendingDisposition, setPendingDisposition] = useState<
    "inline" | "attachment" | null
  >(null);
  const open = async (
    disposition: "inline" | "attachment",
    suppliedPassword?: string,
  ) => {
    const popup = window.open("about:blank", "_blank");
    try {
      const { token } = await createTicket({
        entryId: props.entry._id,
        password: suppliedPassword || undefined,
        disposition,
      });
      const url = storageApi(
        `/api/storage/files/${props.entry._id}?ticket=${encodeURIComponent(token)}`,
      );
      if (popup) popup.location.href = url;
      else window.location.href = url;
      setError(null);
      setPassword("");
      setPendingDisposition(null);
    } catch (reason) {
      popup?.close();
      setError(friendlyError(reason, "Could not open file"));
    }
  };
  return (
    <article className={styles.entry}>
      <div className={galleryStyles.miniGlyph}>
        <FileGlyph extension={props.entry.extension} />
      </div>
      <div className={styles.entryDetails}>
        <strong>{props.entry.name}</strong>
        {props.entry.description ? <p>{props.entry.description}</p> : null}
        <small>
          {formatBytes(props.entry.size)} · {props.entry.views} views ·{" "}
          {props.entry.downloads} downloads
          {props.entry.passwordProtected ? " · locked" : ""}
        </small>
        {error ? <span className={layout.formError}>{error}</span> : null}
      </div>
      <div className={styles.entryActions}>
        {props.entry.exifJson ? <button type="button" onClick={props.onExif} title="EXIF metadata">ⓘ</button> : null}
        <button type="button" onClick={() => props.entry.passwordProtected ? setPendingDisposition("inline") : void open("inline")}>View</button>
        <button type="button" onClick={() => props.entry.passwordProtected ? setPendingDisposition("attachment") : void open("attachment")}>Download</button>
      </div>
      {pendingDisposition ? (
        <Dialog
          title={pendingDisposition === "inline" ? "View protected file" : "Download protected file"}
          onClose={() => setPendingDisposition(null)}
        >
          <form
            className={layout.form}
            onSubmit={(event) => {
              event.preventDefault();
              void open(pendingDisposition, password);
            }}
          >
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
            <button type="submit">Continue</button>
          </form>
        </Dialog>
      ) : null}
    </article>
  );
}
