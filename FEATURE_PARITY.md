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
→ **Ours:** `nodes/locations/samples/timeDeltas/duration/cyclesPerMicroSecond` ✅ + `dma?` (IDmaModel) 🟡.

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
→ **Ours:** the enriched grid replaces `dmaRecords`; `uniqueCallFrames`/`callFrames` replaced by **flame columns at x** (we read the CPU stack from `columns`, see §5 tooltip). Others ⬜.

### `IAmigaProfileBase` (`client/types.ts`) — shared, frame-0 only
`objdump` (text), `chipMem`/`bogoMem` (base64 snapshots), `symbols: SymbolInformation[]`,
`sections: Section[]`, `systemStackLower/Upper`, `stackLower/Upper`, `baseClock`,
`cpuCycleUnit`.
→ **Ours:** `chipMem`/`slow` snapshot ✅ (unwired); `symbols` ⬜ (planned: ship `getSymbols()`);
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
→ **Ours:** `BusOwner` ordinals + `channelStyle()` (colours copied) ✅; `DmaEvents` ⬜ (tooltip-only in old, deferred); subtype mapping owner+flags ✅.

### `Blit` (`client/dma.ts`)
`{cycleStart, vposStart, hposStart, cycleEnd?, vposEnd?, hposEnd?, BLTSIZH, BLTSIZV,
BLTCON0, BLTCON1, BLTAFWM, BLTALWM, BLTxPT[4], BLTxDAT[4], BLTxMOD[4]}` — built by `GetBlits`. ⬜
### `Copper` (`client/dma.ts`)
`{cycle, vpos, hpos, address, insn: CopperInstruction}` — built by `GetCopper`.
`CopperInstruction` = Move{DA,RD,label} | Wait{VP,HP,BFD,VE,HE} | Skip{…}. ⬜ (we have a copper disassembler in `memoryViewer`).
### `GfxResource` (`backend/profile_types.ts`)
`{address, size, name, type(bitmap/palette/copperlist/sprite), flags(interleaved/masked/ham), bitmap?{w,h,numPlanes}, palette?{numEntries}, sprite?{index}}`. ⬜ (needs an emulator-side resource registry).
### `Memory` class (`client/dma.ts`)
`{chipMem:Uint8Array@0, bogoMem:Uint8Array@0xc00000}` + read/write Byte/Word/Long. → our `DmaSnapshot` 🟡.
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
- `GetMemoryAfterDma(memory, dmaRecords, endCycle)` → Memory with writes ≤ endCycle. 🟡 (ours: `reconstructMemoryAt`, unwired)
- `GetCustomRegsAfterDma(customRegs, dmaRecords, endCycle)` → regs at cycle (DMACON SETCLR aware). 🟡 (`reconstructCustomRegs`, unwired)
- `GetAgaColorsAfterDma(...)` → palette at cycle. ⛔
- `GetBlits(customRegs, dmaRecords)` → Blit[]. ⬜
- `GetCopper(chipMem, dmaRecords)` → Copper[]. ⬜
- `GetPrev/NextCustomRegWriteTime(index, cycle, dmaRecords)` → register write navigation. ⬜
- `GetPaletteFromCustomRegs/Memory/Copper(...)`. ⬜
- `GetScreenFromCopper(copper, chipsetFlags)` / `GetScreenFromBlit(...)`. ⬜
- `SymbolizeAddress(addr, amiga, base)` → STACK/SYSSTACK region, gfxResource+off, section+symbol+off,
  **.text → inline call-stack** (`uniqueCallFrames`), or custom-reg name. 🟡 (split: webview `symbolize()` for symbols + flame-columns for callstack + static reg-name table).
- `getScreen(scale, model, freezeModel, time, state)` → pixel/source/ptr/dma/copper overlay arrays. ⬜

---

## 2. Profiling views

### 2.1 Flame graph — `flame/flame-graph.tsx` ✅ (CPU) / 🟡 (DMA) / ⬜ (blit)
Time-ordered flame chart. **CPU rows** + a **DMA line** (row 0, `buildDmaBoxes`, one box/cycle
colored by type/subtype) + a **blitter line** (row 1, `buildBlitBoxes` from `blits[]`).
Interactions: hover tooltip, click focus, Ctrl+click open source, double-click/Enter zoom,
wheel zoom (shift=pan), drag pan, arrows/Home/End navigate, Esc reset, draggable time marker.
**Data:** nodes/locations/samples/timeDeltas/duration (CPU); `amiga.dmaRecords`+`customRegs`
(DMA line); `blits` (blit line); `cpuCycleUnit` (DMA↔CPU). Builds `buildColumns→IColumn[]`,
`buildBoxes`, `buildDmaBoxes`, `buildBlitBoxes`; WebGL renderer + `TextCache`.
→ **Ours:** CPU flame ✅ (2D canvas, no WebGL); DMA band ✅ (off typed arrays, coalesced);
blit line ⬜ (needs `GetBlits`); draggable time-marker ⬜ (drives the hardware views).

### 2.2 Time-view (top-down tree table) — `table/time-view.tsx` ✅
Expandable tree, sort Self/Total, filter+auto-expand, keyboard nav, click→open source,
ImpactBar, Shift=recursive expand. **Data:** `IGraphNode[]` from `createTopDownGraph` (CPU)
+ DMA subtree (`processDmaNodes`: per-type/subtype time from `dmaRecords`). → **Ours** ✅ with
CPU/DMA grouping (DMA from grid).

### 2.3 Bottom-up tree — `table/bottomUpGraph.ts` + time-view ⬜
Reversed (leaf→callers) tree. **Data:** nodes/locations only. Cheap to add.

