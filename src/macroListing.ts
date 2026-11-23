import type { Hunk } from "./amigaHunkParser";

interface SourcePosition {
  path: string;
  line: number;
}

interface RepeatDefinition {
  kind: string;
  line: number;
  callSite: SourcePosition;
  callText: string;
}

interface RepeatFrame {
  kind: string;
  endLine: number;
  nextLine: number;
  iteration: number;
  instructions: InstructionRow[];
}

function substituteRepeatCounter(text: string, iteration: number): string {
  // Match entire identifiers, quoted strings and comments before replacing the counter.
  return text.replace(/;.*|"(?:""|\\.|[^"])*"|'(?:''|\\.|[^'])*'|[\w.$@]+/g,
    token => token.toUpperCase() === "REPTN" ? String(iteration) : token);
}

interface Expansion {
  sourceReference: number;
  callSite: SourcePosition;
  callText: string;
  kind: "macro" | "repeat";
  lines: string[];
  instructions: InstructionRow[];
}

interface InstructionRow {
  expansion: Expansion;
  line: number;
  bytes: Buffer;
  hunk: number;
  offset: number;
  group: InstructionRow[];
}

export interface InlineExpansion extends SourcePosition {
  instruction: string;
}

export interface ExpandedSource {
  source: { name: string; sourceReference: number; origin: string };
  line: number;
  callSite: SourcePosition;
  template?: SourcePosition;
  inline?: InlineExpansion;
  annotations?: InlineExpansion[];
}

/** The wide vasm listing for a directly assembled Hunk executable. */
export class MacroListing {
  private readonly expansions = new Map<number, Expansion>();
  private readonly instructions = new Map<string, InstructionRow>();

