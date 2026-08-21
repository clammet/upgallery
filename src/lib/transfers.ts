export type TransferKind = "upload" | "delete" | "move";
export type TransferItem = {
  id: number;
  name: string;
  kind: TransferKind;
  /** Queued items wait for a free slot; they are pending but not yet running. */
  status: "queued" | "active" | "success" | "error";
  /** 0..1 fraction, or null for operations without measurable progress. */
  progress: number | null;
  error?: string;
  /** Re-attempts the failed operation; present when the failure is retryable. */
  retry?: () => void;
  /**
   * True once the operation needs this tab's JavaScript to finish (beyond a
   * fire-and-forget server mutation), so closing the page would strand it.
   */
  clientWork?: boolean;
};

let nextId = 1;
let items: TransferItem[] = [];
const listeners = new Set<() => void>();

let emitScheduled = false;

function emit() {
  emitScheduled = false;
  for (const listener of listeners) listener();
}

/**
 * Notifies at most once per animation frame. Upload progress events arrive
 * many times per second per request; the store updates synchronously so
 * readers never see stale data, only the React re-render is coalesced.
 */
function scheduleEmit() {
  if (emitScheduled) return;
  emitScheduled = true;
  const run = () => {
    if (emitScheduled) emit();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

function update(
  id: number,
  patch: Partial<TransferItem>,
  options: { coalesce?: boolean } = {},
) {
  items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
  if (options.coalesce === true) scheduleEmit();
  else emit();
}

/** True while the item still has work ahead of it (queued or running). */
export function transferPending(item: TransferItem): boolean {
  return item.status === "queued" || item.status === "active";
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTransfers(): TransferItem[] {
  return items;
}

export function beginTransfer(
  name: string,
  kind: TransferKind,
  progress: number | null = 0,
): number {
  return addTransfer(name, kind, "active", progress);
}

/**
 * Registers a transfer that is waiting for a concurrency slot. Call
 * `startTransfer` when it begins running.
 */
export function queueTransfer(
  name: string,
  kind: TransferKind,
  progress: number | null = 0,
): number {
  return addTransfer(name, kind, "queued", progress);
}

export function startTransfer(id: number): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.status !== "queued") return;
  update(id, { status: "active" });
}

function addTransfer(
  name: string,
  kind: TransferKind,
  status: "queued" | "active",
  progress: number | null,
): number {
  const id = nextId;
  nextId += 1;
  items = [...items, { id, name, kind, status, progress }];
  emit();
  return id;
}

export function reportTransferProgress(id: number, progress: number): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.status !== "active") return;
  const next = Math.min(progress, 1);
  // Skip sub-percent updates so network chunks don't spam re-renders.
  if (
    current.progress !== null &&
    next < 1 &&
    next - current.progress < 0.01
  ) {
    return;
  }
  update(id, { progress: next }, { coalesce: true });
}

export function markTransferClientWork(id: number): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.clientWork === true) return;
  update(id, { clientWork: true });
}

export function completeTransfer(id: number): void {
  update(id, { status: "success", progress: 1 });
}

export function failTransfer(
  id: number,
  error: string,
  retry?: () => void,
): void {
  update(id, { status: "error", error, retry });
}

export function retryTransfer(id: number): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.status !== "error") return;
  const retry = current.retry;
  if (retry === undefined) return;
  update(id, {
    status: "active",
    error: undefined,
    retry: undefined,
    progress: current.progress === null ? null : 0,
  });
  retry();
}

export function clearFinishedTransfers(): void {
  const remaining = items.filter(transferPending);
  if (remaining.length === items.length) return;
  items = remaining;
  emit();
}

export function discardTransfers(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const discardedIds = new Set(ids);
  const remaining = items.filter((item) => !discardedIds.has(item.id));
  if (remaining.length === items.length) return;
  items = remaining;
  emit();
}

const DEFAULT_TRANSFER_CONCURRENCY = 2;
const MAX_TRANSFER_CONCURRENCY = 8;

export function parseTransferConcurrency(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_TRANSFER_CONCURRENCY;
  }
  return Math.min(parsed, MAX_TRANSFER_CONCURRENCY);
}

/** Runs worker over every item, keeping at most `limit` calls in flight. */
export async function runWithConcurrency<T>(
  tasks: readonly T[],
  limit: number,
  worker: (task: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, tasks.length)) },
      async () => {
        while (index < tasks.length) {
          const task = tasks[index];
          index += 1;
          await worker(task);
        }
      },
    ),
  );
}