### 2.4 Tooltip — part of `flame-graph.tsx` 🟡
CPU: self/total/aggregate + file:line. DMA: symbolized **Address** (callstack for code),
**Register** (name+offset or CPU R/W.B/W/L), **Data** (sized), **Events**, **DMACON** bit grid,
**Line**, **Color Clock**, register doc (markdown). Blit: size, BLTCON flags, minterm + truth
table, per-channel A/B/C/D ptr+modulo+masks, start/end line/clock/cycle, duration.
→ **Ours:** DMA tooltip with channel/Data/Access/Line/ColorClock 🟡; Address=callstack-from-columns
(planned), Register name from static table (planned); Events/DMACON/doc ⬜; blit tooltip ⬜.

### 2.5 Filter box — `filter.tsx` ✅ · 2.6 Unit dropdown — `unit-select.tsx` ✅
### 2.7 Frame selector / thumbnails — `layout.tsx` ⬜
Multi-frame carousel: screenshot + CPU/blitter utilization bars. **Data:** `screenshot`,
`idleCycles`, blit cycles. Needs multi-frame capture + screenshots.
### 2.8 Code lenses — `createLenses(model, unit)` ⬜
Per file:line self/agg/ticks lenses in the editor (extension-side here).

---

## 3. Hardware debugger views (all ⬜ here; all need time-scrubbing + reconstruction)

Shared widget: **`zoomcanvas.tsx`** — 8× magnifier + hover info, click→pick cycle/pixel. Reused
by screen + resources.

### 3.1 Denise screen visualizer — `debugger/screen.tsx` + `screen.ts` ⬜⛔(AGA parts)
Live display reconstruction: bitplanes 1–8 + sprites 0–7 toggles, time slider (CPU→DMA cycle),
DMA/copper overlays (opacity), reference screenshot overlay, freeze + memory-persistence, 8× zoom
w/ pixel/colour/register readout. **Data:** `dmaRecords`, `customRegs`→`GetCustomRegsAfterDma`,
`agaColors`→`GetAgaColorsAfterDma`, `memory`→`GetMemoryAfterDma`, screenshot. `getScreen()` emits
`pixelSources/pixelPtrs/pixels/pixelsRgb/pixelsDma/pixelsCopper`.

### 3.2 Custom registers viewer — `debugger/customregs.tsx` ⬜
Table of writeable regs at a chosen cycle (hex/dec/bin, colour swatch, PFxH/P decode),
prev/next-write navigation, hover docs. **Data:** `customRegs`+`dmaRecords` →
`GetCustomRegsAfterDma`, `GetPrev/NextCustomRegWriteTime`. (Register names: reuse our static table.)

### 3.3 Copper disassembler — `debugger/copper.tsx` ⬜
Virtual list of all copper instructions (addr, vpos/hpos, MOVE/WAIT/SKIP, reg name, colour
swatch), highlight current at time, regex find, hover docs. **Data:** `copper?` (from `GetCopper`,
built once). We already have a **copper disassembler in `memoryViewer/copperDisassembler.ts`**.

### 3.4 Blitter operations list — `debugger/blitter.tsx` ⬜
List of blits (start vpos/hpos/cycle, size, A/B/C/D ptrs) + 4 channel-source canvases, highlight
current. **Data:** `blits?` (GetBlits), `memory`→`GetMemoryAfterDma` at blit start/end,
`gfxResources`, `customRegs`→`GetPaletteFromCustomRegs`.

### 3.5 Graphics resources viewer — `debugger/resources.tsx` ⬜⛔(HAM8)
Bitmap + palette dropdowns; render bitmap with palette; 8× zoom; overlays: blit rects, overdraw
heatmap. **Data:** `gfxResources`, `copper`→`GetScreenFromCopper`, `customRegs`/memory palettes,
`memory`→`GetMemoryAfterDma` (overdraw). Needs an emulator-side gfx-resource registry.

### 3.6 Memory viewer — `debugger/memory.tsx` ⬜
Chip + slow memory as pixels (1px=8B, coloured by DMA activity), 16×32 hex detail, region select,
persistence slider, r/w toggles, CPU-follow, B/W/L sizes. **Data:** `memory` snapshot +
`dmaRecords` → `GetMemoryAfterDma`. (We have a separate `memoryViewer` already — different feature.)

---

## 4. Time/cycle conventions
`CpuCyclesToDmaCycles = cpu*cpuCycleUnit/512`; `DmaCyclesToCpuCycles = dma*512/cpuCycleUnit`;
dma-cycle index = `vpos*227 + hpos`. A shared **time cursor** (CPU cycles) drives every hardware
view. → **Ours:** DMA slot index *is* the cursor; map to flame x via `slot/owner.length`. A
draggable flame time-marker (2.1) would be the natural cursor source.

---

## 5. Parity priorities (suggested order)

1. **Symbol table → webview** (`symbolize(addr)`), static custom-reg names — unblocks tooltips +
   disassembly + copper + memory. *(in progress, DMA tooltip)*
2. **Flame time-marker** → a shared time cursor.
3. **Reconstruction wired** (`reconstructMemoryAt`/`CustomRegs`) + validation — unblocks memory &
   register views.
4. **GetBlits / GetCopper** equivalents from the grid → blitter line + lists.
5. **Custom registers viewer** + **copper list** (reuse `memoryViewer` disassembler).
6. **gfx-resource registry** (emulator-side) → resources/screen.
7. **Screen reconstruction** (`getScreen`) — largest; OCS/ECS first, AGA ⛔.
8. Multi-frame capture + thumbnails; bottom-up tree; code lenses; DMACON/Events tooltip detail.

The bus grid + chip/slow snapshot we already capture is the substrate for 3–7; the main missing
inputs are **symbols in the webview**, a **gfx-resource registry**, and **screenshots/multi-frame**.
