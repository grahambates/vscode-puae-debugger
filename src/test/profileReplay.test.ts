import { readFileSync } from "fs";
import * as path from "path";
import { decodeCapture } from "../profileFormat";
import { loadProfile } from "../profileLoader";
import { DMA_HPOS, DMA_VPOS } from "../shared/profilerTypes";
import { buildColumns } from "../webview/profilerViewer/columns";
import { createTopDownGraph } from "../webview/profilerViewer/topDownGraph";

// End-to-end replay of a real captured frame (template/a.elf, minted via the Save button):
// decode the .puaeprofile -> rebuild the SourceMap from the embedded ELF + relocation ->
// build the model (extension layer) -> turn it into columns + the CPU/DMA tree (webview
// layer). No emulator needed; the bundle is the deterministic fixture.
const FIXTURE = path.join(__dirname, "fixtures/profiles/template.puaeprofile");

describe("replay template.puaeprofile", () => {
  const file = readFileSync(FIXTURE);

  it("decodes a complete, relocation-bearing bundle", () => {
    const { raws: [raw], elf, manifest } = decodeCapture(file);
    expect(manifest.version).toBe(1);
    expect(elf && elf.length).toBeGreaterThan(0);
    expect(manifest.program.elfEmbedded).toBe(true);
    expect(manifest.relocation?.segmentOffsets.length).toBeGreaterThan(0);
    expect(raw.dma?.length).toBe(DMA_HPOS * DMA_VPOS * 8); // 71051 cells * 8 bytes
    expect(raw.snapshot?.chip.length).toBeGreaterThan(0);
  });

  it("rebuilds the model with symbolicated + inlined frames (extension layer)", () => {
    const { frames, manifest } = loadProfile(file);
    const model = frames[0].model;
    const names = model.locations.map((l) => l.callFrame.functionName);

    expect(model.locations.length).toBeGreaterThan(10);
    expect(names[0]).toBe("(all)"); // synthetic root
    // a.elf inlines functions — they must appear as their own frames, suffixed.
    expect(names.some((n) => n.endsWith(" (inlined)"))).toBe(true);
    // Kickstart ROM leaves re-symbolicate from the manifest's ROM sha1 (the .kick module is
    // re-merged on load) — ROM/OS calls show [Kick] <name>, matching the live view.
    expect(names.some((n) => n.startsWith("[Kick] "))).toBe(true);
    // DMA captured in the same frame.
    expect(model.dma?.owner.length).toBe(DMA_HPOS * DMA_VPOS);
    expect(model.dmaSnapshot).toBeDefined();
    expect(model.symbols && model.symbols.length).toBeGreaterThan(0);
    // Timing derived from the measured frame cycles (PAL: /20000 µs).
    expect(model.duration).toBeGreaterThan(0);
    expect(model.cyclesPerMicroSecond).toBeCloseTo((manifest.meta.frameCycles ?? 0) / 20000, 3);
  });

  it("turns the model into columns + a CPU/DMA top-down tree (webview layer)", () => {
    const { frames } = loadProfile(file);
    const model = frames[0].model;

    const columns = buildColumns(model);
    expect(columns.length).toBeGreaterThan(0);
    // Not exactly 0: buildColumns anchors CPU columns to the DMA grid's own record of each
    // instruction's fetch (see columns.ts' buildSampleSlots) rather than a cycle-cost fraction, so
    // the first column starts at the real DMA slot of the first sampled instruction — which is
    // rarely slot 0, since some real time (interrupts/OS calls) typically runs before the capture's
    // first sampled (in-program) instruction that frame.
    expect(columns[0].x1).toBeGreaterThanOrEqual(0);
    expect(columns[0].x1).toBeLessThan(0.01);
    expect(columns[columns.length - 1].x2).toBeCloseTo(1, 6);

    const groups = Object.values(createTopDownGraph(model).children).map((n) => n.callFrame.functionName);
    expect(groups).toContain("CPU");
    expect(groups).toContain("DMA");
  });
});

// A 2-frame document built from the same real captured bytes as template.puaeprofile (frame 1 is
// a duplicate of frame 0, minus its own disassembly/registers — matching what a live multi-frame
// capture actually stores for frames 1..N-1, see buildFramesFromCaptures). Real profile-stream/
// DMA-grid/copper bytes for both frames, so decodeProfileStream/decodeDmaGrid/symbolication all
// run against genuine data, not hand-crafted mocks — just exercising the save/load round trip
// with more than one frame present.
const MULTI_FIXTURE = path.join(__dirname, "fixtures/profiles/template-multiframe.puaeprofile");

describe("replay template-multiframe.puaeprofile", () => {
  const file = readFileSync(MULTI_FIXTURE);

  it("decodes both frames independently", () => {
    const { raws, manifest } = decodeCapture(file);
    expect(manifest.frameCount).toBe(2);
    expect(raws).toHaveLength(2);
    expect(raws[0].dma?.length).toBe(DMA_HPOS * DMA_VPOS * 8);
    expect(raws[1].dma?.length).toBe(DMA_HPOS * DMA_VPOS * 8);
    // Only frame 0 could ever persist real disassembly — this particular fixture's capture
    // has none (see the single-frame replay above, which doesn't assert on it either), so
    // frame 1 has none too. profileFormat.test.ts's synthetic multi-frame test covers the
    // actual reweighting mechanic with a fixture that does carry disassembly.
    expect(raws[1].disassembly).toBeUndefined();
  });

  it("rebuilds both frames independently", () => {
    const { frames } = loadProfile(file);
    expect(frames).toHaveLength(2);

    for (const f of frames) {
      const names = f.model.locations.map((l) => l.callFrame.functionName);
      expect(names[0]).toBe("(all)");
      expect(f.model.dma?.owner.length).toBe(DMA_HPOS * DMA_VPOS);
    }
    expect(frames[1].raw.disassembly).toBeUndefined();
  });

  it("attaches a combined all-frames model to frame 0", () => {
    const { frames } = loadProfile(file);
    const combined = frames[0].combined;
    expect(combined).toBeDefined();
    // Both frames' samples concatenated — roughly double frame 0's duration alone.
    expect(combined!.samples.length).toBeGreaterThan(frames[0].model.samples.length);
    expect(combined!.symbols).toEqual(frames[0].model.symbols);

    const columns = buildColumns(combined!);
    expect(columns.length).toBeGreaterThan(0);
  });
});
