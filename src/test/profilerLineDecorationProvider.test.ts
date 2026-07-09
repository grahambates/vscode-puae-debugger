import * as vscode from "vscode";
import { ProfilerLineDecorationProvider } from "../profilerLineDecorationProvider";
import { IProfileModel, IDisassembledFunction, IDisassembledInstruction } from "../shared/profilerTypes";

const ins = (overrides: Partial<IDisassembledInstruction>): IDisassembledInstruction => ({
  address: 0x1000,
  hex: "0000",
  text: "nop",
  length: 2,
  hits: 0,
  cycles: 0,
  ...overrides,
});

const fn = (name: string, instructions: IDisassembledInstruction[]): IDisassembledFunction => ({
  address: instructions[0]?.address ?? 0,
  name,
  instructions,
});

const model = (disassembly: IDisassembledFunction[]): IProfileModel => ({
  nodes: [],
  locations: [],
  samples: [],
  timeDeltas: [],
  pcs: [],
  duration: 1000,
  cyclesPerMicroSecond: 7.09379,
  disassembly,
});

const mockEditor = (path: string): vscode.TextEditor & { setDecorations: jest.Mock } =>
  ({
    document: { uri: { fsPath: path } },
    setDecorations: jest.fn(),
  }) as unknown as vscode.TextEditor & { setDecorations: jest.Mock };

// Find the one setDecorations call (out of one call per heat bucket) that received a non-empty
// ranges/options array — the bucket the test's single decorated line landed in.
function nonEmptyCall(editor: { setDecorations: jest.Mock }): unknown[] | undefined {
  for (const call of editor.setDecorations.mock.calls) {
    const options = call[1] as unknown[];
    if (options.length > 0) return options;
  }
  return undefined;
}

describe("ProfilerLineDecorationProvider", () => {
  it("starts enabled", () => {
    const p = new ProfilerLineDecorationProvider();
    expect(p.isEnabled()).toBe(true);
  });

  it("setEnabled toggles isEnabled", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(false);
    expect(p.isEnabled()).toBe(false);
    p.setEnabled(true);
    expect(p.isEnabled()).toBe(true);
  });

  it("aggregates instructions by (file, line), merging across functions sharing a line", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(
      model([
        fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5, address: 0x1000 })]),
        fn("b", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 50, hits: 3, address: 0x2000 })]),
      ]),
    );
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    const options = nonEmptyCall(editor) as { range: { startLine: number }; renderOptions: { after: { contentText: string } } }[];
    expect(options).toHaveLength(1);
    expect(options[0].range.startLine).toBe(9); // line 10 (1-based) -> 9 (0-based)
    // 150 total cycles, 8 total hits (merged across both functions)
    expect(options[0].renderOptions.after.contentText).toContain("150");
    expect(options[0].renderOptions.after.contentText).toContain("8");
  });

  it("skips instructions with no file/line, or with zero cycles and zero hits", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(
      model([
        fn("a", [
          ins({ cycles: 100, hits: 5 }), // no file/line
          ins({ file: "C:\\proj\\a.c", line: 5, cycles: 0, hits: 0 }), // nothing to show
          ins({ file: "C:\\proj\\a.c", line: -1, cycles: 100, hits: 5 }), // negative line
        ]),
      ]),
    );
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    expect(nonEmptyCall(editor)).toBeUndefined();
  });

  it("computes the per-file max from summed per-line totals, not per-instruction values", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(
      model([
        fn("a", [
          // line 1: two small instructions summing to 90 (bigger than the single line-2 instruction)
          ins({ file: "C:\\proj\\a.c", line: 1, cycles: 40, hits: 1, address: 0x1000 }),
          ins({ file: "C:\\proj\\a.c", line: 1, cycles: 50, hits: 1, address: 0x1002 }),
          // line 2: one bigger single instruction, but smaller line-total than line 1
          ins({ file: "C:\\proj\\a.c", line: 2, cycles: 80, hits: 1, address: 0x1004 }),
        ]),
      ]),
    );
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    // Both lines get decorations; line 1 (90 cy, the file max) should land in the hottest bucket.
    const calls = editor.setDecorations.mock.calls as [unknown, { range: { startLine: number } }[]][];
    const hottestBucketCall = calls[calls.length - 1][1]; // last bucket = hottest
    expect(hottestBucketCall.some((o) => o.range.startLine === 0)).toBe(true); // line 1 -> 0-based 0
  });

  it("hover returns undefined when disabled", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(false);
    p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
    const hover = p.provideHover(
      { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument,
      { line: 9 } as vscode.Position,
    );
    expect(hover).toBeUndefined();
  });

  it("hover returns undefined for a line with no data", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
    const hover = p.provideHover(
      { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument,
      { line: 99 } as vscode.Position,
    );
    expect(hover).toBeUndefined();
  });

  it("hover reports cycles, % of file total, and hit count for a decorated line", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(
      model([
        fn("a", [
          ins({ file: "C:\\proj\\a.c", line: 10, cycles: 75, hits: 5, address: 0x1000 }),
          ins({ file: "C:\\proj\\a.c", line: 20, cycles: 25, hits: 1, address: 0x1002 }),
        ]),
      ]),
    );
    const hover = p.provideHover(
      { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument,
      { line: 9 } as vscode.Position, // line 10, 0-based
    ) as vscode.Hover;
    expect(hover).toBeDefined();
    const text = (hover.contents as unknown as { value: string }).value;
    expect(text).toContain("75");
    expect(text).toContain("75.0%"); // 75 of 100 total file cycles
    expect(text).toContain("5 execution");
  });

  it("refreshEditor clears decorations when disabled", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
    p.setEnabled(false);
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    expect(nonEmptyCall(editor)).toBeUndefined();
  });

  it("clear() removes all aggregated data", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
    p.clear();
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    expect(nonEmptyCall(editor)).toBeUndefined();
  });

  it("matches files case-insensitively and normalizes separators, like ProfilerCodeLensProvider", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.update(model([fn("a", [ins({ file: "c:/proj/A.C", line: 10, cycles: 100, hits: 5 })])]));
    const editor = mockEditor("C:\\proj\\a.c");
    p.refreshEditor(editor);
    expect(nonEmptyCall(editor)).toBeDefined();
  });
});
