import { findAccesses, findRegisterChanges, groupAccesses } from "../webview/profilerViewer/accesses";
import { BusOwner, DMA_HPOS, DMA_WRITE, IProfileModel, REG_COUNT } from "../shared/profilerTypes";
import { resolveAccessTarget } from "../profileAnalysis";
import { SourceMap } from "../sourceMap";

// A tiny frame: the CPU runs `move.w d0,(a0)` (at $1000) then `nop` (at $1002), and writes $1234 to
// $2000 after the nop's fetch — the 68000's prefetch puts the next opcode fetch before the store.
// The copper sets COLOR00, the blitter writes $2002, and bitplane 1 reads $2000.
const N = 40;
function frame(withRegisters: boolean): IProfileModel {
  const owner = new Uint8Array(N), flags = new Uint8Array(N), addr = new Uint32Array(N), value = new Uint16Array(N);
  const cell = (s: number, o: BusOwner, f: number, a: number, v: number) => { owner[s] = o; flags[s] = f; addr[s] = a; value[s] = v; };
  cell(2, BusOwner.CPU, 4, 0x1000, 0x3080); // fetch move.w d0,(a0)   (DMA_CODE = 4)
  cell(4, BusOwner.CPU, 4, 0x1002, 0x4e71); // fetch nop
  cell(6, BusOwner.CPU, DMA_WRITE, 0x2000, 0x1234); // move's store
  cell(10, BusOwner.COPPER, DMA_WRITE, 0x180, 0x0f00); // MOVE #$0f00,COLOR00
  cell(12, BusOwner.BLITTER, DMA_WRITE, 0x2002, 0xffff);
  cell(14, BusOwner.BPL1, 0, 0x2000, 0x1234);
  const registers = new Uint32Array(2 * REG_COUNT);
  registers[8] = 0x2000; // a0 for the move
  registers[REG_COUNT + 8] = 0x2000;
  return {
    pcs: [0x1000, 0x1002],
    timeDeltas: [2, 2],
    samples: [0, 1, 1],
    nodes: [{ id: 0, selfTime: 0, aggregateTime: 0, children: [1], locationId: 0 }, { id: 1, selfTime: 4, aggregateTime: 4, children: [], parent: 0, locationId: 1 }],
    locations: [{ callFrame: { functionName: "(all)" } }, { callFrame: { functionName: "Clear" } }],
    dma: { owner, flags, addr, value },
    registers: withRegisters ? registers : undefined,
    copper: { addr: Uint32Array.of(0x3000), w1: Uint16Array.of(0x180), w2: Uint16Array.of(0x0f00), hpos: Uint16Array.of(10), vpos: Uint16Array.of(0) },
  } as unknown as IProfileModel;
}
const code = new Uint8Array(0x4000);
code.set([0x30, 0x80, 0x4e, 0x71], 0x1000);
const readCode = (address: number) => code.subarray(address);

describe("findAccesses", () => {
  it("ties a CPU store to the instruction that made it, not the one fetched before it landed", () => {
    const [store] = findAccesses(frame(true), 0x2000, 0x2002, readCode);
    expect(store).toMatchObject({ slot: 6, write: true, value: 0x1234, source: { kind: "cpu", pc: 0x1000, function: "Clear", verified: true } });
  });

  it("without registers, picks the instruction that can write memory, and says it's a guess", () => {
    const [store] = findAccesses(frame(false), 0x2000, 0x2002, readCode);
    expect(store.source).toMatchObject({ kind: "cpu", pc: 0x1000, verified: false });
  });

  it("names a copper MOVE by its list address, under the register's $dffxxx address", () => {
    const [move] = findAccesses(frame(true), 0xdff180, 0xdff182, readCode);
    expect(move).toMatchObject({ address: 0xdff180, write: true, value: 0x0f00, source: { kind: "copper", instruction: 0x3000 } });
  });

  it("lists every kind of access to a range, and groups them", () => {
    const all = findAccesses(frame(true), 0x2000, 0x2004, readCode, [{ startSlot: 11, endSlot: 13 } as never]);
    expect(all.map((a) => a.source.kind)).toEqual(["cpu", "blitter", "dma"]);
    expect(all[1].source).toEqual({ kind: "blitter", blit: 0 });
    expect(groupAccesses(all).map((g) => [g.who, g.write, g.count])).toEqual([
      ["CPU Clear", true, 1],
      ["Blitter D (blit #0)", true, 1],
      ["Bitplane 1", false, 1],
    ]);
    expect(DMA_HPOS).toBe(227); // rows report slots as line:hpos against this
  });
});

