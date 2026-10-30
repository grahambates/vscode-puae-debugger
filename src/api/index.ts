/** Node.js automation API. Each launch owns an independent, explicitly driven machine. */
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  HeadlessSession,
  LaunchOptions as SessionLaunchOptions,
  DEFAULT_EXCEPTION_STOPS,
  InputAction,
  WriteRequest,
} from "../mcp/emulatorSession";
import { WatchCondition, WatchKind } from "../mcp/watchpoints";
import { CODE_TO_RETROK } from "../shared/retroKeys";
import { composeSheet } from "../mcp/contactSheet";
import { encodePng } from "../mcp/png";
import { analyseProfile } from "../profileAnalysis";
import { diffProfiles, summarizeFunctions } from "../profileCompare";
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
  const session = await HeadlessSession.launch({
    ...options,
    kickstartRom,
    rootDir: options.rootDir ?? resolve(__dirname, ".."),
  });
  try {
    await session.setExceptionStops(
      options.exceptions ?? DEFAULT_EXCEPTION_STOPS,
    );
    await session.setBreakpoints(options.breakpoints ?? []);
    await session.saveSnapshot("start");
    return new Emulator(session);
  } catch (error) {
    session.dispose();
    throw error;
  }
}

export class Emulator {
  private closed = false;
  private busy = false;
  /** @internal Use launch(). */
  constructor(private readonly session: HeadlessSession) {}

  private async use<T>(
    fn: (session: HeadlessSession) => T | Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("Emulator is closed");
    if (this.busy)
      throw new Error(
        "An emulator operation is already running; await it before starting another",
      );
    this.busy = true;
    try {
      return await fn(this.session);
    } finally {
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
  run(options: { frames?: number } = {}) {
    return this.use((s) =>
      s.continueUntilStop(integer(options.frames ?? 500, "frames", 5000)),
    );
  }
  step(options: { count?: number } = {}) {
    return this.use((s) => s.step(integer(options.count ?? 1, "count", 1000)));
  }
  reverse(
    options: { mode?: "step" | "continue" | "frame"; count?: number } = {},
  ) {
    const mode = options.mode ?? "step";
    return this.use((s) =>
      s.reverse(
        mode,
        integer(options.count ?? 1, "count", mode === "step" ? 100000 : 50),
      ),
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
      this.use(
        async (s) =>
          (
            await s.inspect([
              {
                address: address(at),
                bytes: integer(bytes, "bytes", 16 * 1024 * 1024),
              },
            ])
          ).memory[0].data,
      ),
    write: (at: Address, bytes: Uint8Array) =>
      this.write({
        memory: [{ address: address(at), bytes: Buffer.from(bytes) }],
      }),
    writeValue: (at: Address, value: number, size: 1 | 2 | 4 = 2) =>
      this.write({ memory: [{ address: address(at), value, size }] }),
  };
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
      const image = s.screenshot();
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
  captureProfile(options: { frames?: number; path?: string } = {}) {
    return this.use(async (s) => {
      const result = await s.captureProfile(
        integer(options.frames ?? 1, "frames", MAX_CAPTURE_FRAMES),
      );
      if (options.path) await writeFile(options.path, result.bytes);
      return result;
    });
  }
  /** Idempotent; wait for any active operation before closing. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.busy)
      throw new Error("Await the active emulator operation before closing");
    this.closed = true;
    this.session.dispose();
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
