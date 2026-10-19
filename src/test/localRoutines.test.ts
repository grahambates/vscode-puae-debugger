import { callTarget, localRoutineName, snapshotReader } from "../localRoutines";
import { buildProfileModel, InstructionSample } from "../profilerManager";
import { SourceMap } from "../sourceMap";

// Foo at $1000; .bar at $1010, on line 6 of main.s (label alone on line 5).
const source = [
  "Foo:",
  "        move.w  d0,d1",
  "        bsr     .bar",
  "        rts",
  ".bar:",
  "        move.w  d0,d1",
  "        rts",
];
const sourceMap = {
  findSymbolOffset: (address: number) => (address >= 0x1000 && address < 0x1100 ? { symbol: "Foo", offset: address - 0x1000 } : undefined),
  lookupAddress: (address: number) => (address === 0x1010 ? { path: "main.s", line: 6, address } : address === 0x1004 ? { path: "main.s", line: 3, address } : undefined),
} as unknown as SourceMap;
const lines = (path: string) => (path === "main.s" ? source : undefined);

describe("callTarget", () => {
  const chip = new Uint8Array(0x2000);
  chip.set([0x61, 0x00, 0x00, 0x0a], 0x1004); // bsr.w $1010 (from $1004: $1006 + $0a)
  chip.set([0x4e, 0xb9, 0x00, 0x00, 0x12, 0x34], 0x1100); // jsr $1234.l
  chip.set([0x4e, 0x90], 0x1106); // jsr (a0)
  chip.set([0x4e, 0x75], 0x1108); // rts
  const read = snapshotReader(chip);

  it("reads the target of a bsr or an absolute jsr", () => {
    expect(callTarget(0x1004, read)).toBe(0x1010);
    expect(callTarget(0x1100, read)).toBe(0x1234);
  });

  it("has none for a call through a register, or something that isn't a call", () => {
    expect(callTarget(0x1106, read)).toBeUndefined();
    expect(callTarget(0x1108, read)).toBeUndefined();
  });
});

describe("localRoutineName", () => {
  it("names a routine entered at a local label after the label in the source", () => {
    expect(localRoutineName(0x1010, sourceMap, lines)).toBe("Foo.bar");
  });

  it("falls back to the offset without the source", () => {
    expect(localRoutineName(0x1010, sourceMap)).toBe("Foo+$10");
    expect(localRoutineName(0x1010, sourceMap, () => undefined)).toBe("Foo+$10");
  });

  it("leaves an entry at the routine's own start alone", () => {
    expect(localRoutineName(0x1000, sourceMap, lines)).toBeUndefined();
  });
});

describe("buildProfileModel with local routines", () => {
  // Main at $1000 calls into Foo's local label .bar at $2010, by bsr or through a register.
  const fooSource = ["Foo:", "        rts", "", "; the subroutine", ".bar:", "        move.w  d0,d1", "        rts"];
  const lineOf: Record<number, number> = { 0x2000: 1, 0x2010: 6, 0x2012: 7 };
  const asm = {
    findSymbolOffset: (a: number) =>
      a >= 0x1000 && a < 0x1100 ? { symbol: "Main", offset: a - 0x1000 } : a >= 0x2000 && a < 0x2100 ? { symbol: "Foo", offset: a - 0x2000 } : undefined,
    lookupAddress: (a: number) => (lineOf[a] ? { path: "foo.s", line: lineOf[a], address: a } : undefined),
    findSegmentForAddress: () => ({}),
    getCfaForPc: () => undefined,
    getUnwindRows: () => [],
  } as unknown as SourceMap;
  const sourceLines = (path: string) => (path === "foo.s" ? fooSource : undefined);
  const names = (model: ReturnType<typeof buildProfileModel>) => model.locations.map((l) => l.callFrame.functionName);
  const code = (bytes: number[]) => {
    const chip = new Uint8Array(0x3000);
    chip.set(bytes, 0x1004);
    return snapshotReader(chip);
  };

  it("names a bsr'd local label from the call", () => {
    const read = code([0x61, 0x00, 0x10, 0x0a]); // bsr.w $2010
    const model = buildProfileModel(
      [{ stack: [0x2012, 0x1004], cycles: 4 }], // already running: the call says where it began
      asm, undefined, { read, sourceLines },
    );
    expect(names(model)).toContain("Foo.bar");
    expect(names(model)).not.toContain("Foo");
  });

  it("names a call through a register from where the frame began, once it begins in the capture", () => {
    const read = code([0x4e, 0x90]); // jsr (a0)
    const samples: InstructionSample[] = [
      { stack: [0x2012, 0x1004], cycles: 4 }, // already running when the capture began: unknown
      { stack: [0x1006], cycles: 4 },
      { stack: [0x2010, 0x1004], cycles: 4 }, // a new call, entered at .bar
      { stack: [0x2012, 0x1004], cycles: 4 },
    ];
    const model = buildProfileModel(samples, asm, undefined, { read, sourceLines });
    const leafNames = model.samples.slice(1).map((id) => model.locations[model.nodes[id].locationId].callFrame.functionName);
    expect(leafNames).toEqual(["Foo", "Main", "Foo.bar", "Foo.bar"]);
  });
});
