/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import authComponent from "@clammet/convex-googly-auth/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEFAULT_UPLOAD_EXPIRY_OPTIONS, enabledUploadExpiryOptions, uploadExpiresAt, type UploadExpiry } from "./lib/uploadExpiry";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup(kind: "image" | "uploader" = "uploader") {
  const t = convexTest(schema, modules);
  authComponent.register(t);
  const admin = t.withIdentity({ subject: "admin", issuer: "https://accounts.google.com", tokenIdentifier: "https://accounts.google.com|admin" });
  const adminId = await admin.mutation(api.profiles.ensureCurrent, {});
  await t.run((ctx) => ctx.db.patch("profiles", adminId, { isSystemAdmin: true }));
  const galleryId = await admin.mutation(api.galleries.create, {
    name: "Expiry", slug: "expiry", kind, storageKind: "shared", storageRoot: "expiry",
    hosts: [{ host: "expiry.example.com", rootPath: "/up" }],
  });
  const gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
  const owner = t.withIdentity({ subject: "owner", issuer: "https://accounts.google.com", tokenIdentifier: "https://accounts.google.com|owner" });
  const ownerId = await owner.mutation(api.profiles.ensureCurrent, {});
  await t.run((ctx) => ctx.db.insert("galleryRoles", { galleryId, profileId: ownerId, role: "owner" }));
  const input = { galleryId, folderId: gallery!.rootFolderId!, name: "photo.jpg", mimeType: "image/jpeg", size: 100 };
  async function upload(expiry?: UploadExpiry, extras = {}) {
    const intent = await owner.mutation(api.entries.createUploadIntent, { ...input, expiry, ...extras });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    const completion = {
      intentId: intent.intentId, actualMimeType: "image/jpeg", extension: "jpg", mediaKind: "image" as const,
      size: 100, sha256: "a".repeat(64), storageKey: "protected/expiry/photo.jpg", thumbnailKey: "derivatives/expiry/photo.jpg",
    };
    const result = await t.mutation(internal.storageGateway.completeUpload, completion);
    return { ...result, completion };
  }
  return { t, admin, owner, galleryId, input, upload };
}

