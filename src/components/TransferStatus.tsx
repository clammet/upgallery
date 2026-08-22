import { memo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowUpDown,
  Check,
  CircleAlert,
  Clock,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { anonymousClaim } from "../lib/authClient";
import {
  clearFinishedTransfers,
  getTransfers,
  resolveAllTransferConflicts,
  resolveTransferConflict,
  retryTransfer,
  skipAllTransferConflicts,
  subscribeTransfers,
  transferFinished,
  transferPending,
  type ConflictPolicy,
  type TransferItem,
  type TransferKind,
} from "../lib/transfers";
import { useBeforeUnloadGuard } from "../hooks/useBeforeUnloadGuard";
import styles from "../styles/transfers.module.css";
import layout from "../styles/layout.module.css";

type BulkOperation = FunctionReturnType<
  typeof api.bulkOperations.listMine
>[number];

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Client-side transfers: uploads and the folder operations this tab drives.
function transferSummary(items: TransferItem[]): string | null {
  const verbs: Record<TransferKind, [active: string, done: string]> = {
    upload: ["uploading", "uploaded"],
    delete: ["deleting", "deleted"],
    move: ["moving", "moved"],
  };
  const verbFor = (subset: TransferItem[], tense: 0 | 1) => {
    const kind = subset[0]?.kind;
    return kind !== undefined && subset.every((item) => item.kind === kind)
      ? verbs[kind][tense]
      : ["transferring", "transferred"][tense];
  };
  const counted = items.filter((item) => item.status !== "conflict");
  if (counted.length === 0) return null;
  const active = counted.filter(transferPending);
  const failed = counted.filter((item) => item.status === "error");
  if (active.length > 0) {
    return `${plural(active.length, "item")} ${verbFor(active, 0)}`;
  }
  if (failed.length > 0) {
    return `${failed.length} of ${plural(counted.length, "item")} failed`;
  }
  return `${plural(counted.length, "item")} ${verbFor(counted, 1)}`;
}

// Server-side bulk operations, which outlive the page.
function operationSummary(operations: BulkOperation[]): string | null {
  const active = operations.filter(
    (operation) =>
      operation.status === "queued" || operation.status === "processing",
  );
  const failed = operations.filter((operation) => operation.status === "failed");
  const finished = operations.filter(
    (operation) =>
      operation.status === "complete" || operation.status === "failed",
  );
  if (active.length > 0) {
    return `${plural(active.length, "bulk operation")} running`;
  }
  if (failed.length > 0) {
    return `${plural(failed.length, "bulk operation")} failed`;
  }
  if (finished.length > 0) {
    return `${plural(finished.length, "bulk operation")} complete`;
  }
  return null;
}

// Memoized with no props: the page that hosts it re-renders on every listing
// update, and without this every transfer row would render again each time.
export const TransferStatus = memo(function TransferStatus() {
  const items = useSyncExternalStore(subscribeTransfers, getTransfers);
  const operations =
    useQuery(api.bulkOperations.listMine, {
      anonymousClaim: anonymousClaim(),
    }) ?? [];
  const dismissFinished = useMutation(api.bulkOperations.dismissFinished);
  const resolveBulkConflicts = useMutation(api.bulkOperations.resolveConflicts);
  const resolveBulkConflict = useMutation(api.bulkOperations.resolveConflict);
  const [open, setOpen] = useState(false);
  // Uploads and client-driven filesystem steps die with the tab; queued
  // server-side work (moves, plain deletes) finishes without us.
  useBeforeUnloadGuard(
    items.some(
      (item) =>
        transferPending(item) &&
        (item.kind === "upload" || item.clientWork === true),
    ),
  );
  if (items.length === 0 && operations.length === 0) return null;

  const busy =
    items.some(transferPending) ||
    operations.some(
      (operation) =>
        operation.status === "queued" || operation.status === "processing",
    );
  const failed =
    items.some((item) => item.status === "error") ||
    operations.some((operation) => operation.status === "failed");
  const bulkConflicts = operations.reduce(
    (sum, operation) => sum + operation.conflictItems,
    0,
  );
  const conflicts =
    items.filter((item) => item.status === "conflict").length + bulkConflicts;
  const summary = [
    conflicts > 0
      ? `${plural(conflicts, "item")} already exist${conflicts === 1 ? "s" : ""}`
      : null,
    transferSummary(items),
    operationSummary(operations),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const resolveAll = (policy: ConflictPolicy) => {
    resolveAllTransferConflicts(policy);
    if (bulkConflicts > 0) {
      void resolveBulkConflicts({ anonymousClaim: anonymousClaim(), policy });
    }
  };
  const skipAll = () => {
    skipAllTransferConflicts();
    if (bulkConflicts > 0) {
      void resolveBulkConflicts({
        anonymousClaim: anonymousClaim(),
        policy: "skip",
      });
    }
  };
  // The same three choices sit in the bar and in the pane header.
  const conflictActions =
    conflicts > 0 ? (
      <ConflictAllActions onResolve={resolveAll} onSkip={skipAll} />
    ) : null;
  // "Clear" drops finished rows and finished operations only; in-progress
  // and parked ones stay, and the pane stays open while any remain.
  const clearable =
    items.some(transferFinished) ||
    operations.some(
      (operation) =>
        operation.status === "complete" || operation.status === "failed",
    );
  const clear = () => {
    clearFinishedTransfers();
    if (operations.length > 0) {
      void dismissFinished({ anonymousClaim: anonymousClaim() });
    }
    if (!busy && conflicts === 0) setOpen(false);
  };

  return (
    <>
      <div className={`${layout.notice} ${styles.bar}`}>
        <span className={failed && !busy ? styles.barFailed : undefined}>
          {summary}
        </span>
        <div className={styles.barActions}>
          {conflictActions}
          <button
            className={layout.iconButton}
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={open ? "Hide transfer details" : "Show transfer details"}
            title={open ? "Hide transfer details" : "Show transfer details"}
          >
            <ArrowUpDown aria-hidden="true" size={18} />
          </button>
          <button
            className={layout.iconButton}
            type="button"
            onClick={clear}
            disabled={busy || conflicts > 0 || !clearable}
            aria-label="Clear finished transfers"
            title="Clear finished transfers"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </div>
      {open ? (
        <aside className={styles.panel} aria-label="Transfers">
          <header className={styles.panelHeader}>
            <h2>Transfers</h2>
            <div className={styles.panelActions}>
              {conflictActions}
              <button type="button" onClick={clear} disabled={!clearable}>
                Clear
              </button>
              <button
                className={layout.iconButton}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close transfer panel"
                title="Close transfer panel"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
          </header>
          <ul className={styles.list}>
            {operations.map((operation) => (
              <BulkOperationRow
                key={operation._id}
                operation={operation}
                onResolve={(jobId, policy) =>
                  void resolveBulkConflict({
                    anonymousClaim: anonymousClaim(),
                    jobId,
                    policy,
                  })
                }
              />
            ))}
            {items.map((item) => (
              <TransferRow key={item.id} item={item} />
            ))}
          </ul>
        </aside>
      ) : null}
    </>
  );
});

// "Replace all" / "Auto rename all" / "Skip", shown while any conflict waits.
function ConflictAllActions(props: {
  onResolve: (policy: ConflictPolicy) => void;
  onSkip: () => void;
}) {
  return (
    <>
      <button
        className={styles.barButton}
        type="button"
        onClick={() => props.onResolve("replace")}
        title="Replace every item that already exists"
      >
        Replace all
      </button>
      <button
        className={styles.barButton}
        type="button"
        onClick={() => props.onResolve("rename")}
        title="Give every item that already exists a new name"
      >
        Auto rename all
      </button>
      <button
        className={styles.barButton}
        type="button"
        onClick={props.onSkip}
        title="Skip every item that already exists"
      >
        Skip
      </button>
    </>
  );
}

// Right-aligned per-item choices for a parked row; the row name truncates to
// leave room for them.
function ConflictActions(props: {
  name: string;
  onResolve: (policy: ConflictPolicy) => void;
}) {
  return (
    <span className={styles.rowActions}>
      <button
        className={styles.rowActionButton}
        type="button"
        onClick={() => props.onResolve("replace")}
        aria-label={`Replace the existing ${props.name}`}
      >
        Replace
      </button>
      <button
        className={styles.rowActionButton}
        type="button"
        onClick={() => props.onResolve("rename")}
        aria-label={`Auto rename ${props.name}`}
      >
        Auto rename
      </button>
    </span>
  );
}

function ProgressBar(props: { progress: number | null }) {
  return (
    <div
      className={styles.progressTrack}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        props.progress === null ? undefined : Math.round(props.progress * 100)
      }
    >
      <div
        className={
          props.progress === null
            ? `${styles.progressFill} ${styles.progressIndeterminate}`
            : styles.progressFill
        }
        style={
          props.progress === null
            ? undefined
            : { transform: `scaleX(${props.progress})` }
        }
      />
    </div>
  );
}

// Rows only change when their own item object does (progress, status), so a
// progress tick on one upload leaves the other rows untouched.
const TransferRow = memo(function TransferRow(props: { item: TransferItem }) {
  const item = props.item;
  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowName} title={item.name}>
          {item.name}
        </span>
        {item.status === "conflict" ? (
          <ConflictActions
            name={item.name}
            onResolve={(policy) => resolveTransferConflict(item.id, policy)}
          />
        ) : (
          <>
            <span className={styles.rowKind}>{item.kind}</span>
            {item.status === "queued" ? (
              <Clock className={styles.queued} aria-label="Queued" size={15} />
            ) : item.status === "active" ? (
              <LoaderCircle
                className={styles.spinner}
                aria-label="In progress"
                size={15}
              />
            ) : item.status === "success" ? (
              <Check
                className={styles.tick}
                aria-label="Done"
                size={15}
                strokeWidth={3}
              />
            ) : (
              <>
                {item.retry !== undefined ? (
                  <button
                    className={`${layout.iconButton} ${styles.retryButton}`}
                    type="button"
                    onClick={() => retryTransfer(item.id)}
                    aria-label={`Retry ${item.name}`}
                    title="Retry"
                  >
                    <RotateCw aria-hidden="true" size={14} />
                  </button>
                ) : null}
                <X
                  className={styles.cross}
                  aria-label="Failed"
                  size={15}
                  strokeWidth={3}
                />
              </>
            )}
          </>
        )}
      </div>
      {item.status === "error" || item.status === "conflict" ? (
        <p className={styles.rowError}>{item.error}</p>
      ) : (
        <ProgressBar progress={item.progress} />
      )}
    </li>
  );
});

