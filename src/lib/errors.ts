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

/** The machine-readable code a Convex function attached to its refusal. */
function convexErrorCode(reason: unknown): string | undefined {
  if (!(reason instanceof ConvexError)) return undefined;
  const data: unknown = reason.data;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return undefined;
  }
  return typeof data.code === "string" ? data.code : undefined;
}

/**
 * True when a gallery folder refused a name it already holds, whether the
 * refusal came from a Convex mutation or through the storage server.
 */
export function isEntryExistsError(reason: unknown): boolean {
  if (reason instanceof ConvexError) {
    return convexErrorCode(reason) === "entry_exists";
  }
  return reason instanceof RequestError && reason.code === "entry_exists";
}

/**
 * True when the server refused because the viewer lacks access. A backend
 * from before the structured code rejects with a plain message that the
 * Convex client wraps in its own text, so that spelling is accepted too.
 */
export function isUnauthorizedError(reason: unknown): boolean {
  if (reason instanceof ConvexError) {
    return convexErrorCode(reason) === "unauthorized";
  }
  return reason instanceof Error && /\bUnauthorized\b/.test(reason.message);
}

export function friendlyError(reason: unknown, fallback = "Request failed"): string {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  if (reason instanceof ConvexError) {
    const data: unknown = reason.data;
    if (typeof data === "string") return data;
    if (
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      return data.message;
    }
  }
  const serverMessage = /Uncaught Error:\s*([^\n]+)/.exec(reason.message)?.[1];
  if (serverMessage) {
    return serverMessage.replace(/\s+at\s+handler.*$/, "").trim();
  }
  const firstLine = reason.message.split("\n")[0]?.trim();
  return firstLine || fallback;
}
