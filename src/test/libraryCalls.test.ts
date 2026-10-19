import { describeLibraryCall, libraryCallComments } from "../libraryCalls";

// A tiny machine: exec.library at $1000 (AbsExecBase at 4 points to it), a non-library at $3000,
// and a ROM symbol table with AllocMem.
const EXEC = 0x1000;
function memory(): (address: number, length: number) => Promise<Uint8Array> {
  const mem = new Uint8Array(0x10000);
  const long = (at: number, v: number) => { mem[at] = v >>> 24; mem[at + 1] = (v >>> 16) & 0xff; mem[at + 2] = (v >>> 8) & 0xff; mem[at + 3] = v & 0xff; };
  long(4, EXEC);
  mem[EXEC + 8] = 9; // NT_LIBRARY
  long(EXEC + 10, 0x2000);
  [..."exec.library\0"].forEach((c, i) => (mem[0x2000 + i] = c.charCodeAt(0)));
  // Jump table: -198 JMP $fc1234 (AllocMem); -204 JMP $5000 (patched into RAM); -210 not a JMP.
  const jmp = (offset: number, target: number) => { mem[EXEC + offset] = 0x4e; mem[EXEC + offset + 1] = 0xf9; long(EXEC + offset + 2, target); };
  jmp(-198, 0xfc1234);
  jmp(-204, 0x5000);
  long(0x6000, EXEC); // a variable holding the base, for `movea.l GfxBase(pc),a6`-style loads
  return async (address, length) => mem.slice(address, address + length);
}
const symbols = (address: number) => (address === 0xfc1234 ? "AllocMem" : undefined);

const MOVEA_4W_A6 = "2c 78 00 04"; // movea.l 4.w,a6
const JSR_198 = "4e ae ff 3a"; // jsr -198(a6)
const JSR_204 = "4e ae ff 34"; // jsr -204(a6)
const MOVEQ = "70 00"; // moveq #0,d0
const LEA_A6 = "4d f9 00 00 30 00"; // lea $3000,a6

describe("describeLibraryCall", () => {
  it("names the routine an entry jumps to, by exact symbol", async () => {
    expect(await describeLibraryCall(EXEC, -198, memory(), symbols)).toBe("exec.library AllocMem");
  });

  it("shows a patched entry's target, and a non-JMP entry's offset", async () => {
    expect(await describeLibraryCall(EXEC, -204, memory(), symbols)).toBe("exec.library -204 -> $005000 (RAM, patched)");
    expect(await describeLibraryCall(EXEC, -210, memory(), symbols)).toBe("exec.library -210");
  });

  it("says nothing when the base isn't a library", async () => {
    expect(await describeLibraryCall(0x3000, -198, memory(), symbols)).toBeUndefined();
  });
});

describe("libraryCallComments", () => {
  const lines = (...hex: string[]) => {
    let address = 0x400;
    return hex.map((h) => {
      const line = { address, hex: h };
      address += h.split(" ").length;
      return line;
    });
  };

  it("follows the a6 load before the call, past instructions that don't touch a6", async () => {
    const listing = lines(MOVEA_4W_A6, MOVEQ, JSR_198);
    const comments = await libraryCallComments(listing, memory(), symbols);
    expect(comments.get(listing[2].address)).toBe("exec.library AllocMem");
  });

  it("follows a pc-relative load of the base from a variable", async () => {
    // movea.l $6000(pc),a6 at $400: the displacement is from the extension word at $402.
    const listing = lines("2c 7a 5b fe", JSR_198);
    const comments = await libraryCallComments(listing, memory(), symbols);
    expect(comments.get(listing[1].address)).toBe("exec.library AllocMem");
  });

  it("names nothing when a6 was changed in a way it can't follow", async () => {
    const listing = lines(MOVEA_4W_A6, LEA_A6, JSR_198);
    expect((await libraryCallComments(listing, memory(), symbols)).size).toBe(0);
  });

  it("uses the live a6 at the PC, but not past an a6 load at the PC itself", async () => {
    const listing = lines(MOVEQ, JSR_198);
    const atPc = await libraryCallComments(listing, memory(), symbols, { live: { pc: listing[0].address, a6: EXEC } });
    expect(atPc.get(listing[1].address)).toBe("exec.library AllocMem");
    // The instruction at the PC loads a6 from a non-library: the live (old) value doesn't apply.
    const reload = lines(LEA_A6, JSR_198);
    expect((await libraryCallComments(reload, memory(), symbols, { live: { pc: reload[0].address, a6: EXEC } })).size).toBe(0);
  });

  it("prefers a6 known exactly at the call, and lists each library it was called with", async () => {
    const listing = lines(LEA_A6, JSR_198, JSR_204);
    const comments = await libraryCallComments(listing, memory(), symbols, {
      a6At: (address) => (address === listing[1].address ? [EXEC, EXEC] : address === listing[2].address ? [EXEC, 0x3000] : undefined),
    });
    expect(comments.get(listing[1].address)).toBe("exec.library AllocMem");
    expect(comments.get(listing[2].address)).toBe("exec.library -204 -> $005000 (RAM, patched)");
  });
});