const BulkOperationRow = memo(function BulkOperationRow(props: {
  operation: BulkOperation;
  onResolve: (jobId: Id<"entryMoveJobs">, policy: ConflictPolicy) => void;
}) {
  const operation = props.operation;
  const settled = operation.completedItems + operation.failedItems;
  const progress =
    operation.discoveryComplete && operation.totalItems > 0
      ? settled / operation.totalItems
      : operation.discoveryComplete
        ? 1
        : null;
  const running =
    operation.status === "queued" || operation.status === "processing";
  const unlisted = operation.conflictItems - operation.conflicts.length;
  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowName}>
          {operation.kind === "delete" ? "Delete files" : "Move files"}
        </span>
        <span className={styles.rowKind}>
          {operation.discoveryComplete
            ? `${settled} / ${operation.totalItems}`
            : `${settled} processed · finding files`}
        </span>
        {running ? (
          <LoaderCircle
            className={styles.spinner}
            aria-label="In progress"
            size={15}
          />
        ) : operation.status === "complete" ? (
          <Check
            className={styles.tick}
            aria-label="Done"
            size={15}
            strokeWidth={3}
          />
        ) : operation.status === "conflict" ? (
          <CircleAlert
            className={styles.cross}
            aria-label="Waiting on conflicts"
            size={15}
          />
        ) : (
          <X
            className={styles.cross}
            aria-label="Failed"
            size={15}
            strokeWidth={3}
          />
        )}
      </div>
      {operation.status === "failed" ? (
        <p className={styles.rowError}>
          {operation.failedItems} failed
          {operation.error ? `: ${operation.error}` : ""}
        </p>
      ) : operation.status === "conflict" ? (
        <p className={styles.rowError}>
          {plural(operation.conflictItems, "item")} already exist
          {operation.conflictItems === 1 ? "s" : ""}
        </p>
      ) : (
        <ProgressBar progress={progress} />
      )}
      {operation.conflicts.length > 0 ? (
        <ul className={styles.conflictList}>
          {operation.conflicts.map((conflict) => (
            <li className={styles.row} key={conflict.jobId}>
              <div className={styles.rowTop}>
                <span className={styles.rowName} title={conflict.name}>
                  {conflict.name}
                </span>
                <ConflictActions
                  name={conflict.name}
                  onResolve={(policy) => props.onResolve(conflict.jobId, policy)}
                />
              </div>
              <p className={styles.rowError}>Item exists</p>
            </li>
          ))}
          {unlisted > 0 ? (
            <li className={styles.rowKind}>and {plural(unlisted, "more item")}</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});
