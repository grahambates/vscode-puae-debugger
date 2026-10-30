/** Node.js automation API. Each launch owns an independent, explicitly driven machine. */
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  LaunchOptions as SessionLaunchOptions,
  InputAction,
  WriteRequest,
} from "../mcp/emulatorSession";
import { WatchCondition, WatchKind } from "../mcp/watchpoints";
import { CODE_TO_RETROK } from "../shared/retroKeys";
import { composeSheet } from "../mcp/contactSheet";
import { encodePng } from "../mcp/png";
import { analyseProfile } from "../profileAnalysis";
import { diffProfiles, summarizeFunctions } from "../profileCompare";
import { createSession, AutomationSession } from "./session";
import { createWorkerSession } from "./workerSession";
import type { StopState } from "../mcp/emulatorSession";
import { MAX_CAPTURE_FRAMES } from "../shared/profilerTypes";

export type {
  StopState,
  InspectResult,
  SnapshotInfo,
  WatchEntry,
  WriteRequest,
  InputAction,
} from "../mcp/emulatorSession";
export type { WatchCondition, WatchKind } from "../mcp/watchpoints";
export type { ProfileAnalysis, ProfileFinding } from "../profileAnalysis";
export { EXCEPTIONS } from "../mcp/emulatorSession";

export interface LaunchOptions
  extends Omit<SessionLaunchOptions, "rootDir" | "kickstartRom"> {
  /** Defaults to the installed package's assets. Override for a custom emulator build. */
  rootDir?: string;
  /** Path to your ROM, or set PUAE_KICKSTART_ROM. */
  kickstartRom?: string;
  breakpoints?: string[];
  /** Exception vectors to stop on; defaults to bus/address errors, illegal instruction and divide by zero. */
  exceptions?: number[];
  /** Run in a worker (default true), allowing hard cancellation and isolated diagnostics. */
  isolate?: boolean;
  /** Wall-clock deadline for boot and each worker request. Default 30000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type Address = string | number;
export type MouseButton = "left" | "middle" | "right";
export type JoystickButton =
  | "fire"
  | "fire2"
  | "up"
  | "down"
  | "left"
  | "right";

function integer(
  value: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
  min = 1,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}
function address(value: Address): string {
  return typeof value === "number"
    ? `0x${integer(value, "address", 0xffffffff, 0).toString(16)}`
    : value;
}
const mouseButtons = { left: 0, middle: 1, right: 2 };
const joystickBits = { fire: 0, fire2: 8, up: 4, down: 5, left: 6, right: 7 };

/** Launch paused at entry, with a "start" snapshot. No browser or MCP process is needed. */
export async function launch(options: LaunchOptions): Promise<Emulator> {
  const kickstartRom = options.kickstartRom ?? process.env.PUAE_KICKSTART_ROM;
  if (!kickstartRom)
    throw new Error("Provide kickstartRom or set PUAE_KICKSTART_ROM");
  const { isolate = true, timeoutMs, signal, ...config } = options;
  if (!isolate && (signal || timeoutMs !== undefined))
    throw new Error(
      "Launch deadlines and AbortSignal require worker isolation",
    );
  const sessionOptions = {
    ...config,
    kickstartRom,
    rootDir: options.rootDir ?? resolve(__dirname, ".."),
    log: options.log ?? (() => {}),
  };
  const session = isolate
    ? await createWorkerSession(sessionOptions, { timeoutMs, signal })
    : await createSession(sessionOptions);
  return new Emulator(session, timeoutMs);
}

export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface WaitOptions extends OperationOptions {
  frames?: number;
}
export class WaitError extends Error {
  constructor(
    message: string,
    public readonly lastStop?: StopState,
    public readonly actual?: number | string,
  ) {
    super(message);
    this.name = "WaitError";
  }
}

export class Emulator {
  private closed = false;
  private busy = false;
  /** @internal Use launch(). */
  constructor(
    private readonly session: AutomationSession,
    private readonly timeoutMs = 30000,
  ) {}

  private async use<T>(
    fn: (session: AutomationSession) => T | Promise<T>,
    options: OperationOptions = {},
  ): Promise<T> {
    if (this.closed) throw new Error("Emulator is closed");
    if (this.busy)
      throw new Error(
        "An emulator operation is already running; await it before starting another",
      );
    options.signal?.throwIfAborted();
    if (
      (options.signal || options.timeoutMs !== undefined) &&
      !this.session.terminate
    )
      throw new Error(
        "AbortSignal and wall-clock deadlines require worker isolation",
      );
    const deadline = integer(
      options.timeoutMs ?? this.timeoutMs,
      "timeoutMs",
      2147483647,
    );
    let interruption: Error | undefined;
    const cancel = (message: string) => {
      interruption = new Error(message);
      this.closed = true;
      void this.session.terminate?.(message);
    };
    const abort = () => cancel("Emulator operation aborted; machine closed");
    const timer = this.session.terminate
      ? setTimeout(
          () =>
            cancel(
              `Emulator operation timed out after ${deadline} ms; machine closed`,
            ),
          deadline,
        )
      : undefined;
    options.signal?.addEventListener("abort", abort, { once: true });
    this.busy = true;
    try {
      const value = await fn(this.session);
      if (interruption) throw interruption;
      return value;
    } catch (error) {
      throw interruption ?? error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.busy = false;
    }
  }

  get entryPoint(): number {
    return this.session.entryPoint;
  }
  get frame(): number {
    return this.session.frame;
  }
  get hasSourceInfo(): boolean {
    return this.session.hasSourceInfo;
  }
  get segmentOffsets(): number[] {
    return [...this.session.segmentOffsets];
  }

  /** Runs at most this many emulated frames and returns the stop reason and location. Always pauses afterwards. */
  run(options: WaitOptions = {}) {
    return this.use(
      (s) =>
        s.continueUntilStop(integer(options.frames ?? 500, "frames", 5000)),
      options,
    );
  }
  /** Run to an address, symbol or source line, preserving existing breakpoints. */
  runUntil(at: Address, options: WaitOptions = {}) {
    return this.use(async (s) => {
      const budget = integer(options.frames ?? 500, "frames", 5000);
      const target = await s.resolveAddress(address(at));
      const initial = await s.inspect([]);
      if (parseInt(initial.cpu.pc, 16) === target) {
        return {
          stopped: true,
          reason: "TARGET_REACHED",
          pc: target,
          location: initial.location,
          framesRun: 0,
        };
      }
      const exists = await s.hasBreakpoint(target);
      if (!exists) await s.setBreakpoints([address(target)]);
      try {
        const stop = await s.continueUntilStop(budget);
        if (stop.pc === target && stop.reason === "BREAKPOINT_REACHED")
          return stop;
        throw new WaitError(
          `runUntil(${at}) ${stop.stopped ? "interrupted by " + stop.reason : "timed out"} after ${stop.framesRun} frames at ${stop.location}`,
          stop,
        );
      } finally {
        if (!exists && !this.closed)
          await s.removeBreakpoints([address(target)]);
      }
    }, options);
  }

  /** Poll a big-endian byte, word or long at frame boundaries; check before advancing. */
  waitForMemory(
    at: Address,
    options: WaitOptions & { equals: number; size?: 1 | 2 | 4 },
  ) {
    return this.use(async (s) => {
      const budget = integer(options.frames ?? 500, "frames", 5000);
      const size = options.size ?? 2;
      if (![1, 2, 4].includes(size))
        throw new RangeError("size must be 1, 2 or 4");
      integer(options.equals, "equals", 2 ** (size * 8) - 1, 0);
      let stop: StopState | undefined;
      for (let ran = 0; ; ran++) {
        const value = (await s.readBytes(address(at), size)).readUIntBE(
          0,
          size,
        );
        if (value === options.equals) return { value, framesRun: ran, stop };
        if (stop?.stopped || ran === budget)
          throw new WaitError(
            `waitForMemory(${at}) ${stop?.stopped ? "interrupted by " + stop.reason : "timed out"} after ${ran} frames; expected ${options.equals}, last value ${value}`,
            stop,
            value,
          );
        stop = await s.continueUntilStop(1);
        // Yield to Node so timers and AbortSignals can be delivered between polls.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }, options);
  }

  /** Consume serial output until a substring or regular expression matches. */
  waitForSerial(pattern: string | RegExp, options: WaitOptions = {}) {
    return this.use(async (s) => {
      const budget = integer(options.frames ?? 500, "frames", 5000);
      const expression =
        pattern instanceof RegExp
          ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
          : undefined;
      let text = "";
      let stop: StopState | undefined;
      for (let ran = 0; ; ran++) {
        const output = await s.takeSerial();
        text += output.text;
        if (output.dropped || text.length > 1024 * 1024)
          throw new WaitError(
            "Serial output overflowed while waiting",
            stop,
            text,
          );
        if (
          expression ? expression.test(text) : text.includes(pattern as string)
        )
          return { text, framesRun: ran, stop };
        if (stop?.stopped || ran === budget)
          throw new WaitError(
            `waitForSerial(${pattern}) ${stop?.stopped ? "interrupted by " + stop.reason : "timed out"} after ${ran} frames`,
            stop,
            text,
          );
        stop = await s.continueUntilStop(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }, options);
  }

  step(options: OperationOptions & { count?: number } = {}) {
    return this.use(
      (s) => s.step(integer(options.count ?? 1, "count", 1000)),
      options,
    );
  }
  reverse(
    options: OperationOptions & {
      mode?: "step" | "continue" | "frame";
      count?: number;
    } = {},
  ) {
    const mode = options.mode ?? "step";
    return this.use(
      (s) =>
        s.reverse(
          mode,
          integer(options.count ?? 1, "count", mode === "step" ? 100000 : 50),
        ),
      options,
    );
  }
  inspect() {
    return this.use((s) => s.inspect([]));
  }
  disassemble(
    at?: Address,
    options: { before?: number; count?: number; wholeFunction?: boolean } = {},
  ) {
    return this.use((s) =>
      s.disassemble(at === undefined ? undefined : address(at), {
        before: integer(options.before ?? 0, "before", 1000, 0),
        count: integer(options.count ?? 20, "count", 1000),
        wholeFunction: options.wholeFunction ?? false,
        maxInstructions: 1000,
      }),
    );
  }
  readonly breakpoints = {
    add: (...specs: Address[]) =>
      this.use((s) => s.setBreakpoints(specs.map(address))),
    remove: (...specs: Address[]) =>
      this.use((s) => s.removeBreakpoints(specs.map(address))),
    clear: () => this.use((s) => s.removeBreakpoints(["all"])),
    list: () => this.use((s) => s.listBreakpoints()),
  };
  readonly exceptions = {
    set: (vectors: number[]) =>
      this.use((s) =>
        s.setExceptionStops(vectors.map((v) => integer(v, "vector", 255, 2))),
      ),
    list: () => this.use((s) => s.listExceptionStops()),
  };
  readonly memory = {
    read: (at: Address, bytes: number) =>
      this.use((s) =>
        s.readBytes(address(at), integer(bytes, "bytes", 16 * 1024 * 1024)),
      ),
    readByte: (at: Address) => this.readScalar(at, 1),
    readWord: (at: Address) => this.readScalar(at, 2),
    readLong: (at: Address) => this.readScalar(at, 4),
    readString: (
      at: Address,
      options: { maxBytes?: number; encoding?: BufferEncoding } = {},
    ) =>
      this.use(async (s) => {
        const bytes = await s.readBytes(
          address(at),
          integer(options.maxBytes ?? 256, "maxBytes", 16 * 1024 * 1024),
        );
        const end = bytes.indexOf(0);
        if (end < 0)
          throw new Error(
            `Unterminated string at ${at} within ${bytes.length} bytes`,
          );
        return bytes.subarray(0, end).toString(options.encoding ?? "latin1");
      }),
    write: (at: Address, bytes: Uint8Array) =>
      this.write({
        memory: [{ address: address(at), bytes: Buffer.from(bytes) }],
      }),
    writeValue: (at: Address, value: number, size: 1 | 2 | 4 = 2) =>
      this.write({ memory: [{ address: address(at), value, size }] }),
  };
  private readScalar(at: Address, size: 1 | 2 | 4) {
    return this.use(async (s) =>
      (await s.readBytes(address(at), size)).readUIntBE(0, size),
    );
  }
  readonly registers = {
    read: () => this.use(async (s) => (await s.inspect([])).cpu),
    write: (name: string, value: string | number) =>
      this.write({ registers: [{ name, value }] }),
  };
  readonly watches = {
    add: (
      at: Address,
      options: {
        bytes?: number;
        kind?: WatchKind;
        condition?: WatchCondition;
      } = {},
    ) =>
      this.use((s) =>
        s.addWatch(
          address(at),
          options.bytes === undefined
            ? undefined
            : integer(options.bytes, "bytes", 16 * 1024 * 1024),
          options.kind ?? "write",
          options.condition,
        ),
      ),
    remove: (id: number) => this.use((s) => s.removeWatch(id)),
    list: () => this.use((s) => s.listWatches()),
  };
  /** Batch writes. Numeric memory values are encoded big-endian. */
  write(request: Partial<WriteRequest>) {
    return this.use((s) =>
      s.write({ memory: [], registers: [], custom: [], ...request }),
    );
  }
  readonly custom = {
    read: () => this.use((s) => s.chipset()),
    registers: () =>
      this.use(async (s) =>
        Object.fromEntries(
          Object.entries(await s.customRegisters()).map(([name, register]) => [
            name,
            Number(register.value),
          ]),
        ),
      ),
    write: (name: string, value: string | number) =>
      this.write({ custom: [{ name, value }] }),
    copperList: (options: { address?: Address; count?: number } = {}) =>
      this.use((s) =>
        s.copperList(
          options.address === undefined ? undefined : address(options.address),
          integer(options.count ?? 512, "count", 4096),
        ),
      ),
  };
  readonly snapshots = {
    save: (name: string) => this.use((s) => s.saveSnapshot(name)),
    restore: (name: string) => this.use((s) => s.restoreSnapshot(name)),
    delete: (name: string) => this.use((s) => s.deleteSnapshot(name)),
    list: () => this.use((s) => s.listSnapshots()),
  };
  /** Low-level sequences, including held inputs and frame waits. */
  input(actions: InputAction[]) {
    return this.use((s) => {
      for (const action of actions) {
        if (action.kind === "wait") integer(action.frames, "frames", 5000);
        if (action.kind === "move") {
          integer(action.dx, "dx", 10000, -10000);
          integer(action.dy, "dy", 10000, -10000);
        }
      }
      return s.input(actions);
    });
  }
  /** Release all held input without running a frame, even at a breakpoint. */
  releaseAll() {
    return this.use((s) => s.releaseAll());
  }

  readonly keyboard = {
    press: (code: string) => this.key(code, "key"),
    down: (code: string) => this.key(code, "keyDown"),
    up: (code: string) => this.key(code, "keyUp"),
  };
  private key(name: string, kind: "key" | "keyDown" | "keyUp") {
    const code = CODE_TO_RETROK[name];
    if (code === undefined)
      return Promise.reject(
        new Error(
          `Unknown keyboard code: ${name}. Use DOM codes such as KeyA, Enter or Space.`,
        ),
      );
    return this.input([{ kind, code, name, label: `${kind} ${name}` }]);
  }
  readonly mouse = {
    move: (dx: number, dy: number) =>
      this.input([{ kind: "move", dx, dy, label: "mouse move" }]),
    click: (button: MouseButton = "left") => this.mouseAction(button, "click"),
    down: (button: MouseButton = "left") => this.mouseAction(button, "press"),
    up: (button: MouseButton = "left") => this.mouseAction(button, "release"),
  };
  private mouseAction(
    button: MouseButton,
    kind: "click" | "press" | "release",
  ) {
    if (!(button in mouseButtons))
      return Promise.reject(new Error(`Unknown mouse button: ${button}`));
    return this.input([
      { kind, button: mouseButtons[button], label: `${kind} ${button}` },
    ]);
  }
  readonly joystick = {
    press: (button: JoystickButton) => this.joy(button, "joyTap"),
    down: (button: JoystickButton) => this.joy(button, "joyPress"),
    up: (button: JoystickButton) => this.joy(button, "joyRelease"),
  };
  private joy(
    name: JoystickButton,
    kind: "joyTap" | "joyPress" | "joyRelease",
  ) {
    if (!(name in joystickBits))
      return Promise.reject(new Error(`Unknown joystick button: ${name}`));
    return this.input([
      { kind, bit: joystickBits[name], name, label: `${kind} ${name}` },
    ]);
  }
  readonly serial = { read: () => this.use((s) => s.takeSerial()) };
  /** Returns PNG and RGBA data; optionally writes the PNG to disk. */
  screenshot(options: { path?: string } = {}) {
    return this.use(async (s) => {
      const image = await s.screenshot();
      if (options.path) await writeFile(options.path, image.png);
      return image;
    });
  }
  frameSequence(
    options: {
      frames?: number;
      every?: number;
      warmup?: number;
      columns?: number;
      half?: boolean;
      path?: string;
    } = {},
  ) {
    return this.use(async (s) => {
      const result = await s.frameSequence(
        integer(options.warmup ?? 0, "warmup", 5000, 0),
        integer(options.frames ?? 4, "frames", 16),
        integer(options.every ?? 1, "every", 5000),
      );
      if (!result.tiles.length)
        throw new Error(
          "Execution stopped before the first screenshot; use inspect() to examine the stop",
        );
      const sheet = composeSheet(result.tiles, {
        columns: integer(options.columns ?? 4, "columns", 16),
        half: options.half ?? true,
      });
      const png = encodePng(sheet.rgba, sheet.width, sheet.height);
      if (options.path) await writeFile(options.path, png);
      return { ...result, ...sheet, png };
    });
  }
  captureProfile(options: WaitOptions & { path?: string } = {}) {
    return this.use(async (s) => {
      const result = await s.captureProfile(
        integer(options.frames ?? 1, "frames", MAX_CAPTURE_FRAMES),
      );
      if (options.path) await writeFile(options.path, result.bytes);
      return result;
    }, options);
  }
  /** Idempotent; wait for any active operation before closing. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.session.terminate?.();
      return;
    }
    if (this.busy)
      throw new Error("Await the active emulator operation before closing");
    this.closed = true;
    await this.session.dispose();
  }

  /** Hard cancellation. Permanently closes an isolated machine, including active work. */
  async terminate(): Promise<void> {
    if (!this.session.terminate)
      throw new Error("Hard cancellation requires worker isolation");
    this.closed = true;
    await this.session.terminate();
  }
}

/** Saved captures and captureProfile().bytes use the same analysis as the MCP tools. */
export const profiles = {
  async analyse(
    input: string | Uint8Array,
    options: NonNullable<Parameters<typeof analyseProfile>[1]> = {},
  ) {
    return analyseProfile(
      typeof input === "string" ? await readFile(input) : input,
      options,
    );
  },
  summarize: summarizeFunctions,
  diff: diffProfiles,
};
export { analyseProfile, diffProfiles, summarizeFunctions };
export const puae = { launch, profiles };

export { images, compareImages } from "./images";
export type { Image, CompareOptions, Rectangle } from "./images";
export { withEmulator } from "./fixture";
