import { describe, expect, test } from "vitest";
import { AsyncSemaphore, CapacityError } from "../storage/concurrency";

describe("storage concurrency limits", () => {
  test("bounds active and queued work", async () => {
    const semaphore = new AsyncSemaphore(1, 1);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const task = async (gate: Promise<void>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
    };

    const first = semaphore.run(() => task(firstGate));
    await Promise.resolve();
    const second = semaphore.run(() => task(secondGate));
    await Promise.resolve();

    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.queuedCount).toBe(1);

    await expect(semaphore.run(async () => undefined)).rejects.toBeInstanceOf(
      CapacityError,
    );

    releaseFirst();
    await first;
    releaseSecond();
    await second;
    expect(maximumActive).toBe(1);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.queuedCount).toBe(0);
  });
});
