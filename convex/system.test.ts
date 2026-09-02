/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import authComponent from "@clammet/convex-googly-auth/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
let profileSequence = 0;

function setupTest() {
  const t = convexTest(schema, modules);
  authComponent.register(t);
  return t;
}

function asUser(t: TestConvex<typeof schema>, googleSubject: string) {
  return t.withIdentity({
    subject: googleSubject.split("|")[1]!,
    issuer: "https://accounts.google.com",
    tokenIdentifier: googleSubject,
    email: "someone@example.com",
    name: "Test User",
  });
}

async function seedUser(t: TestConvex<typeof schema>, admin: boolean) {
  profileSequence += 1;
  const googleSubject = `https://accounts.google.com|system-test-${profileSequence}`;
  const profileId = await asUser(t, googleSubject).mutation(
    api.profiles.ensureCurrent,
    {},
  );
  if (admin) {
    await t.run(async (ctx) => {
      await ctx.db.patch("profiles", profileId, { isSystemAdmin: true });
    });
  }
  return googleSubject;
}

describe("deployment status", () => {
  test("service heartbeats upsert one row per component", async () => {
    const t = setupTest();
    await t.mutation(internal.system.reportServiceStatus, {
      component: "storage-worker",
      commit: "a".repeat(40),
    });
    await t.mutation(internal.system.reportServiceStatus, {
      component: "storage-worker",
      commit: "b".repeat(40),
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("serviceHeartbeats").take(4),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      component: "storage-worker",
      commit: "b".repeat(40),
    });
    expect(rows[0]!.at).toBeTypeOf("number");
  });

  test("an empty commit means the build carries none", async () => {
    const t = setupTest();
    await t.mutation(internal.system.reportServiceStatus, {
      component: "storage-api",
      commit: "",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("serviceHeartbeats").take(4),
    );
    expect(rows[0]?.commit).toBeUndefined();
  });

  test("only system administrators can read deployment status", async () => {
    const t = setupTest();
    const admin = await seedUser(t, true);
    const user = await seedUser(t, false);
    await t.mutation(internal.system.reportServiceStatus, {
      component: "storage-api",
      commit: "c".repeat(40),
    });

    const status = await asUser(t, admin).query(api.system.deploymentStatus);
    expect(status.services).toMatchObject([
      { component: "storage-api", commit: "c".repeat(40) },
    ]);
    // The checked-in buildInfo carries no commit outside a real deploy.
    expect(status.convexCommit).toBeNull();

    await expect(
      asUser(t, user).query(api.system.deploymentStatus),
    ).rejects.toThrow(/Unauthorized/);
    await expect(t.query(api.system.deploymentStatus)).rejects.toThrow();
  });
});

describe("system settings", () => {
  test("lightbox preload settings default globally and only admins can update them", async () => {
    const t = setupTest();
    const admin = await seedUser(t, true);
    const user = await seedUser(t, false);

    await expect(t.query(api.system.lightboxPreloadSettings)).resolves.toEqual({
      ahead: 2,
      behind: 0,
    });
    await expect(
      asUser(t, user).mutation(api.system.updateLightboxPreloadSettings, {
        ahead: 4,
        behind: 1,
      }),
    ).rejects.toThrow(/Unauthorized/);

    const adminClient = asUser(t, admin);
    await adminClient.mutation(api.system.updateLightboxPreloadSettings, {
      ahead: 4,
      behind: 1,
    });
    await expect(t.query(api.system.lightboxPreloadSettings)).resolves.toEqual({
      ahead: 4,
      behind: 1,
    });
    await expect(
      adminClient.mutation(api.system.updateLightboxPreloadSettings, {
        ahead: 21,
        behind: 0,
      }),
    ).rejects.toThrow(/between 0 and 20/);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("systemSettings")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .take(2),
    );
    expect(rows).toHaveLength(1);
  });
});
