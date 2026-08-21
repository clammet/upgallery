import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a callback whose identity never changes but which always invokes
 * the latest `callback`. Lets memoized children skip re-renders when a parent
 * re-creates handlers that close over fresh state every render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
