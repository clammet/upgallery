import Busboy from "busboy";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { config } from "./config.js";
import {
  callConvex,
  ConvexRequestError,
  type UploadClaim,
} from "./convex.js";
import { formatBytes } from "./format.js";
import { runWithHeartbeat } from "./heartbeat.js";
import {
  absoluteStoragePath,
  buildStorageKey,
  storageDirectory,
  storageFileMode,
} from "./paths.js";
import {
  classifyMedia,
  resolveExtension,
  resolveMimeType,
} from "./media.js";
import {
  sha256File,
  writeImageWithoutLocationData,
} from "./locationMetadata.js";
import { removeReplacedFile } from "./replacedFile.js";

type ParsedFile = {
  temporaryPath: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export async function handleUpload(
  request: Request,
  response: Response,
): Promise<void> {
  const intentId = request.header("x-upload-intent");
  const token = request.header("x-upload-token");
  if (!intentId || !token) {
    response.status(400).json({ error: "Missing upload intent headers" });
    return;
  }

  let claim: UploadClaim | undefined;
  let temporaryDirectory: string | undefined;
  const requestAbort = new AbortController();
  request.once("aborted", () => {
    requestAbort.abort(new Error("Upload client disconnected"));
  });
  try {
    claim = await callConvex<UploadClaim>(
      "/internal/storage/claim-upload",
      { intentId, token },
    );
    const completed = await runWithHeartbeat({
      signal: requestAbort.signal,
      timeoutMs: config.workerTaskTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      renew: () =>
        callConvex("/internal/storage/renew-upload", { intentId }),
      task: async (signal) => {
        if (!request.headers["content-type"]?.startsWith("multipart/form-data")) {
          throw new Error("Upload must use multipart/form-data");
        }
        const temporaryRoot = join(config.storageRoot, ".tmp");
        await mkdir(temporaryRoot, { recursive: true });
        temporaryDirectory = await mkdtemp(join(temporaryRoot, "upload-"));
        let parsed = await parseMultipart(
          request,
          temporaryDirectory,
          Math.min(claim!.maxFileSize, config.absoluteUploadLimit),
          signal,
        );
        const mimeType = resolveMimeType(claim!.name, parsed.mimeType);
        const extension = resolveExtension(claim!.name, mimeType);
        const mediaKind = classifyMedia(mimeType);
        if (claim!.removeLocationData && mediaKind === "image") {
          const strippedPath = `${parsed.temporaryPath}.location-stripped`;
          await writeImageWithoutLocationData(
            parsed.temporaryPath,
            strippedPath,
            signal,
          );
          await rename(strippedPath, parsed.temporaryPath);
          const stripped = await stat(parsed.temporaryPath);
          const effectiveLimit = Math.min(
            claim!.maxFileSize,
            config.absoluteUploadLimit,
          );
          if (stripped.size > effectiveLimit) {
            throw new Error(
              `File exceeds the ${formatBytes(effectiveLimit)} limit after removing location data`,
            );
          }
          parsed = {
            ...parsed,
            size: stripped.size,
            sha256: await sha256File(parsed.temporaryPath, signal),
          };
        }
        const storageKey = buildStorageKey({
          galleryKind: claim!.galleryKind,
          storageKind: claim!.storageKind,
          storageRoot: claim!.storageRoot,
          sha256: parsed.sha256,
          extension,
          folderSegments: claim!.folderSegments,
          fileName: claim!.name,
        });
        await mkdir(storageDirectory(storageKey), { recursive: true });
        const finalPath = absoluteStoragePath(storageKey);
        if (claim!.galleryKind === "image" && claim!.storageKind === "user") {
          await installReplacing(parsed.temporaryPath, finalPath, signal);
        } else {
          try {
            await access(finalPath);
            await unlink(parsed.temporaryPath);
          } catch {
            await installReplacing(parsed.temporaryPath, finalPath, signal);
          }
        }
        // Multipart and partial files stay private. Publish only paths that
        // nginx is explicitly allowed to serve; uploader storage remains
        // owner-only. This also repairs a same-content file from an older
        // upload that was installed mode 0600.
        await chmod(finalPath, storageFileMode(storageKey));
        if (
          claim!.replacesStorageKey !== undefined &&
          claim!.replacesStorageKey !== storageKey
        ) {
          await removeReplacedFile(claim!.replacesStorageKey, finalPath);
        }
        const installed = await stat(finalPath);
        return await callConvex<{ entryId: string; name: string }>(
          "/internal/storage/complete-upload",
          {
            intentId,
            actualMimeType: mimeType,
            extension,
            mediaKind,
            size: parsed.size,
            sha256: parsed.sha256,
            storageKey,
            filesystemModifiedAt:
              claim!.storageKind === "user" ? installed.mtimeMs : undefined,
            filesystemIdentity:
              claim!.storageKind === "user"
                ? `${installed.dev}:${installed.ino}`
                : undefined,
          },
        );
      },
    });
    response.status(201).json(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    const code =
      error instanceof ConvexRequestError ? error.code : undefined;
    if (claim !== undefined) {
      await callConvex("/internal/storage/fail-upload", {
        intentId,
        error: message,
      }).catch(() => undefined);
    }
    response
      .status(code === "entry_exists" ? 409 : 400)
      .json({ error: message, code });
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

async function installReplacing(
  source: string,
  destination: string,
  signal: AbortSignal,
) {
  const partial = `${destination}.partial-${process.pid}-${randomUUID()}`;
  try {
    await pipeline(
      createReadStream(source),
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    await rename(partial, destination);
    await unlink(source);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

async function parseMultipart(
  request: Request,
  temporaryDirectory: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ParsedFile> {
  return await new Promise<ParsedFile>((resolve, reject) => {
    const parser = Busboy({
      headers: request.headers,
      limits: { files: 1, fileSize: maxBytes, fields: 0 },
    });
    const onAbort = () => {
      parser.destroy(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Upload was aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    let filePromise: Promise<ParsedFile> | undefined;
    let parserError: Error | undefined;

    parser.on("file", (_fieldName, stream, info) => {
      if (filePromise !== undefined) {
        stream.resume();
        parserError = new Error("Only one file can be uploaded at a time");
        return;
      }
      const temporaryPath = join(temporaryDirectory, "payload");
      const hash = createHash("sha256");
      let size = 0;
      let truncated = false;
      stream.once("limit", () => {
        truncated = true;
      });
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      filePromise = pipeline(
        stream,
        meter,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal },
      ).then(() => {
        if (truncated) {
          throw new Error(`File exceeds the ${formatBytes(maxBytes)} limit`);
        }
        return {
          temporaryPath,
          fileName: info.filename,
          mimeType: info.mimeType,
          size,
          sha256: hash.digest("hex"),
        };
      });
    });
    parser.once("error", (error) => {
      cleanup();
      reject(error);
    });
    parser.once("finish", () => {
      cleanup();
      if (parserError !== undefined) {
        reject(parserError);
      } else if (filePromise === undefined) {
        reject(new Error("No file was supplied"));
      } else {
        void filePromise.then(resolve, reject);
      }
    });
    request.pipe(parser);
  });
}

export function openPublicFile(storageKey: string) {
  return createReadStream(absoluteStoragePath(storageKey));
}
