# Changelog

## Unreleased

### MCP server

- `emulator_inspect` decodes the custom chips (`chipset`: beam position, DMACON, INTENA/INTREQ, BPLCONx, bitplane/sprite/copper/blitter pointers, colours) and the copper list in memory (`copper`/`copperAt`), following COPJMPs and labelling WAITs past line 255.
- `emulator_disassemble`: 68000 disassembly around the PC, an address, a symbol or a source line, or a whole routine — with branch targets, custom registers, CIAs and symbols resolved.
- `emulator_write`: change memory, CPU registers and custom registers in a paused session; every write is read back.
- `emulator_watch`: watchpoints on exact address ranges or named custom registers, reporting the value written and who wrote it (CPU and PC, the copper MOVE, or blitter/disk DMA). A watch can be conditional — stop when the value becomes X (`equals`) or only when it actually changes (`changes`) — judged on the whole value after the write, whatever size the write was.
- `emulator_breakpoints`: list and remove breakpoints, and choose which exceptions stop the session. Sessions now stop on bus error, address error, illegal instruction and zero divide by default.
- `emulator_snapshot`: save and restore a session's whole machine state; a `start` snapshot is taken at launch.
- `emulator_input`: mouse clicks and movement, keyboard keys and the joystick, played as a sequence of actions over real frames.
- Serial output — `kprintf` and anything else the program writes to the serial port — is captured and included in the reply of every tool that runs frames.
- `emulator_reverse`: go back in a session by instructions, to the last breakpoint hit, or to the start of the frame — e.g. from a crash straight to the faulting instruction.
- `emulator_screenshot` can lay several frames out on one contact sheet (`count`, `every`), each labelled with its frame number and marked when identical to the frame before it.
- `profile_dump` (and `profile dump` on the CLI) gains total time including callees (`sort`), the call tree (`callTree`), every call path into a function (`callers`), the flame graph as text by raster line (`flame`, `lines`), blits (`blits`) and the executed copper trace (`copper`). `profile_check` and `profile_dump` report repeated frames — where the picture didn't change — and how long each picture stayed on screen.
- `emulator_disassemble` names library calls — `jsr -198(a6)` as `exec.library AllocMem` — from the library base in `a6` and its jump table, so it also shows when a function has been patched.
- `profile_dump`'s per-instruction listing (`instructions`) prints the same readable disassembly as `emulator_disassemble` — hex addresses and immediates, branch targets, and symbols, custom registers and CIAs named — including for captures saved earlier.
- `puae-debugging` skill for the emulator tools, and `puae-profiling` now covers making captures with them — including from a debugging session, and before/after a change — not just reading saved ones; `skill install` now installs it alongside `puae-profiling`, leaving already-installed skills alone unless `--force` is given.

### Fixes

- Profiler memory reconstruction (Memory, Screen and the DMA tooltip's register state) started from the state after the capture rather than at the frame's start, so values written later in the frame appeared from its first cycle. The Blitter view now also fills in blitter registers set before the frame. Captures saved by earlier versions keep the old behaviour.
- A capture of a program with no debug information can be opened in the profiler.
- A data breakpoint hit by a copper write now names the copper MOVE that made it; it pointed at the instruction after it.
- A Kickstart ROM dumped "doubled" to 512KB (the usual form of 1.3 dumps) wasn't recognised, so ROM code had no symbol names in the debugger, profiler or MCP tools.
- Continuing after a reverse step (or reverse continue / step back a frame) ran one frame too many before the next frame ended.
- Stepping back — most reliably a frame forward and then a frame back — could leave the wrong picture on screen (a later frame, or a blank one) instead of the one shown at that point.
- With the profiler already open, a capture started from the emulator toolbar used the profiler's frame count instead of the one next to the button. Each capture now uses the count in the panel it was started from, and the profiler's field follows it.
- MCP: `~` in paths (including `PUAE_KICKSTART_ROM`) is expanded; screenshots and profile captures no longer require debug information; `profile_dump` no longer returns a stale analysis after a capture is rewritten to the same file; `emulator_continue` with nothing armed reports the frames it ran rather than a missed breakpoint.

## 1.0.0

Initial release.

### Debugging

- PUAE (WinUAE-derived) emulator running inside VS Code as a WebAssembly webview: 68000–68060 CPUs, OCS/ECS/AGA chipsets, any WinUAE `.uae` config key via `emulatorOptions` or `emulatorConfigFile`.
- `fastLoad` injects the program straight into memory; otherwise it boots from an auto-generated disk or a mounted `hardDrivePath` directory.
- Source-level debugging for Amiga Hunk executables (vasm `-linedebug` line info, GCC stabs) and ELF (DWARF or stabs), including DWARF stack unwinding and inlined functions.
- Breakpoints: source line, instruction, function, conditional, hit-count and logpoints.
- Data breakpoints on symbols, CPU registers and custom chipset registers, reporting whether the CPU, Copper or Blitter/disk DMA made the write.
- Exception catchpoints, plus a "write to unallocated memory" filter backed by AllocMem/FreeMem tracking.
- Step into/over/out by line or instruction, and reverse debugging: step back, reverse continue, start/end of frame and end of scanline.
- Debug Console expression language with memory, disassembly and trace helpers; C/C++ expression evaluation over DWARF types.
- Disassembly view, with Kickstart calls labelled by ROM identity.

### Tools

- Memory Viewer: hex dump, bitmap visualizer, CPU and Copper disassembly, and saving memory to disk.
- Amiga State Viewer: display/playfield state, palette and live memory allocations.
- Live emulator view with DMA overlay, blit visualizer, per-channel mute, warp mode, and mouse/keyboard capture.
- CPU/DMA profiler capturing 1–100 frames: flame graph, per-instruction cycle heat-map, frame reconstruction from the DMA grid, Copper and Blitter views, and memory reconstruction. Captures save to self-contained `.puaeprofile` files.
- Profiler results in the editor: per-line cycle annotations and per-function CodeLens.

### Standalone CLI (`npm install -g puae-debugger`)

- Standalone DAP server for nvim-dap, Emacs `dap-mode` and other DAP clients, serving the emulator and tool panels to a browser tab.
- `profile dump|check` for inspecting and verifying `.puaeprofile` captures from the command line.
- `mcp` server exposing a headless emulator (screenshots, profile capture, breakpoints, stepping, inspection) and profile analysis to MCP clients.
- `skill install` for the `puae-profiling` Claude Code skill.
