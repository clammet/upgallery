// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { idlePollDelay, WorkerWakeups } from "../storage/polling";

afterEach(() => vi.useRealTimers());

test("idle polling backs off with bounded jitter and a maximum no lower than its base", () => {
  expect([1, 2, 3, 100].map(attempt => idlePollDelay(attempt, 1000, 4000, () => 1)))
    .toEqual([1000, 2000, 4000, 4000]);
  expect(idlePollDelay(100, 1000, 4000, () => 0)).toBe(3000);
  expect(idlePollDelay(100, 5000, 4000, () => 1)).toBe(5000);
  expect(idlePollDelay(1, 1000, 4000, () => 1)).toBe(1000);
});

test("work wakes all waiting lanes and does not lose a wake during a claim", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkerWakeups();
  const controller = new AbortController();
  const version = wakeups.version;
  const first = wakeups.wait(4000, controller.signal, version);
  const second = wakeups.wait(4000, controller.signal, version);
  expect(vi.getTimerCount()).toBe(2);
  wakeups.wake();
  await Promise.all([first, second]);
  expect(vi.getTimerCount()).toBe(0);
  await wakeups.wait(4000, controller.signal, version);
  expect(vi.getTimerCount()).toBe(0);
});

test("idle waits time out and shutdown removes pending timers", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkerWakeups();
  const controller = new AbortController();
  const timed = wakeups.wait(1000, controller.signal, wakeups.version);
  await vi.advanceTimersByTimeAsync(1000);
  await timed;
  const pending = wakeups.wait(4000, controller.signal, wakeups.version);
  const rejection = expect(pending).rejects.toThrow("shutdown");
  controller.abort(new Error("shutdown"));
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});
