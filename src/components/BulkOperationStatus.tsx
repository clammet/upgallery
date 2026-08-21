import { memo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowUpDown, Check, LoaderCircle, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { anonymousClaim } from "../lib/authClient";
import styles from "../styles/transfers.module.css";
import layout from "../styles/layout.module.css";

// Memoized with no props so the hosting page's re-renders do not reach it.
export const BulkOperationStatus = memo(function BulkOperationStatus() {
  const operations = useQuery(api.bulkOperations.listMine, {
    anonymousClaim: anonymousClaim(),
  });
  const dismissFinished = useMutation(api.bulkOperations.dismissFinished);
  const [open, setOpen] = useState(false);
  if (operations === undefined || operations.length === 0) return null;

  const active = operations.filter(
    (operation) =>
      operation.status === "queued" || operation.status === "processing",
  );
  const failed = operations.filter(
    (operation) => operation.status === "failed",
  );
  const summary =
    active.length > 0
      ? `${active.length} bulk operation${active.length === 1 ? "" : "s"} running`
      : failed.length > 0
        ? `${failed.length} bulk operation${failed.length === 1 ? "" : "s"} failed`
        : `${operations.length} bulk operation${operations.length === 1 ? "" : "s"} complete`;

  return (
    <>
      <div className={`${layout.notice} ${styles.bar}`}>
        <span>{summary}</span>
        <div className={styles.barActions}>
          <button
            className={layout.iconButton}
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={open ? "Hide bulk operation details" : "Show bulk operation details"}
            title={open ? "Hide bulk operation details" : "Show bulk operation details"}
          >
            <ArrowUpDown aria-hidden="true" size={18} />
          </button>
          <button
            className={layout.iconButton}
            type="button"
            disabled={active.length > 0}
            onClick={() => {
              void dismissFinished({ anonymousClaim: anonymousClaim() });
              setOpen(false);
            }}
            aria-label="Clear finished bulk operations"
            title="Clear finished bulk operations"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </div>
      {open ? (
        <aside className={styles.panel} aria-label="Bulk operations">
          <header className={styles.panelHeader}>
            <h2>Bulk operations</h2>
            <button
              className={layout.iconButton}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close bulk operation panel"
              title="Close"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </header>
          <ul className={styles.list}>
            {operations.map((operation) => {
              const settled =
                operation.completedItems + operation.failedItems;
              const progress =
                operation.discoveryComplete && operation.totalItems > 0
                  ? settled / operation.totalItems
                  : operation.discoveryComplete
                    ? 1
                    : null;
              return (
                <li className={styles.row} key={operation._id}>
                  <div className={styles.rowTop}>
                    <span className={styles.rowName}>
                      {operation.kind === "delete" ? "Delete files" : "Move files"}
                    </span>
                    <span className={styles.rowKind}>
                      {operation.discoveryComplete
                        ? `${settled} / ${operation.totalItems}`
                        : `${settled} processed · finding files`}
                    </span>
                    {operation.status === "queued" ||
                    operation.status === "processing" ? (
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
                  ) : (
                    <div
                      className={styles.progressTrack}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={
                        progress === null ? undefined : Math.round(progress * 100)
                      }
                    >
                      <div
                        className={
                          progress === null
                            ? `${styles.progressFill} ${styles.progressIndeterminate}`
                            : styles.progressFill
                        }
                        style={
                          progress === null
                            ? undefined
                            : { width: `${Math.round(progress * 100)}%` }
                        }
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      ) : null}
    </>
  );
});
