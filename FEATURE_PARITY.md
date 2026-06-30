# Feature parity reference — `vscode-amiga-debug` webview

A catalogue of every webview feature in the **old** extension (`vscode-amiga-debug`, the
WinUAE-based profiler/debugger) and the **exact data each needs**, so we can plan toward
parity in this extension. Paths below are in `../vscode-amiga-debug/src/`.

> **Status legend:** ✅ done here · 🟡 partial · ⬜ not yet · ⛔ N/A for vAmiga (e.g. AGA).
> This is a roadmap reference, not a spec — verify against the old source before porting.

---

## 0. Architecture contrast (important)

**Old extension:** the webview is *self-contained*. The backend dumps one big JSON
(`IProfileModel` + `$amiga` + `$base`) containing **raw memory snapshots, symbol tables,
sections, the per-cycle DMA grid, custom registers, gfx resources, screenshots** — and the
webview does *all* symbolization, memory/register/colour reconstruction, copper/blit
parsing, and screen rendering locally.

**This extension (so far):** the extension symbolizes/aggregates and ships a **lean,
pre-computed model**; the webview renders. Phase 4 keeps the enriched DMA grid + a chip/slow
snapshot but reconstruction is unwired.

**Decision for parity:** move the *reusable primitives* (symbol table, custom-register
names, memory/register reconstruction) to the webview so disassembly/copper/memory/screen
views can be built there — while keeping profiler-specific aggregation extension-side.
Custom-register names stay a **static webview table** (reuse `memoryViewer/copperDisassembler`
+ `stateViewer`). See §8 for the per-feature data we'd need to ship.

**vAmiga deltas vs WinUAE capture:**
- We use an **enriched bus grid** (`{owner,flags,data,addr}`/cycle), not WinUAE's 58-byte
  `dma_rec`. Read/write + byte/word come from `flags`; channel from `owner` (BusOwner).
- **OCS/ECS only** (6 bitplanes, no AGA) → `agaColors`/HAM8/8-plane features are ⛔ or differ.
- We don't yet capture: `gfxResources`, `pcTrace`, `registerTrace`, screenshots, full
  custom-register baseline (write-only regs), AGA colours.

---

## 1. Data model the old webview received

### `IProfileModel` (`client/model.ts`)
`nodes` (IComputedNode[]), `locations` (ILocation[]), `samples` (number[]),
`timeDeltas` (number[]), `duration` (cycles), `rootPath?`, plus Amiga extras:
`amiga?` (IAmigaProfileExtra), `base?` (IAmigaProfileBase), `shrinkler?`, and
webview-filled `memory?` (Memory), `copper?` (Copper[]), `blits?` (Blit[]).
→ **Ours:** `nodes/locations/samples/timeDeltas/duration/cyclesPerMicroSecond` ✅ + `dma?` (IDmaModel) ✅ +
`copper?` (ICopperModel) ✅.

### `IComputedNode` — `{id, selfTime, aggregateTime, children[], parent?, locationId}` (+shrinkler orig*). ✅
### `ILocation` — `{id, selfTime, aggregateTime, ticks, category, callFrame, src?}` (+orig*). ✅ (we use `address` instead of `src`).
### `IGraphNode extends ILocation` — `{children:{[id]}, childrenSize, parent?, filtered}` — the table tree node. ✅ (ours adds `dmaColor?`).

