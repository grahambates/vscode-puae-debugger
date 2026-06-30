// 68k status-register flag formatting, shared across webviews (the live PUAE app's CPU
// trace/disassembly RPC handlers, and the profiler's CPU Registers panel). 16-char string
// matching vAmiga/Moira's disassembleSR() format — vAmigaDebugAdapter.ts checks
// flags.includes("S") to detect supervisor mode for exception stack-frame handling, so this
// exact format is load-bearing, not just a display convenience.
export function srFlags(sr: number): string {
  const bit = (n: number) => (sr & (1 << n)) !== 0;
  const ipl = (sr >> 8) & 7;
  return [
    bit(15) ? "T" : "t",
    bit(14) ? "T" : "t",
    bit(13) ? "S" : "s",
    bit(12) ? "M" : "m",
    "-",
    ipl & 4 ? "1" : "0",
    ipl & 2 ? "1" : "0",
    ipl & 1 ? "1" : "0",
    "-",
    "-",
    "-",
    bit(4) ? "X" : "x",
    bit(3) ? "N" : "n",
    bit(2) ? "Z" : "z",
    bit(1) ? "V" : "v",
    bit(0) ? "C" : "c",
  ].join("");
}
