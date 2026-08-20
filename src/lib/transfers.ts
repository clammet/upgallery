export type TransferKind = "upload" | "delete" | "move";
export type TransferItem = {
  id: number;
  name: string;
  kind: TransferKind;
  status: "active" | "success" | "error";
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

function emit() {
  for (const listener of listeners) listener();
}

function update(id: number, patch: Partial<TransferItem>) {
  items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
  emit();
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
  const id = nextId;
  nextId += 1;
  items = [...items, { id, name, kind, status: "active", progress }];
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
  update(id, { progress: next });
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
  const remaining = items.filter((item) => item.status === "active");
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
