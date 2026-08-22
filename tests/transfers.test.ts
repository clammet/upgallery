import { describe, expect, it, vi } from "vitest";
import {
  beginTransfer,
  skipAllTransferConflicts,
  clearFinishedTransfers,
  completeTransfer,
  conflictTransfer,
  createWorkQueue,
  discardTransfers,
  failTransfer,
  getTransfers,
  markTransferClientWork,
  parseTransferConcurrency,
  queueTransfer,
  registerConflictBatch,
  renameTransfer,
  reportTransferProgress,
  resolveAllTransferConflicts,
  resolveTransferConflict,
  retryTransfer,
  startTransfer,
  subscribeTransfers,
  transferPending,
  type ConflictPolicy,
} from "../src/lib/transfers";

describe("transfers store", () => {
  it("tracks a transfer through progress to completion", () => {
    const id = beginTransfer("photo.jpg", "upload");
    let item = getTransfers().find((candidate) => candidate.id === id);
    expect(item).toMatchObject({ status: "active", progress: 0 });

    reportTransferProgress(id, 0.5);
    item = getTransfers().find((candidate) => candidate.id === id);
    expect(item?.progress).toBe(0.5);

    completeTransfer(id);
    item = getTransfers().find((candidate) => candidate.id === id);
    expect(item).toMatchObject({ status: "success", progress: 1 });
  });

  it("skips sub-percent progress updates but always applies completion", () => {
    const id = beginTransfer("large.bin", "upload");
    reportTransferProgress(id, 0.5);
    const before = getTransfers();
    reportTransferProgress(id, 0.505);
    expect(getTransfers()).toBe(before);
    reportTransferProgress(id, 1);
    expect(
      getTransfers().find((candidate) => candidate.id === id)?.progress,
    ).toBe(1);
  });

  it("records failures and clears only finished items", () => {
    const failedId = beginTransfer("broken.png", "upload");
    const activeId = beginTransfer("pending.png", "delete", null);
    failTransfer(failedId, "Upload failed");
    expect(
      getTransfers().find((candidate) => candidate.id === failedId),
    ).toMatchObject({ status: "error", error: "Upload failed" });

    clearFinishedTransfers();
    const remaining = getTransfers();
    expect(
      remaining.find((candidate) => candidate.id === failedId),
    ).toBeUndefined();
    expect(
      remaining.find((candidate) => candidate.id === activeId),
    ).toMatchObject({ status: "active", progress: null });
  });

  it("discards only the specified transfer rows", () => {
    const discardedId = beginTransfer("no-op.jpg", "move", null);
    const remainingId = beginTransfer("moving.jpg", "move", null);

    discardTransfers([discardedId]);

    expect(
      getTransfers().find((candidate) => candidate.id === discardedId),
    ).toBeUndefined();
    expect(
      getTransfers().find((candidate) => candidate.id === remainingId),
    ).toBeDefined();
  });

  it("reactivates a failed transfer and invokes its retry callback", () => {
    const id = beginTransfer("flaky.jpg", "upload");
    reportTransferProgress(id, 0.6);
    let attempts = 0;
    failTransfer(id, "Network error", () => {
      attempts += 1;
    });
    retryTransfer(id);
    expect(attempts).toBe(1);
    const item = getTransfers().find((candidate) => candidate.id === id);
    expect(item).toMatchObject({ status: "active", progress: 0 });
    expect(item?.error).toBeUndefined();
  });

  it("ignores retries for non-retryable or finished transfers", () => {
    const plainId = beginTransfer("plain.jpg", "upload");
    failTransfer(plainId, "boom");
    retryTransfer(plainId);
    expect(
      getTransfers().find((candidate) => candidate.id === plainId)?.status,
    ).toBe("error");

    const doneId = beginTransfer("done.jpg", "upload");
    completeTransfer(doneId);
    retryTransfer(doneId);
    expect(
      getTransfers().find((candidate) => candidate.id === doneId)?.status,
    ).toBe("success");
  });

  it("marks client-driven work and keeps the flag through a retry", () => {
    const id = beginTransfer("folder", "delete", null);
    markTransferClientWork(id);
    expect(
      getTransfers().find((candidate) => candidate.id === id)?.clientWork,
    ).toBe(true);
    failTransfer(id, "rmdir failed", () => undefined);
    retryTransfer(id);
    expect(
      getTransfers().find((candidate) => candidate.id === id),
    ).toMatchObject({ status: "active", clientWork: true });
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    let notified = 0;
    const unsubscribe = subscribeTransfers(() => {
      notified += 1;
    });
    const id = beginTransfer("notify.txt", "upload");
    expect(notified).toBe(1);
    unsubscribe();
    completeTransfer(id);
    expect(notified).toBe(1);
  });

  it("keeps queued transfers pending until they start", () => {
    const id = queueTransfer("later.jpg", "upload");
    const find = () => getTransfers().find((candidate) => candidate.id === id);
    expect(find()).toMatchObject({ status: "queued", progress: 0 });
    expect(transferPending(find()!)).toBe(true);

    clearFinishedTransfers();
    expect(find()).toBeDefined();

    // Progress before start is ignored: nothing is running yet.
    reportTransferProgress(id, 0.5);
    expect(find()?.progress).toBe(0);

    startTransfer(id);
    expect(find()?.status).toBe("active");
    startTransfer(id);
    reportTransferProgress(id, 0.5);
    expect(find()?.progress).toBe(0.5);
    completeTransfer(id);
    expect(transferPending(find()!)).toBe(false);
  });

  it("coalesces progress notifications into one per frame", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 16) as unknown as number,
    );
    try {
      let notified = 0;
      const unsubscribe = subscribeTransfers(() => {
        notified += 1;
      });
      const id = beginTransfer("big.bin", "upload");
      expect(notified).toBe(1);

      reportTransferProgress(id, 0.2);
      reportTransferProgress(id, 0.4);
      // The store is current immediately; only the notification waits.
      expect(
        getTransfers().find((candidate) => candidate.id === id)?.progress,
      ).toBe(0.4);
      expect(notified).toBe(1);
      vi.runAllTimers();
      expect(notified).toBe(2);

      // A status change notifies at once and supersedes the pending frame.
      reportTransferProgress(id, 0.6);
      completeTransfer(id);
      expect(notified).toBe(3);
      vi.runAllTimers();
      expect(notified).toBe(3);
      unsubscribe();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("ignores progress reports for finished transfers", () => {
    const id = beginTransfer("done.txt", "upload");
    completeTransfer(id);
    reportTransferProgress(id, 0.2);
    expect(
      getTransfers().find((candidate) => candidate.id === id),
    ).toMatchObject({ status: "success", progress: 1 });
  });

  it("parks a conflict until a policy re-runs it, and Clear leaves it alone", () => {
    const id = beginTransfer("dupe.jpg", "upload");
    const find = () => getTransfers().find((candidate) => candidate.id === id);
    const chosen: ConflictPolicy[] = [];
    conflictTransfer(id, (policy) => chosen.push(policy));
    expect(find()).toMatchObject({
      status: "conflict",
      error: "Item exists",
      progress: 0,
    });
    expect(transferPending(find()!)).toBe(false);

    resolveTransferConflict(id, "rename");
    expect(chosen).toEqual(["rename"]);
    expect(find()).toMatchObject({ status: "queued", progress: 0 });
    expect(find()?.error).toBeUndefined();
    expect(find()?.resolve).toBeUndefined();
    // A second resolution is a no-op: the row is no longer parked.
    resolveTransferConflict(id, "replace");
    expect(chosen).toEqual(["rename"]);

    const parkedId = beginTransfer("other.jpg", "upload");
    conflictTransfer(parkedId, () => undefined);
    const doneId = beginTransfer("done.jpg", "upload");
    completeTransfer(doneId);
    clearFinishedTransfers();
    expect(
      getTransfers().find((candidate) => candidate.id === parkedId),
    ).toMatchObject({ status: "conflict" });
    expect(
      getTransfers().find((candidate) => candidate.id === doneId),
    ).toBeUndefined();
    expect(find()).toBeDefined();
    skipAllTransferConflicts();
    expect(
      getTransfers().find((candidate) => candidate.id === parkedId),
    ).toBeUndefined();
  });

  it("applies an all-items policy to parked rows and registered batches", () => {
    const batchPolicies: ConflictPolicy[] = [];
    const unregister = registerConflictBatch((policy) =>
      batchPolicies.push(policy),
    );
    const chosen: ConflictPolicy[] = [];
    const first = beginTransfer("a.jpg", "upload");
    const second = beginTransfer("b.jpg", "upload");
    conflictTransfer(first, (policy) => chosen.push(policy));
    conflictTransfer(second, (policy) => chosen.push(policy));

    resolveAllTransferConflicts("replace");
    expect(chosen).toEqual(["replace", "replace"]);
    expect(batchPolicies).toEqual(["replace"]);

    // Skip tells batches to skip from now on and drops parked rows.
    const third = beginTransfer("c.jpg", "upload");
    conflictTransfer(third, (policy) => chosen.push(policy));
    skipAllTransferConflicts();
    expect(batchPolicies).toEqual(["replace", "skip"]);
    expect(chosen).toEqual(["replace", "replace"]);
    expect(
      getTransfers().find((candidate) => candidate.id === third),
    ).toBeUndefined();

    unregister();
    resolveAllTransferConflicts("rename");
    expect(batchPolicies).toEqual(["replace", "skip"]);
    completeTransfer(first);
    completeTransfer(second);
  });

  it("renames a row to the name it ended up with", () => {
    const id = beginTransfer("photo.jpg", "upload");
    const before = getTransfers();
    renameTransfer(id, "photo.jpg");
    expect(getTransfers()).toBe(before);
    renameTransfer(id, "photo (2).jpg");
    expect(
      getTransfers().find((candidate) => candidate.id === id)?.name,
    ).toBe("photo (2).jpg");
  });
});

