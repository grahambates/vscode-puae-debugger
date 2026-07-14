// Amiga bitplane/palette decode primitives shared between the profiler's Screen reconstruction
// (profilerViewer/gfxResources.ts, ResourcesView.tsx — replaying a captured DMA/copper trace) and
// the live emulator's paused-screen hover tooltip (puaeApp/screenHover.ts — replaying the same
// register-write log live, one scanline at a time). Zero vscode/Node imports, per this project's
// src/shared/ convention.
import { CUSTOM_REGISTER_OFFSETS as R } from "../webview/shared/customRegisters";

// 4-bit -> 8-bit component expansion (OCS/ECS COLORxx nibbles).
export const expand4 = (v: number) => v * 0x11;

// 6-bit -> 8-bit component expansion (AGA HAM8's new-component fields).
export const expand6 = (v: number) => (v << 2) | (v >> 4);

// Decodes the mode-relevant bits of a BPLCON0 value in isolation — shared by the initial-state
// computation in buildScreenFromModel and by per-line BPLCON0 tracking, so both interpret the
// register identically (including the OCS/ECS 7-plane trick). `numPlanes` here is read directly
// off the BPU field (bpu, or 6 for the 7-plane trick) — NOT necessarily the DMA-grid-derived value
// a caller may use for buffer sizing; callers that need "how many planes does *this* BPLCON0 value
// describe" want this one.
export function decodeBplcon0(bplcon0: number, isAga: boolean): {
  numPlanes: number; hires: boolean; ham: boolean; dpf: boolean; staticPlanes: boolean;
} {
  const hires = (bplcon0 & (1 << 15)) !== 0;
  const ham   = (bplcon0 & (1 << 11)) !== 0;
  const dpf   = (bplcon0 & (1 << 10)) !== 0;
  const bpu   = (bplcon0 >> 12) & 7;
  // See IScreen.staticPlanes's doc comment (gfxResources.ts) for the hardware background.
  const staticPlanes = bpu === 7 && !isAga;
  const numPlanes = staticPlanes ? 6 : bpu;
  return { numPlanes, hires, ham, dpf, staticPlanes };
}

// `agaColors`, when present, is AGA's full 256-entry, already-24-bit-per-channel palette (see
// gfxResources.ts's DmaSnapshot.agaColors doc comment) — already fully reconstructed C-side
// (BPLCON3 LOCT/bank-select applied), so this just repacks each 0x00RRGGBB entry into the
// canvas-ready 0xAABBGGRR (RGBA byte order) format used throughout. Falls back to the OCS/ECS
// COLOR00-31 window (32 entries, 4-bit-per-channel) when absent (non-AGA capture).
export function buildPalette(regs: Uint16Array, agaColors?: Uint32Array): Uint32Array {
  if (agaColors) {
    const pal = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = agaColors[i];
      const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
      pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    return pal;
  }
  const pal = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const raw = regs[(R.COLOR00 + i * 2) >> 1];
    const r = expand4((raw >> 8) & 0xf);
    const g = expand4((raw >> 4) & 0xf);
    const b = expand4(raw & 0xf);
    pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return pal;
}
