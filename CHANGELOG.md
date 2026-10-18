# Changelog

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
- `profile dump|check` for inspecting and verifying `.puaeprofile` captures from the command line: self and total time, call tree and callers, the flame graph as text by raster line, blits, the executed copper trace, and repeated-frame detection.
- `mcp` server exposing a headless emulator and profile analysis to MCP clients: screenshots and profile capture; sessions with breakpoints, exception stops, watchpoints, stepping and snapshots; registers, memory, decoded chipset state, copper lists and disassembly; and writes to memory, CPU and custom registers.
- `skill install` for the `puae-profiling` and `puae-debugging` Claude Code skills.
