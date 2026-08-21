import { memo, useState, useSyncExternalStore } from "react";
import {
  ArrowUpDown,
  Check,
  Clock,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import {
  clearFinishedTransfers,
  getTransfers,
  retryTransfer,
  subscribeTransfers,
  transferPending,
  type TransferItem,
  type TransferKind,
} from "../lib/transfers";
import { useBeforeUnloadGuard } from "../hooks/useBeforeUnloadGuard";
import styles from "../styles/transfers.module.css";
import layout from "../styles/layout.module.css";

// Memoized with no props: the page that hosts it re-renders on every listing
// update, and without this every transfer row would render again each time.
export const TransferStatus = memo(function TransferStatus() {
  const items = useSyncExternalStore(subscribeTransfers, getTransfers);
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
  if (items.length === 0) return null;
  const activeItems = items.filter(transferPending);
  const active = activeItems.length;
  const failed = items.filter((item) => item.status === "error").length;
  const verbFor = (subset: TransferItem[], tense: "active" | "done") => {
    const verbs: Record<TransferKind, [active: string, done: string]> = {
      upload: ["uploading", "uploaded"],
      delete: ["deleting", "deleted"],
      move: ["moving", "moved"],
    };
    const kind = subset[0]?.kind;
    const uniform =
      kind !== undefined && subset.every((item) => item.kind === kind)
        ? verbs[kind]
        : (["transferring", "transferred"] as const);
    return uniform[tense === "active" ? 0 : 1];
  };
  const summary =
    active > 0
      ? `${active} item${active === 1 ? "" : "s"} ${verbFor(activeItems, "active")}`
      : failed > 0
        ? `${failed} of ${items.length} item${items.length === 1 ? "" : "s"} failed`
        : `${items.length} item${items.length === 1 ? "" : "s"} ${verbFor(items, "done")}`;
  return (
    <>
      <div className={`${layout.notice} ${styles.bar}`}>
        <span className={failed > 0 && active === 0 ? styles.barFailed : undefined}>
          {summary}
        </span>
        <div className={styles.barActions}>
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
            onClick={() => {
              clearFinishedTransfers();
              setOpen(false);
            }}
            disabled={active > 0}
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
              <button
                type="button"
                onClick={clearFinishedTransfers}
                disabled={active > 0}
              >
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
            {items.map((item) => (
              <TransferRow key={item.id} item={item} />
            ))}
          </ul>
        </aside>
      ) : null}
    </>
  );
});

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
      </div>
      {item.status === "error" ? (
        <p className={styles.rowError}>{item.error}</p>
      ) : (
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            item.progress === null
              ? undefined
              : Math.round(item.progress * 100)
          }
        >
          <div
            className={
              item.progress === null
                ? `${styles.progressFill} ${styles.progressIndeterminate}`
                : styles.progressFill
            }
            style={
              item.progress === null
                ? undefined
                : { transform: `scaleX(${item.progress})` }
            }
          />
        </div>
      )}
    </li>
  );
});
