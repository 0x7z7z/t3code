import { createContext } from "react";

// Keep folded text mounted for find; reveal only the selected match.
export const MarkdownFindContext = createContext(false);

/**
 * Find dispatches `beforematch` to selected ancestors. Create this ref during render with
 * stable `onReveal` so it attaches once.
 */
export function findRevealRef(onReveal: () => void) {
  return (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("beforematch", onReveal);
    return () => element.removeEventListener("beforematch", onReveal);
  };
}
