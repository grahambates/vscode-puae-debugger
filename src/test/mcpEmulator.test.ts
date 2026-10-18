// Tests for the emulator-backed MCP tools and the PNG encoder they use — the parts that don't
// need a Kickstart ROM.
//
// Everything here stops short of booting a machine: argument handling is checked by asserting the
// tools reject bad input *before* they'd start one, which is also the behaviour that matters
// (a mistyped frame count should come back as a message, not forty minutes of emulation). The
// end-to-end path — boot, inject, capture, screenshot, and the stdout discipline the protocol
// depends on — is covered by puae-wasm/test/test_mcp_emulator.mjs, which skips without a ROM.

import { readFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import { inflateSync } from "zlib";
import { MAX_CAPTURE_FRAMES } from "../shared/profilerTypes";
import { parseHunks } from "../amigaHunkParser";
import { sourceMapFromHunks } from "../amigaHunkSourceMap";
import { describe as describeAddress, resolveBreakpointSpec } from "../mcp/breakpointSpec";
import { emulatorTools, exceptionVectors, watchAdds, writeRequest } from "../mcp/emulatorTools";
import type { HeadlessSession } from "../mcp/emulatorSession";
import { encodePng } from "../mcp/png";
import { expandHome } from "../mcp/paths";
import { SessionRegistry } from "../mcp/sessionRegistry";
import { buildTools } from "../mcp/tools";

const CTX = { rootDir: "/nonexistent-root" };
const tool = (name: string) => emulatorTools(CTX).find((t) => t.name === name)!;
// Wrapped in an async IIFE, not Promise.resolve(run(...)): argument validation happens before
// any await, so it throws synchronously — which is exactly how the dispatcher calls it (inside
// `try { await tool.run(...) }`), and how it turns into an isError result rather than a crash.
const runTool = async (name: string, args: Record<string, unknown>) => tool(name).run(args);

describe("emulator MCP tools", () => {
  const savedRom = process.env.PUAE_KICKSTART_ROM;
  beforeEach(() => {
    delete process.env.PUAE_KICKSTART_ROM;
  });
  afterAll(() => {
    if (savedRom === undefined) delete process.env.PUAE_KICKSTART_ROM;
    else process.env.PUAE_KICKSTART_ROM = savedRom;
  });

  it("serves the emulator tools alongside the analysis tools, capture first", () => {
    expect(buildTools(CTX).map((t) => t.name)).toEqual([
      "emulator_launch",
      "emulator_snapshot",
      "emulator_breakpoints",
      "emulator_continue",
      "emulator_step",
      "emulator_inspect",
      "emulator_watch",
      "emulator_write",
      "emulator_disassemble",
      "emulator_close",
      "emulator_screenshot",
      "emulator_capture_profile",
      "profile_check",
      "profile_dump",
    ]);
  });

  it("points at the environment variable when no ROM is given", async () => {
    await expect(runTool("emulator_screenshot", { program: "/tmp/x" })).rejects.toThrow(
      /PUAE_KICKSTART_ROM/,
    );
  });

  it("accepts the ROM from the environment", async () => {
    process.env.PUAE_KICKSTART_ROM = "/tmp/rom-from-env";
    // Gets past the ROM check and fails on the unreadable program instead, which is the next step.
    await expect(runTool("emulator_screenshot", { program: "/definitely/missing" })).rejects.toThrow(
      /ENOENT|no such file/,
    );
  });

  it("refuses an out-of-range frame count before booting anything", async () => {
    // rootDir is nonexistent, so anything that got as far as booting would fail differently —
    // this asserting on "capped" is what proves the bound is checked first.
    await expect(
      runTool("emulator_capture_profile", { program: "/tmp/x", kickstartRom: "/tmp/rom", frames: 9999 }),
    ).rejects.toThrow(`capped at ${MAX_CAPTURE_FRAMES}`);
    await expect(
      runTool("emulator_screenshot", { program: "/tmp/x", kickstartRom: "/tmp/rom", frames: 100000 }),
    ).rejects.toThrow(/capped at 5000/);
  });

  it("rejects a non-object config rather than passing nonsense to the emulator", async () => {
    await expect(
      runTool("emulator_screenshot", { program: "/tmp/x", kickstartRom: "/tmp/rom", config: "cpu_model=68020" }),
    ).rejects.toThrow(/"config" must be an object/);
  });

  it("tells the caller what to do with the capture it produces", () => {
    // The capture tool's whole value is that the analysis tools can then read the file; a
    // description that doesn't say so leaves a model holding a path it doesn't use.
    expect(tool("emulator_capture_profile").description).toMatch(/profile_dump/);
  });
});

describe("PNG encoder", () => {
  // 2x2: red, green / blue, transparent — distinct in every channel, so a mis-ordered or
  // mis-strided write shows up rather than cancelling out.
  const PIXELS = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   0, 0, 0, 0,
  ]);

  it("writes a PNG signature and IHDR describing the image", () => {
    const png = encodePng(PIXELS, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2); // width
    expect(png.readUInt32BE(20)).toBe(2); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type: RGBA
  });

  it("round-trips the pixels through IDAT unchanged", () => {
    const png = encodePng(PIXELS, 2, 2);
    // Walk the chunk list rather than assuming offsets, then inflate IDAT and strip the
    // per-row filter byte to recover exactly what went in.
    let offset = 8;
    let idat: Buffer | undefined;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString("latin1");
      if (type === "IDAT") idat = png.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
    }
    const raw = inflateSync(idat!);
    const stride = 2 * 4;
    expect(raw[0]).toBe(0); // filter type None
    expect([...raw.subarray(1, 1 + stride)]).toEqual([...PIXELS.subarray(0, stride)]);
    expect(raw[1 + stride]).toBe(0);
    expect([...raw.subarray(2 + stride, 2 + stride * 2)]).toEqual([...PIXELS.subarray(stride, stride * 2)]);
  });

  it("ends with IEND", () => {
    const png = encodePng(PIXELS, 2, 2);
    expect(png.subarray(png.length - 8, png.length - 4).toString("latin1")).toBe("IEND");
  });

  it("refuses a buffer that doesn't match the stated size", () => {
    // A short buffer would otherwise encode as a silently corrupt image.
    expect(() => encodePng(PIXELS, 3, 2)).toThrow(/expected 24 bytes/);
    expect(() => encodePng(PIXELS, 0, 2)).toThrow(/invalid size/);
  });
});

