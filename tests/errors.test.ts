import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { friendlyError, isUnauthorizedError } from "../src/lib/errors";

describe("isUnauthorizedError", () => {
  test("recognizes the structured refusal", () => {
    const error = new ConvexError({ code: "unauthorized", message: "Unauthorized" });
    expect(isUnauthorizedError(error)).toBe(true);
  });

  test("recognizes a plain refusal wrapped by the Convex client", () => {
    const error = new Error(
      "[CONVEX Q(folders:list)] [Request ID: 1] Server Error\nUncaught Error: Unauthorized\n    at handler",
    );
    expect(isUnauthorizedError(error)).toBe(true);
  });

  test("ignores other failures", () => {
    expect(isUnauthorizedError(new ConvexError({ code: "entry_exists" }))).toBe(false);
    expect(isUnauthorizedError(new Error("Folder not found"))).toBe(false);
    expect(isUnauthorizedError("Unauthorized")).toBe(false);
  });
});

describe("friendlyError", () => {
  test("uses the message carried by a structured refusal", () => {
    const error = new ConvexError({ code: "unauthorized", message: "Unauthorized" });
    expect(friendlyError(error)).toBe("Unauthorized");
  });
});
