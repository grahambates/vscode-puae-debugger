import * as vscode from "vscode";
import { ProfilerCodeLensProvider } from "../profilerCodeLensProvider";
import { IProfileModel, ILocation, Category } from "../shared/profilerTypes";

const loc = (overrides: Partial<ILocation>): ILocation => ({
  id: 1,
  selfTime: 0,
  aggregateTime: 0,
  category: Category.User,
  callFrame: { functionName: "fn", url: "C:\\proj\\a.c", scriptId: "0", lineNumber: 4, columnNumber: 0 },
  address: 0x1000,
  ...overrides,
});

const model = (locations: ILocation[]): IProfileModel => ({
  nodes: [],
  locations,
  samples: [],
  timeDeltas: [],
  pcs: [],
  duration: 1000,
  cyclesPerMicroSecond: 7.09379,
});

const doc = (path: string): vscode.TextDocument => ({ uri: { fsPath: path } }) as vscode.TextDocument;

describe("ProfilerCodeLensProvider", () => {
  it("provides a lens at the location's line for a matching file", () => {
    const p = new ProfilerCodeLensProvider();
    p.update(model([loc({ selfTime: 250, aggregateTime: 500 })]));

    const lenses = p.provideCodeLenses(doc("C:\\proj\\a.c"));
    expect(lenses).toHaveLength(1);
    const lens = (lenses as vscode.CodeLens[])[0];
    expect((lens.range as unknown as { startLine: number }).startLine).toBe(4);
    expect((lens.command as { title: string }).title).toBe("25.0% Self, 50.0% Total");
  });

  it("matches the file path case-insensitively and normalizes separators", () => {
    const p = new ProfilerCodeLensProvider();
    p.update(model([loc({ selfTime: 1, callFrame: { functionName: "fn", url: "c:/proj/A.C", scriptId: "0", lineNumber: 0, columnNumber: 0 } })]));
    expect(p.provideCodeLenses(doc("C:\\proj\\a.c"))).toHaveLength(1);
  });

  it("skips locations with no source, unknown line, or all-zero times", () => {
    const p = new ProfilerCodeLensProvider();
    p.update(
      model([
        loc({ callFrame: { functionName: "fn", url: "", scriptId: "0", lineNumber: 4, columnNumber: 0 } }), // no file
        loc({ callFrame: { functionName: "fn", url: "C:\\proj\\b.c", scriptId: "0", lineNumber: -1, columnNumber: 0 } }), // unknown line
        loc({ callFrame: { functionName: "fn", url: "C:\\proj\\c.c", scriptId: "0", lineNumber: 0, columnNumber: 0 } }), // all zero
      ]),
    );
    expect(p.provideCodeLenses(doc("C:\\proj\\b.c"))).toHaveLength(0);
    expect(p.provideCodeLenses(doc("C:\\proj\\c.c"))).toHaveLength(0);
  });

  it("returns nothing for a file with no lenses, and clears on clear()/update(undefined)", () => {
    const p = new ProfilerCodeLensProvider();
    p.update(model([loc({ selfTime: 1 })]));
    expect(p.provideCodeLenses(doc("C:\\proj\\other.c"))).toHaveLength(0);

    p.clear();
    expect(p.provideCodeLenses(doc("C:\\proj\\a.c"))).toHaveLength(0);
  });

  it("fires onDidChangeCodeLenses on update", () => {
    const p = new ProfilerCodeLensProvider();
    const handler = jest.fn();
    p.onDidChangeCodeLenses(handler);
    p.update(model([loc({ selfTime: 1 })]));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