### `IAmigaProfileExtra` (`client/types.ts`) — the per-frame hardware capture
| field | holds | consumers |
|---|---|---|
| `chipsetFlags` | OCS/ECSAgnus/ECSDenise/AGA bits | screen, colours |
| `customRegs: number[]` | 256 custom regs at frame start | blits/copper/regs/screen reconstruction |
| `agaColors: number[]` | 256×24-bit AGA palette | screen/resources (⛔ vAmiga) |
| `dmaRecords: DmaRecord[]` | **227×313 = 70 951** per-cycle records (~4 MB) | everything DMA/memory/screen |
| `gfxResources: GfxResource[]` | registered bitmaps/palettes/coppers/sprites | resources viewer, SymbolizeAddress |
| `idleCycles` | CPU idle cycles | frame thumbnails/stats |
| `uniqueCallFrames: CallFrame[]` | dedup'd inline call stacks per .text addr | SymbolizeAddress (code callstack) |
| `callFrames: number[]` | 1/word in .text → index into uniqueCallFrames | SymbolizeAddress |
| `pcTrace: number[]` | `[pc, cycles]` pairs | objdump annotation |
| `registerTrace?: number[]` | regs per sample | inspection |
→ **Ours:** the enriched grid replaces `dmaRecords`; `uniqueCallFrames`/`callFrames` replaced by **flame columns at x** (we read the CPU stack from `columns`, see §5 tooltip); `pcTrace` ✅ (we
already had the strictly richer exact-per-instruction `samples`/`InstructionSample[]` extension-
side — `fetchDisassembly` aggregates it into per-PC hits/cycles, see §2.9). `registerTrace` ⬜.

### `IAmigaProfileBase` (`client/types.ts`) — shared, frame-0 only
`objdump` (text), `chipMem`/`bogoMem` (base64 snapshots), `symbols: SymbolInformation[]`,
`sections: Section[]`, `systemStackLower/Upper`, `stackLower/Upper`, `baseClock`,
`cpuCycleUnit`.
→ **Ours:** `chipMem`/`slow` snapshot ✅ (wired: Memory view, `reconstructMemoryAt`); `symbols` ✅
(shipped `ISymbol[]`, webview `createSymbolizer`/`symbolize()`); `objdump` ✅ (no host-side
`objdump` binary in this project — text comes from the live wasm session instead, see §2.9);
timing via measured `frameCycles`/`cyclesPerMicroSecond` ✅; `sections`/stack bounds ⬜.

### `DmaRecord` (`backend/profile_types.ts`)
`{reg?(&0x1000=CPU, &0x0100=write, &0xff=size), dat?, datHi?, size?(2/4/8), addr?, evt?(DmaEvents), type?(DmaTypes), extra?(DmaSubTypes), intlev?, end?}`.
→ **Ours:** `Cell{owner,flags,data,addr}` — r/w+size in `flags`, channel in `owner`, no `evt`.

### DMA enums (`client/dma.ts`)
- `NR_DMA_REC_HPOS=227`, `NR_DMA_REC_VPOS=313`; `displayLeft=92`, `displayTop=28`.
- `DmaTypes`: REFRESH, CPU, COPPER, AUDIO, BLITTER, BITPLANE, SPRITE, DISK, CONFLICT.
- `DmaSubTypes`: CPU_CODE/DATA; COPPER/WAIT/SPECIAL; BLITTER/FILL/LINE.
- `DmaEvents` (bitfield, ~30): BLITIRQ, BLIFINALD, BLITSTARTFINISH, BPLFETCHUPDATE,
  COPPERWAKE, CPUIRQ, INTREQ, COPPERWANTED, NOONEGETS, CPUBLITTERSTEAL/STOLEN, COPPERSKIP,
  DDFSTRT/STOP, VB/VS/LOF/LOL, HBS/HBE, HDIWS/HDIWE, VDIW, HSS/HSE, CIAA/CIAB_IRQ, CPUSTOP(IPL).
- `dmaTypes: Map<type,{name, subtypes:Map<sub,{color(0xAARRGGBB), name?}>}>` — the colour palette.
→ **Ours:** `BusOwner` ordinals + `channelStyle()` (colours copied) ✅; `DmaEvents` ✅ (PUAE's own
`dma_rec.evt` — already computed every cycle by the core for its internal debug log, just exposed
via a new wasm export rather than re-derived; `DMA_EVENT_*` + `dmaEventNames()` in
`webview/profilerViewer/dma.ts`; `evt2`/IPL bits not included); subtype mapping owner+flags ✅.

