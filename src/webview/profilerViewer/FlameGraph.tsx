import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { CallTreeNode, ProfileResult } from "../../shared/profilerTypes";

// Lean canvas flame graph. Consumes the aggregated ProfileResult call tree
// directly. Width of each box is proportional to its `total` cycles within the
// current focus (zoom) node; depth grows downward. Hover for details, click to
// zoom into a node. The richer WebGL renderer is a later (Preact) graft.

interface Box {
  x: number;
  w: number;
  depth: number;
  node: CallTreeNode;
}

const ROW_H = 18;
const CHAR_W = 6.2; // approx width of the 11px monospace glyphs used for labels

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360} 55% 55%)`;
}

export function FlameGraph({ result }: { result: ProfileResult }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<CallTreeNode>(result.root);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ box: Box; x: number; y: number } | null>(null);

  // Reset zoom when a fresh capture arrives.
  useEffect(() => setFocus(result.root), [result]);

  // Track container width.
  useEffect(() => {
    const update = () => setWidth(wrapRef.current?.clientWidth ?? 800);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const frameName = (n: CallTreeNode): string =>
    n.frame < 0 ? "(all)" : result.uniqueFrames[n.frame]?.func ?? "?";

  const { boxes, maxDepth } = useMemo(() => {
    const out: Box[] = [];
    let max = 0;
    const focusTotal = focus.total || 1;
    const layout = (node: CallTreeNode, x: number, w: number, depth: number) => {
      out.push({ x, w, depth, node });
      if (depth > max) max = depth;
      let cx = x;
      for (const k of [...node.children].sort((a, b) => b.total - a.total)) {
        const kw = (k.total / focusTotal) * w;
        layout(k, cx, kw, depth + 1);
        cx += kw;
      }
    };
    layout(focus, 0, width, 0);
    return { boxes: out, maxDepth: max };
  }, [focus, width, result]);

  const height = (maxDepth + 1) * ROW_H;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    cv.style.width = `${width}px`;
    cv.style.height = `${height}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";

    for (const b of boxes) {
      if (b.w < 0.5) continue;
      const y = b.depth * ROW_H;
      const name = frameName(b.node);
      ctx.fillStyle = b.node === hover?.box.node ? "#ffffff" : colorFor(name);
      ctx.fillRect(b.x, y, Math.max(b.w - 1, 0.5), ROW_H - 1);
      if (b.w > 28) {
        ctx.fillStyle = "#000000";
        const maxChars = Math.floor((b.w - 6) / CHAR_W);
        ctx.fillText(name.length > maxChars ? name.slice(0, Math.max(0, maxChars)) : name, b.x + 3, y + ROW_H / 2);
      }
    }
  }, [boxes, width, height, hover]);

  const onMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const depth = Math.floor((e.clientY - rect.top) / ROW_H);
    const box = boxes.find((b) => b.depth === depth && mx >= b.x && mx < b.x + b.w) ?? null;
    setHover(box ? { box, x: e.clientX, y: e.clientY } : null);
  };

  const onClick = () => {
    if (hover) setFocus(hover.box.node);
  };

  const pct = (n: CallTreeNode): string => (((n.total / (result.root.total || 1)) * 100).toFixed(1));

  const hoverFrame = hover && hover.box.node.frame >= 0 ? result.uniqueFrames[hover.box.node.frame] : undefined;

  return (
    <div className="flame" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      {focus !== result.root && (
        <button className="reset" onClick={() => setFocus(result.root)}>
          ↩ reset zoom
        </button>
      )}
      <canvas ref={canvasRef} onMouseMove={onMove} onClick={onClick} />
      {hover && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="tt-func">{frameName(hover.box.node)}</div>
          <div>
            {pct(hover.box.node)}% · total {hover.box.node.total.toLocaleString()} · self{" "}
            {hover.box.node.self.toLocaleString()} cycles
          </div>
          {hoverFrame?.file && (
            <div className="tt-loc">
              {hoverFrame.file}:{hoverFrame.line}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
