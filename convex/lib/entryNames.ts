import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { autoRenamedFileName, entryNameKey } from "./normalize";

type DbCtx = QueryCtx | MutationCtx;

export type ConflictPolicy = "replace" | "rename";

const MAX_RESERVATIONS = 256;
const MAX_RENAME_ATTEMPTS = 1000;

// Clients match on `code`; the storage server forwards it as HTTP 409.
export function entryExistsError(name: string) {
  return new ConvexError({ code: "entry_exists" as const, name });
}

export function isEntryExistsError(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data &&
    error.data.code === "entry_exists"
  );
}

/**
 * The ready entry occupying `nameKey` in a folder. Filesystem imports can
 * mirror case-variant duplicates that exist on disk, so more than one match
 * is tolerated and the first wins.
 */
export async function findReadyEntryByNameKey(
  ctx: DbCtx,
  folderId: Id<"folders">,
  nameKey: string,
  excludeEntryId?: Id<"entries">,
): Promise<Doc<"entries"> | null> {
  const matches = await ctx.db
    .query("entries")
    .withIndex("by_folderId_and_state_and_nameKey", (q) =>
      q.eq("folderId", folderId).eq("state", "ready").eq("nameKey", nameKey),
    )
    .take(4);
  return matches.find((entry) => entry._id !== excludeEntryId) ?? null;
}

/**
 * Name keys that in-flight work will occupy in the folder once it lands:
 * uploads past their claim and moves that are queued or running.
 */
export async function reservedNameKeys(
  ctx: DbCtx,
  folderId: Id<"folders">,
  exclude: {
    intentId?: Id<"uploadIntents">;
    jobId?: Id<"entryMoveJobs">;
  } = {},
): Promise<Set<string>> {
  const keys = new Set<string>();
  const intents = await ctx.db
    .query("uploadIntents")
    .withIndex("by_folderId_and_state", (q) =>
      q.eq("folderId", folderId).eq("state", "uploading"),
    )
    .take(MAX_RESERVATIONS);
  for (const intent of intents) {
    if (intent._id === exclude.intentId) continue;
    keys.add(entryNameKey(intent.resolvedName ?? intent.name));
  }
  for (const status of ["queued", "processing"] as const) {
    const jobs = await ctx.db
      .query("entryMoveJobs")
      .withIndex("by_destinationFolderId_and_status", (q) =>
        q.eq("destinationFolderId", folderId).eq("status", status),
      )
      .take(MAX_RESERVATIONS);
    for (const job of jobs) {
      if (job._id === exclude.jobId) continue;
      const name =
        job.targetName ?? (await ctx.db.get("entries", job.entryId))?.name;
      if (name !== undefined) keys.add(entryNameKey(name));
    }
  }
  return keys;
}

async function nameTaken(
  ctx: DbCtx,
  folderId: Id<"folders">,
  nameKey: string,
  reserved: Set<string>,
  excludeEntryId?: Id<"entries">,
): Promise<boolean> {
  return (
    reserved.has(nameKey) ||
    (await findReadyEntryByNameKey(ctx, folderId, nameKey, excludeEntryId)) !==
      null
  );
}

/**
 * First "name (n)" variant that is free. The pick is added to `reserved` so
 * later callers in the same transaction skip it.
 */
export async function pickAvailableName(
  ctx: DbCtx,
  folderId: Id<"folders">,
  name: string,
  reserved: Set<string>,
  excludeEntryId?: Id<"entries">,
): Promise<string> {
  for (let attempt = 2; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    const candidate = autoRenamedFileName(name, attempt);
    const key = entryNameKey(candidate);
    if (!(await nameTaken(ctx, folderId, key, reserved, excludeEntryId))) {
      reserved.add(key);
      return candidate;
    }
  }
  throw new Error(`Could not find a free name for ${name}`);
}

/**
 * Decides the final name for a file landing in a folder. Uploader galleries
 * allow duplicates, so the name passes through. In image galleries a taken
 * name either throws entry_exists (no policy), keeps the name and reports
 * the ready entry it replaces, or picks a free "(n)" variant.
 */
export async function resolveLandingName(
  ctx: DbCtx,
  input: {
    gallery: Doc<"galleries">;
    folderId: Id<"folders">;
    name: string;
    policy?: ConflictPolicy;
    excludeEntryId?: Id<"entries">;
    excludeIntentId?: Id<"uploadIntents">;
    excludeJobId?: Id<"entryMoveJobs">;
    /** Pass one set across a loop so picks made earlier in it are honored. */
    reserved?: Set<string>;
  },
): Promise<{ name: string; replaces: Doc<"entries"> | null }> {
  if (input.gallery.kind !== "image") {
    return { name: input.name, replaces: null };
  }
  const reserved =
    input.reserved ??
    (await reservedNameKeys(ctx, input.folderId, {
      intentId: input.excludeIntentId,
      jobId: input.excludeJobId,
    }));
  const nameKey = entryNameKey(input.name);
  const existing = await findReadyEntryByNameKey(
    ctx,
    input.folderId,
    nameKey,
    input.excludeEntryId,
  );
  if (existing === null && !reserved.has(nameKey)) {
    reserved.add(nameKey);
    return { name: input.name, replaces: null };
  }
  if (input.policy === undefined) {
    throw entryExistsError(input.name);
  }
  if (input.policy === "replace") {
    reserved.add(nameKey);
    return { name: input.name, replaces: existing };
  }
  return {
    name: await pickAvailableName(
      ctx,
      input.folderId,
      input.name,
      reserved,
      input.excludeEntryId,
    ),
    replaces: null,
  };
}
