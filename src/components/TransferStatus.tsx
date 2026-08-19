import { useState, useSyncExternalStore } from "react";
import { ArrowUpDown, Check, LoaderCircle, X } from "lucide-react";
import {
  clearFinishedTransfers,
  getTransfers,
  subscribeTransfers,
  type TransferItem,
} from "../lib/transfers";
import styles from "../styles/transfers.module.css";
import layout from "../styles/layout.module.css";

export function TransferStatus() {
  const items = useSyncExternalStore(subscribeTransfers, getTransfers);
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const activeItems = items.filter((item) => item.status === "active");
  const active = activeItems.length;
  const failed = items.filter((item) => item.status === "error").length;
  const verbFor = (subset: TransferItem[], tense: "active" | "done") =>
    subset.every((item) => item.kind === "delete")
      ? tense === "active"
        ? "deleting"
        : "deleted"
      : tense === "active"
        ? "transferring"
        : "transferred";
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
            disabled={active === items.length}
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
                disabled={active === items.length}
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
}

function TransferRow(props: { item: TransferItem }) {
  const item = props.item;
  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowName} title={item.name}>
          {item.name}
        </span>
        <span className={styles.rowKind}>{item.kind}</span>
        {item.status === "active" ? (
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
          <X
            className={styles.cross}
            aria-label="Failed"
            size={15}
            strokeWidth={3}
          />
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
                : { width: `${Math.round(item.progress * 100)}%` }
            }
          />
        </div>
      )}
    </li>
  );
}
