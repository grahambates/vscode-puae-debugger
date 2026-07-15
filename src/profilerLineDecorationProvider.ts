import * as vscode from "vscode";
import { win32 } from "path";
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
// via the "puae-debugger.toggleLineProfilerAnnotations" command for anyone who finds
// decorating every profiled line too visually heavy for routine editing.
//
// model.disassembly is bounded by a total decoded-instruction budget in profilerManager.ts.
// Functions are visited hottest-first, but the budget is independent of how source or assembly
// labels happen to divide those instructions into functions.
export class ProfilerLineDecorationProvider implements vscode.HoverProvider, vscode.Disposable {
  private enabled = true;

  // Keyed by win32.normalize(path).toUpperCase() — matches SourceMap/ProfilerCodeLensProvider's
  // path-matching convention (see SourceMap's own doc comment for why win32, not the
  // platform-native `path` module). Line numbers are 1-based (as in IDisassembledInstruction.line).
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

  // Does this line currently carry a decoration? Used to gate the "Jump to Next Execution in
  // Profiler" editor-context-menu command before bothering to reveal the profiler panel — see
  // puae-debugger.jumpToProfilerExecution in extension.ts. `line` is 1-based.
  public hasDataAt(file: string, line: number): boolean {
    if (!this.enabled) return false;
    return !!this.byFile.get(win32.normalize(file).toUpperCase())?.has(line);
  }

  public update(model: IProfileModel | undefined): void {
    const byFile = new Map<string, Map<number, LineStats>>();
    for (const fn of model?.disassembly ?? []) {
      for (const ins of fn.instructions) {
        if (!ins.file || ins.line === undefined || ins.line < 0) continue;
        if (ins.cycles <= 0 && ins.hits <= 0) continue;
        const key = win32.normalize(ins.file).toUpperCase();
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

    this.byFile = byFile;
    this.maxCyclesByFile = new Map();
    this.totalCyclesByFile = new Map();
    for (const key of byFile.keys()) this.recomputeFileAggregates(key);
    this.refreshVisibleEditors();
  }

  public clear(): void {
    this.update(undefined);
  }

  // Recomputes maxCyclesByFile/totalCyclesByFile for one file from its current byFile entry —
  // shared by update() (fresh data) and handleDocumentChange() (existing data with some lines
  // dropped/shifted, which can change the max/total).
  private recomputeFileAggregates(key: string): void {
    const lines = this.byFile.get(key);
    if (!lines || lines.size === 0) {
      this.maxCyclesByFile.delete(key);
      this.totalCyclesByFile.delete(key);
      return;
    }
    let max = 0;
    let total = 0;
    for (const { cycles } of lines.values()) {
      if (cycles > max) max = cycles;
      total += cycles;
    }
    this.maxCyclesByFile.set(key, max);
    this.totalCyclesByFile.set(key, total);
  }

  // Keeps cached line data roughly in sync with live edits, so decorations don't silently drift
  // onto the wrong line (e.g. inserting a line above profiled code). For each content change in
  // the event (processed bottom-to-top, since VS Code expresses every change in one event
  // relative to the SAME pre-event document — applying top-to-bottom would let an earlier change
  // invalidate later changes' line numbers): lines strictly before the edited span are kept as-is;
  // lines strictly after are shifted by linesAdded-linesRemoved; lines touching the edited span
  // itself are DROPPED rather than guessed at — deliberately conservative, since this profiler's
  // whole value is exact (not estimated) numbers, and a dropped line just reappears at the next
  // capture, whereas a wrongly-shifted one would look authoritative while being silently wrong.
  public handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const key = win32.normalize(event.document.uri.fsPath).toUpperCase();
    const lines = this.byFile.get(key);
    if (!lines || lines.size === 0) return;

    const changes = [...event.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    for (const change of changes) {
      const startLine = change.range.start.line + 1; // 0-based -> 1-based
      const endLine = change.range.end.line + 1;
      const linesAdded = (change.text.match(/\n/g) ?? []).length;
      const linesRemoved = endLine - startLine;
      const delta = linesAdded - linesRemoved;
      // Even a delta=0 edit (e.g. typing within one line) still must drop the touched line below
      // — its content changed, so its cached count can no longer be trusted — hence no early-out
      // here regardless of delta.
      const next = new Map<number, LineStats>();
      for (const [line, stats] of lines) {
        if (line < startLine) next.set(line, stats);
        else if (line > endLine) next.set(line + delta, stats);
        // else: line falls within [startLine, endLine] — dropped.
      }
      lines.clear();
      for (const [line, stats] of next) lines.set(line, stats);
    }

    if (lines.size === 0) this.byFile.delete(key);
    this.recomputeFileAggregates(key);
    this.refreshEditorsForDocument(event.document);
  }

  private refreshEditorsForDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.refreshEditor(editor);
    }
  }

  public refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refreshEditor(editor);
  }

  public refreshEditor(editor: vscode.TextEditor): void {
    if (this.enabled) this.applyToEditor(editor);
    else this.clearEditorDecorations(editor);
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const key = win32.normalize(editor.document.uri.fsPath).toUpperCase();
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
    const key = win32.normalize(document.uri.fsPath).toUpperCase();
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