### `Blit` (`client/dma.ts`)
`{cycleStart, vposStart, hposStart, cycleEnd?, vposEnd?, hposEnd?, BLTSIZH, BLTSIZV,
BLTCON0, BLTCON1, BLTAFWM, BLTALWM, BLTxPT[4], BLTxDAT[4], BLTxMOD[4]}` — built by `GetBlits`. ✅
(`blits.ts` `getBlits`, reconstructed from the grid; wired to the flame blit-line + Blitter view).
### `Copper` (`client/dma.ts`)
`{cycle, vpos, hpos, address, insn: CopperInstruction}` — built by `GetCopper`.
`CopperInstruction` = Move{DA,RD,label} | Wait{VP,HP,BFD,VE,HE} | Skip{…}. ✅ (PUAE's `cop_record[]`
trace, `decodeCopperRecords` + `CopperView`; disassembled via `src/shared/copperDisassembler.ts`,
also used by `memoryViewer`).
### `GfxResource` (`backend/profile_types.ts`)
`{address, size, name, type(bitmap/palette/copperlist/sprite), flags(interleaved/masked/ham), bitmap?{w,h,numPlanes}, palette?{numEntries}, sprite?{index}}`. ⬜ (needs an emulator-side resource registry).
### `Memory` class (`client/dma.ts`)
`{chipMem:Uint8Array@0, bogoMem:Uint8Array@0xc00000}` + read/write Byte/Word/Long. → our `DmaSnapshot`
✅ (wired: Memory view, `reconstructMemoryAt`/`resolveMemoryRegion`).
### `CallFrame`/`SourceLine` — `{frames: {func?,file,line}[]}` (inline-aware). → replaced by flame columns.

### `DisplayUnit` (`client/display.ts`)
`Microseconds, Cycles, Lines, PercentFrame, Bytes, BytesHex, Percent`;
`cyclesPerMicroSecond = baseClock/4*256/cpuCycleUnit/1e6`; PercentFrame `/200`; Lines `*312.5/100`.
→ **Ours:** same units, measured `cyclesPerMicroSecond` ✅ (Bytes/Hex unused yet).
### `IRichFilter` — `{text, caseSensitive?, regex?}` + `compileFilter`. ✅

### Backend production & sizes (`backend/profile.ts`)
`ProfileFrame{chipsetFlags, customRegs(512B), agaColors(1KB), dmaRecords(~4MB), gfxResources,
profileCycles, idleCycles, profileArray(packed pc/cycles/regs), screenshot}`;
`ProfileFile{sectionBases, stacks, kickRom, chipMem(≤2MB), bogoMem, baseClock, cpuCycleUnit, frames[]}`.
**Big-ticket payloads:** dmaRecords ~4 MB/frame, chip/bogo up to 2 MB, screenshots.
→ **Ours:** enriched grid ~570 KB/frame (8 B × 71 k), chip/slow snapshot, no screenshots.