describe("resolveAccessTarget", () => {
  const sourceMap = {
    getSymbols: () => ({ Screen: 0x2000, Counter: 0x3000 }),
    getSymbolLengths: () => ({ Screen: 0x2800, Counter: 2 }),
  } as unknown as SourceMap;

  it("takes a custom register, a symbol (its own size), an address, a :LENGTH, or a range", () => {
    expect(resolveAccessTarget("COLOR00", sourceMap)).toMatchObject({ start: 0xdff180, end: 0xdff182 });
    expect(resolveAccessTarget("BPL1PT", sourceMap)).toMatchObject({ start: 0xdff0e0, end: 0xdff0e4 });
    expect(resolveAccessTarget("Screen", sourceMap)).toMatchObject({ start: 0x2000, end: 0x4800 });
    expect(resolveAccessTarget("Screen:16", sourceMap)).toMatchObject({ start: 0x2000, end: 0x2010 });
    expect(resolveAccessTarget("0x1000", sourceMap)).toMatchObject({ start: 0x1000, end: 0x1002 });
    expect(resolveAccessTarget("$1000-$10ff", sourceMap)).toMatchObject({ start: 0x1000, end: 0x1100 });
    expect(resolveAccessTarget("d7", sourceMap)).toMatchObject({ cpuRegister: 7 });
    expect(resolveAccessTarget("SP", sourceMap)).toMatchObject({ cpuRegister: 15 });
  });

  it("suggests symbols for an unknown name", () => {
    expect(() => resolveAccessTarget("screen2", sourceMap)).toThrow(/did you mean Screen/);
  });
});

describe("findRegisterChanges", () => {
  // Five samples: moveq #1,d0 ($1000), jsr $f80000 ($1002, the ROM, unsampled), nop ($1008) —
  // then an interrupt arrives (supervisor bit set) at the handler ($2000).
  const D0 = 0, SR = 16;
  const rows: [number, number, number][] = [ // pc, d0, sr
    [0x1000, 0, 0x0000],
    [0x1002, 1, 0x0000], // moveq set d0 = 1
    [0x1008, 7, 0x0000], // the ROM call returned d0 = 7
    [0x2000, 7, 0x2000], // interrupt taken: S set, d0 unchanged
    [0x2002, 9, 0x2000],
  ];
  const registers = new Uint32Array(rows.length * REG_COUNT);
  rows.forEach(([, d0, sr], k) => { registers[k * REG_COUNT + D0] = d0; registers[k * REG_COUNT + SR] = sr; });
  const model = {
    pcs: rows.map(([pc]) => pc),
    timeDeltas: rows.map(() => 4),
    samples: [0, ...rows.map(() => 1)],
    nodes: [{ id: 0, locationId: 0, children: [1] }, { id: 1, locationId: 1, parent: 0, children: [] }],
    locations: [{ callFrame: { functionName: "(all)" } }, { callFrame: { functionName: "Main" } }],
    registers,
  } as unknown as IProfileModel;
  const mem = new Uint8Array(0x3000);
  mem.set([0x70, 0x01, 0x4e, 0xb9, 0x00, 0xf8, 0x00, 0x00, 0x4e, 0x71], 0x1000);
  const readCode = (a: number) => mem.subarray(a);

  it("lists each change with the instruction that made it, and what came in between", () => {
    const changes = findRegisterChanges(model, D0, readCode);
    expect(changes.map((c) => [c.pc, c.from, c.to, c.via])).toEqual([
      [0x1000, 0, 1, undefined],
      [0x1002, 1, 7, "outside"], // the jsr's ROM routine did it
      [0x2000, 7, 9, undefined],
    ]);
    expect(findRegisterChanges(model, SR, readCode).find((c) => c.pc === 0x1008)?.via).toBe("exception");
  });

  it("finds nothing without a register trace", () => {
    expect(findRegisterChanges({ ...model, registers: undefined }, D0, readCode)).toEqual([]);
  });
});
