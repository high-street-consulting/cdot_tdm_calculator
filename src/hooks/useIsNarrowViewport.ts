// Shared viewport-width hook. Lived in ShopBody.tsx until the small-screen
// notice needed the same behaviour; two copies of a matchMedia subscription
// drift, so it moved here rather than being duplicated.

import { useEffect, useState } from "react";

/** True while the viewport is at or below `maxWidth`. */
export function useIsNarrowViewport(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}
