// Top-level `puae-debugger --help`.
//
// Kept out of server.ts so it can be tested: importing that module starts the DAP and HTTP
// servers as a side effect, which a unit test can't do. The test that matters asserts every
// subcommand actually appears here — help that silently falls behind the commands it documents
// is worse than none, since a caller trusts it to be the full list.
//
// Each subcommand keeps its own detailed usage (profileCli.ts, skillCli.ts); this is the map that
// gets you to them.

export const HELP_FLAGS = ["-h", "--help", "help"];
export const VERSION_FLAGS = ["-v", "--version"];

export function usage(version: string): string {
  return `puae-debugger ${version} — debug and profile Amiga programs against a PUAE emulator.

Usage:
  puae-debugger [options]                 Start the debug adapter + emulator UI server (default)
  puae-debugger profile <dump|check> ...  Inspect a saved .puaeprofile capture
  puae-debugger mcp                       Serve the emulator and profile analysis over MCP (stdio)
  puae-debugger skill install [...]       Install the puae-profiling and puae-debugging skills

Server options:
  --port N        DAP port to listen on (default 4711)
  --http-port N   HTTP/WebSocket port serving the emulator UI in a browser (default 5321)
  --stdio         Speak DAP over stdin/stdout instead of listening on a TCP port,
                  for clients that spawn the adapter themselves
  --no-open       Don't open the emulator screen in a browser on launch

Other:
  -h, --help      Show this help
  -v, --version   Print the version

Each subcommand has its own help, e.g. "puae-debugger profile --help".
Both servers bind to 127.0.0.1 only.`;
}
