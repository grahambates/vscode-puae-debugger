import {
  attachDisassembly,
  fetchDisassembly,
  reweightDisassembly,
  MAX_DISASSEMBLE_INSTRUCTIONS,
  RawDisassembledFunction,
  InstructionSample,
  RawCapture,
} from "../profilerManager";
import { encodeCapture, decodeCapture } from "../profileFormat";
import { SourceMap } from "../sourceMap";
import { IProfileModel } from "../shared/profilerTypes";

describe("attachDisassembly", () => {
  it("annotates each instruction with file/line from the source map, by exact address", () => {
    const sourceMap = {
      lookupAddress: (addr: number) => (addr === 0x100 ? { path: "a.c", line: 5 } : undefined),
    } as unknown as SourceMap;

    const raw: RawDisassembledFunction[] = [
      {
        address: 0x100,
        end: 0x104,
        name: "foo",
        totalCycles: 16,
        instructions: [
          { address: 0x100, hex: "4e71", text: "nop", length: 2, hits: 3, cycles: 12 },
          { address: 0x102, hex: "4e75", text: "rts", length: 2, hits: 1, cycles: 4 },
        ],
      },
    ];

    const out = attachDisassembly(raw, sourceMap);
    expect(out).toHaveLength(1);
    expect(out[0].instructions[0]).toMatchObject({ address: 0x100, file: "a.c", line: 5, hits: 3, cycles: 12 });
    expect(out[0].instructions[1].file).toBeUndefined();
    expect(out[0].instructions[1].line).toBeUndefined();
  });
});

