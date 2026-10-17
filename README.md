# PUAE Debugger

Debug Amiga (m68k) programs in VS Code with a [PUAE](https://github.com/libretro/libretro-uae) (WinUAE-derived) emulator running directly inside the editor as a webview — no external emulator process, no platform-specific binaries.

## Why

- **Fast iteration.** `fastLoad` injects your program straight into Amiga RAM, skipping the disk-boot sequence entirely — startup is close to instant.
- **Full machine range.** Because it's built on WinUAE's PUAE core rather than a from-scratch reimplementation, this isn't limited to OCS/ECS or 68000/68020 like some browser-based Amiga debuggers — 68000 through 68060, and OCS through AGA, are all supported.
- **Real visual introspection.** A cycle-accurate DMA/CPU profiler with a flame graph, per-channel DMA overlay on the live screen, a Copper disassembler, and a blitter-list visualizer — built on the same debug symbols as the rest of the debugging session, not a separate reverse-engineering tool.
- **No native binaries to install.** The emulator core is WebAssembly, so there's nothing platform-specific to build or ship alongside the extension.

## Getting started

You'll need:

- A **Kickstart ROM** file for the model you're targeting (not included — bring your own; see [Requirements](#requirements)).
- A `m68k` language extension for syntax highlighting and language features, e.g. [Motorola 68000 Assembly](https://marketplace.visualstudio.com/items?itemName=gigabates.m68k-lsp) or [Amiga Assembly](https://marketplace.visualstudio.com/items?itemName=prb28.amiga-assembly).
- A toolchain that emits debug info the extension understands: [vasm](http://sun.hasenbraten.de/vasm/)/[vlink](http://sun.hasenbraten.de/vlink/) (assembly, `-linedebug`/GNU stabs) or [vbcc](http://www.compilersandtools.com/vbcc) / [bebbo's Amiga GCC](https://github.com/bebbo/amiga-gcc) (C/C++, DWARF or stabs) — see [Source-level debugging](#source-level-debugging) below.

Add a launch configuration to `.vscode/launch.json` — use one of the built-in snippets (type `PUAE:` when creating a new configuration) or write one directly:

```jsonc
{
  "type": "puae",
  "request": "launch",
  "name": "Launch PUAE",
  "program": "${workspaceFolder}/out/a.exe",
  "fastLoad": true,
  "stopOnEntry": true,
  "kickstartRom": "${workspaceFolder}/roms/kick13.rom",
  "emulatorOptions": {
    "cpu_model": 68000,
    "chipmem_size": 2,
    "bogomem_size": 2,
    "chipset": "ocs"
  }
}
```

Then hit F5. Every WinUAE `.uae` config key is accepted under `emulatorOptions` (a subset has IntelliSense/validation; anything else is passed through verbatim), so existing WinUAE quickstart configs or hand-tuned setups carry over directly. `emulatorConfigFile` can point at a full `.uae` file to use as a base, with `emulatorOptions` overriding individual keys.

## Debugging

- **Breakpoints**: source-line, instruction, function/symbol, conditional and hit-count breakpoints, and logpoints — evaluated using the same expression syntax as the Debug Console (see below).
- **Data breakpoints (watchpoints)**: set on symbols (with size auto-derived from DWARF type info or a `dc.*` declaration), CPU registers (break on value change), or custom chipset registers — including ones like `DMACON` where the read and write addresses differ. Watchpoint hit reports distinguish the CPU, the Copper, or the Blitter/disk DMA as the writer, and jump straight to the responsible Copper source line when applicable. Default watchpoint length is inferred but overridable per-breakpoint.
- **Exception catchpoints**: Bus error, Address error, Illegal instruction, Zero divide, Privilege violation — plus a "Write to unallocated memory" filter backed by live AllocMem/FreeMem tracking, so bad pointer writes get caught even without a symbol.
- **Stepping**: line and instruction granularity, step into/over/out — synthesized on top of PUAE's plain run/pause primitives by decoding the current instruction and placing a temporary breakpoint (`jsr`/`bsr`/`dbra` for step-over, the live shadow call stack for step-out).
- **Reverse debugging**: step back one instruction, continue in reverse until the previous breakpoint, or jump to the start/end of the current frame or the end of the current scanline — backed by periodic full-state checkpoints plus exact-instruction replay between them, so it lands precisely, not just at the nearest checkpoint.
- **Debug Console / REPL**: a JavaScript-like expression language for reading and writing emulator state — CPU/custom registers and program symbols are usable as bare variable names, plus helpers like `peekU32(addr)` / `poke16(addr, value)`, `readBytes`/`readWords`/`readLongs` for hex dumps, `disassemble(addr)`, `disassembleCopper(addr)`, and `trace()` for recent instruction history. Type `help` for the full guide.
- **C/C++ expressions**: hovers, watches, and `setExpression` understand `.`, `->`, `[]`, `*`, `&` over DWARF-typed locals and globals for C/C++ programs, falling back to the assembly/REPL evaluator otherwise.
- **Disassembly view**: VS Code's built-in disassembly view is fully wired up, including for addresses with no source mapping (Kickstart calls, etc.) — the ROM is identified by SHA-1 and its calls are labelled using an embedded symbol table where available.

## Source-level debugging

Debug info is auto-detected from the file's actual bytes, not its extension:

- **Amiga Hunk executables**: `-linedebug`-style line hunks (vasm) or GCC stabs embedded in `HUNK_DEBUG` blocks.
- **ELF binaries**: DWARF (`.debug_info`/`.debug_line`) or GNU stabs.

DWARF gets you the most: `.debug_frame`-based stack unwinding (used by the debugger's call stack and the profiler's unwind table) and inline function expansion (`DW_TAG_inlined_subroutine`), giving proper innermost-first inline call chains. Assembly builds without DWARF still get full locals/globals/line mapping — the debugger falls back to a live, self-correcting shadow call stack maintained by the emulator core itself (tracking `jsr`/`bsr`/exception entry against `rts`/`rte`) rather than a heuristic stack scan.

## Memory Viewer

Open from the debug toolbar, the command palette, or by right-clicking a symbol in the Variables view ("View in Memory Viewer"). Four views over the same address space:

- **Hex Dump** — with per-byte watchpoint toggling directly from the view.
- **Visual** — a bitmap render of raw memory with automatic stride-guessing, for eyeballing bitplane/sprite data.
- **Disassembly** and **Copper** — CPU and Copper-list disassembly at an address.

The address bar accepts a numeric address or an expression, with autocomplete over symbol names. A region selector switches between Chip/Slow/Fast/Kickstart RAM, and "Save to Disk..." exports a raw memory range.

## Amiga State Viewer

A live GUI view of Amiga hardware state that isn't easily read from a register dump: bitplane count, Hi-Res/Interlace/HAM/dual-playfield flags, palette, playfield priority, screen geometry, and ECS/AGA-specific flags — plus a Memory Allocations tab showing live Chip/Slow/Fast RAM usage and a clickable list of currently allocated blocks (from the same AllocMem/FreeMem tracking that backs the "write to unallocated memory" catchpoint) that jumps straight into the Memory Viewer.

## Live emulator view

The webview isn't just a passive screen:

- **DMA overlay** — per-channel toggles (Refresh/CPU/Copper/Audio/Blitter/Bitplane/Sprite/Disk, with an "all" toggle and shift-click isolate) drawn directly onto the running frame, with an opacity slider and a hover tooltip showing Copper disassembly or DMA cycle info — click through to the responsible source line.
- **Blit visualizer** — highlights blitter destination regions as they're written, with a configurable fade/decay.
- **Per-channel mute** — individual bitplanes, sprites, audio channels, and the blitter, useful for isolating what's producing a given visual or audio artifact.
- **Warp mode** — uncapped-speed emulation (auto-engaged while a non-`fastLoad` boot is still loading), plus a slow-motion speed dropdown for the opposite case. Cycle-exact CPU/DMA-contention modeling is a genuine runtime toggle, not just a speed cap, so warp mode is actually fast.
- **Mouse and keyboard capture** — pointer lock for the emulated Amiga mouse, keyboard forwarding while the canvas is focused.

## CPU/DMA Profiler

Capture 1–100 frames of full DMA-cycle and CPU-instruction detail ("Capture Frame Profile" on the debug toolbar) and explore it across several linked views, all synced to one shared timeline:

- **Flame graph** — top-down or bottom-up call trees, filterable by function/file name (including regex).
- **CPU/Disassembly** — per-instruction cycle and hit-count heat-map, branch/jump arrow lanes, register value history, source correlation.
- **DMA/Screen** — full frame reconstruction from the captured DMA grid, with per-pixel hover showing the raw bitplane bits, resolved palette color, HAM decode, sprite ownership, and the Copper instruction that set it up.
- **Copper** — per-instruction disassembly of the captured Copper list with source lookup.
- **Blitter** — reconstructed blit list with a per-blit detail grid.
- **Memory** — byte-level chip/slow RAM reconstruction at any point in the captured range.

Multi-frame captures get a filmstrip of thumbnails (hover to enlarge) and support shift-click range selection to combine several frames into one continuous timeline. Panels can be split side-by-side (horizontal or vertical), and results save to a self-contained `.puaeprofile` file — it embeds the program binary, relocation info, and Kickstart ROM identity, so a teammate can open a shared capture and get identical symbolication without your build environment or ROM file.

Profiler data also surfaces back in the editor: per-line heat-tinted background + cycle/hit counts (toggle via "Toggle Line Profiler Annotations"), a CodeLens above each profiled function ("X% Self, Y% Total"), and "Jump to Next Execution in Profiler" from the editor context menu.

## Standalone server (outside VS Code)

The same debug adapter also runs as a standalone server, for any editor that speaks the Debug Adapter Protocol (nvim-dap, Emacs `dap-mode`, …). Everything that would be a VS Code webview — the live emulator screen, profiler, memory viewer and state viewer — is served to a browser tab instead, by a small local HTTP/WebSocket server.

Install it from npm:

```sh
npm install -g puae-debugger
puae-debugger
```

Or run it without installing at all, with `npx puae-debugger`. (Working in a checkout of this repo instead? `npm install && npm run compile && npm run standalone` starts the same server from your build.)

Both the DAP and HTTP servers bind to `127.0.0.1` only.

| Flag | Purpose |
|---|---|
| `--port N` | DAP TCP port (default `4711`) |
| `--http-port N` | HTTP/WebSocket port serving the browser panels (default `5321`) |
| `--stdio` | Speak DAP over stdin/stdout instead of listening on a TCP port — for clients that spawn the adapter process themselves |
| `--no-open` | Don't open the emulator screen in a browser on launch |

### Connecting a client

Launch configurations take exactly the same options as in VS Code (see [Configuration reference](#configuration-reference)) — minus any `${...}` variables your client doesn't expand itself, so prefer absolute paths if in doubt. For nvim-dap:

```lua
-- Long-lived server: start `puae-debugger` yourself, then point nvim-dap at it.
dap.adapters.puae = { type = "server", host = "127.0.0.1", port = 4711 }

-- Or let nvim-dap spawn a process per session instead:
-- dap.adapters.puae = { type = "executable", command = "puae-debugger", args = { "--stdio" } }

dap.configurations.asm = {
  {
    type = "puae",
    request = "launch",
    name = "Launch PUAE",
    program = "${workspaceFolder}/out/a.exe",
    fastLoad = true,
    stopOnEntry = true,
    kickstartRom = "${workspaceFolder}/roms/kick13.rom",
  },
}
```

The TCP server shares one emulator instance — and one browser tab — across every debug session that connects to it, so relaunching doesn't reboot the wasm machine or make the tab reconnect. `--stdio` trades that away: the client owns the process, so each session gets a fresh boot and a new tab.

### Browser panels

The emulator screen opens automatically on launch (Chrome is preferred when installed — its WebGL/WebAssembly performance is meaningfully better here — falling back to the default browser). The other panels are reachable from that screen's toolbar buttons, or directly:

| URL | Panel |
|---|---|
| `/` | Live emulator screen |
| `/profiler` | CPU/DMA profiler — `?numFrames=N` sets the capture length |
| `/state` | Amiga state viewer |

The memory viewer is opened per-address, from the emulator screen's toolbar button or the `openMemoryViewer` custom request.

Since there's no command palette or debug toolbar outside VS Code, the UI actions those provide are exposed as DAP custom requests to bind to a key: `openProfiler`, `openStateViewer` and `openMemoryViewer` (optional `address`), plus `stepBackFrame`, `eof` and `eol` for the frame/scanline stepping commands (back one frame, forward to end of frame, forward to end of scanline).

### Offline subcommands

The same binary has a few modes that need neither the emulator nor a browser:

- `puae-debugger profile dump|check <file.puaeprofile>` — inspect a saved capture from the command line. `dump` prints per-frame cycle costs, top functions and the DMA bus census (`--stalls` additionally compares measured cost against 68000 datasheet timings, and `--instructions <function>` breaks one routine down instruction by instruction); `check` verifies the capture against physical invariants and exits non-zero on an error-level finding, so it can gate a build. `--json` emits the full analysis for a script to consume.
- `puae-debugger mcp` — an MCP server exposing the emulator and the profile analysis to an MCP client:

  ```sh
  claude mcp add puae -e PUAE_KICKSTART_ROM=/path/to/kick31.rom -- npx -y puae-debugger mcp
  ```

  To share the setup with everyone working on a project, commit it as `.mcp.json` instead. Other MCP clients (Cursor, Claude Desktop, VS Code) take the same `command`/`args`/`env` in their own config files. Leave the ROM path to each user's environment, since it differs per machine and the ROM can't be committed:

  ```json
  {
    "mcpServers": {
      "puae": {
        "command": "npx",
        "args": ["-y", "puae-debugger", "mcp"],
        "env": { "PUAE_KICKSTART_ROM": "${PUAE_KICKSTART_ROM}" }
      }
    }
  }
  ```

  (`${VAR}` expansion in `.mcp.json` is a Claude Code feature; other clients may need the path written in.)

  `profile_check` and `profile_dump` read a saved `.puaeprofile`, as above. The rest *run* the program, on a machine booted headlessly — no browser, no VS Code — with the program injected the way `fastLoad` does. The ROM comes from `PUAE_KICKSTART_ROM` (as above) or a per-call `kickstartRom` argument.

  | Tool | |
  |---|---|
  | `emulator_screenshot` | Run for N frames and save a PNG of the screen — whether an effect renders, where a glitch appears, whether a change altered the picture |
  | `emulator_capture_profile` | Run for N frames and record a `.puaeprofile`, verified with `profile_check` before it's handed back |
  | `emulator_launch` | Start a session: boot, inject, hold at the entry point. Breakpoints take an address (`0x2140`), a symbol (`draw_sprite`) or a source line (`main.s:42`) |
  | `emulator_continue` | Run until a breakpoint fires or a frame budget runs out, reporting where it stopped and why |
  | `emulator_step` | Single-step instructions |
  | `emulator_inspect` | Registers, symbolicated call stack, current source line, and hex dumps of memory at an address or symbol |
  | `emulator_close` | End a session |

  The first two work standalone — pass a `program` and they boot a throwaway machine, so the same arguments always give the same answer. They also take a `session` instead, which is what makes the interesting sequence possible: run to a breakpoint, inspect registers and memory there, then profile or screenshot *from that exact state*. Together this closes the loop — "why is this routine slow", "did that change help", "what's in this buffer by the time we reach here" — without a person driving the debugger and relaying the results.
- `puae-debugger skill install` — installs the `puae-profiling` skill into your project's `.claude/skills/` (`--global` for `~/.claude/skills/` instead). It's the judgement that goes with the commands above: verify a capture before reading it, don't mistake flame-graph width for time spent, and check the DMA bus census before optimizing CPU code that was really waiting on the blitter. Worth installing in the Amiga project you're profiling, not just here.

## Configuration reference

Full schema with inline documentation is available via IntelliSense in `launch.json`. Key options:

| Option | Purpose |
|---|---|
| `program` | Path to the executable to run |
| `debugProgram` | Separate file to read debug symbols from, if different from `program` |
| `fastLoad` | Inject the program directly into memory instead of booting from disk |
| `hardDrivePath` | (non-`fastLoad`) Mount a host directory as `DH0:` instead of the auto-generated single-program disk — lets the program use its own libraries, data files, and `s/startup-sequence` |
| `kickstartRom` | Path to the Kickstart ROM file (required) |
| `emulatorConfigFile` | Base WinUAE-format `.uae` file |
| `emulatorOptions` | Raw WinUAE `.uae` key/value overrides — `quickstart` machine presets (e.g. `"A1200,1"`), CPU/chipset/RAM sizing, floppy/sound/display options, and any other WinUAE key |
| `stopOnEntry` | Pause immediately after launch |

## Requirements

- **Kickstart ROM**: not included, for copyright reasons — supply your own dump matching the machine you're targeting.
- VS Code 1.104 or later — or, for the [standalone server](#standalone-server-outside-vs-code), Node.js and a DAP-capable editor instead.

## License

This project is licensed under the [GNU General Public License version 2](LICENSE.txt). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution, component licensing, and source provenance.

Emulation is powered by [PUAE](https://github.com/libretro/libretro-uae) (libretro-uae), derived from WinUAE by Toni Wilen and contributors.
