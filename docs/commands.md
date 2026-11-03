# Offline subcommands

The npm package includes some commands that can be used outside of the extension:

- `puae-debugger profile dump|check <file.puaeprofile>` — inspect a saved capture from the command line. `dump` prints per-frame cycle costs, top functions and the DMA bus census (`--stalls` additionally compares measured cost against 68000 datasheet timings, and `--instructions <function>` breaks one routine down instruction by instruction); `check` verifies the capture against physical invariants and exits non-zero on an error-level finding, so it can gate a build. `--json` emits the full analysis for a script to consume. `dump --summary` gives each function's min/avg/max per frame across a multi-frame capture, and `profile diff <before> <after>` compares two captures function by function. `dump --accesses <register|symbol|address[:length]|from-to>` lists every chip-bus access to it in the frame and who made it — the CPU (instruction and source line), a copper MOVE, the blitter, bitplane or sprite DMA. `dump --iterations <address|symbol|file:line>` splits a capture at each pass of the main loop: each pass's length, the ones that took longer than a frame, and per-function cost per pass. Times are colour clocks (two 68000 cycles each).
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

  For Codex:

  ```sh
  codex mcp add puae --env PUAE_KICKSTART_ROM=/path/to/kick31.rom -- npx -y puae-debugger mcp
  ```

  Codex stops a tool call after 60 seconds by default, which a long `emulator_continue` or a many-frame capture can exceed. Raise it in `~/.codex/config.toml`:

  ```toml
  [mcp_servers.puae]
  tool_timeout_sec = 300
  ```

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
- `puae-debugger skill install` — installs two skills into your project's `.claude/skills/` (`--global` for `~/.claude/skills/` instead). They're the judgement that goes with the tools: `puae-profiling` for making and reading captures (verify a capture before reading it, don't mistake flame-graph width for time spent, check the DMA bus census before optimizing CPU code that was really waiting on the blitter), and `puae-debugging` for the MCP emulator tools (which tool answers which symptom — a crash, a corrupted variable, a wrong screen — and what not to misread, like the PC of an address error or the CPU's PC on a DMA write). Worth installing in the Amiga project you're working on, not just here. For Codex (or another agent that follows the Agent Skills convention), add `--agents` to install into `.agents/skills/` instead.

  The installed skills are copies, so they don't change when the package does. After upgrading, run `npx puae-debugger@latest skill install` again (with `--global` and `--agents` as you installed them): copies an older version installed are updated, and copies you've edited are left alone unless you pass `--force`, which keeps your version as `SKILL.md.bak`. The MCP server checks too: if the project's or your global skills are older than the server, it tells the agent, which passes the update command on to you.