### Reconstruction functions (`client/dma.ts`, `client/screen.ts`) — all webview-side
- `GetMemoryAfterDma(memory, dmaRecords, endCycle)` → Memory with writes ≤ endCycle. ✅ (`reconstructMemoryAt`, wired: Memory view)
- `GetCustomRegsAfterDma(customRegs, dmaRecords, endCycle)` → regs at cycle (DMACON SETCLR aware). ✅ (`reconstructCustomRegs`, wired: DMA tooltip + Custom Registers view)
- `GetAgaColorsAfterDma(...)` → palette at cycle. ⛔
- `GetBlits(customRegs, dmaRecords)` → Blit[]. ✅ (`getBlits`, wired: flame blit-line + Blitter view)
- `GetCopper(chipMem, dmaRecords)` → Copper[]. ✅ (`decodeCopperRecords` + `CopperView`)
- `GetPrev/NextCustomRegWriteTime(index, cycle, dmaRecords)` → register write navigation. ✅ (`findPrevRegWrite`/`findNextRegWrite`; `findPrevMemWrite`/`findNextMemWrite` for the Memory view's byte-click)
- `GetPaletteFromCustomRegs/Memory/Copper(...)`. ⬜
- `GetScreenFromCopper(copper, chipsetFlags)` / `GetScreenFromBlit(...)`. ⬜
- `SymbolizeAddress(addr, amiga, base)` → STACK/SYSSTACK region, gfxResource+off, section+symbol+off,
  **.text → inline call-stack** (`uniqueCallFrames`), or custom-reg name. 🟡 (split: webview `symbolize()` for symbols + flame-columns for callstack + static reg-name table — STACK/SYSSTACK region and gfxResource+off still ⬜).
- `getScreen(scale, model, freezeModel, time, state)` → pixel/source/ptr/dma/copper overlay arrays. ⬜

---

## 2. Profiling views

### 2.1 Flame graph — `flame/flame-graph.tsx` ✅ (CPU) / ✅ (DMA) / ✅ (blit)
Time-ordered flame chart. **CPU rows** + a **DMA line** (row 0, `buildDmaBoxes`, one box/cycle
colored by type/subtype) + a **blitter line** (row 1, `buildBlitBoxes` from `blits[]`).
Interactions: hover tooltip, click focus, Ctrl+click open source, double-click/Enter zoom,
wheel zoom (shift=pan), drag pan, arrows/Home/End navigate, Esc reset, draggable time marker.
**Data:** nodes/locations/samples/timeDeltas/duration (CPU); `amiga.dmaRecords`+`customRegs`
(DMA line); `blits` (blit line); `cpuCycleUnit` (DMA↔CPU). Builds `buildColumns→IColumn[]`,
`buildBoxes`, `buildDmaBoxes`, `buildBlitBoxes`; WebGL renderer + `TextCache`.
→ **Ours:** CPU flame ✅ (2D canvas, no WebGL); DMA band ✅ (off typed arrays, coalesced);
blit line ✅ (`buildBoxes`/`getBlits`); scrubbable time-marker ✅ (`selectedSlot` — click-drag the
ruler strip or click the DMA band; drives Custom Registers/Copper/Blitter/Memory).

### 2.2 Time-view (top-down tree table) — `table/time-view.tsx` ✅
Expandable tree, sort Self/Total, filter+auto-expand, keyboard nav, click→open source,
ImpactBar, Shift=recursive expand. **Data:** `IGraphNode[]` from `createTopDownGraph` (CPU)
+ DMA subtree (`processDmaNodes`: per-type/subtype time from `dmaRecords`). → **Ours** ✅ with
CPU/DMA grouping (DMA from grid).

### 2.3 Bottom-up tree — `table/bottomUpGraph.ts` + time-view ✅
Reversed (leaf→callers) tree. **Data:** nodes/locations only. → **Ours:** `bottomUpGraph.ts`
(`createBottomUpGraph`, CPU-only — note: the old extension's version is itself dead code, never
wired into its UI), a Top Down/Bottom Up toggle inside the Time View tab reusing `TimeView.tsx`
unchanged (it's agnostic to which tree built `data`).

### 2.4 Tooltip — part of `flame-graph.tsx` 🟡
CPU: self/total/aggregate + file:line. DMA: symbolized **Address** (callstack for code),
**Register** (name+offset or CPU R/W.B/W/L), **Data** (sized), **Events**, **DMACON** bit grid,
**Line**, **Color Clock**, register doc (markdown). Blit: size, BLTCON flags, minterm + truth
table, per-channel A/B/C/D ptr+modulo+masks, start/end line/clock/cycle, duration.
→ **Ours:** DMA tooltip ✅ (channel, symbolized Address w/ callstack-from-columns, Register
name+doc from the static table, Data, Access, Line/ColorClock, DMACON chips via
`reconstructCustomRegs`); Events ✅ (chips row, same style as DMA Control — see §1's `DmaEvents`); blit tooltip ✅
(`BlitDetailGrid`, shared verbatim with the Blitter view's detail pane).

### 2.5 Filter box — `filter.tsx` ✅ · 2.6 Unit dropdown — `unit-select.tsx` ✅
### 2.7 Frame selector / thumbnails — `layout.tsx` ⬜
Multi-frame carousel: screenshot + CPU/blitter utilization bars. **Data:** `screenshot`,
`idleCycles`, blit cycles. Needs multi-frame capture + screenshots.
### 2.8 Code lenses — `createLenses(model, unit)` ✅
Per file:line self/agg/ticks lenses in the editor (extension-side here). → **Ours:**
`profilerCodeLensProvider.ts` — simpler than the old extension's version since our `IProfileModel`
is already built extension-side (no webview→host `setCodeLenses` postMessage round-trip needed);
one global provider fed by both the live panel and the `.vamigaprofile` editor.

### 2.9 Disassembly view — `objdump.tsx` ✅ (no jump-arrow visualization)
Per-instruction assembly listing annotated with profiling data, linked to a time cursor and to
source. **Data (old):** `objdump` (text, from running the `objdump` binary against the ELF, or a
live-disassembled fallback) + `pcTrace: [pc,cycles] pairs` for annotation.
→ **Ours:** `DisassemblyView.tsx` — a virtualized per-function instruction list (function dropdown,
hottest first), with exact per-PC `hits`/`cycles` (this profiler traces *every* retired
instruction, not statistical sampling, so these are exact counts/totals for the frame, not
estimates — stronger than the old extension's data). No host-side `objdump` exists in this
project, so text/bytes come from the live wasm session (`_wasm_disassemble`) via a new
`disassembleRange` RPC command, fetched eagerly for every executed function right after capture
(`profilerManager.ts`'s `fetchDisassembly`/`attachDisassembly`) — mirrors how the DMA grid/copper
trace/events are fetched, and is also embedded in saved `.vamigaprofile` files (since it can't be
regenerated without a live session). "Follow execution" reuses the flame graph's column-resolution
machinery (`columns.ts`'s `resolveStackAtX`, shared with the DMA tooltip's call-stack line) to
highlight/auto-scroll to the instruction at `selectedSlot`. Jump-arrow (branch) SVG overlays and
the old extension's theoretical-cycle-table tooltip aren't ported; click-to-source is one-way
(time cursor → instruction; clicking an instruction doesn't move the cursor back, since one
address can execute at multiple cycles in a frame, making the reverse ambiguous).

---

## 3. Hardware debugger views

Custom Registers (3.2), Copper (3.3), Blitter (3.4), and Memory (3.6) are done — all four are tabs
in the profiler's right pane, linked to the flame graph's scrubbable `selectedSlot` playhead.
Screen visualizer (3.1) and Resources viewer (3.5) remain; both need a gfx-resource registry first.

Shared widget: **`zoomcanvas.tsx`** — 8× magnifier + hover info, click→pick cycle/pixel. Reused
by screen + resources.

### 3.1 Denise screen visualizer — `debugger/screen.tsx` + `screen.ts` ⬜⛔(AGA parts)
Live display reconstruction: bitplanes 1–8 + sprites 0–7 toggles, time slider (CPU→DMA cycle),
DMA/copper overlays (opacity), reference screenshot overlay, freeze + memory-persistence, 8× zoom
w/ pixel/colour/register readout. **Data:** `dmaRecords`, `customRegs`→`GetCustomRegsAfterDma`,
`agaColors`→`GetAgaColorsAfterDma`, `memory`→`GetMemoryAfterDma`, screenshot. `getScreen()` emits
`pixelSources/pixelPtrs/pixels/pixelsRgb/pixelsDma/pixelsCopper`.

### 3.2 Custom registers viewer — `debugger/customregs.tsx` ✅
`CustomRegsView.tsx`: writeable regs at `selectedSlot` (hex / signed-decimal for BPLxMOD, COLORxx
swatch), changed-this-cycle highlight, prev/next-write nav (`findPrevRegWrite`/`findNextRegWrite`).
PTH/PTL pointer pairs shown combined + symbolized. Hover docs not ported (see flame DMA tooltip
instead, which has them). Register names from the static `customRegisters.ts` table.

### 3.3 Copper disassembler — `debugger/copper.tsx` ✅
`CopperView.tsx`: virtualized (react-window) list of every executed copper instruction for the
frame (addr, vpos/hpos, MOVE/WAIT/SKIP via `src/shared/copperDisassembler.ts`), highlights/
auto-scrolls to the current instruction at `selectedSlot`, click-to-jump. Regex find / hover docs
not ported. **Data:** PUAE's `cop_record[]` trace (`wasm_copper_get_records_*`), decoded by
`decodeCopperRecords`.

### 3.4 Blitter operations list — `debugger/blitter.tsx` ✅
`BlitterView.tsx`: list of blits reconstructed from the grid (label, channels, start position),
highlights/auto-scrolls to the current blit at `selectedSlot`, click-to-jump; full detail (size,
BLTCON chips, minterm, per-channel A/B/C/D ptr/modulo/masks, start/end/duration) via
`BlitDetailGrid`, shared with the flame graph's blit tooltip. The 4 channel-source-data canvases
from the old extension aren't ported.

### 3.5 Graphics resources viewer — `debugger/resources.tsx` ⬜⛔(HAM8)
Bitmap + palette dropdowns; render bitmap with palette; 8× zoom; overlays: blit rects, overdraw
heatmap. **Data:** `gfxResources`, `copper`→`GetScreenFromCopper`, `customRegs`/memory palettes,
`memory`→`GetMemoryAfterDma` (overdraw). Needs an emulator-side gfx-resource registry.

### 3.6 Memory viewer — `debugger/memory.tsx` ✅
`MemoryView.tsx`: read-only virtualized hex+ASCII dump of chip/slow RAM reconstructed at
`selectedSlot` (`reconstructMemoryAt`), region select, "Follow writes" (auto-switches region +
scrolls to + highlights whatever address the current cycle wrote), click-a-byte → jumps the
playhead to its most recent write (`findPrevMemWrite`). The old extension's pixel/heatmap/zoom
view, persistence slider, and B/W/L size toggles aren't ported. (Distinct from the separate, live
`memoryViewer` feature.)
**Perf note:** the reconstructed buffer is kept out of React props entirely (rows read it via a
stable `getByte()` closure over a ref, not a literal prop value) — React's dev-build prop
instrumentation deep-walks large prop values every render, which made this tab visibly hang while
scrubbing until fixed.

---

## 4. Time/cycle conventions
`CpuCyclesToDmaCycles = cpu*cpuCycleUnit/512`; `DmaCyclesToCpuCycles = dma*512/cpuCycleUnit`;
dma-cycle index = `vpos*227 + hpos`. A shared **time cursor** (CPU cycles) drives every hardware
view. → **Ours:** ✅ — the DMA slot index *is* the cursor (`selectedSlot`, App.tsx), set by the
flame graph's scrubbable playhead (2.1: drag the ruler strip/handle, or click the DMA band) and
consumed by Custom Registers/Copper/Blitter/Memory.

---

## 5. Parity priorities (suggested order)

1. ✅ **Symbol table → webview** (`symbolize(addr)`), static custom-reg names.
2. ✅ **Flame time-marker** → a shared time cursor (`selectedSlot`, scrubbable playhead).
3. ✅ **Reconstruction wired** (`reconstructMemoryAt`/`CustomRegs`) — Memory + Custom Registers views.
4. ✅ **GetBlits / GetCopper** equivalents from the grid → blitter line + lists.
5. ✅ **Custom registers viewer** + **copper list** + **blitter list** + **memory viewer**
   (3.2/3.3/3.4/3.6) — all four wired to the shared playhead.
6. ⬜ **gfx-resource registry** (emulator-side) → resources/screen. **Next big lift.**
7. ⬜ **Screen reconstruction** (`getScreen`) — largest; OCS/ECS first, AGA ⛔. Depends on #6.
8. ⬜ Multi-frame capture + thumbnails. ✅ bottom-up tree, code lenses, and the Events bitfield
   done. Multi-frame is the only item left here, and it's independent of 6–7.

What's left is screen reconstruction + the gfx-resource registry it depends on (6–7, by far the
largest remaining work), and a handful of small independent items (8). Also worth noting: PUAE's
`puae_dma_serialize()` originally never tagged CPU **writes** with the DMA_WRITE flag in the
profiler's grid (only instruction fetches) — fixed in the `libretro-uae` submodule fork, since it
silently broke every reconstruction feature above for any register/RAM write made by the CPU
rather than the Copper.
