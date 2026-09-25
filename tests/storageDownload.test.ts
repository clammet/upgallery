// @vitest-environment node
import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

vi.mock("../storage/config.js", () => ({
  config: { convexSiteUrl: "http://convex.invalid", storageSecret: "test-secret" },
}));
const fixture = vi.hoisted(() => ({ path: "" }));
vi.mock("../storage/paths.js", () => ({ absoluteStoragePath: () => fixture.path }));
import { handleDownload } from "../storage/download.js";

const app = express();
app.get("/api/storage/files/:entryId", handleDownload);
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "upgallery-download-"));
  fixture.path = join(directory, "file.txt");
  await writeFile(fixture.path, "hello");
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());

function failedDownload(code = "download_expired", target: string | null = "/up?item=entry") {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Download rejected", code }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(target)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

test("expired direct navigation redirects to the item without caching the redirect", async () => {
  const fetch = failedDownload();
  const response = await request(app).get("/api/storage/files/entry?ticket=old")
    .set("Host", "example.com").set("Sec-Fetch-Dest", "document");
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe("/up?item=entry");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ entryId: "entry", host: "example.com" });
});

test("deleted items redirect to the uploader notification, including older browsers", async () => {
  failedDownload("download_not_found", "/up/?notice=item-not-found");
  const response = await request(app).get("/api/storage/files/entry?ticket=old").set("Accept", "text/html");
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe("/up/?notice=item-not-found");
});

test.each(["image", "video", "audio", "iframe", "empty"])("expired %s requests remain file errors", async (destination) => {
  const fetch = failedDownload();
  const response = await request(app).get("/api/storage/files/entry?ticket=old")
    .set("Sec-Fetch-Dest", destination).set("Accept", "text/html");
  expect(response.status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("unrelated failures and non-uploader targets do not redirect", async () => {
  const fetch = failedDownload("unauthorized");
  expect((await request(app).get("/api/storage/files/entry?ticket=old").set("Sec-Fetch-Dest", "document")).status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(1);
  failedDownload("download_expired", null);
  expect((await request(app).get("/api/storage/files/entry?ticket=old").set("Sec-Fetch-Dest", "document")).status).toBe(404);
});

test("valid tickets still serve the file and mismatched IDs never redirect", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    entryId: "entry", storageKey: "file.txt", mimeType: "text/plain", fileName: "file.txt", disposition: "inline",
  })));
  vi.stubGlobal("fetch", fetch);
  const response = await request(app).get("/api/storage/files/entry?ticket=valid").set("Sec-Fetch-Dest", "document");
  expect(response.status).toBe(200);
  expect(response.text).toBe("hello");
  const mismatch = await request(app).get("/api/storage/files/other?ticket=valid").set("Sec-Fetch-Dest", "document");
  expect(mismatch.status).toBe(404);
  expect(mismatch.headers.location).toBeUndefined();
});
