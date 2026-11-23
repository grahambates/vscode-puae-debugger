import path from "node:path";
import type { Hunk } from "./amigaHunkParser";

interface ListingLine {
  text: string;
  emission?: { hunk: number; offset: number; bytes: string };
}

export interface InactiveSourceBlock {
  startLine: number;
  lines: string[];
  ranges: Array<{ start: number; end: number }>;
}

export interface InactiveExpansionSource {
  path: string;
  blocks: InactiveSourceBlock[];
}

interface Branch {
  start: number;
  end: number;
  emitted: boolean;
  nested: Branch[][];
}

const conditionalStart = /^(?:if|if[bdc]|ifn[bdc]|ifmacro[n]?d|ifeq|ifne|iflt|ifle|ifgt|ifge|ifmi|ifpl|ifp?[12])$/;

function directive(text: string): string {
  const code = text.replace(/^\s*[\w.$@]+\s*::?\s*|^[\w.$@]+\s+/, "");
  return /^\s*([a-z][a-z0-9]*)(?=\s|;|$)/i.exec(code)?.[1].toLowerCase() ?? "";
}

function findInactive(branches: Branch[], ranges: InactiveSourceBlock["ranges"]) {
  const active = branches.filter(branch => branch.emitted);
  for (const branch of branches) {
    if (active.length === 1 && branch !== active[0]) {
      if (branch.start <= branch.end) ranges.push({ start: branch.start, end: branch.end });
    } else {
      for (const nested of branch.nested) findInactive(nested, ranges);
    }
  }
}

export class ConditionalListing {
  private readonly files = new Map<string, Map<number, ListingLine>>();
  private readonly repeatedFiles = new Set<string>();

  record(file: string, line: number, listing: ListingLine): void {
    const name = path.normalize(file);
    let lines = this.files.get(name);
    if (!lines) {
      lines = new Map();
      this.files.set(name, lines);
    }
    if (lines.has(line)) this.repeatedFiles.add(name);
    else lines.set(line, listing);
  }

  recordExpansion(file: string, line: number, emission: NonNullable<ListingLine["emission"]>): void {
    const row = this.files.get(path.normalize(file))?.get(line);
    if (row) row.emission ??= emission;
  }

  inactiveBlocks(filename: string, hunks: readonly Hunk[], expandedLines?: ReadonlySet<number>): InactiveSourceBlock[] {
    const file = path.normalize(filename);
    const matches = [...this.files.keys()].filter(name =>
      name === file || (!path.isAbsolute(name) && file.endsWith(path.sep + name)),
    );
    // Repeated includes can take different branches at the same source location.
    if (matches.length !== 1 || this.repeatedFiles.has(matches[0])) return [];
    const lines = this.files.get(matches[0])!;
    const blocks: InactiveSourceBlock[] = [];
    const stack: Branch[][] = [];
    for (const [line, row] of lines) {
      const token = directive(row.text);
      if (conditionalStart.test(token)) {
        stack.push([{ start: line + 1, end: line, emitted: false, nested: [] }]);
        continue;
      }
      const branches = stack.at(-1);
      if (!branches) continue;
      const branch = branches.at(-1)!;
      if (token === "else" || token === "elif" || token === "elseif") {
        branch.end = line - 1;
        branches.push({ start: line + 1, end: line, emitted: false, nested: [] });
      } else if (token === "endc" || token === "endif") {
        branch.end = line - 1;
        stack.pop();
        const parent = stack.at(-1)?.at(-1);
        if (parent) {
          parent.nested.push(branches);
          parent.emitted ||= branches.some(item => item.emitted);
        } else {
          const ranges: InactiveSourceBlock["ranges"] = [];
          findInactive(branches, ranges);
          if (!ranges.length) continue;
          const startLine = branches[0].start - 1;
          const source = Array.from({ length: line - startLine + 1 }, (_, index) => lines.get(startLine + index)?.text);
          if (source.every(text => text !== undefined)) blocks.push({ startLine, lines: source, ranges });
        }
      } else if (expandedLines?.has(line)) {
        branch.emitted = true;
      } else if (!expandedLines && !branch.emitted && row.emission) {
        const { hunk, offset, bytes } = row.emission;
        branch.emitted = hunks[hunk]?.data?.subarray(offset, offset + bytes.length / 2)
          .toString("hex") === bytes.toLowerCase();
      }
    }
    return blocks;
  }
}
