import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Mirrors the App-level hook so the Writing Screen also honors the OS
 * preference directly, even if a parent forgets to pass `reducedMotion`. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
