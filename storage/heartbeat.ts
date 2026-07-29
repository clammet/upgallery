export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

export async function runWithHeartbeat<T>(input: {
  signal: AbortSignal;
  timeoutMs: number;
  heartbeatIntervalMs: number;
  renew: () => Promise<unknown>;
  task: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Storage task exceeded ${input.timeoutMs}ms`));
  }, input.timeoutMs);
  timeout.unref();
  const forwardAbort = () => controller.abort(abortReason(input.signal));
  input.signal.addEventListener("abort", forwardAbort, { once: true });

  let renewing = false;
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    void input
      .renew()
      .catch((error: unknown) => {
        heartbeatError = error;
        controller.abort(error);
      })
      .finally(() => {
        renewing = false;
      });
  }, input.heartbeatIntervalMs);
  heartbeat.unref();

  try {
    const result = await input.task(controller.signal);
    if (heartbeatError !== undefined) throw heartbeatError;
    if (controller.signal.aborted) throw abortReason(controller.signal);
    return result;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", forwardAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Storage operation aborted");
}
