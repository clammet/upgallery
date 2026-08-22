export type TransferKind = "upload" | "delete" | "move";
/** How one parked item proceeds. */
export type ConflictPolicy = "replace" | "rename";
/** What a batch does with conflicts: a policy, or skip them. */
export type ConflictChoice = ConflictPolicy | "skip";
export type TransferItem = {
  id: number;
  name: string;
  kind: TransferKind;
  /**
   * Queued items wait for a free slot; conflict items wait for the user to
   * pick a policy. Neither counts as finished, but only queued and active
   * items are pending work.
   */
  status: "queued" | "active" | "success" | "error" | "conflict";
  /** 0..1 fraction, or null for operations without measurable progress. */
  progress: number | null;
  error?: string;
  /** Re-attempts the failed operation; present when the failure is retryable. */
  retry?: () => void;
  /** Re-runs the operation under a policy; present on conflict rows. */
  resolve?: (policy: ConflictPolicy) => void;
  /**
   * True once the operation needs this tab's JavaScript to finish (beyond a
   * fire-and-forget server mutation), so closing the page would strand it.
   */
  clientWork?: boolean;
};

let nextId = 1;
let items: TransferItem[] = [];
const listeners = new Set<() => void>();
// Batches still queuing work register here so "Replace all" / "Auto rename
// all" / "Skip" also covers the items they have not started yet.
const batchPolicyListeners = new Set<(choice: ConflictChoice) => void>();

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

/** Shows the name the item ended up with (an auto-renamed upload). */
export function renameTransfer(id: number, name: string): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.name === name) return;
  update(id, { name });
}

export function completeTransfer(id: number): void {
  update(id, { status: "success", progress: 1 });
}

export function failTransfer(
  id: number,
  error: string,
  retry?: () => void,
): void {
  update(id, { status: "error", error, retry, resolve: undefined });
}

/**
 * Parks the item because the destination already holds its name. `resolve`
 * re-runs it under the chosen policy; until then the row shows "Item exists"
 * with Replace / Auto rename. Only "Skip" drops parked rows.
 */
export function conflictTransfer(
  id: number,
  resolve: (policy: ConflictPolicy) => void,
): void {
  update(id, {
    status: "conflict",
    error: "Item exists",
    retry: undefined,
    resolve,
    progress: 0,
  });
}

export function resolveTransferConflict(
  id: number,
  policy: ConflictPolicy,
): void {
  const current = items.find((item) => item.id === id);
  if (current === undefined || current.status !== "conflict") return;
  const resolve = current.resolve;
  if (resolve === undefined) return;
  update(id, {
    status: "queued",
    error: undefined,
    resolve: undefined,
    progress: 0,
  });
  resolve(policy);
}

/**
 * Lets a batch adopt the choice made by "Replace all" / "Auto rename all" /
 * "Skip" for the items it has not started yet. Returns the unregister
 * function.
 */
export function registerConflictBatch(
  onChoice: (choice: ConflictChoice) => void,
): () => void {
  batchPolicyListeners.add(onChoice);
  return () => {
    batchPolicyListeners.delete(onChoice);
  };
}

/** Applies one policy to every parked item and every running batch. */
export function resolveAllTransferConflicts(policy: ConflictPolicy): void {
  for (const listener of batchPolicyListeners) listener(policy);
  for (const item of items) {
    if (item.status === "conflict") resolveTransferConflict(item.id, policy);
  }
}

/**
 * Drops every parked item and tells running batches to skip conflicts from
 * now on. The files are simply not uploaded; nothing else changes.
 */
export function skipAllTransferConflicts(): void {
  for (const listener of batchPolicyListeners) listener("skip");
  discardTransfers(
    items.filter((item) => item.status === "conflict").map((item) => item.id),
  );
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

/** True for rows "Clear" may drop: done or failed, neither pending nor parked. */
export function transferFinished(item: TransferItem): boolean {
  return item.status === "success" || item.status === "error";
}

export function clearFinishedTransfers(): void {
  const remaining = items.filter((item) => !transferFinished(item));
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

export type WorkQueue = {
  /** Runs the job once a slot is free; jobs start in push order. */
  push: (job: () => Promise<void>) => void;
  /** Resolves once nothing is queued or running. */
  drain: () => Promise<void>;
};

/**
 * Keeps at most `limit` jobs in flight. Unlike a one-shot worker pool it
 * accepts jobs at any time, so items re-run after a conflict is resolved
 * wait for a slot like the rest.
 */
export function createWorkQueue(limit: number): WorkQueue {
  const pending: Array<() => Promise<void>> = [];
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  const pump = () => {
    while (inFlight < Math.max(1, limit) && pending.length > 0) {
      const job = pending.shift()!;
      inFlight += 1;
      void Promise.resolve()
        .then(job)
        .catch(() => undefined)
        .then(() => {
          inFlight -= 1;
          pump();
        });
    }
    if (inFlight === 0 && pending.length === 0) {
      for (const resolve of waiting.splice(0)) resolve();
    }
  };
  return {
    push(job) {
      pending.push(job);
      pump();
    },
    drain() {
      if (inFlight === 0 && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}
