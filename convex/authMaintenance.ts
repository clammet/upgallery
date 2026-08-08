import { internalMutation } from "./_generated/server";
import { googlyAuth } from "./lib/auth";

export const cleanupExpiredSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await googlyAuth.cleanupExpiredSessions(ctx);
  },
});
