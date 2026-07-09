import * as vscode from "vscode";
import { normalize } from "path";
import { IProfileModel } from "./shared/profilerTypes";
import { heatColor } from "./shared/profilerColor";

// Number of discrete background-tint levels. VS Code's per-DecorationOptions `renderOptions`
// only lets an individual range override its `before`/`after` attachment (see
// ThemableDecorationInstanceRenderOptions in @types/vscode) — NOT the line's own background
// color, which is fixed per TextEditorDecorationType at creation time. So a smooth per-line
// heat gradient needs one decoration type per discrete level, with each line's range assigned
// to its nearest bucket (the same technique VS Code coverage-gutter extensions use), rather than
// one type with infinitely many background colors.
const HEAT_BUCKETS = 8;

interface LineStats {
  cycles: number;
  hits: number;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Per-source-line cycle/execution-count annotations in the real VS Code editor — the line-level
// companion to ProfilerCodeLensProvider's per-function stats. Sourced from the same
// IProfileModel a capture/load already builds (model.disassembly, which — unlike
// ILocation/CallFrame — carries exact per-instruction hits/cycles/file/line; see
// shared/profilerTypes.ts), grouped here by (file, line) since multiple instructions commonly
// share one source line. On by default, same as the function-level CodeLens — toggled off/on
// via the "vamiga-debugger.toggleLineProfilerAnnotations" command for anyone who finds
// decorating every profiled line too visually heavy for routine editing.
//
// model.disassembly only covers the hottest ~64 functions (MAX_DISASSEMBLE_FUNCTIONS in
// profilerManager.ts) — colder functions simply have no entries here (and so show no line
// decorations) even though they still get a function-level CodeLens from
// ProfilerCodeLensProvider, which draws from the more complete model.locations instead.
export class ProfilerLineDecorationProvider implements vscode.HoverProvider, vscode.Disposable {
  private enabled = true;

  // Keyed by normalize(path).toUpperCase() — matches SourceMap/ProfilerCodeLensProvider's
  // path-matching convention. Line numbers are 1-based (as in IDisassembledInstruction.line).
  private byFile = new Map<string, Map<number, LineStats>>();
  // Per-file hottest single LINE's cycle total (the sum for that line, not one instruction's
  // value) — the heat-tint scale is local to each file, same reasoning DisassemblyView.tsx's
  // per-function (not per-capture) scaling uses: keeps the gradient meaningful for a file that's
  // individually cold relative to the rest of the program.
  private maxCyclesByFile = new Map<string, number>();
  // Per-file total cycles across all its lines, for the hover's "% of file" figure.
  private totalCyclesByFile = new Map<string, number>();

  // One decoration type per heat bucket, each with a fixed backgroundColor (computed once, via
  // the SAME heatColor() formula DisassemblyView.tsx's per-instruction heat map uses, so the two
  // views agree visually) plus shared `after`-attachment styling (color/style/margin) — the
  // actual per-line contentText is supplied per-DecorationOptions instance in applyToEditor.
  private readonly bucketTypes: vscode.TextEditorDecorationType[] = Array.from(
    { length: HEAT_BUCKETS },
    (_, i) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: heatColor(i + 0.5, HEAT_BUCKETS) ?? undefined,
        after: {
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          fontStyle: "italic",
          margin: "0 0 0 1.5rem",
        },
      }),
  );

  public setEnabled(on: boolean): void {
    this.enabled = on;
    this.refreshVisibleEditors();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public update(model: IProfileModel | undefined): void {
    const byFile = new Map<string, Map<number, LineStats>>();
    for (const fn of model?.disassembly ?? []) {
      for (const ins of fn.instructions) {
        if (!ins.file || ins.line === undefined || ins.line < 0) continue;
        if (ins.cycles <= 0 && ins.hits <= 0) continue;
        const key = normalize(ins.file).toUpperCase();
        let lines = byFile.get(key);
        if (!lines) {
          lines = new Map();
          byFile.set(key, lines);
        }
        const existing = lines.get(ins.line);
        if (existing) {
          existing.cycles += ins.cycles;
          existing.hits += ins.hits;
        } else {
          lines.set(ins.line, { cycles: ins.cycles, hits: ins.hits });
        }
      }
    }

    const maxCyclesByFile = new Map<string, number>();
    const totalCyclesByFile = new Map<string, number>();
    for (const [file, lines] of byFile) {
      let max = 0;
      let total = 0;
      for (const { cycles } of lines.values()) {
        if (cycles > max) max = cycles;
        total += cycles;
      }
      maxCyclesByFile.set(file, max);
      totalCyclesByFile.set(file, total);
    }

    this.byFile = byFile;
    this.maxCyclesByFile = maxCyclesByFile;
    this.totalCyclesByFile = totalCyclesByFile;
    this.refreshVisibleEditors();
  }

  public clear(): void {
    this.update(undefined);
  }

  public refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refreshEditor(editor);
  }

  public refreshEditor(editor: vscode.TextEditor): void {
    if (this.enabled) this.applyToEditor(editor);
    else this.clearEditorDecorations(editor);
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const key = normalize(editor.document.uri.fsPath).toUpperCase();
    const lines = this.byFile.get(key);
    if (!lines) {
      this.clearEditorDecorations(editor);
      return;
    }
    const maxCycles = this.maxCyclesByFile.get(key) ?? 0;
    const buckets: vscode.DecorationOptions[][] = this.bucketTypes.map(() => []);
    for (const [line, stats] of lines) {
      const heat = maxCycles > 0 ? stats.cycles / maxCycles : 0;
      const bucketIdx = Math.min(HEAT_BUCKETS - 1, Math.floor(heat * HEAT_BUCKETS));
      const zeroBased = line - 1;
      buckets[bucketIdx].push({
        range: new vscode.Range(zeroBased, 0, zeroBased, 0),
        renderOptions: {
          after: { contentText: ` ${formatCount(stats.cycles)} cy · ${formatCount(stats.hits)}×` },
        },
      });
    }
    this.bucketTypes.forEach((type, i) => editor.setDecorations(type, buckets[i]));
  }

  private clearEditorDecorations(editor: vscode.TextEditor): void {
    this.bucketTypes.forEach((type) => editor.setDecorations(type, []));
  }

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    if (!this.enabled) return undefined;
    const key = normalize(document.uri.fsPath).toUpperCase();
    const stats = this.byFile.get(key)?.get(position.line + 1); // 0-based -> 1-based
    if (!stats) return undefined;
    const total = this.totalCyclesByFile.get(key) ?? 0;
    const pct = total > 0 ? (stats.cycles / total) * 100 : 0;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**Profiler:** ${stats.cycles.toLocaleString()} cycles (${pct.toFixed(1)}% of file), ` +
        `${stats.hits.toLocaleString()} execution${stats.hits === 1 ? "" : "s"}`,
    );
    return new vscode.Hover(md);
  }

  public dispose(): void {
    this.bucketTypes.forEach((type) => type.dispose());
  }
}