  constructor(text: string, hunkSizes: readonly number[]) {
    const lines = text.split(/\r?\n/);
    const sections = lines.slice(0, lines.findIndex(line => line.startsWith("Source:")))
      .filter(line => /^[0-9a-f]+: "/i.test(line));
    if (sections.length !== hunkSizes.length || sections.some((entry, index) => {
      const section = /^([0-9a-f]+): ".*" \(0-([0-9a-f]+)\)$/i.exec(entry);
      return !section || parseInt(section[1], 16) !== index ||
        Math.ceil(parseInt(section[2], 16) / 4) * 4 !== hunkSizes[index];
    })) {
      throw new Error("The vasm listing sections do not match the executable Hunks");
    }

    let sourcePath: string | undefined;
    let callSite: SourcePosition | undefined;
    let callText = "";
    const definitions: RepeatDefinition[] = [];
    const repeats: RepeatFrame[] = [];
    let closedRepeat: RepeatDefinition | undefined;
    let repeatEndLine = 0;
    let expansion: Expansion | undefined;
    for (const textLine of lines) {
      const source = /^Source: "(.*)"$/.exec(textLine);
      if (source) {
        sourcePath = source[1];
        callSite = undefined;
        definitions.length = 0;
        repeats.length = 0;
        closedRepeat = undefined;
        expansion = undefined;
        continue;
      }
      const row = /^(?:([0-9a-f]+):([0-9a-f]+) ([0-9a-f]+))? *\t *(\d+)([:MR]) (.*)$/i.exec(textLine);
      if (!row || !sourcePath) continue;
      const [, section, address, bytes, line, kind, sourceText] = row;
      const listingLine = Number(line);
      const repeat = closedRepeat;
      closedRepeat = undefined;
      if (kind === ":") {
        callSite = { path: sourcePath, line: listingLine };
        callText = sourceText.trim();
        repeats.length = 0;
        expansion = undefined;
      } else if (repeat && listingLine === 1 && kind === (repeat.kind === ":" ? "R" : repeat.kind)) {
        // vasm restarts the generated source at line 1 and prints a final
        // blank row at the original ENDR's relative line in each iteration.
        repeats.push({ kind, endLine: repeatEndLine, nextLine: 1, iteration: -1, instructions: [] });
      } else {
        while (repeats.length && repeats.at(-1)!.nextLine === 1 &&
          (repeats.at(-1)!.kind !== kind || listingLine !== 1)) {
          repeats.pop();
        }
      }

      if (!callSite) continue;
      const frame = repeats.at(-1);
      if (frame?.kind === kind && frame.nextLine === listingLine) {
        if (listingLine === 1) {
          frame.iteration++;
          frame.instructions = [];
        }
        frame.nextLine = listingLine === frame.endLine ? 1 : listingLine + 1;
      }

      const directive = (/^\s*\.?(rept|endr)(?=\s|;|$)/i.exec(sourceText) ??
        /^(?:\s*[^\s:]+:\s*|[^\s:]+\s+)\.?(rept|endr)(?=\s|;|$)/i.exec(sourceText))
        ?.[1].toLowerCase();
      const insideDefinition = definitions.length > 0;
      if (directive === "rept") {
        definitions.push({ kind, line: listingLine, callSite, callText });
      } else if (directive === "endr" && definitions.at(-1)?.kind === kind) {
        const definition = definitions.pop()!;
        if (!definitions.length) {
          closedRepeat = definition;
          repeatEndLine = listingLine - definition.line;
        }
      }

      if (kind === ":" || insideDefinition || directive === "rept") continue;
      if (!expansion) {
        if (kind === "R" && !repeat) continue;
        const standalone = kind === "R" ? repeat : undefined;
        expansion = {
          sourceReference: this.expansions.size + 1,
          callSite: standalone?.callSite ?? callSite,
          callText: standalone?.callText ?? callText,
          kind: standalone ? "repeat" : "macro",
          lines: [],
          instructions: [],
        };
        this.expansions.set(expansion.sourceReference, expansion);
      }
      expansion.lines.push(frame && frame.iteration >= 0
        ? substituteRepeatCounter(sourceText, frame.iteration)
        : sourceText);
      if (address && bytes && bytes.length % 2 === 0) {
        const hunk = parseInt(section, 16);
        const offset = parseInt(address, 16);
        const data = Buffer.from(bytes, "hex");
        if (offset + data.length <= hunkSizes[hunk]) {
          // Three header lines precede the expansion in the virtual document.
          const group = frame?.instructions ?? expansion.instructions;
          const instruction = { expansion, line: expansion.lines.length + 3, bytes: data, hunk, offset, group };
          group.push(instruction);
          this.instructions.set(`${hunk}:${offset}`, instruction);
        }
      }
    }
  }

  instructionAt(hunk: number, offset: number): InstructionRow | undefined {
    return this.instructions.get(`${hunk}:${offset}`);
  }

  source(sourceReference: number): string | undefined {
    const expansion = this.expansions.get(sourceReference);
    if (!expansion) return;
    return [
      `; ${expansion.kind === "repeat" ? "Repeat block" : "Macro call"}: ${expansion.callText}`,
      "; Go to template line",
      "",
      ...expansion.lines,
      "",
    ].join("\n");
  }
}

/** Expected live bytes after applying any loader fixups that overlap the listing row. */
export function relocatedListingBytes(
  hunk: Hunk,
  offset: number,
  length: number,
  segmentOffsets: readonly number[],
): Buffer | undefined {
  const data = hunk.data;
  if (!data || offset < 0 || offset + length > data.length) return;
  const result = Buffer.from(data.subarray(offset, offset + length));
  for (const relocation of hunk.reloc32) {
    for (const site of relocation.offsets) {
      const start = Math.max(site, offset);
      const end = Math.min(site + 4, offset + length);
      if (start >= end) continue;
      const base = segmentOffsets[relocation.target];
      if (base === undefined || site < 0 || site + 4 > data.length) return;
      const relocated = Buffer.alloc(4);
      relocated.writeUInt32BE((data.readUInt32BE(site) + base) >>> 0);
      relocated.copy(result, start - offset, start - site, end - site);
    }
  }
  return result;
}
