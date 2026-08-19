export type TransferKind = "upload" | "delete";
export type TransferItem = {
  id: number;
  name: string;
  kind: TransferKind;
  status: "active" | "success" | "error";
  /** 0..1 fraction, or null for operations without measurable progress. */
  progress: number | null;
  error?: string;
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

export function completeTransfer(id: number): void {
  update(id, { status: "success", progress: 1 });
}

export function failTransfer(id: number, error: string): void {
  update(id, { status: "error", error });
}

export function clearFinishedTransfers(): void {
  items = items.filter((item) => item.status === "active");
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
