// `puae-debugger mcp` — an MCP server over stdio, exposing saved .puaeprofile analysis
// (tools.ts) and a headless emulator (emulatorTools.ts).
//
// A subcommand of the existing binary rather than a separate one, for the same reasons `profile`
// is: it shares the bin entry, the bundle and package installation, and an MCP client config
// naming `puae-debugger mcp` reads plainly.
//
// Register with a client by pointing it at this command, e.g. for Claude Code:
//
//     claude mcp add puae -e PUAE_KICKSTART_ROM=/path/to/kick.rom -- npx -y puae-debugger mcp
//
// The emulator tools boot PUAE in this process, with no browser: headlessEmulator.ts loads
// puae.wasm and runs setupRpcDispatcher (src/webview/puaeApp/rpc.ts, built to out/puaeRpc.mjs)
// against it under plain Node, the same way puae-wasm/test/*.mjs drive it.

import { log, serveStdio } from "./jsonRpc";
import { buildTools } from "./tools";

/**
 * @param rootDir Package root (the directory holding `puae/` and `out/`), which the
 * emulator-backed tools need to find the wasm module and the RPC dispatcher at runtime.
 */
export function runMcpServer(rootDir: string): void {
  // stdout is the protocol stream, so nothing but sendMessage may write to it. That is easy to
  // honour in this code and impossible to honour in code this server calls: booting the emulator
  // pulls in the Emscripten module, whose frontend_shim.c logs its boot progress with EM_ASM
  // console.log — which landed mid-frame in a JSON-RPC message and broke the client's parser
  // outright the first time an emulator tool ran. Redirecting console.log for the process closes
  // that off for anything else that logs too. (Emscripten's own printf path is redirected
  // separately, where the module is created — see headlessEmulator.ts.)
  console.log = (...args: unknown[]) => log(args.map(String).join(" "));
  console.info = console.log;
  console.debug = console.log;

  // Version is informational (clients show it). Injected from package.json by esbuild's `define`
  // (see esbuild.js), so it can't drift the way the hand-synced copy it replaced would have:
  // importing package.json would bundle the whole manifest, and reading it at runtime would mean
  // guessing a path back to the package root that differs between a checkout, an installed
  // package and ts-jest.
  serveStdio({ name: "puae-debugger", version: __PUAE_DEBUGGER_VERSION__ }, buildTools({ rootDir }));
}
