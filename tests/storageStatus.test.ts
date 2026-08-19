// @vitest-environment node
import request from "supertest";
import { beforeAll, expect, test } from "vitest";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = "http://convex.invalid";
  process.env.STORAGE_INTERNAL_SECRET =
    "test-storage-secret-with-more-than-24-characters";
  process.env.STORAGE_ROOT = ".storage-test";
});

test("statusz reports an idle service as not busy", async () => {
  const { app } = await import("../storage/server.js");
  const response = await request(app).get("/statusz");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    busy: false,
    uploads: { active: 0, queued: 0 },
    downloads: { active: 0, queued: 0 },
    filesystemOperations: { active: 0, queued: 0 },
  });
});
