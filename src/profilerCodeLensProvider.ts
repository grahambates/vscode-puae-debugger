import * as vscode from "vscode";
import { normalize } from "path";
import { IProfileModel } from "./shared/profilerTypes";

// Inline per-function "X.X% Self, Y.Y% Total, N Ticks" CodeLenses, sourced from the most
// recently captured/loaded profiler model. Ported from vscode-amiga-debug's createLenses +
// ProfileCodeLensProvider/LensCollection, collapsed into one class: that extension built its
// model in the webview and posted lens DTOs back over postMessage, but ours already builds
// IProfileModel extension-side (profilerManager.ts buildModelFromCapture), so there's no
// round-trip needed — callers just pass the model straight to `update()`.
//
// Global and last-write-wins by design: lenses reflect whichever profile (live capture or a
// loaded .puaeprofile) was most recently shown, across all panels/editors, and persist after
// that panel closes — consistent with ProfilerViewerProvider's own "reload survives capture"
// caching, since the underlying symbol data stays valid after a session ends.
export class ProfilerCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  // Keyed by normalize(path).toUpperCase() — matches SourceMap's path-matching convention
  // (src/sourceMap.ts), so lookups agree with how breakpoints/source resolution key paths.
  private byFile = new Map<string, vscode.CodeLens[]>();

  public update(model: IProfileModel | undefined): void {
    const byFile = new Map<string, vscode.CodeLens[]>();
    if (model) {
      for (const loc of model.locations) {
        const file = loc.callFrame.url;
        if (!file || loc.callFrame.lineNumber < 0) continue; // no source (DMA/synthetic/unresolved)
        if (loc.selfTime <= 0 && loc.aggregateTime <= 0) continue; // nothing to show

        const selfPct = model.duration > 0 ? (loc.selfTime / model.duration) * 100 : 0;
        const totalPct = model.duration > 0 ? (loc.aggregateTime / model.duration) * 100 : 0;
        const title = `${selfPct.toFixed(1)}% Self, ${totalPct.toFixed(1)}% Total`;
        // callFrame.lineNumber is 1-based (see shared/profilerTypes.ts); vscode.Range/Position
        // are 0-based, so convert here — same conversion openProfilerSource already applies for
        // this exact field. Missing it previously put the lens one line low: harmless-looking in
        // C/C++ (still lands on some nearby statement) but visibly wrong in assembly, where it
        // showed under the function's first instruction instead of anchored to it (i.e. visually
        // right below the label, where a CodeLens for that line naturally renders).
        const line = Math.max(0, loc.callFrame.lineNumber - 1);
        const range = new vscode.Range(line, 0, line, 0);
        const lens = new vscode.CodeLens(range, { title, command: "" });

        const key = normalize(file).toUpperCase();
        const list = byFile.get(key);
        if (list) list.push(lens);
        else byFile.set(key, [lens]);
      }
    }
    this.byFile = byFile;
    this.changeEmitter.fire();
  }

  public clear(): void {
    this.update(undefined);
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    return this.byFile.get(normalize(document.uri.fsPath).toUpperCase()) ?? [];
  }
}