describe("breakpoint specs", () => {
  // A real SourceMap from a committed hunk fixture — no ROM and no emulator needed, which is why
  // resolution lives in its own module. Segment base is arbitrary; what matters is that symbol
  // and line lookups are relocated by it, exactly as they are for an injected program.
  const BASE = 0x00c02140;
  const hunks = parseHunks(readFileSync(path.join(__dirname, "fixtures/amigaPrograms/gencop")));
  const sourceMap = sourceMapFromHunks(hunks, [BASE]);
  const sourceFile = sourceMap.getSourceFiles()[0];

  it("resolves a hex address, with or without a $ prefix", () => {
    expect(resolveBreakpointSpec("0xc02280", sourceMap).address).toBe(0xc02280);
    expect(resolveBreakpointSpec("$c02280", sourceMap).address).toBe(0xc02280);
  });

  it("resolves a decimal address", () => {
    // A caller reading an address out of a report shouldn't have to re-prefix it.
    expect(resolveBreakpointSpec(String(0xc02280), sourceMap).address).toBe(0xc02280);
  });

  it("resolves a symbol to its relocated address", () => {
    const resolved = resolveBreakpointSpec("moveloop", sourceMap);
    expect(resolved.address).toBe(sourceMap.getSymbols()["moveloop"]);
    expect(resolved.address).toBeGreaterThanOrEqual(BASE);
    expect(resolved.description).toMatch(/moveloop -> 0x[0-9a-f]{8}/);
  });

  it("resolves a source line, splitting on the last colon so a drive letter survives", () => {
    // The fixture's paths are Windows absolute ("c:\...\gencop.s"), which is exactly the case a
    // naive split on the first colon gets wrong.
    expect(sourceFile).toMatch(/^[a-z]:\\/i);
    const resolved = resolveBreakpointSpec(`${sourceFile}:155`, sourceMap);
    expect(resolved.address).toBe(sourceMap.lookupSourceLine(sourceFile, 155).address);
  });

  it("reports the nearest line with code when the requested one has none", () => {
    // A line-number argument that lands on a comment or blank line is a normal mistake, and
    // silently moving without saying so would misreport where the breakpoint actually is.
    const target = sourceMap.lookupSourceLine(sourceFile, 156).line;
    const resolved = resolveBreakpointSpec(`${sourceFile}:156`, sourceMap);
    if (target !== 156) expect(resolved.description).toMatch(/nearest line with code: \d+/);
  });

  it("suggests near matches for an unknown symbol", () => {
    // "not found" leaves a caller stuck; a list of candidates lets them fix the argument.
    expect(() => resolveBreakpointSpec("moveloo", sourceMap)).toThrow(/Did you mean:.*moveloop/);
  });

  it("lists the program's symbols when nothing is close", () => {
    expect(() => resolveBreakpointSpec("zzzz", sourceMap)).toThrow(/Symbols: .*moveloop/);
  });

  it("names the source files when a file:line doesn't resolve", () => {
    expect(() => resolveBreakpointSpec("nope.s:10", sourceMap)).toThrow(/Source files in this program:/);
  });

  it("rejects an empty spec", () => {
    expect(() => resolveBreakpointSpec("   ", sourceMap)).toThrow(/Empty breakpoint/);
  });

  it("labels an unnamed Kickstart address rather than leaving a bare number", () => {
    // Only a handful of ROMs ship symbols, so this is the normal case for a ROM frame in a call
    // stack — and a bare 0x00fc0b58 reads like a lookup failure instead of "this is the ROM".
    expect(describeAddress(0x00fc0b58, sourceMap)).toBe("0x00fc0b58 (Kickstart ROM)");
    expect(describeAddress(sourceMap.getSymbols()["moveloop"], sourceMap)).toMatch(/moveloop/);
  });
});

