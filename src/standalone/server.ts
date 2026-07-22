import { createServer as createHttpServer } from "http";
import { createServer as createNetServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";
import { DebugAdapter } from "../debugAdapter";
import { ProfilerRpcClient } from "../profilerManager";
import { openInBrowser } from "./openInBrowser";
import { StandalonePuaeEmulator } from "./standalonePuaeEmulator";
import { StandaloneProfilerViewerProvider } from "./standaloneProfilerViewerProvider";
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
  const profilerUrl = `http://127.0.0.1:${options.httpPort}/profiler`;

  const emulator = new StandalonePuaeEmulator(rootDir, url, (sessionUrl) => {
    console.log(`PUAE emulator: ${sessionUrl}`);
    if (options.openBrowser) openInBrowser(sessionUrl);
  });

  // Bulk binary blobs (DMA grid/snapshot/JPEGs) for the profiler's per-frame
  // captures — written to disk and served as plain static files rather than
  // sent over the RPC channel, same reasoning as the vscode host (see
  // uint8ToBase64's comment in src/shared/base64.ts). One scratch dir per
  // server process; files are cleaned up on capture reset
  // (StandaloneProfilerViewerProvider.deleteBulkFile), not on process exit.
  const bulkDir = join(tmpdir(), `puae-profiler-${process.pid}`);
  const profilerProvider = new StandaloneProfilerViewerProvider(
    bulkDir,
    () => emulator as unknown as ProfilerRpcClient,
  );

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
    if (req.url === "/profiler") {
      // Lazily opens the profiler "panel" on first visit — unlike the
      // emulator screen, there's no DAP launch step that implies you want
      // this open; show() is cheap (surface creation is synchronous) even
      // though it's typed async.
      void profilerProvider.show().then(() => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(profilerProvider.getHtml());
      });
      return;
    }
    if (req.url?.startsWith("/profiler-bulk/")) {
      if (!serveStaticFile(bulkDir, req.url.slice("/profiler-bulk".length), res)) {
        notFound(res);
      }
      return;
    }
    if (!serveStaticFile(rootDir, req.url ?? "/", res)) {
      notFound(res);
    }
  });

  // noServer + a single shared 'upgrade' listener dispatching by path —
  // *not* two separate `new WebSocketServer({server, path})` instances.
  // Confirmed by direct testing: with `ws`, two WebSocketServers attached to
  // the same http.Server via their own `path` option corrupt each other's
  // permessage-deflate framing (clients see "Expected RSV1 to be clear" and
  // the connection dies after the first message) — this is the documented
  // multi-endpoint pattern precisely to avoid that.
  const emulatorWss = new WebSocketServer({ noServer: true });
  emulatorWss.on("connection", (socket) => emulator.attachBrowser(socket));

  const profilerWss = new WebSocketServer({ noServer: true });
  profilerWss.on("connection", (socket) => profilerProvider.attachBrowser(socket));

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/rpc") {
      emulatorWss.handleUpgrade(req, socket, head, (ws) => emulatorWss.emit("connection", ws, req));
    } else if (req.url === "/profiler/rpc") {
      profilerWss.handleUpgrade(req, socket, head, (ws) => profilerWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(options.httpPort, "127.0.0.1", () => {
    console.log(`HTTP/WebSocket server listening on http://127.0.0.1:${options.httpPort}`);
    console.log(`Profiler: ${profilerUrl}`);
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
    const session = new DebugAdapter(emulator, () => openInBrowser(profilerUrl));
    session.setRunAsServer(true);
    session.start(socket, socket);
    socket.on("close", () => console.log("DAP client disconnected"));
  });
  dapServer.listen(options.dapPort, "127.0.0.1", () => {
    console.log(`DAP server listening on 127.0.0.1:${options.dapPort}`);
  });
}

main();
