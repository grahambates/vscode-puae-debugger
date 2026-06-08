import "./Tooltip.css";
import React, { useLayoutEffect, useRef } from "react";

export interface TooltipProps {
  x: number;
  y: number;
  heading?: React.ReactNode;
  text: React.ReactNode;
}

const OFFSET = 10;
const MARGIN = 4;

export const Tooltip = (props: TooltipProps) => {
  const ref = useRef<HTMLDivElement>(null);

  // Flip to the other side of the cursor when the tooltip would otherwise be
  // cropped by the right or bottom edge of the viewport. Set the position
  // directly on the element (rather than via state) since it's derived from
  // the rendered size and shouldn't trigger another render.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { offsetWidth, offsetHeight } = el;

    let left = props.x + OFFSET;
    if (left + offsetWidth > window.innerWidth - MARGIN) {
      left = props.x - OFFSET - offsetWidth;
    }

    let top = props.y + OFFSET;
    if (top + offsetHeight > window.innerHeight - MARGIN) {
      top = props.y - OFFSET - offsetHeight;
    }

    el.style.left = `${Math.max(MARGIN, left)}px`;
    el.style.top = `${Math.max(MARGIN, top)}px`;
  }, [props.x, props.y, props.heading, props.text]);

  return (
    <div
      ref={ref}
      className="tooltip"
      style={{
        left: props.x + OFFSET,
        top: props.y + OFFSET,
      }}
    >
      {props.heading && <div className="tooltip-heading">{props.heading}</div>}
      {props.text}
    </div>
  );
};
