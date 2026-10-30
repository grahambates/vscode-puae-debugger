import { Worker } from "worker_threads";
import { join } from "path";
import type { AutomationSession, SessionOptions } from "./session";

// Buffers lose their prototype during structured cloning; preserve the public Buffer contract.
function revive(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revive(item)]),
    );
  }
  return value;
}

export interface WorkerOptions {
  /** Boot deadline. Public API operations apply their own deadlines. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export async function createWorkerSession(
  options: SessionOptions,
  control: WorkerOptions,
): Promise<AutomationSession> {
  const { log, ...data } = options;
  const timeoutMs = control.timeoutMs ?? 30000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647
  )
    throw new RangeError("timeoutMs must be a positive integer");
  control.signal?.throwIfAborted();
  const worker = new Worker(join(__dirname, "apiWorker.js"), {
    workerData: data,
  });
  let metadata: Record<string, unknown> = {};
  let nextId = 0;
  let closed = false;
  let finishBoot!: () => void;
  let failBoot!: (error: Error) => void;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let termination: Promise<void> | undefined;
  const stop = (error: Error): Promise<void> => {
    if (termination) return termination;
    closed = true;
    clearTimeout(bootTimer);
    control.signal?.removeEventListener("abort", abort);
    failBoot(error);
    for (const item of pending.values()) {
      item.reject(error);
    }
    pending.clear();
    termination = worker.terminate().then(() => undefined);
    return termination;
  };
  const abort = () => {
    void stop(new Error("Emulator launch aborted"));
  };
  const bootTimer = setTimeout(() => {
    void stop(new Error(`Emulator launch timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  const ready = new Promise<void>((resolve, reject) => {
    finishBoot = resolve;
    failBoot = reject;
  });
  worker.on("message", (message) => {
    if (closed) return;
    if (message.log !== undefined) {
      try {
        log?.(message.log);
      } catch (error) {
        void stop(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (message.ready) {
      metadata = message.ready;
      clearTimeout(bootTimer);
      control.signal?.removeEventListener("abort", abort);
      finishBoot();
      return;
    }
    if (message.failed) {
      void stop(new Error(message.failed.message));
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    metadata = message.metadata;
    if (message.error) {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      item.reject(error);
    } else item.resolve(revive(message.value));
  });
  worker.on("error", (error) => {
    void stop(error);
  });
  worker.on("exit", (code) => {
    if (!closed) void stop(new Error(`Emulator worker exited (${code})`));
  });
  control.signal?.addEventListener("abort", abort, { once: true });
  await ready;
  return new Proxy({} as AutomationSession, {
    get(_target, name: string) {
      if (name in metadata) return metadata[name];
      if (name === "terminate" || name === "dispose")
        return (reason = "Emulator is closed") => stop(new Error(reason));
      // Prevent Promise resolution from treating this proxy as a thenable.
      if (name === "then") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (closed) {
            reject(new Error("Emulator is closed"));
            return;
          }
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          try {
            worker.postMessage({ id, method: name, args });
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        });
    },
  });
}
