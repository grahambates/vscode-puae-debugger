import { attachDisassembly, fetchDisassembly, RawDisassembledFunction, ProfilerRpcClient, InstructionSample, RawCapture } from "../profilerManager";
import { encodeCapture, decodeCapture } from "../vamigaProfile";
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
        name: "foo",
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
    duration: 1000,
    cyclesPerMicroSecond: 7.09379,
    symbols: [
      { address: 0x1000, name: "foo", size: 0x10 },
      { address: 0x2000, name: "bar", size: 0x10 },
    ],
  });

  it("aggregates exact per-PC hits/cycles and fetches each executed function's range once", async () => {
    const samples: InstructionSample[] = [
      { stack: [0x1000], cycles: 4 },
      { stack: [0x1000], cycles: 6 }, // same PC again — aggregates
      { stack: [0x1004], cycles: 2 }, // different PC, same function — no extra RPC call
      { stack: [0x2000], cycles: 100 }, // a different, hotter function
    ];
    const map = sourceMap({
      0x1000: { symbol: "foo", offset: 0 },
      0x1004: { symbol: "foo", offset: 4 },
      0x2000: { symbol: "bar", offset: 0 },
    });

    const calls: unknown[] = [];
    const sendRpcCommand = jest.fn(async (_cmd: string, args?: unknown) => {
      calls.push(args);
      const a = args as { startAddr: number; endAddr: number };
      return {
        instructions: [{ address: a.startAddr, hex: "4e71", text: "nop", length: 2 }],
      };
    });
    const rpc = { sendRpcCommand } as unknown as ProfilerRpcClient;

    const result = await fetchDisassembly(rpc, baseModel(), samples, map);

    expect(rpc.sendRpcCommand).toHaveBeenCalledTimes(2); // one per distinct function, not per sample/PC
    expect(calls).toEqual(
      expect.arrayContaining([{ startAddr: 0x1000, endAddr: 0x1010 }, { startAddr: 0x2000, endAddr: 0x2010 }]),
    );

    // Hottest function (bar, 100 cycles) sorted first.
    expect(result.map((f) => f.name)).toEqual(["bar", "foo"]);

    const foo = result.find((f) => f.name === "foo")!;
    expect(foo.instructions[0]).toMatchObject({ address: 0x1000, hits: 2, cycles: 10 }); // 4+6
  });

  it("skips PCs that don't resolve to a known symbol (Kickstart/[IRQ]/etc.)", async () => {
    const samples: InstructionSample[] = [{ stack: [0xf80000], cycles: 50 }]; // out of program
    const rpc: ProfilerRpcClient = { sendRpcCommand: jest.fn() };

    const result = await fetchDisassembly(rpc, baseModel(), samples, sourceMap({}));
    expect(result).toEqual([]);
    expect(rpc.sendRpcCommand).not.toHaveBeenCalled();
  });

  it("skips a resolved symbol with no known size", async () => {
    const samples: InstructionSample[] = [{ stack: [0x3000], cycles: 1 }];
    const map = sourceMap({ 0x3000: { symbol: "unsized", offset: 0 } });
    const model = baseModel(); // "unsized" isn't in model.symbols at all
    const rpc: ProfilerRpcClient = { sendRpcCommand: jest.fn() };

    const result = await fetchDisassembly(rpc, model, samples, map);
    expect(result).toEqual([]);
    expect(rpc.sendRpcCommand).not.toHaveBeenCalled();
  });
});

describe("vamigaProfile codec with disassembly", () => {
  const sampleRaw = (): RawCapture => ({
    profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    disassembly: [
      {
        address: 0x1000,
        name: "foo",
        instructions: [{ address: 0x1000, hex: "4e71", text: "nop", length: 2, hits: 3, cycles: 12 }],
      },
    ],
  });

  it("round-trips raw.disassembly through encode/decode", () => {
    const { raw: out } = decodeCapture(encodeCapture(sampleRaw()));
    expect(out.disassembly).toEqual(sampleRaw().disassembly);
  });

  it("leaves disassembly undefined for a pre-disassembly document", () => {
    const raw: RawCapture = {
      profile: { data: new Uint8Array([1, 0, 0, 0]), start: 0, end: 0, total: 0, inRange: 0, frameCycles: 0, isPAL: true },
    };
    const { raw: out } = decodeCapture(encodeCapture(raw));
    expect(out.disassembly).toBeUndefined();
  });
});
