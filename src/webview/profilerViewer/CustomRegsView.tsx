import { useCallback, useMemo } from "react";
import { getProfileModel } from "./modelStore";
import { reconstructCustomRegs, findPrevRegWrite, findNextRegWrite } from "./reconstruct";
import { WRITEABLE_REG_OFFSETS, PTR_HIGH_OFFSETS, isColorReg, formatRegValue } from "./customRegsTable";
import { customRegisterName } from "../shared/customRegisters";
import { createSymbolizer } from "./symbols";
import { DMA_HPOS } from "../../shared/profilerTypes";

// Table of writeable custom registers at a chosen DMA cycle (the old vscode-amiga-debug
// debugger/customregs.tsx, ported). The cycle comes from `selectedSlot` — set by clicking the DMA
// band in the flame graph (see FlameGraph's selectedSlot/onSelectSlot). High-pointer-half registers
// (BPLxPTH, COPxLCH, …) are shown combined with their low half as one symbolized 32-bit address.
export function CustomRegsView({
  selectedSlot,
  onSelectSlot,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
}) {
  const model = getProfileModel();
  const dma = model?.dma;
  const base = model?.dmaSnapshot?.custom;
  const symbolize = useMemo(() => createSymbolizer(model?.symbols), [model]);

  const slot = selectedSlot ?? (dma ? dma.owner.length - 1 : 0);
  // `customRegs` includes the write at `slot` itself; `prevRegs` excludes it, so a register whose
  // value differs between the two just changed at this exact cycle (highlighted below).
  const prevRegs = useMemo(
    () => (dma && base ? reconstructCustomRegs(dma, base, slot) : undefined),
    [dma, base, slot],
  );
  const customRegs = useMemo(
    () => (dma && base ? reconstructCustomRegs(dma, base, slot + 1) : undefined),
    [dma, base, slot],
  );

  const navTo = useCallback(
    (target: number | undefined) => {
      if (target !== undefined) onSelectSlot(target);
    },
    [onSelectSlot],
  );

  if (!model) return null;
  if (!dma || !customRegs || !prevRegs) {
    return <div className="hint">No DMA capture for this frame — custom registers unavailable.</div>;
  }

  return (
    <div className="customregs">
      <div className="cr-time">
        Cycle {slot} (line {Math.floor(slot / DMA_HPOS)}, color clock {slot % DMA_HPOS})
      </div>
      <div className="cr-rows">
        {WRITEABLE_REG_OFFSETS.map((offset) => {
          const index = offset >> 1;
          const isPth = PTR_HIGH_OFFSETS.has(offset);
          const name = customRegisterName(offset) ?? `$${offset.toString(16)}`;
          const changed = isPth
            ? customRegs[index] !== prevRegs[index] || customRegs[index + 1] !== prevRegs[index + 1]
            : customRegs[index] !== prevRegs[index];

          const prev = () => {
            const a = findPrevRegWrite(dma, offset, slot);
            const b = isPth ? findPrevRegWrite(dma, offset + 2, slot) : undefined;
            navTo(a === undefined ? b : b === undefined ? a : Math.max(a, b));
          };
          const next = () => {
            const a = findNextRegWrite(dma, offset, slot);
            const b = isPth ? findNextRegWrite(dma, offset + 2, slot) : undefined;
            navTo(a === undefined ? b : b === undefined ? a : Math.min(a, b));
          };

          let valueNode: React.ReactNode;
          if (isPth) {
            const addr = ((customRegs[index] << 16) | customRegs[index + 1]) >>> 0;
            const sym = symbolize(addr);
            const hex = `$${addr.toString(16).padStart(6, "0")}`;
            valueNode = <span>{sym ? `${sym} (${hex})` : hex}</span>;
          } else {
            valueNode = (
              <span>
                {formatRegValue(name, customRegs[index])}
                {isColorReg(offset) && (
                  <span
                    className="dma-dot"
                    style={{ background: `#${(customRegs[index] & 0xfff).toString(16).padStart(3, "0")}` }}
                  />
                )}
              </span>
            );
          }

          return (
            <div className={"cr-row" + (changed ? " cr-changed" : "")} key={offset}>
              <span className="cr-name">{name}</span>
              <span className="cr-addr">${offset.toString(16).padStart(3, "0")}</span>
              <span className="cr-value">{valueNode}</span>
              <span className="cr-nav">
                <button onClick={prev} title="Previous write">
                  ◀
                </button>
                <button onClick={next} title="Next write">
                  ▶
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
