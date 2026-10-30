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
import { outdatedSkills } from "../standalone/skillCli";

/**
 * @param rootDir Package root (the directory holding `puae/` and `out/`), which the
 * emulator-backed tools need to find the wasm module and the RPC dispatcher at runtime.
 */
export function runMcpServer(rootDir: string): void {
  // stdout is exclusively JSON-RPC. Core output is routed separately by headlessEmulator,
  // but shared helpers can still emit console diagnostics. This redirect is confined to the
  // MCP CLI process; the JavaScript API uses worker-local logging instead.
  console.log = (...args: unknown[]) => log(args.map(String).join(" "));
  console.info = console.log;
  console.debug = console.log;

  // Version is informational (clients show it). Injected from package.json by esbuild's `define`
  // (see esbuild.js), so it can't drift the way the hand-synced copy it replaced would have:
  // importing package.json would bundle the whole manifest, and reading it at runtime would mean
  // guessing a path back to the package root that differs between a checkout, an installed
  // package and ts-jest.
  const version = __PUAE_DEBUGGER_VERSION__;
  serveStdio({ name: "puae-debugger", version, instructions: skillsInstructions(rootDir, version) }, buildTools({ rootDir }));
}

// The skills installed in a project are copies, so they fall behind this server whenever the
// package is updated (an npx-launched server is usually the latest; the copies are whatever was
// installed last). They describe these tools, so an old one can steer the model wrong. Nothing
// else would notice: say so where the model will see it, once per session.
function skillsInstructions(rootDir: string, version: string): string | undefined {
  let notes: string[];
  try {
    notes = outdatedSkills(rootDir, version);
  } catch {
    return undefined;
  }
  if (notes.length === 0) return undefined;
  for (const note of notes) log(`puae-debugger: outdated skill: ${note}`);
  return (
    `Some installed puae-debugger skills are older than this server (${version}) and may describe ` +
    `its tools wrongly. Tell the user once, early on, and give them the command to update:\n` +
    notes.map((n) => `- ${n}`).join("\n")
  );
}
