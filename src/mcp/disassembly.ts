// The emulator_disassemble listing: decoded lines (m68kDisassembly.ts) laid out with symbol
// labels, the current PC and source lines from the session's SourceMap.

import { SourceMap } from "../sourceMap";
import { DecodedLine } from "../m68kDisassembly";

export { decodeLine, decodeRange } from "../m68kDisassembly";
export type { DecodedLine } from "../m68kDisassembly";

/**
 * A SourceMap as the decoder's symbol lookup: "symbol" or "symbol+$offset" — hex, the same form
 * profile_dump's listing gets from a capture's symbol list (createSymbolizer), so the two
 * disassemblies read alike.
 */
export function sourceMapSymbolizer(sourceMap?: SourceMap): ((address: number) => string | undefined) | undefined {
  if (!sourceMap) return undefined;
  return (address) => {
    const sym = sourceMap.findSymbolOffset(address);
    return sym ? (sym.offset ? `${sym.symbol}+$${sym.offset.toString(16)}` : sym.symbol) : undefined;
  };
}

/**
 * Renders decoded lines as a listing: a label line wherever a symbol starts, `=>` on the current
 * PC, and the source location as a comment whenever it changes from the line above.
 */
export function formatListing(lines: DecodedLine[], pc: number | undefined, sourceMap?: SourceMap): string {
  const labels = new Map<number, string[]>();
  for (const [name, address] of Object.entries(sourceMap?.getSymbols() ?? {})) {
    const names = labels.get(address) ?? [];
    names.push(name);
    labels.set(address, names);
  }
  const out: string[] = [];
  let lastSource = "";
  for (const line of lines) {
    for (const name of labels.get(line.address) ?? []) out.push(`${name}:`);
    const location = sourceMap?.lookupAddress(line.address);
    const source = location ? `${location.path}:${location.line}` : "";
    const comments = [...line.comments];
    if (source && source !== lastSource) comments.push(source);
    lastSource = source;
    const marker = line.address === pc ? "=>" : "  ";
    const body = `${marker} ${line.address.toString(16).padStart(8, "0")}  ${line.hex.padEnd(20)} ${line.text}`;
    out.push(comments.length ? `${body.padEnd(64)} ; ${comments.join(", ")}` : body);
  }
  return out.join("\n");
}
