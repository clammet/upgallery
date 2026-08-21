import { describe, expect, it, vi } from "vitest";
import {
  beginTransfer,
  clearFinishedTransfers,
  completeTransfer,
  discardTransfers,
  failTransfer,
  getTransfers,
  markTransferClientWork,
  parseTransferConcurrency,
  queueTransfer,
  reportTransferProgress,
  retryTransfer,
  runWithConcurrency,
  startTransfer,
  subscribeTransfers,
  transferPending,
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

describe("runWithConcurrency", () => {
  it("processes every task while keeping at most `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (task) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      done.push(task);
    });
    expect(done.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("handles an empty task list and limits above the task count", async () => {
    await runWithConcurrency([], 4, () => Promise.reject(new Error("no")));
    const seen: string[] = [];
    await runWithConcurrency(["only"], 8, async (task) => {
      seen.push(task);
    });
    expect(seen).toEqual(["only"]);
  });
});
