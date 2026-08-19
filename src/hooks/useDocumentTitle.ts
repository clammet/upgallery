import { useEffect } from "react";

const DEFAULT_TITLE = "upgallery";

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ?? DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