describe("uploader expiry", () => {
  test("owners and admins configure expiry, preserve choices across off/on, and require a duration", async () => {
    const { t, owner, admin, galleryId } = await setup();
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true });
    let gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
    expect(gallery!.expiryOptions ?? DEFAULT_UPLOAD_EXPIRY_OPTIONS).toEqual(DEFAULT_UPLOAD_EXPIRY_OPTIONS);
    await owner.mutation(api.galleries.update, { galleryId, expiryOptions: ["3days", "1month"] });
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: false });
    await admin.mutation(api.galleries.update, { galleryId, expiryEnabled: true });
    gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
    expect(gallery).toMatchObject({ expiryEnabled: true, expiryOptions: ["3days", "1month"] });
    await expect(owner.mutation(api.galleries.update, { galleryId, expiryOptions: [] })).rejects.toThrow("Enable at least one");
    const editor = t.withIdentity({ subject: "editor", issuer: "https://accounts.google.com", tokenIdentifier: "https://accounts.google.com|editor" });
    const editorId = await editor.mutation(api.profiles.ensureCurrent, {});
    await t.run((ctx) => ctx.db.insert("galleryRoles", { galleryId, profileId: editorId, role: "editor" }));
    await expect(editor.mutation(api.galleries.update, { galleryId, expiryEnabled: false })).rejects.toThrow();
    await expect(t.mutation(api.galleries.update, { galleryId, expiryEnabled: false })).rejects.toThrow();
  });

  test("upload intents enforce the configured options and disabled galleries remain permanent", async () => {
    const { t, owner, galleryId, input, upload } = await setup();
    const permanent = await upload();
    expect((await t.run((ctx) => ctx.db.get("entries", permanent.entryId)))!.expiresAt).toBeUndefined();
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "1day" })).rejects.toThrow("not enabled");
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true, expiryOptions: ["3days"] });
    await expect(owner.mutation(api.entries.createUploadIntent, input)).rejects.toThrow("Choose an enabled");
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "1day" })).rejects.toThrow("Choose an enabled");
    const expiring = await upload("3days");
    expect((await t.run((ctx) => ctx.db.get("entries", expiring.entryId)))!.expiresAt).toBe(Date.now() + 3 * DAY);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get("entries", permanent.entryId)))!.state).toBe("ready");
  });

  test("Never is enabled for older saved options until explicitly disabled, and that preference survives off/on", async () => {
    const { t, owner, galleryId, input } = await setup();
    // A duration list saved before Never was introduced must retain its choices.
    await t.run((ctx) => ctx.db.patch("galleries", galleryId, {
      expiryEnabled: true, expiryOptions: ["3days", "1month"],
    }));
    let gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
    expect(enabledUploadExpiryOptions(gallery!)).toEqual(["never", "3days", "1month"]);
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "never" })).resolves.toHaveProperty("intentId");
    await owner.mutation(api.galleries.update, { galleryId, expiryOptions: ["3days"] });
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: false });
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true });
    gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
    expect(enabledUploadExpiryOptions(gallery!)).toEqual(["3days"]);
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "never" })).rejects.toThrow("Choose an enabled");
    await owner.mutation(api.galleries.update, { galleryId, expiryOptions: ["3days", "never"] });
    gallery = await t.run((ctx) => ctx.db.get("galleries", galleryId));
    expect(enabledUploadExpiryOptions(gallery!)).toEqual(["never", "3days"]);
  });

  test("Never uploads have no expiry or scheduled deletion, including when it is the only option", async () => {
    const { t, owner, galleryId, upload, input } = await setup();
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true, expiryOptions: ["never"] });
    const { entryId } = await upload("never");
    expect(uploadExpiresAt(Date.now(), "never")).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get("entries", entryId)))!.expiresAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10))).toHaveLength(0);
    vi.advanceTimersByTime(366 * DAY);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get("entries", entryId)))!.state).toBe("ready");
    const { token } = await owner.mutation(api.entries.createDownloadTicket, { galleryId, entryId, disposition: "attachment" });
    await expect(t.mutation(internal.storageGateway.claimDownload, { token })).resolves.toHaveProperty("entryId", entryId);
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "1day" })).rejects.toThrow("Choose an enabled");
  });

  test("image galleries reject expiry settings and upload durations", async () => {
    const { owner, galleryId, input } = await setup("image");
    await expect(owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true })).rejects.toThrow("only supported by uploader");
    await expect(owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "1week" })).rejects.toThrow("not enabled");
  });

  test("expiry starts at completion, revokes access, and queues originals and derivatives exactly once", async () => {
    const { t, owner, galleryId, input } = await setup();
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true });
    const intent = await owner.mutation(api.entries.createUploadIntent, { ...input, expiry: "1day", password: "secret", unlisted: true });
    await t.mutation(internal.storageGateway.claimUpload, intent);
    vi.advanceTimersByTime(60_000);
    const completion = {
      intentId: intent.intentId, actualMimeType: "image/jpeg", extension: "jpg", mediaKind: "image" as const,
      size: 100, sha256: "a".repeat(64), storageKey: "protected/expiry/photo.jpg", thumbnailKey: "derivatives/expiry/thumb.jpg",
    };
    const { entryId } = await t.mutation(internal.storageGateway.completeUpload, completion);
    const expiresAt = Date.now() + DAY;
    await t.run((ctx) => ctx.db.patch("entries", entryId, { previewKey: "derivatives/expiry/preview.jpg" }));
    // A retried completion must not extend the lifetime or enqueue a second timer.
    vi.advanceTimersByTime(1_000);
    await t.mutation(internal.storageGateway.completeUpload, completion);
    expect((await t.run((ctx) => ctx.db.get("entries", entryId)))!.expiresAt).toBe(expiresAt);
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: false });
    vi.advanceTimersByTime(DAY - 1_001);
    await t.finishInProgressScheduledFunctions();
    expect((await t.run((ctx) => ctx.db.get("entries", entryId)))!.state).toBe("ready");
    const { token } = await owner.mutation(api.entries.createDownloadTicket, { galleryId, entryId, disposition: "attachment", password: "secret" });
    await t.mutation(internal.storageGateway.claimDownload, { token });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    await t.mutation(internal.entryExpiry.expire, { entryId, expiresAt });
    expect((await t.run((ctx) => ctx.db.get("entries", entryId)))!.state).toBe("deleted");
    await expect(t.mutation(internal.storageGateway.claimDownload, { token })).rejects.toThrow("File not found");
    const listing = await owner.query(api.folders.list, { galleryId, folderId: input.folderId });
    expect(listing.entries).toHaveLength(0);
    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("storageDeleteJobs").withIndex("by_entryId", (q) => q.eq("entryId", entryId)).take(10),
      galleryStats: await ctx.db.query("galleryStats").withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId)).unique(),
      folderStats: await ctx.db.query("folderStats").withIndex("by_folderId", (q) => q.eq("folderId", input.folderId)).unique(),
    }));
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ storageKey: completion.storageKey, thumbnailKey: completion.thumbnailKey, previewKey: "derivatives/expiry/preview.jpg", deleteEntry: true });
    expect(state.galleryStats).toMatchObject({ itemCount: 0, totalBytes: 0 });
    expect(state.folderStats).toMatchObject({ itemCount: 0, totalBytes: 0 });
    const job = await t.mutation(internal.storageGateway.claimMaintenance, {});
    expect(job).toMatchObject({ kind: "delete", removePhysical: true, removeThumbnail: true, removePreview: true });
    await t.mutation(internal.storageGateway.completeDelete, { jobId: state.jobs[0]._id });
    expect(await t.run((ctx) => ctx.db.get("entries", entryId))).toBeNull();
    await t.mutation(internal.entryExpiry.expire, { entryId, expiresAt });
  });

  test("manual deletion before expiry does not queue duplicate work or decrement counters twice", async () => {
    const { t, owner, galleryId, upload } = await setup();
    await owner.mutation(api.galleries.update, { galleryId, expiryEnabled: true });
    const { entryId } = await upload("1day");
    await owner.mutation(api.entries.remove, { entryId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      jobs: await ctx.db.query("storageDeleteJobs").withIndex("by_entryId", (q) => q.eq("entryId", entryId)).take(10),
      stats: await ctx.db.query("galleryStats").withIndex("by_galleryId", (q) => q.eq("galleryId", galleryId)).unique(),
    }));
    expect(state.jobs).toHaveLength(1);
    expect(state.stats).toMatchObject({ itemCount: 0, totalBytes: 0 });
  });

  test.each([
    ["1day", "2028-01-31T12:30:00Z", "2028-02-01T12:30:00Z"],
    ["3days", "2028-01-31T12:30:00Z", "2028-02-03T12:30:00Z"],
    ["1week", "2028-01-31T12:30:00Z", "2028-02-07T12:30:00Z"],
    ["3weeks", "2028-01-31T12:30:00Z", "2028-02-21T12:30:00Z"],
    ["1month", "2028-01-31T12:30:00Z", "2028-02-29T12:30:00Z"],
    ["3months", "2028-01-31T12:30:00Z", "2028-04-30T12:30:00Z"],
    ["1year", "2028-02-29T12:30:00Z", "2029-02-28T12:30:00Z"],
  ] as const)("calculates %s including month-end and leap-year boundaries", (expiry, start, end) => {
    expect(uploadExpiresAt(Date.parse(start), expiry)).toBe(Date.parse(end));
  });
});
