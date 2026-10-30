// This worker owns a single native session. Only data crosses the boundary.
import { parentPort, workerData } from "worker_threads";
import { createSession, SessionOptions } from "./session";
import type { HeadlessSession } from "../mcp/emulatorSession";

const port = parentPort!;
const log = (...args: unknown[]) =>
  port.postMessage({ log: args.map(String).join(" ") });
// Confined to this worker: catches diagnostics from RPC/profile helpers too.
console.log = console.info = console.debug = console.warn = console.error = log;
const metadata = (s: HeadlessSession) => ({
  entryPoint: s.entryPoint,
  frame: s.frame,
  hasSourceInfo: s.hasSourceInfo,
  segmentOffsets: s.segmentOffsets,
});
const serialize = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});
async function main() {
  const session = await createSession({
    ...(workerData as SessionOptions),
    log: (line) => log(line),
  });
  port.postMessage({ ready: metadata(session) });
  port.on(
    "message",
    async ({
      id,
      method,
      args,
    }: {
      id: number;
      method: keyof HeadlessSession;
      args: unknown[];
    }) => {
      try {
        const fn = session[method];
        if (typeof fn !== "function")
          throw new Error(`Unknown session method: ${method}`);
        const value = await (fn as (...args: unknown[]) => unknown).apply(
          session,
          args,
        );
        port.postMessage({ id, value, metadata: metadata(session) });
      } catch (error) {
        port.postMessage({
          id,
          error: serialize(error),
          metadata: metadata(session),
        });
      }
    },
  );
}
main().catch((error) => {
  port.postMessage({ failed: serialize(error) });
  port.close();
});
