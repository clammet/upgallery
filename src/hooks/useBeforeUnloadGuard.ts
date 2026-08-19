import { useEffect } from "react";

/** Asks the browser to confirm leaving the page while `active` is true. */
export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy support: Chrome/Edge < 119 require returnValue to be set.
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}
