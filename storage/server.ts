import express from "express";
import helmet from "helmet";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { config } from "./config.js";
import { AsyncSemaphore, CapacityError } from "./concurrency.js";
import { callConvex } from "./convex.js";
import { handleDownload } from "./download.js";
import { prepareTemporaryStorage } from "./temporary.js";
import { handleUpload } from "./upload.js";
import { runFilesystemOperation } from "./userFilesystem.js";

export const app: express.Express = express();
const uploads = new AsyncSemaphore(
  config.maxConcurrentUploads,
  config.maxQueuedUploads,
);
const downloads = new AsyncSemaphore(
  config.maxConcurrentDownloads,
  config.maxQueuedDownloads,
);
const filesystemOperations = new AsyncSemaphore(
  config.maxConcurrentFilesystemOperations,
  config.maxQueuedFilesystemOperations,
);

app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);
app.use(express.json({ limit: "8kb" }));
app.get("/healthz", (_request, response) => {
  response.json({ ok: true });
});
app.get("/readyz", (_request, response) => {
  void callConvex<{ ok: boolean }>("/internal/storage/health")
    .then(() => response.json({ ok: true }))
    .catch((error: unknown) => {
      response.status(503).json({
        ok: false,
        error: error instanceof Error ? error.message : "Convex is unavailable",
      });
    });
});
app.post("/api/storage/upload", (request, response) => {
  runLimited(uploads, response, () => handleUpload(request, response));
});
app.get("/api/storage/files/:entryId", (request, response) => {
  runLimited(downloads, response, () => handleDownload(request, response));
});
app.post("/api/storage/sync-user-directory", (request, response) => {
  const body: unknown = request.body;
  if (
    !isRecord(body) ||
    typeof body.galleryId !== "string" ||
    typeof body.folderId !== "string" ||
    body.galleryId.length > 100 ||
    body.folderId.length > 100
  ) {
    response.status(400).json({ error: "Invalid directory sync request" });
    return;
  }
  void callConvex<{ queued: boolean; jobId: string }>(
    "/internal/storage/queue-filesystem-sync",
    { galleryId: body.galleryId, folderId: body.folderId },
  )
    .then((result) => response.status(202).json(result))
    .catch((error: unknown) => {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Could not queue sync",
      });
    });
});
app.post("/api/storage/user-folder-operation", (request, response) => {
  const body: unknown = request.body;
  if (
    !isRecord(body) ||
    typeof body.operationId !== "string" ||
    typeof body.token !== "string" ||
    body.operationId.length > 100 ||
    body.token.length > 512
  ) {
    response.status(400).json({ error: "Invalid filesystem operation" });
    return;
  }
  const operationId = body.operationId;
  const token = body.token;
  runLimited(filesystemOperations, response, async () => {
    try {
      const result = await runFilesystemOperation(operationId, token);
      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Operation failed",
      });
    }
  });
});
app.use(
  "/media/derivatives/gallery",
  express.static(`${config.storageRoot}/derivatives/gallery`, {
    fallthrough: false,
    immutable: true,
    maxAge: "1y",
    index: false,
    dotfiles: "deny",
  }),
);
app.use(
  "/media/users",
  express.static(`${config.storageRoot}/public/users`, {
    fallthrough: false,
    maxAge: 0,
    etag: true,
    index: false,
    dotfiles: "allow",
  }),
);
app.use(
  "/media",
  express.static(`${config.storageRoot}/public`, {
    fallthrough: false,
    immutable: true,
    maxAge: "1y",
    index: false,
    dotfiles: "deny",
  }),
);

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);
    response.status(500).json({ error: "Storage service error" });
  },
);

if (process.env.NODE_ENV !== "test") {
  await mkdir(config.storageRoot, { recursive: true });
  await prepareTemporaryStorage();
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`upgallery storage service listening on :${config.port}`);
  });
  installGracefulShutdown(server);
}

function runLimited(
  semaphore: AsyncSemaphore,
  response: express.Response,
  task: () => Promise<void>,
): void {
  void semaphore.run(task).catch((error: unknown) => {
    if (!response.headersSent) {
      response.status(error instanceof CapacityError ? 503 : 500).json({
        error:
          error instanceof CapacityError
            ? "Storage service is busy; retry later"
            : "Storage service error",
      });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
}

function installGracefulShutdown(server: Server): void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; draining storage API requests`);
    server.close((error) => {
      if (error !== undefined) {
        console.error("Storage API shutdown failed:", error);
        process.exitCode = 1;
      }
    });
    const force = setTimeout(() => {
      console.error("Storage API shutdown grace period expired");
      server.closeAllConnections();
      process.exitCode = 1;
    }, config.shutdownGraceMs);
    force.unref();
  }
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
