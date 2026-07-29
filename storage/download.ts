import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { callConvex, type DownloadClaim } from "./convex.js";
import { absoluteStoragePath } from "./paths.js";

export async function handleDownload(
  request: Request,
  response: Response,
): Promise<void> {
  const token = typeof request.query.ticket === "string" ? request.query.ticket : "";
  if (!token || token.length > 512) {
    response.status(400).json({ error: "Missing download ticket" });
    return;
  }
  try {
    const claim = await callConvex<DownloadClaim>(
      "/internal/storage/claim-download",
      { token },
    );
    if (claim.entryId !== request.params.entryId) {
      throw new Error("Download ticket does not match this entry");
    }
    const path = absoluteStoragePath(claim.storageKey);
    const file = await stat(path);
    const requestedRange = request.header("range");
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("content-type", claim.mimeType);
    response.setHeader(
      "content-disposition",
      `${claim.disposition === "attachment" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(claim.fileName)}`,
    );
    response.setHeader("cache-control", "private, no-store");

    if (requestedRange !== undefined) {
      const range = parseRange(requestedRange, file.size);
      if (range === null) {
        response.status(416).setHeader("content-range", `bytes */${file.size}`);
        response.end();
        return;
      }
      response.status(206);
      response.setHeader("content-length", range.end - range.start + 1);
      response.setHeader(
        "content-range",
        `bytes ${range.start}-${range.end}/${file.size}`,
      );
      await pipeline(createReadStream(path, range), response);
      return;
    }
    response.setHeader("content-length", file.size);
    await pipeline(createReadStream(path), response);
  } catch (error) {
    if (!response.headersSent) {
      response.status(404).json({
        error: error instanceof Error ? error.message : "File not found",
      });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null) return null;
  const start = match[1] === "" ? 0 : Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}
