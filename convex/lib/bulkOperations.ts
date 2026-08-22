import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type OperationCounts = {
  discoveryComplete: boolean;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  conflictItems: number;
};

// Items are either still moving, done, failed, or parked on a name conflict.
// Parked items hold the operation in "conflict" (nothing is running, but it
// is not over) until a policy resolves them or the operation is dismissed.
export function operationStatus(
  counts: OperationCounts,
): "processing" | "complete" | "failed" | "conflict" {
  const settled =
    counts.completedItems + counts.failedItems + counts.conflictItems;
  if (!counts.discoveryComplete || settled < counts.totalItems) {
    return "processing";
  }
  if (counts.conflictItems > 0) return "conflict";
  return counts.failedItems > 0 ? "failed" : "complete";
}

export async function settleBulkMoveItem(
  ctx: MutationCtx,
  operationId: Id<"bulkOperations"> | undefined,
  result: { success: boolean; error?: string },
) {
  if (operationId === undefined) return;
  const operation = await ctx.db.get("bulkOperations", operationId);
  if (
    operation === null ||
    operation.kind !== "move" ||
    operation.status === "complete" ||
    operation.status === "failed"
  ) {
    return;
  }
  const completedItems =
    operation.completedItems + (result.success ? 1 : 0);
  const failedItems = operation.failedItems + (result.success ? 0 : 1);
  await ctx.db.patch("bulkOperations", operation._id, {
    completedItems,
    failedItems,
    ...(result.error === undefined
      ? {}
      : { error: result.error.slice(0, 1000) }),
    status: operationStatus({ ...operation, completedItems, failedItems }),
    updatedAt: Date.now(),
  });
}
