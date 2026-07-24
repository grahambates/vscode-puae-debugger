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

const fn = (name: string, instructions: IDisassembledInstruction[]): IDisassembledFunction => {
  const last = instructions[instructions.length - 1];
  return {
    address: instructions[0]?.address ?? 0,
    end: last ? last.address + last.length : 0,
    name,
    totalCycles: instructions.reduce((s, i) => s + i.cycles, 0),
    instructions,
  };
};

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

  describe("hasDataAt (gates the 'Jump to Next Execution in Profiler' editor command)", () => {
    it("is true for a decorated line, false for an undecorated one", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
      expect(p.hasDataAt("C:\\proj\\a.c", 10)).toBe(true);
      expect(p.hasDataAt("C:\\proj\\a.c", 11)).toBe(false);
    });

    it("matches files case-insensitively and normalizes separators", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "c:/proj/A.C", line: 10, cycles: 100, hits: 5 })])]));
      expect(p.hasDataAt("C:\\proj\\a.c", 10)).toBe(true);
    });

    it("is false when tracking is disabled, even for an otherwise-decorated line", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
      p.setEnabled(false);
      expect(p.hasDataAt("C:\\proj\\a.c", 10)).toBe(false);
    });

    it("is false after clear()", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 100, hits: 5 })])]));
      p.clear();
      expect(p.hasDataAt("C:\\proj\\a.c", 10)).toBe(false);
    });
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

  it("computes the per-function max from summed per-line totals, not per-instruction values", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setEnabled(true);
    p.setGlobalHeat(false);
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

  describe("setGlobalHeat", () => {
    it("starts on, matching DisassemblyView.tsx's own default", () => {
      const p = new ProfilerLineDecorationProvider();
      expect(p.isGlobalHeat()).toBe(true);
    });

    it("scales every line's heat by the hottest line across the whole capture instead of just its own function's max", () => {
      const p = new ProfilerLineDecorationProvider();
      p.setEnabled(true);
      p.update(
        model([
          // Each file here has exactly one function, so its function-max and file-max coincide —
          // this test isolates the global-vs-per-function distinction specifically (the separate
          // "per-function, not per-file" test below covers a file with two functions instead).
          fn("hot", [ins({ file: "C:\\proj\\hot.c", line: 1, cycles: 1000, hits: 1, address: 0x1000 })]),
          fn("cold", [ins({ file: "C:\\proj\\cold.c", line: 1, cycles: 10, hits: 1, address: 0x2000 })]),
        ]),
      );
      const coldEditor = mockEditor("C:\\proj\\cold.c");

      // Per-function (globalHeat off): cold.c's only line IS its enclosing function's own max ->
      // hottest bucket.
      p.setGlobalHeat(false);
      p.refreshEditor(coldEditor);
      let calls = coldEditor.setDecorations.mock.calls as [unknown, { range: { startLine: number } }[]][];
      expect(calls[calls.length - 1][1]).toHaveLength(1);

      coldEditor.setDecorations.mockClear();
      p.setGlobalHeat(true);
      expect(p.isGlobalHeat()).toBe(true);
      p.refreshEditor(coldEditor);

      // Global (the default): cold.c's line is only 10/1000 of the capture's hottest line -> the
      // coldest bucket, not the hottest.
      calls = coldEditor.setDecorations.mock.calls as [unknown, { range: { startLine: number } }[]][];
      expect(calls[calls.length - 1][1]).toHaveLength(0);
      expect(calls[0][1]).toHaveLength(1);
    });
  });

  it("scales each line by its own enclosing function's max when globalHeat is off, not the whole file's max — matching DisassemblyView.tsx's per-function mode", () => {
    const p = new ProfilerLineDecorationProvider();
    p.setGlobalHeat(false);
    p.setEnabled(true);
    p.update(
      model([
        // Same file, two very differently-hot functions.
        fn("hot_fn", [ins({ file: "C:\\proj\\multi.c", line: 1, cycles: 1000, hits: 1, address: 0x1000 })]),
        fn("cold_fn", [ins({ file: "C:\\proj\\multi.c", line: 2, cycles: 10, hits: 1, address: 0x2000 })]),
      ]),
    );
    const editor = mockEditor("C:\\proj\\multi.c");
    p.refreshEditor(editor);

    const calls = editor.setDecorations.mock.calls as [unknown, { range: { startLine: number } }[]][];
    // Line 1 (hot_fn's only line) is its own function's max -> hottest bucket.
    expect(calls[calls.length - 1][1].some((o) => o.range.startLine === 0)).toBe(true);
    // Line 2 (cold_fn's only line) is ALSO its own function's max (10/10 = 1.0), even though the
    // file's overall max is 1000 — a per-file default would have buried it near the coldest
    // bucket (10/1000); the per-function default instead also puts it in the hottest bucket.
    expect(calls[calls.length - 1][1].some((o) => o.range.startLine === 1)).toBe(true);
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

  describe("handleDocumentChange (live-edit tracking)", () => {
    // Real vscode.TextDocumentContentChangeEvent shape ({range: {start: {line}, end: {line}},
    // text}) — distinct from this test file's flat MockRange (used elsewhere for constructed
    // vscode.Range instances), since contentChanges arrive from VS Code's live API untouched.
    const change = (startLine0: number, endLine0: number, text: string) => ({
      range: { start: { line: startLine0, character: 0 }, end: { line: endLine0, character: 0 } },
      text,
    });
    const changeEvent = (
      doc: vscode.TextDocument,
      changes: ReturnType<typeof change>[],
    ): vscode.TextDocumentChangeEvent =>
      ({ document: doc, contentChanges: changes }) as unknown as vscode.TextDocumentChangeEvent;

    function lineAt(p: ProfilerLineDecorationProvider, path: string, oneBasedLine: number): { cycles: number; hits: number } | undefined {
      const hover = p.provideHover(
        { uri: { fsPath: path } } as vscode.TextDocument,
        { line: oneBasedLine - 1 } as vscode.Position,
      ) as vscode.Hover | undefined;
      if (!hover) return undefined;
      const text = (hover.contents as unknown as { value: string }).value;
      const cycles = Number(text.match(/([\d,]+) cycles/)?.[1].replace(/,/g, ""));
      const hits = Number(text.match(/([\d,]+) execution/)?.[1].replace(/,/g, ""));
      return { cycles, hits };
    }

    it("shifts lines after an inserted line down, leaves earlier lines untouched", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(
        model([
          fn("a", [
            ins({ file: "C:\\proj\\a.c", line: 3, cycles: 10, hits: 1, address: 0x1000 }),
            ins({ file: "C:\\proj\\a.c", line: 10, cycles: 200, hits: 9, address: 0x1002 }),
          ]),
        ]),
      );
      const doc = { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument;
      // Cursor at end of (0-based) line 4 = (1-based) line 5, press Enter: insert one line
      // between line 5 and line 6. Nothing before line 5 is touched; line 10 -> line 11.
      p.handleDocumentChange(changeEvent(doc, [change(4, 4, "\n")]));

      expect(lineAt(p, "C:\\proj\\a.c", 3)).toEqual({ cycles: 10, hits: 1 }); // unaffected
      expect(lineAt(p, "C:\\proj\\a.c", 10)).toBeUndefined(); // moved away from here
      expect(lineAt(p, "C:\\proj\\a.c", 11)).toEqual({ cycles: 200, hits: 9 }); // shifted down by 1
    });

    it("shifts lines up when a whole line is deleted", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 200, hits: 9 })])]));
      const doc = { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument;
      // Delete the whole of (0-based) line 5 = (1-based) line 6, i.e. range [line5,char0)..[line6,char0), text="".
      p.handleDocumentChange(changeEvent(doc, [change(5, 6, "")]));
      expect(lineAt(p, "C:\\proj\\a.c", 10)).toBeUndefined();
      expect(lineAt(p, "C:\\proj\\a.c", 9)).toEqual({ cycles: 200, hits: 9 }); // shifted up by 1
    });

    it("drops (does not guess at) a line whose own content was edited, even with no line-count change", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(
        model([
          fn("a", [
            ins({ file: "C:\\proj\\a.c", line: 5, cycles: 100, hits: 5, address: 0x1000 }),
            ins({ file: "C:\\proj\\a.c", line: 6, cycles: 50, hits: 2, address: 0x1002 }),
          ]),
        ]),
      );
      const doc = { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument;
      // Same-line edit entirely within (0-based) line 4 = (1-based) line 5 — no newline change.
      p.handleDocumentChange(changeEvent(doc, [change(4, 4, "xyz")]));
      expect(lineAt(p, "C:\\proj\\a.c", 5)).toBeUndefined(); // dropped — its code changed
      expect(lineAt(p, "C:\\proj\\a.c", 6)).toEqual({ cycles: 50, hits: 2 }); // untouched line, unaffected
    });

    it("is a no-op for a file with no cached data (doesn't throw)", () => {
      const p = new ProfilerLineDecorationProvider();
      const doc = { uri: { fsPath: "C:\\proj\\untouched.c" } } as vscode.TextDocument;
      expect(() => p.handleDocumentChange(changeEvent(doc, [change(0, 0, "\n")]))).not.toThrow();
    });

    it("ignores edits to a different file", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(model([fn("a", [ins({ file: "C:\\proj\\a.c", line: 10, cycles: 200, hits: 9 })])]));
      const otherDoc = { uri: { fsPath: "C:\\proj\\other.c" } } as vscode.TextDocument;
      p.handleDocumentChange(changeEvent(otherDoc, [change(0, 0, "\n")]));
      expect(lineAt(p, "C:\\proj\\a.c", 10)).toEqual({ cycles: 200, hits: 9 }); // unaffected
    });

    it("applies multiple changes in one event correctly regardless of array order", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(
        model([
          fn("a", [
            ins({ file: "C:\\proj\\a.c", line: 3, cycles: 10, hits: 1, address: 0x1000 }),
            ins({ file: "C:\\proj\\a.c", line: 10, cycles: 20, hits: 2, address: 0x1002 }),
            ins({ file: "C:\\proj\\a.c", line: 20, cycles: 30, hits: 3, address: 0x1004 }),
          ]),
        ]),
      );
      const doc = { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument;
      // Two separate single-line insertions: one before line 10 (0-based line 4 => 1-based 5),
      // one before line 20 (0-based line 14 => 1-based 15). Listed out of line-order to confirm
      // handleDocumentChange sorts/orders them correctly rather than relying on input order.
      p.handleDocumentChange(changeEvent(doc, [change(14, 14, "\n"), change(4, 4, "\n")]));

      expect(lineAt(p, "C:\\proj\\a.c", 3)).toEqual({ cycles: 10, hits: 1 }); // before both edits
      expect(lineAt(p, "C:\\proj\\a.c", 11)).toEqual({ cycles: 20, hits: 2 }); // shifted by the first insertion only (+1)
      expect(lineAt(p, "C:\\proj\\a.c", 22)).toEqual({ cycles: 30, hits: 3 }); // shifted by both insertions (+2)
    });

    it("recomputes per-file max/total after a line is dropped", () => {
      const p = new ProfilerLineDecorationProvider();
      p.update(
        model([
          fn("a", [
            ins({ file: "C:\\proj\\a.c", line: 5, cycles: 100, hits: 5, address: 0x1000 }), // was the file's hottest line
            ins({ file: "C:\\proj\\a.c", line: 10, cycles: 50, hits: 2, address: 0x1002 }),
          ]),
        ]),
      );
      const doc = { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument;
      // Edit line 5 itself away — drops it, leaving line 10 as the file's only (and so hottest) line.
      p.handleDocumentChange(changeEvent(doc, [change(4, 4, "xyz")]));
      // % of file total should now be 100% (50/50), not 33% (50/150) from before the edit.
      const stats = lineAt(p, "C:\\proj\\a.c", 10);
      expect(stats).toEqual({ cycles: 50, hits: 2 });
      const hover = p.provideHover(
        { uri: { fsPath: "C:\\proj\\a.c" } } as vscode.TextDocument,
        { line: 9 } as vscode.Position,
      ) as vscode.Hover;
      expect((hover.contents as unknown as { value: string }).value).toContain("100.0%");
    });
  });
});
