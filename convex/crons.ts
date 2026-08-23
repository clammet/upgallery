import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "cleanup expired auth sessions",
  { hours: 24 },
  internal.authMaintenance.cleanupExpiredSessions,
  {},
);

crons.interval(
  "dismiss stale bulk operations",
  { minutes: 15 },
  internal.bulkOperations.dismissStale,
  {},
);

crons.interval(
  "cleanup expired download tickets",
  { minutes: 15 },
  internal.ticketMaintenance.cleanupExpired,
  {},
);

export default crons;
