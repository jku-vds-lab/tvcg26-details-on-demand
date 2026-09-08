import { useEffect, useRef, useState } from "react";
export function useInlineBusy(active: boolean, delayMs = 150) {
  const [visible, setVisible] = useState(false);
  const t = useRef<number | null>(null);
  useEffect(() => {
    if (active) {
      t.current = window.setTimeout(() => setVisible(true), delayMs);
    } else {
      if (t.current) clearTimeout(t.current);
      setVisible(false);
    }
    return () => { if (t.current) clearTimeout(t.current); };
  }, [active, delayMs]);
  return visible;
}
