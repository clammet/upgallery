/** Idle workers back off independently, with jitter to avoid synchronized claims. */
export function idlePollDelay(
  emptyAttempts: number,
  baseMs: number,
  maximumMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    Math.max(baseMs, maximumMs),
    baseMs * 2 ** Math.min(16, Math.max(0, emptyAttempts - 1)),
  );
  return Math.round(ceiling * (0.75 + 0.25 * random()));
}

/** Work discovered by one lane wakes the other lanes in the same process. */
export class WorkerWakeups {
  version = 0;
  private listeners = new Set<() => void>();

  wake() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  async wait(ms: number, signal: AbortSignal, observedVersion: number) {
    signal.throwIfAborted();
    if (observedVersion !== this.version) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(onWake);
        signal.removeEventListener("abort", onAbort);
      };
      const onWake = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(onWake, ms);
      timer.unref();
      this.listeners.add(onWake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
