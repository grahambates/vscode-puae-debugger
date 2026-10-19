import { useMemo, useState } from "react";
import { AccessList, useAccessContext, useMemoryAccesses } from "./AccessList";
import { Tooltip } from "./Tooltip";
import { getProfileModel } from "./modelStore";
import { reconstructCustomRegs } from "./reconstruct";
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
  onOpenSource,
}: {
  selectedSlot: number | undefined;
  onSelectSlot: (slot: number) => void;
  onOpenSource: (file: string, line: number, toSide: boolean) => void;
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

  // The register whose accesses are listed below — picked by clicking its row.
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [hover, setHover] = useState<{ offset: number; x: number; y: number } | undefined>(undefined);
  const ctx = useAccessContext(model);
  const target = useMemo(
    () => (selected === undefined ? undefined : { start: 0xdff000 + selected, end: 0xdff000 + selected + (PTR_HIGH_OFFSETS.has(selected) ? 4 : 2) }),
    [selected],
  );
  const rows = useMemoryAccesses(model, ctx, target);
  // A pointer pair is listed as one: BPL1PTH and BPL1PTL as BPL1PT.
  const selectedName = selected === undefined
    ? undefined
    : PTR_HIGH_OFFSETS.has(selected)
      ? (customRegisterName(selected) ?? `$${selected.toString(16)}`).replace(/H$/, "")
      : (customRegisterName(selected) ?? `$${selected.toString(16)}`);

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
            <div
              className={"cr-row cr-clickable" + (changed ? " cr-changed" : "") + (offset === selected ? " cr-selected" : "")}
              key={offset}
              onClick={() => setSelected(offset === selected ? undefined : offset)}
              onMouseMove={(e) => setHover({ offset, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(undefined)}
            >
              <span className="cr-name">{name}</span>
              <span className="cr-addr">${offset.toString(16).padStart(3, "0")}</span>
              <span className="cr-value">{valueNode}</span>
            </div>
          );
        })}
      </div>
      {hover && (
        <Tooltip x={hover.x} y={hover.y} width={240}>
          <CustomRegTip offset={hover.offset} regs={customRegs} changed={customRegs[hover.offset >> 1] !== prevRegs[hover.offset >> 1]} symbolize={symbolize} />
        </Tooltip>
      )}
      {selectedName !== undefined && (
        <AccessList
          title={`Accesses to ${selectedName}`}
          rows={rows}
          selectedSlot={selectedSlot}
          onSelect={(row) => onSelectSlot(row.slot)}
          onOpenSource={onOpenSource}
          onClose={() => setSelected(undefined)}
          empty="Nothing wrote or read it this frame."
        />
      )}
    </div>
  );
}

// A register's value at the cursor, read every useful way: a pointer pair as an address (and its
// symbol), a colour as its RGB, anything else as hex, decimal, signed and binary — the last being
// what a control register like DMACON or BPLCON0 is really read as.
function CustomRegTip({ offset, regs, changed, symbolize }: {
  offset: number;
  regs: Uint16Array;
  changed: boolean;
  symbolize: (address: number) => string | undefined;
}) {
  const isPth = PTR_HIGH_OFFSETS.has(offset);
  const full = customRegisterName(offset) ?? `$${offset.toString(16)}`;
  const name = isPth ? full.replace(/H$/, "") : full; // a pointer pair as one: BPL1PT
  const value = regs[offset >> 1];
  const rows: [string, string][] = [];
  if (isPth) {
    const addr = ((value << 16) | regs[(offset >> 1) + 1]) >>> 0;
    rows.push(["Address", `$${addr.toString(16).padStart(6, "0")}`]);
    const sym = symbolize(addr);
    if (sym) rows.push(["Symbol", sym]);
  } else if (isColorReg(offset)) {
    const rgb = value & 0xfff;
    rows.push(["Value", `$${rgb.toString(16).padStart(3, "0")}`], ["RGB", `${rgb >> 8}, ${(rgb >> 4) & 0xf}, ${rgb & 0xf}`]);
  } else {
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    rows.push(["Hex", `$${value.toString(16).padStart(4, "0")}`], ["Decimal", String(value)]);
    if (signed !== value) rows.push(["Signed", String(signed)]);
    rows.push(["Binary", value.toString(2).padStart(16, "0").replace(/(.{4})(?=.)/g, "$1 ")]);
  }
  return (
    <>
      <div className="tt-func">{name} ($dff{offset.toString(16).padStart(3, "0")})</div>
      <div className="tip-grid">
        {rows.map(([label, v]) => (
          <span key={label} style={{ display: "contents" }}>
            <span className="tip-label">{label}</span>
            <span className="tip-val">{v}</span>
          </span>
        ))}
      </div>
      {changed && <div className="tt-hint">Written at this cycle</div>}
      <div className="tt-hint">Click: access history</div>
    </>
  );
}