describe("parseTransferConcurrency", () => {
  it("defaults to 2 when unset or invalid", () => {
    expect(parseTransferConcurrency(undefined)).toBe(2);
    expect(parseTransferConcurrency("")).toBe(2);
    expect(parseTransferConcurrency("banana")).toBe(2);
    expect(parseTransferConcurrency("0")).toBe(2);
    expect(parseTransferConcurrency("-3")).toBe(2);
  });

  it("accepts explicit values and caps them at 8", () => {
    expect(parseTransferConcurrency("1")).toBe(1);
    expect(parseTransferConcurrency("4")).toBe(4);
    expect(parseTransferConcurrency("50")).toBe(8);
  });
});

describe("createWorkQueue", () => {
  it("runs every job while keeping at most `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const queue = createWorkQueue(2);
    for (const task of [1, 2, 3, 4, 5]) {
      queue.push(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        done.push(task);
      });
    }
    await queue.drain();
    expect(done.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("drains immediately when idle, survives rejected jobs, and accepts late jobs", async () => {
    const queue = createWorkQueue(8);
    await queue.drain();
    const seen: string[] = [];
    queue.push(() => Promise.reject(new Error("no")));
    queue.push(async () => {
      seen.push("only");
    });
    await queue.drain();
    expect(seen).toEqual(["only"]);
    // Work pushed after a drain (a resolved conflict) still runs.
    queue.push(async () => {
      seen.push("later");
    });
    await queue.drain();
    expect(seen).toEqual(["only", "later"]);
  });
});