describe("fetchDisassembly", () => {
  const sourceMap = (resolvable: Record<number, { symbol: string; offset: number }>): SourceMap =>
    ({
      findSymbolOffset: (pc: number) => resolvable[pc],
    }) as unknown as SourceMap;

  const baseModel = (): IProfileModel => ({
    nodes: [],
    locations: [],
    samples: [],
    timeDeltas: [],
    pcs: [],
    duration: 1000,
    cyclesPerMicroSecond: 7.09379,
    symbols: [
      { address: 0x1000, name: "foo", size: 0x10 },
      { address: 0x2000, name: "bar", size: 0x10 },
    ],
  });

  // Chip memory filled with NOPs — gives both functions something valid to decode.
  const nopChipMem = (): Uint8Array => {
    const mem = new Uint8Array(0x3000);
    for (let i = 0; i < mem.length; i += 2) { mem[i] = 0x4e; mem[i + 1] = 0x71; }
    return mem;
  };

  it("aggregates exact per-PC hits/cycles and decodes each executed function", () => {
    const samples: InstructionSample[] = [
      { stack: [0x1000], cycles: 4 },
      { stack: [0x1000], cycles: 6 }, // same PC again — aggregates
      { stack: [0x1004], cycles: 2 }, // different PC, same function
      { stack: [0x2000], cycles: 100 }, // a different, hotter function
    ];
    const map = sourceMap({
      0x1000: { symbol: "foo", offset: 0 },
      0x1004: { symbol: "foo", offset: 4 },
      0x2000: { symbol: "bar", offset: 0 },
    });

    const result = fetchDisassembly(baseModel(), samples, map, nopChipMem());

    // Hottest function (bar, 100 cycles) sorted first.
    expect(result.map((f) => f.name)).toEqual(["bar", "foo"]);

    const foo = result.find((f) => f.name === "foo")!;
    expect(foo.instructions[0]).toMatchObject({ address: 0x1000, hits: 2, cycles: 10 }); // 4+6
  });

  it("returns [] when no chip memory is provided", () => {
    const samples: InstructionSample[] = [{ stack: [0x1000], cycles: 10 }];
    const map = sourceMap({ 0x1000: { symbol: "foo", offset: 0 } });
    expect(fetchDisassembly(baseModel(), samples, map)).toEqual([]);
    expect(fetchDisassembly(baseModel(), samples, map, undefined)).toEqual([]);
  });

  it("skips PCs that don't resolve to a known symbol (Kickstart/[IRQ]/etc.)", () => {
    const samples: InstructionSample[] = [{ stack: [0xf80000], cycles: 50 }];
    expect(fetchDisassembly(baseModel(), samples, sourceMap({}), nopChipMem())).toEqual([]);
  });

  it("skips a resolved symbol with no known size", () => {
    const samples: InstructionSample[] = [{ stack: [0x3000], cycles: 1 }];
    const map = sourceMap({ 0x3000: { symbol: "unsized", offset: 0 } });
    const model = baseModel(); // "unsized" isn't in model.symbols
    expect(fetchDisassembly(model, samples, map, nopChipMem())).toEqual([]);
  });

  // Zorro II fast RAM's start address is autoconfig-assigned (not fixed like chip's 0x0 or
  // slow's 0xC00000), so fetchDisassembly/clientDisassembleRange take it as a parameter
  // rather than hardcoding it — see clientDisassembleRange's comment in profilerManager.ts.
  it("decodes from fast RAM when fastMem/fastAddr are provided", () => {
    const samples: InstructionSample[] = [{ stack: [0x200004], cycles: 5 }];
    const map = sourceMap({ 0x200004: { symbol: "fastFn", offset: 4 } });
    const model: IProfileModel = { ...baseModel(), symbols: [{ address: 0x200000, name: "fastFn", size: 0x10 }] };
    const fastMem = new Uint8Array(0x10);
    for (let i = 0; i < fastMem.length; i += 2) { fastMem[i] = 0x4e; fastMem[i + 1] = 0x71; } // NOPs

    const result = fetchDisassembly(model, samples, map, nopChipMem(), undefined, fastMem, 0x200000);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fastFn");
    // instructions[2] = the NOP at 0x200004 (2 NOPs in from fastAddr 0x200000)
    expect(result[0].instructions[2]).toMatchObject({ address: 0x200004, hits: 1, cycles: 5 });
  });

  it("returns no instructions for a fast-RAM function when fastMem/fastAddr aren't provided", () => {
    const samples: InstructionSample[] = [{ stack: [0x200004], cycles: 5 }];
    const map = sourceMap({ 0x200004: { symbol: "fastFn", offset: 4 } });
    const model: IProfileModel = { ...baseModel(), symbols: [{ address: 0x200000, name: "fastFn", size: 0x10 }] };

    const result = fetchDisassembly(model, samples, map, nopChipMem());

    expect(result).toHaveLength(1); // the function is still listed...
    expect(result[0].instructions).toEqual([]); // ...but with no decoded instructions
  });

  it("includes more than 64 small executed symbol ranges", () => {
    const functionCount = 200;
    const baseAddress = 0x1000;
    const symbols = Array.from({ length: functionCount }, (_, i) => ({
      address: baseAddress + i * 2,
      name: `fn${i}`,
      size: 2,
    }));
    const samples = symbols.map((symbol, i) => ({ stack: [symbol.address], cycles: functionCount - i }));
    const resolvable = Object.fromEntries(
      symbols.map((symbol) => [symbol.address, { symbol: symbol.name, offset: 0 }]),
    );
    const chipMem = new Uint8Array(baseAddress + functionCount * 2);
    for (const symbol of symbols) {
      chipMem[symbol.address] = 0x4e;
      chipMem[symbol.address + 1] = 0x71;
    }

    const result = fetchDisassembly(
      { ...baseModel(), symbols },
      samples,
      sourceMap(resolvable),
      chipMem,
    );

    expect(result).toHaveLength(functionCount);
    expect(result.reduce((total, fn) => total + fn.instructions.length, 0)).toBe(functionCount);
  });

  it("caps decoded work by total instruction count rather than function count", () => {
    // No per-function cap on top of this (one existed briefly — MAX_INSTRUCTIONS_PER_FUNCTION —
    // added while SourceMap.getSymbolLengths had an ordering bug that produced wildly-wrong sizes;
    // removed once that bug was fixed, since real Amiga code legitimately has large functions
    // (unrolled loops, big dispatch tables) that a per-function cap would misleadingly truncate).
    // A single big/hot function is allowed to consume nearly the whole global budget, same as any
    // symbol-defined function count would.
    const baseAddress = 0x1000;
    const hotInstructionCount = MAX_DISASSEMBLE_INSTRUCTIONS - 10;
    const coldAddress = baseAddress + hotInstructionCount * 2;
    const symbols = [
      { address: baseAddress, name: "hot", size: hotInstructionCount * 2 },
      { address: coldAddress, name: "cold", size: 100 * 2 },
    ];
    const samples = [
      { stack: [baseAddress], cycles: 100 },
      { stack: [coldAddress], cycles: 1 },
    ];
    const chipMem = new Uint8Array(coldAddress + 200);
    for (let i = baseAddress; i < chipMem.length; i += 2) {
      chipMem[i] = 0x4e;
      chipMem[i + 1] = 0x71;
    }

    const result = fetchDisassembly(
      { ...baseModel(), symbols },
      samples,
      sourceMap({
        [baseAddress]: { symbol: "hot", offset: 0 },
        [coldAddress]: { symbol: "cold", offset: 0 },
      }),
      chipMem,
    );

    expect(result.map((fn) => fn.name)).toEqual(["hot", "cold"]);
    expect(result.reduce((total, fn) => total + fn.instructions.length, 0)).toBe(MAX_DISASSEMBLE_INSTRUCTIONS);
    expect(result[1].instructions).toHaveLength(10);
    // `end` is the symbol's real end regardless of truncation, and `totalCycles` is the exact
    // total from the full per-PC hit list — both stay correct even though only 10 of "cold"'s
    // real instructions got decoded.
    expect(result[1].end).toBe(coldAddress + 200);
    expect(result[1].totalCycles).toBe(1);
  });
});

