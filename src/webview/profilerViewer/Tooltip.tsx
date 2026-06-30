import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// A tooltip that clamps itself into the viewport using its *measured* size, so it never runs off
// the right/bottom edge regardless of content width. (Hardcoded width guesses mis-clamped: a fixed
// width that ignored padding/border clipped on the right, and a too-large guess yanked a narrow
// tooltip needlessly leftward near the edge.) `useLayoutEffect` reads offsetWidth/Height and adjusts
// before paint, so there's no visible flash at the unclamped position. Shared across profilerViewer
// tabs (FlameGraph's DMA/blit tooltips, MemoryView's byte tooltip, ...) — one implementation, not
// one per consumer.
export function Tooltip({
  x,
  y,
  className,
  width,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 12, top: y + 12 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - el.offsetWidth - 8));
    const top = Math.max(8, Math.min(y + 12, window.innerHeight - el.offsetHeight - 8));
    // Functional update so the no-op pass after a setState bails out (converges in one extra pass).
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    // x/y change on every pointer move (so the hovered content always re-measures with them).
  }, [x, y]);
  return (
    <div
      ref={ref}
      className={className ? `tooltip ${className}` : "tooltip"}
      style={{ left: pos.left, top: pos.top, width }}
    >
      {children}
    </div>
  );
}
