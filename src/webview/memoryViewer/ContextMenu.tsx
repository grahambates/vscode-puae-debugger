import "./ContextMenu.css";
import { useEffect, useLayoutEffect, useRef } from "react";

export interface ContextMenuAction {
  label: string;
  onSelect: () => void;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MARGIN = 4;

export const ContextMenu = ({ x, y, items, onClose }: ContextMenuProps) => {
  const ref = useRef<HTMLDivElement>(null);

  // Keep the menu within the viewport, flipping to the other side of the
  // cursor when it would otherwise be cropped by the right or bottom edge
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { offsetWidth, offsetHeight } = el;

    let left = x;
    if (left + offsetWidth > window.innerWidth - MARGIN) {
      left = x - offsetWidth;
    }
    let top = y;
    if (top + offsetHeight > window.innerHeight - MARGIN) {
      top = y - offsetHeight;
    }

    el.style.left = `${Math.max(MARGIN, left)}px`;
    el.style.top = `${Math.max(MARGIN, top)}px`;
  }, [x, y, items]);

  // Dismiss on outside click or Escape
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      {items.map((item, index) =>
        "separator" in item ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <button
            key={index}
            type="button"
            className="context-menu-item"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
};