describe("reweightDisassembly", () => {
  it("attributes a reweighted function's totalCycles to its full [address, end) range, not just its (possibly truncated) decoded instructions", () => {
    // Mirrors fetchDisassembly's "caps decoded work" case: "cold" is a function whose *decode* was
    // truncated to 10 instructions by MAX_DISASSEMBLE_INSTRUCTIONS, but whose real end (0x1100) is
    // far past that. A later frame's samples can still land on an address in that undecoded tail —
    // summing `instructions[].cycles` would silently drop those cycles; the interval-based
    // totalCycles must not.
    const template: RawDisassembledFunction[] = [
      {
        address: 0x1000,
        end: 0x1100,
        name: "cold",
        totalCycles: 999, // stale total from the original frame — must be fully replaced, not added to
        instructions: Array.from({ length: 10 }, (_, i) => ({
          address: 0x1000 + i * 2, hex: "4e71", text: "nop", length: 2, hits: 0, cycles: 0,
        })),
      },
    ];
    const samples: InstructionSample[] = [
      { stack: [0x1012], cycles: 3 }, // last decoded instruction (0x1000 + 9*2)
      { stack: [0x1050], cycles: 7 }, // inside [address, end) but past the truncated instructions
    ];

    const [cold] = reweightDisassembly(template, samples);

    expect(cold.totalCycles).toBe(10); // 3 + 7, not just the 3 attributable to a decoded instruction
    expect(cold.instructions.find((i) => i.address === 0x1012)).toMatchObject({ hits: 1, cycles: 3 });
    expect(cold.instructions.find((i) => i.address === 0x1050)).toBeUndefined(); // no such decoded row
  });

  it("doesn't attribute a PC outside any function's [address, end) range (gap between symbols)", () => {
    const template: RawDisassembledFunction[] = [
      { address: 0x1000, end: 0x1010, name: "a", totalCycles: 0, instructions: [] },
      { address: 0x2000, end: 0x2010, name: "b", totalCycles: 0, instructions: [] },
    ];
    const samples: InstructionSample[] = [{ stack: [0x1800], cycles: 5 }]; // in the gap between a and b

    const [a, b] = reweightDisassembly(template, samples);

    expect(a.totalCycles).toBe(0);
    expect(b.totalCycles).toBe(0);
  });
});

describe("profileFormat codec with disassembly", () => {
  const sampleRaw = (): RawCapture => ({
    profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    disassembly: [
      {
        address: 0x1000,
        end: 0x1002,
        name: "foo",
        totalCycles: 12,
        instructions: [{ address: 0x1000, hex: "4e71", text: "nop", length: 2, hits: 3, cycles: 12 }],
      },
    ],
  });

  it("round-trips raw.disassembly through encode/decode", () => {
    const { raws: [out] } = decodeCapture(encodeCapture([sampleRaw()]));
    expect(out.disassembly).toEqual(sampleRaw().disassembly);
  });

  it("leaves disassembly undefined for a pre-disassembly document", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    };
    const { raws: [out] } = decodeCapture(encodeCapture([raw]));
    expect(out.disassembly).toBeUndefined();
  });
});
