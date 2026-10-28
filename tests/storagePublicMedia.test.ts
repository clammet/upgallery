// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, expect, test } from "vitest";
import type express from "express";

let root: string;
let app: express.Express;
const fileName = "watch + 100% #1? 日本語.txt";
const url = `/media/users/alice/photos/private/${encodeURIComponent(fileName)}`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "upgallery-public-media-"));
  process.env.CONVEX_SITE_URL = "http://convex.invalid";
  process.env.STORAGE_INTERNAL_SECRET = "test-storage-secret-with-more-than-24-characters";
  process.env.STORAGE_ROOT = root;
  const directory = join(root, "public/users/alice/photos/private");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, fileName), "watch-original", { mode: 0o600 });
  await writeFile(join(directory, ".hidden.txt"), "hidden-original", { mode: 0o600 });
  for (const zone of ["protected/uploaders/drop", "derivatives/up/drop"]) {
    await mkdir(join(root, zone), { recursive: true });
    await writeFile(join(root, zone, "secret.txt"), "protected-original", { mode: 0o600 });
  }
  ({ app } = await import("../storage/server.js"));
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("owner-only originals stream through the storage owner with escaped names and revalidation", async () => {
  const response = await request(app).get(`${url}?v=123`);
  expect(response.status).toBe(200);
  expect(response.text).toBe("watch-original");
  expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
  expect(response.headers.etag).toBeTruthy();
  const cached = await request(app).get(url).set("If-None-Match", response.headers.etag);
  expect(cached.status).toBe(304);
  const head = await request(app).head(url);
  expect(head.status).toBe(200);
  expect(head.headers["content-length"]).toBe(String("watch-original".length));
  const range = await request(app).get(url).set("Range", "bytes=0-4");
  expect(range.status).toBe(206);
  expect(range.text).toBe("watch");
  expect(range.headers["content-range"]).toBe("bytes 0-4/14");
});

test.each(["/media/users/alice/photos/private", "/media/users/alice/photos/private/", "/media/users/alice/photos/missing.txt"])(
  "%s returns 404 for SPA fallback without a redirect or another static root",
  async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toEqual({ error: "File not found" });
  },
);

test("user-original dotfiles remain supported", async () => {
  const response = await request(app).get("/media/users/alice/photos/private/.hidden.txt");
  expect(response.status).toBe(200);
  expect(response.text).toBe("hidden-original");
});

test.each([
  "/media/users/%2e%2e/%2e%2e/protected/uploaders/drop/secret.txt",
  "/media/users/%2e%2e/%2e%2e/derivatives/up/drop/secret.txt",
  "/media/protected/uploaders/drop/secret.txt",
  "/media/derivatives/up/drop/secret.txt",
])("public media cannot read ticket-protected storage via %s", async (path) => {
  const response = await request(app).get(path);
  expect([400, 403, 404]).toContain(response.status);
  expect(response.text).not.toContain("protected-original");
});
