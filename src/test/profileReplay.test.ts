import { readFileSync } from "fs";
import * as path from "path";
import { decodeCapture } from "../vamigaProfile";
import { loadProfile } from "../profileLoader";
import { DMA_HPOS, DMA_VPOS } from "../shared/profilerTypes";
import { buildColumns } from "../webview/profilerViewer/columns";
import { createTopDownGraph } from "../webview/profilerViewer/topDownGraph";

// End-to-end replay of a real captured frame (template/a.elf, minted via the Save button):
// decode the .vamigaprofile -> rebuild the SourceMap from the embedded ELF + relocation ->
// build the model (extension layer) -> turn it into columns + the CPU/DMA tree (webview
// layer). No emulator needed; the bundle is the deterministic fixture.
const FIXTURE = path.join(__dirname, "fixtures/vamigaProfiles/template.vamigaprofile");

describe("replay template.vamigaprofile", () => {
  const file = readFileSync(FIXTURE);

  it("decodes a complete, relocation-bearing bundle", () => {
    const { raw, elf, manifest } = decodeCapture(file);
    expect(manifest.version).toBe(1);
    expect(elf && elf.length).toBeGreaterThan(0);
    expect(manifest.program.elfEmbedded).toBe(true);
    expect(manifest.relocation?.segmentOffsets.length).toBeGreaterThan(0);
    expect(raw.dma?.length).toBe(DMA_HPOS * DMA_VPOS * 8); // 71051 cells * 8 bytes
    expect(raw.snapshot?.chip.length).toBeGreaterThan(0);
  });

  it("rebuilds the model with symbolicated + inlined frames (extension layer)", () => {
    const { model, manifest } = loadProfile(file);
    const names = model.locations.map((l) => l.callFrame.functionName);

    expect(model.locations.length).toBeGreaterThan(10);
    expect(names[0]).toBe("(all)"); // synthetic root
    // a.elf inlines functions — they must appear as their own frames, suffixed.
    expect(names.some((n) => n.endsWith(" (inlined)"))).toBe(true);
    // DMA captured in the same frame.
    expect(model.dma?.owner.length).toBe(DMA_HPOS * DMA_VPOS);
    expect(model.dmaSnapshot).toBeDefined();
    expect(model.symbols && model.symbols.length).toBeGreaterThan(0);
    // Timing derived from the measured frame cycles (PAL: /20000 µs).
    expect(model.duration).toBeGreaterThan(0);
    expect(model.cyclesPerMicroSecond).toBeCloseTo((manifest.meta.frameCycles ?? 0) / 20000, 3);
  });

  it("turns the model into columns + a CPU/DMA top-down tree (webview layer)", () => {
    const { model } = loadProfile(file);

    const columns = buildColumns(model);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns[0].x1).toBe(0);
    expect(columns[columns.length - 1].x2).toBeCloseTo(1, 6);

    const groups = Object.values(createTopDownGraph(model).children).map((n) => n.callFrame.functionName);
    expect(groups).toContain("CPU");
    expect(groups).toContain("DMA");
  });
});
