import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

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
  const settledItems = completedItems + failedItems;
  const finished =
    operation.discoveryComplete && settledItems >= operation.totalItems;
  await ctx.db.patch("bulkOperations", operation._id, {
    completedItems,
    failedItems,
    ...(result.error === undefined
      ? {}
      : { error: result.error.slice(0, 1000) }),
    ...(finished
      ? { status: failedItems > 0 ? "failed" as const : "complete" as const }
      : {}),
    updatedAt: Date.now(),
  });
}
