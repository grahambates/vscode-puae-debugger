import { createServer as createHttpServer } from "http";
import { createServer as createNetServer } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";
import { DebugAdapter } from "../debugAdapter";
import { openInBrowser } from "./openInBrowser";
import { StandalonePuaeEmulator } from "./standalonePuaeEmulator";
import { notFound, serveStaticFile } from "./staticServer";

interface Options {
  dapPort: number;
  httpPort: number;
  openBrowser: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dapPort: 4711, httpPort: 5321, openBrowser: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--port":
        options.dapPort = Number(argv[++i]);
        break;
      case "--http-port":
        options.httpPort = Number(argv[++i]);
        break;
      case "--no-open":
        options.openBrowser = false;
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  // out/standalone.js -> repo/package root (contains puae/, out/, node_modules/).
  const rootDir = join(__dirname, "..");
  const url = `http://127.0.0.1:${options.httpPort}/`;

  const emulator = new StandalonePuaeEmulator(rootDir, url, (sessionUrl) => {
    console.log(`PUAE emulator: ${sessionUrl}`);
    if (options.openBrowser) openInBrowser(sessionUrl);
  });

  const httpServer = createHttpServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      const html = emulator.getHtml();
      if (!html) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("No PUAE session has been launched yet — waiting for a debug adapter `launch` request.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (!serveStaticFile(rootDir, req, res)) {
      notFound(res);
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/rpc" });
  wss.on("connection", (socket) => emulator.attachBrowser(socket));

  httpServer.listen(options.httpPort, "127.0.0.1", () => {
    console.log(`HTTP/WebSocket server listening on http://127.0.0.1:${options.httpPort}`);
  });

  // Hand-rolled DAP-over-TCP server, mirroring @vscode/debugadapter's own
  // (~15-line) runDebugAdapter.js server branch — not reusable directly
  // since DebugAdapter's constructor takes a shared PuaeEmulator instance
  // rather than matching that helper's fixed (noDebug, isServer) signature.
  // One `emulator` (and its browser tab) is shared across every DAP session
  // that connects here, so the wasm engine doesn't reboot and the browser
  // tab doesn't need to reconnect between debug sessions.
  const dapServer = createNetServer((socket) => {
    console.log("nvim-dap (or another DAP client) connected");
    const session = new DebugAdapter(emulator);
    session.setRunAsServer(true);
    session.start(socket, socket);
    socket.on("close", () => console.log("DAP client disconnected"));
  });
  dapServer.listen(options.dapPort, "127.0.0.1", () => {
    console.log(`DAP server listening on 127.0.0.1:${options.dapPort}`);
  });
}

main();
