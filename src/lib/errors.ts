import { ConvexError } from "convex/values";

/** An HTTP refusal from the storage server, with its machine-readable code. */
export class RequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

/**
 * True when a gallery folder refused a name it already holds, whether the
 * refusal came from a Convex mutation or through the storage server.
 */
export function isEntryExistsError(reason: unknown): boolean {
  if (reason instanceof ConvexError) {
    const data: unknown = reason.data;
    return (
      typeof data === "object" &&
      data !== null &&
      "code" in data &&
      data.code === "entry_exists"
    );
  }
  return reason instanceof RequestError && reason.code === "entry_exists";
}

export function friendlyError(reason: unknown, fallback = "Request failed"): string {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  const serverMessage = /Uncaught Error:\s*([^\n]+)/.exec(reason.message)?.[1];
  if (serverMessage) {
    return serverMessage.replace(/\s+at\s+handler.*$/, "").trim();
  }
  const firstLine = reason.message.split("\n")[0]?.trim();
  return firstLine || fallback;
}
