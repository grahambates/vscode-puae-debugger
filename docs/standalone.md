# Standalone server (outside VS Code)

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

## Connecting a client

Launch configurations take exactly the same options as in VS Code (see [Configuration reference](configuration.md)) — minus any `${...}` variables your client doesn't expand itself, so prefer absolute paths if in doubt. For nvim-dap:

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

## Browser panels

The emulator screen opens automatically on launch (Chrome is preferred when installed — its WebGL/WebAssembly performance is meaningfully better here — falling back to the default browser). The other panels are reachable from that screen's toolbar buttons, or directly:

| URL | Panel |
|---|---|
| `/` | Live emulator screen |
| `/profiler` | CPU/DMA profiler — `?numFrames=N` sets the capture length |
| `/state` | Amiga state viewer |

The memory viewer is opened per-address, from the emulator screen's toolbar button or the `openMemoryViewer` custom request.

Since there's no command palette or debug toolbar outside VS Code, the UI actions those provide are exposed as DAP custom requests to bind to a key: `openProfiler`, `openStateViewer` and `openMemoryViewer` (optional `address`), plus `stepBackFrame`, `eof` and `eol` for the frame/scanline stepping commands (back one frame, forward to end of frame, forward to end of scanline).
