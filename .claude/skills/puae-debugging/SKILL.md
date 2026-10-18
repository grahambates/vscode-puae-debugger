---
name: puae-debugging
description: Debug an Amiga program by running it in the PUAE emulator through the puae-debugger MCP tools — find what crashes it, what overwrites a variable or a custom register, why the screen or copper list is wrong, or test a fix without rebuilding. Use when an Amiga program misbehaves (crash, guru, corrupted data, wrong graphics or colours, hang) and the puae-debugger MCP server is available, or when asked to run, step through or inspect an Amiga executable.
---

# Debugging Amiga programs with the puae-debugger MCP tools

This is a **playbook**: which tool answers which question, and which of their answers can't be
taken at face value. It assumes the `puae-debugger` MCP server is registered (`npx puae-debugger
mcp`). For "why is this slow", use the **puae-profiling** skill instead — this one is about
behaviour, not cost.

## Setup

Everything boots a real machine, so it needs a Kickstart ROM: `PUAE_KICKSTART_ROM` in the
server's environment, or `kickstartRom` per call (`~` is fine). `program` is the Amiga hunk
executable; if the debug info lives in an ELF built alongside it, pass that as `debugProgram`.
A stripped binary works too — breakpoints and memory reads then take addresses or hunk symbols,
not `file:line`, and the launch says so.

The program is injected straight into RAM once exec is ready, not loaded by AmigaDOS. So it
can't rely on the OS beyond ROM calls that work in isolation (memory allocation, say) — no DOS,
no input handling, no libraries that need the OS running. That's expected, not a bug: a program
that needs them won't behave as it does from a boot disk.

## The loop

```
emulator_launch      → session id, paused at the entry point; snapshot "start" saved
emulator_breakpoints / emulator_watch   → arm what should stop it
emulator_continue    → runs until something stops it, or maxFrames (default 100) pass
emulator_inspect / emulator_disassemble → look
emulator_write / emulator_snapshot      → change something, or rewind and try again
emulator_close       → when done (max 4 sessions; idle ones close after 15 minutes)
```

Calls that take `program` instead of `session` boot a fresh machine every time and throw it away
— right for one screenshot, wrong for anything with more than one step. The emulator is
deterministic: the same program and arguments give the same result, and a rerun from the
`start` snapshot reproduces the first run exactly.

## By symptom

**It crashes / gurus.** `emulator_launch` already stops on bus error, address error, illegal
instruction and zero divide, so just `emulator_continue`. The stop names the exception and the
PC, and `emulator_inspect` gives registers and the call stack. Two things to know:
- For **bus and address errors** the PC a 68000 records has run ahead of the faulting
  instruction (prefetch) — the culprit is usually one or two instructions *before* it. Look with
  `emulator_disassemble { "address": "<pc>", "before": 8 }`.
- **Privilege violation is off by default** because exec's `Supervisor()` raises it on purpose.
  Turn it on (`emulator_breakpoints { "exceptions": [...] }`) only if the program itself runs in
  user mode and you suspect it.

**Something overwrites a variable, a buffer or a register.** `emulator_watch` on it — arm it
right after `emulator_launch` to catch the first write, then `emulator_continue`. A hit reports
the value, the old value, the exact address and **who** wrote it:
- the CPU, with its PC and source line;
- the copper, with the MOVE that did it (already corrected for the copper's list pointer, which
  has moved on by the time the write lands);
- blitter or disk DMA, for chip RAM.
For a DMA write the CPU's PC is reported only as "meanwhile" — it is *not* the cause, so don't go
reading the code it points at. Ranges are watched exactly (split into aligned blocks; 64 slots in
all), and a custom register can be named directly (`COP1LC`, `DMACON`). Expect early hits from
Kickstart itself — `AllocMem` clearing memory it hands out is a write too.

**The screen is wrong.** `emulator_screenshot` on the session to see it. For something that
moves, or a glitch that lasts one frame, `{ "count": 8 }` puts consecutive frames on one contact
sheet, each labelled with its frame number and marked `=` when identical to the frame before;
`every` spaces them out for a slower animation. Then
`emulator_inspect { "chipset": true, "copper": true }`:
- `chipset` decodes DMACON, INTENA/INTREQ, BPLCONx, display window, bitplane/sprite/blitter
  pointers and the colours. It warns when DMAEN is off — a channel bit set under a cleared master
  enable is a common reason something doesn't appear. Bitplane pointers advance as lines are
  fetched, so mid-frame they won't match what the copper list loads.
- `copper` decodes the list in memory from COP1LC, following COPJMPs; WAITs past line 255 are
  labelled with the real line. That's the list as written. What the copper actually *ran* —
  after SKIPs, late WAITs and jumps — is in a profile capture: `profile_dump { "copper": true }`
  (see puae-profiling).
- `emulator_disassemble` on the code that builds the list, if the list itself is wrong.

**It hangs, or never gets where you expect.** `emulator_continue` with a breakpoint where it
should arrive. "Still running after N frames … check the breakpoint is somewhere this program
actually reaches" means it didn't; `emulator_disassemble` at the current PC shows what it's
spinning in. With nothing armed, `emulator_continue { "maxFrames": 50 }` is simply the way to run
50 frames — that reply isn't a failure.

## Testing an idea without rebuilding

```
emulator_snapshot { "save": "before" }
emulator_write    { "memory": [...], "custom": {...}, "registers": {...} }
emulator_continue / emulator_screenshot     ← did it help?
emulator_snapshot { "restore": "before" }   ← and try the next idea from the same point
```

- **Every write is read back.** "wrote … but it reads back …" means it didn't land — ROM, or
  unmapped memory. Believe it.
- **DMACON, INTENA, INTREQ and ADKCON are SET/CLR registers:** bit 15 chooses set or clear, so
  `$0100` *disables* bitplane DMA and `$8100` enables it. The reply says which it did.
- A memory `value` needs a `size` (`b`/`w`/`l`) — it won't guess a width and clobber the
  neighbouring variable. Patching code is `bytes` (hex).
- Restoring keeps breakpoints, watches and exception stops: they're debugger settings, not
  machine state. `{ "restore": "start" }` reruns the program from its entry point.

## Facts that otherwise mislead

- **Write-only custom registers can't be read from memory.** Reading `$DFF180` returns the bus,
  not COLOR00. `emulator_inspect`'s `chipset` reports the emulator's own copy, which is right.
- **"Stopped … in frame N of this run"** means during that frame, not after N whole frames.
- **Positions are colour clocks.** A line is 227 of them, and a copper WAIT's horizontal value is
  in the same unit as the hpos of any `line:hpos` in a reply.
- **Input runs frames.** `emulator_input` plays mouse and keyboard actions in order — e.g.
  `[{ "click": "left" }]` for the click most demos exit on, then `emulator_continue` to check the
  exit path runs cleanly. Input is read once per frame, so every action runs frames and a
  breakpoint can fire mid-click; the reply then says what is still held down. There's no joystick
  yet. Keys reach code that reads the keyboard itself (the CIA-A serial port, handshaking each
  byte, as demos and games do) — not the OS's input handling, which a fastLoaded program can't
  use (see Setup). If a wait can't be
  satisfied, break after it and move the PC with `emulator_write { "registers": { "pc": "<label>" } }`.
