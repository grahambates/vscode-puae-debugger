// `puae-debugger mcp` — an MCP server over saved .puaeprofile captures.
//
// A subcommand of the existing binary rather than a separate one, for the same reasons `profile`
// is: it shares the bin entry, the bundle and package installation, and an MCP client config
// naming `puae-debugger mcp` reads plainly.
//
// Register with a client by pointing it at this command, e.g. for Claude Code:
//
//     claude mcp add puae -- npx puae-debugger mcp
//
// Emulator-backed tools (capture, screenshot, memory) are not here yet. The groundwork exists —
// setupRpcDispatcher in src/webview/puaeApp/rpc.ts runs against the wasm under plain Node, which
// is how puae-wasm/test/*.mjs drive it — so a headless PuaeRpcClient can be added without a
// browser when those tools are wanted.

import { serveStdio } from "./jsonRpc";
import { TOOLS } from "./tools";

export function runMcpServer(): void {
  // Version is informational (clients show it); kept in step with package.json by hand rather
  // than importing it, since the bundle has no reliable path back to the package root at runtime.
  serveStdio({ name: "puae-debugger", version: "1.0.0" }, TOOLS);
}
