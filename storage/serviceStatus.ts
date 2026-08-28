import { callConvex } from "./convex.js";
import { config } from "./config.js";

const REPORT_INTERVAL_MS = 60_000;

// Periodically tells Convex this process is alive and which commit it runs,
// for the admin System panel. Failures are ignored: Convex being briefly
// unreachable is already surfaced by the readiness probes, and the reader
// treats a silent process as stale on its own.
export function startServiceStatusReporter(
  component: "storage-api" | "storage-worker",
): void {
  const report = () =>
    callConvex("/internal/storage/report-service-status", {
      component,
      commit: config.gitCommit || undefined,
    }).catch(() => undefined);
  void report();
  const timer = setInterval(() => void report(), REPORT_INTERVAL_MS);
  timer.unref();
}