describe("session registry", () => {
  const fakeSession = () => ({ dispose: jest.fn() }) as unknown as HeadlessSession;

  it("hands out ids and looks sessions back up", () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    const id = registry.add(session, "/tmp/prog");
    expect(registry.get(id)).toBe(session);
    expect(registry.list()).toEqual([{ id, program: "/tmp/prog", idleMs: expect.any(Number) }]);
  });

  it("refuses to open more than the cap, and says which are open", () => {
    // Each session holds a wasm instance whose heap can't be handed back on demand, so this cap
    // is the thing standing between a chatty caller and an out-of-memory server.
    const registry = new SessionRegistry();
    const ids = [1, 2, 3, 4].map(() => registry.add(fakeSession(), "/tmp/prog"));
    const extra = fakeSession();
    expect(() => registry.add(extra, "/tmp/prog")).toThrow(new RegExp(`Too many.*${ids.join(", ")}`));
    // The rejected session is disposed rather than leaked on the floor.
    expect((extra as unknown as { dispose: jest.Mock }).dispose).toHaveBeenCalled();
  });

  it("distinguishes a closed session from one that never existed", () => {
    const registry = new SessionRegistry();
    const id = registry.add(fakeSession(), "/tmp/prog");
    registry.close(id, "closed by emulator_close");
    expect(() => registry.get(id)).toThrow(/is gone: closed by emulator_close/);
    expect(() => registry.get("s99")).toThrow(/Unknown session "s99"/);
  });

  it("evicts an idle session and explains why on the next lookup", () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    const id = registry.add(session, "/tmp/prog");
    const realNow = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(realNow + 16 * 60 * 1000);
    try {
      expect(() => registry.get(id)).toThrow(/closed automatically after 15 minutes idle/);
      expect((session as unknown as { dispose: jest.Mock }).dispose).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a session alive while it is being used", () => {
    const registry = new SessionRegistry();
    const id = registry.add(fakeSession(), "/tmp/prog");
    const realNow = Date.now();
    const spy = jest.spyOn(Date, "now");
    try {
      // Touched every 10 minutes: idle time is measured since the last use, not since creation.
      for (const minutes of [10, 20, 30]) {
        spy.mockReturnValue(realNow + minutes * 60 * 1000);
        expect(registry.get(id)).toBeDefined();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("paths", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~/Documents/WinUAE/Kickstarts/Kick13.rom")).toBe(
      path.join(homedir(), "Documents/WinUAE/Kickstarts/Kick13.rom"),
    );
    expect(expandHome("~")).toBe(homedir());
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/abs/kick.rom")).toBe("/abs/kick.rom");
    expect(expandHome("rel/~/kick.rom")).toBe("rel/~/kick.rom");
    expect(expandHome("~user/kick.rom")).toBe("~user/kick.rom");
  });
});

describe("stripped programs", () => {
  // A screenshot or a capture needs no symbols, so a binary without line info must still load.
  const hunks = parseHunks(readFileSync(path.join(__dirname, "fixtures/amigaPrograms/gencop")))
    .map((h) => ({ ...h, lineDebugInfo: [], stabs: [] }));

  it("is still rejected by default, as the debugger expects", () => {
    expect(() => sourceMapFromHunks(hunks, [0xc02140])).toThrow(/No debug information/);
  });

  it("yields an address-only map when debug info is optional", () => {
    const sourceMap = sourceMapFromHunks(hunks, [0xc02140], { requireDebugInfo: false });
    expect(sourceMap.getSourceFiles()).toEqual([]);
    expect(resolveBreakpointSpec("0xc02280", sourceMap).address).toBe(0xc02280);
    expect(() => describeAddress(0xc02280, sourceMap)).not.toThrow();
  });
});

describe("emulator_write arguments", () => {
  it("parses memory, custom and register writes", () => {
    const req = writeRequest({
      memory: [{ address: "lives", value: 3, size: "w" }, { address: "0x1000", bytes: "4e71 4E75" }],
      custom: { COLOR00: "0x0f00" },
      registers: { d0: -1, pc: "main.s:42" },
    });
    expect(req.memory[0]).toEqual({ address: "lives", value: 3, size: 2 });
    expect(req.memory[1].bytes).toEqual(Buffer.from([0x4e, 0x71, 0x4e, 0x75]));
    expect(req.custom).toEqual([{ name: "COLOR00", value: "0x0f00" }]);
    expect(req.registers).toEqual([{ name: "d0", value: -1 }, { name: "pc", value: "main.s:42" }]);
  });

  it("insists on a size for a value, rather than guessing a width", () => {
    expect(() => writeRequest({ memory: [{ address: "lives", value: 3 }] })).toThrow(/needs "size"/);
  });

  it("rejects malformed bytes and ambiguous entries", () => {
    expect(() => writeRequest({ memory: [{ address: "x", bytes: "4e7" }] })).toThrow(/whole bytes/);
    expect(() => writeRequest({ memory: [{ address: "x", bytes: "4e71", value: 1 }] })).toThrow(/not both/);
    expect(() => writeRequest({ registers: { d0: true } })).toThrow(/registers\.d0 must be/);
  });
});

describe("emulator_watch arguments", () => {
  it("defaults to watching writes", () => {
    expect(watchAdds({ add: [{ address: "COP1LC" }] })).toEqual([{ address: "COP1LC", length: undefined, on: "write" }]);
  });

  it("rejects an unknown access kind and an oversized range", () => {
    expect(() => watchAdds({ add: [{ address: "x", on: "execute" }] })).toThrow(/write, read, access/);
    expect(() => watchAdds({ add: [{ address: "x", length: 1 << 21 }] })).toThrow(/capped/);
  });
});

describe("exception stops", () => {
  it("maps names to vectors, and an absent argument to no change", () => {
    expect(exceptionVectors({ exceptions: ["address_error", "ILLEGAL_INSTRUCTION"] })).toEqual([3, 4]);
    expect(exceptionVectors({ exceptions: [] })).toEqual([]);
    expect(exceptionVectors({})).toBeUndefined();
  });

  it("rejects an unknown exception before anything boots", async () => {
    await expect(runTool("emulator_launch", { program: "/tmp/x", exceptions: ["segfault"] })).rejects.toThrow(/Unknown exception "segfault"/);
  });
});
