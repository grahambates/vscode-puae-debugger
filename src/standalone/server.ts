import { createServer as createHttpServer } from "http";
import { createServer as createNetServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { WebSocketServer } from "ws";
import { DebugAdapter } from "../debugAdapter";
import { ProfilerRpcClient } from "../profilerManager";
import { openInBrowser } from "./openInBrowser";
import { StandaloneMemoryViewerProvider } from "./standaloneMemoryViewerProvider";
import { StandalonePuaeEmulator } from "./standalonePuaeEmulator";
import { StandaloneProfilerViewerProvider } from "./standaloneProfilerViewerProvider";
import { StandaloneStateViewerProvider } from "./standaloneStateViewerProvider";
import { notFound, serveStaticFile } from "./staticServer";

interface Options {
  dapPort: number;
  httpPort: number;
  openBrowser: boolean;
  stdio: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dapPort: 4711, httpPort: 5321, openBrowser: true, stdio: false };
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
      case "--stdio":
        options.stdio = true;
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
  // Every status/announcement log below uses console.error (stderr), never
  // console.log — in --stdio mode, stdout *is* the DAP protocol stream
  // (Content-Length-framed JSON), so anything else written to it would
  // corrupt the client's parser. Using stderr unconditionally, rather than
  // branching on options.stdio, keeps this correct in both modes with no
  // risk of an accidentally-missed console.log resurfacing the bug later.
  // out/standalone.js -> repo/package root (contains puae/, out/, node_modules/).
  const rootDir = join(__dirname, "..");
  // Resolved separately from rootDir: npm hoists dependencies to the
  // *installing* project's top-level node_modules, which isn't necessarily
  // `rootDir/node_modules` once this is a real installed/npx'd package
  // (only true by coincidence in this repo's own dev checkout). require.resolve
  // finds wherever npm/node's module resolution actually put it.
  const codiconsDir = dirname(require.resolve("@vscode/codicons/package.json"));
  const url = `http://127.0.0.1:${options.httpPort}/`;
  const profilerUrl = `http://127.0.0.1:${options.httpPort}/profiler`;
  const stateViewerUrl = `http://127.0.0.1:${options.httpPort}/state`;

  const emulator = new StandalonePuaeEmulator(rootDir, url, (sessionUrl) => {
    console.error(`PUAE emulator: ${sessionUrl}`);
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

  // Every panel this opens is itself the result of an explicit user action
  // (the "openMemoryViewer" DAP custom request below) — unlike the emulator
  // screen's own auto-open on launch, --no-open doesn't gate this, same as
  // "openProfiler" below.
  const memoryViewerProvider = new StandaloneMemoryViewerProvider(
    emulator,
    options.httpPort,
    (panelUrl) => {
      console.error(`Memory viewer: ${panelUrl}`);
      openInBrowser(panelUrl);
    },
  );

  const stateViewerProvider = new StandaloneStateViewerProvider(emulator, memoryViewerProvider);

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
    if (req.url === "/open-memory-viewer" || req.url?.startsWith("/open-memory-viewer?")) {
      // Backs the emulator screen's "Open Memory Viewer" toolbar button
      // (app.ts) — a plain same-origin fetch() is simpler than routing this
      // through the emulator's own RPC/WebSocket channel. show() opens a
      // new browser tab itself via the onPanelOpened callback above, same
      // as the "openMemoryViewer" DAP custom request below.
      const address = new URL(req.url, "http://localhost").searchParams.get("address") ?? "";
      void memoryViewerProvider.show(address).then(
        () => res.writeHead(204).end(),
        (error) => {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(error instanceof Error ? error.message : String(error));
        },
      );
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
    if (req.url === "/state") {
      // Same lazy-open pattern as /profiler.
      void stateViewerProvider.show().then(() => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(stateViewerProvider.getHtml());
      });
      return;
    }
    if (req.url?.startsWith("/profiler-bulk/")) {
      if (!serveStaticFile(bulkDir, req.url.slice("/profiler-bulk".length), res)) {
        notFound(res);
      }
      return;
    }
    // Unlike /profiler, a panel's HTML is only ever created by the
    // "openMemoryViewer" DAP custom request below (it needs an address to
    // evaluate, which this route has no source for) — this just serves
    // whatever that already produced.
    const memoryMatch = req.url?.match(/^\/memory\/([^/]+)$/);
    if (memoryMatch) {
      const html = memoryViewerProvider.getHtml(memoryMatch[1]);
      if (!html) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("No memory viewer panel with this ID (it may have been closed, or the server restarted).");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url?.startsWith("/node_modules/@vscode/codicons/")) {
      // resolveUri emits "node_modules/@vscode/codicons/..." URLs unchanged,
      // but they're served from codiconsDir (see above), not rootDir.
      if (!serveStaticFile(codiconsDir, req.url.slice("/node_modules/@vscode/codicons".length), res)) {
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

  const stateWss = new WebSocketServer({ noServer: true });
  stateWss.on("connection", (socket) => stateViewerProvider.attachBrowser(socket));

  // One WebSocketServer for every memory-viewer panel (not one per panel —
  // that'd be unbounded); the panelId is pulled out of the URL and handed
  // to StandaloneMemoryViewerProvider, which looks up that panel's own
  // BrowserWebviewHost internally.
  const memoryWss = new WebSocketServer({ noServer: true });
  memoryWss.on("connection", (socket, req) => {
    const match = req.url?.match(/^\/memory\/([^/]+)\/rpc$/);
    if (!match) {
      socket.close();
      return;
    }
    memoryViewerProvider.attachBrowser(match[1], socket);
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/rpc") {
      emulatorWss.handleUpgrade(req, socket, head, (ws) => emulatorWss.emit("connection", ws, req));
    } else if (req.url === "/profiler/rpc") {
      profilerWss.handleUpgrade(req, socket, head, (ws) => profilerWss.emit("connection", ws, req));
    } else if (req.url === "/state/rpc") {
      stateWss.handleUpgrade(req, socket, head, (ws) => stateWss.emit("connection", ws, req));
    } else if (req.url?.match(/^\/memory\/[^/]+\/rpc$/)) {
      memoryWss.handleUpgrade(req, socket, head, (ws) => memoryWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(options.httpPort, "127.0.0.1", () => {
    console.error(`HTTP/WebSocket server listening on http://127.0.0.1:${options.httpPort}`);
    console.error(`Profiler: ${profilerUrl}`);
    console.error(`State viewer: ${stateViewerUrl}`);
  });

  const createSession = () =>
    new DebugAdapter(
      emulator,
      () => openInBrowser(profilerUrl),
      (address) => void memoryViewerProvider.show(address ?? ""),
      () => openInBrowser(stateViewerUrl),
    );

  if (options.stdio) {
    // One-shot mode: the client (e.g. nvim-dap's "executable" adapter type)
    // spawns this process itself and talks DAP directly over its stdio,
    // instead of pre-starting a long-lived server and pointing a "server"
    // adapter type at it. Trades away the TCP server's cross-session
    // `emulator` reuse (a fresh process here means a fresh wasm boot + browser
    // tab every debug session) for not needing that separate start-up step.
    // No setRunAsServer(true): unlike the per-connection TCP sessions below,
    // this *is* the whole process, so the default behavior — exit when the
    // client disconnects — is what we want.
    console.error("DAP client connected via stdio");
    createSession().start(process.stdin, process.stdout);
  } else {
    // Hand-rolled DAP-over-TCP server, mirroring @vscode/debugadapter's own
    // (~15-line) runDebugAdapter.js server branch — not reusable directly
    // since DebugAdapter's constructor takes a shared PuaeEmulator instance
    // rather than matching that helper's fixed (noDebug, isServer) signature.
    // One `emulator` (and its browser tab) is shared across every DAP session
    // that connects here, so the wasm engine doesn't reboot and the browser
    // tab doesn't need to reconnect between debug sessions.
    const dapServer = createNetServer((socket) => {
      console.error("nvim-dap (or another DAP client) connected");
      const session = createSession();
      session.setRunAsServer(true);
      session.start(socket, socket);
      socket.on("close", () => console.error("DAP client disconnected"));
    });
    dapServer.listen(options.dapPort, "127.0.0.1", () => {
      console.error(`DAP server listening on 127.0.0.1:${options.dapPort}`);
    });
  }
}

main();
