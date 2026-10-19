// The emulator-backed half of the MCP surface: tools that RUN an Amiga program, rather than
// reading a capture someone already took.
//
// The point is to close the loop. Before these, a model could analyse a .puaeprofile only if a
// person had launched the debugger, captured frames and saved the file for it — every iteration
// of "is this routine actually faster now?" needed a human in the middle. These take a program on
// disk and produce the capture (or the screen) directly.
//
// Two ways to use them, because the two questions being asked are different shapes:
//
//   One-shot — pass `program`, get an answer. The machine is booted, used and thrown away, so the
//   same arguments always produce the same result. Right for "screenshot this" or "profile this".
//
//   Session — `emulator_launch` returns an id that later calls pass as `session`. The machine
//   stays alive between calls, so you can run to a breakpoint, read registers and memory there,
//   step, run on to the next one, and screenshot or profile from exactly that state. Right for
//   "why is this variable wrong by the time it reaches here".
//
// Sessions cost a wasm instance each and are capped and idle-evicted (see sessionRegistry.ts);
// `emulator_close` frees one immediately.

import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { analyseProfile } from "../profileAnalysis";
import { renderCheck } from "../profileReport";
import { MAX_CAPTURE_FRAMES } from "../shared/profilerTypes";
import { formatAddress } from "./breakpointSpec";
import {
  DEFAULT_EXCEPTION_STOPS,
  EXCEPTIONS,
  exceptionLabel,
  HeadlessSession,
  InspectResult,
  LaunchOptions,
  StopState,
  InputAction,
  JOYSTICK_BITS,
  MOUSE_BUTTONS,
  WriteRequest,
} from "./emulatorSession";
import { CODE_TO_RETROK } from "../shared/retroKeys";
import { ToolDefinition } from "./jsonRpc";
import { expandHome } from "./paths";
import { SessionRegistry } from "./sessionRegistry";
import { composeSheet } from "./contactSheet";
import { encodePng } from "./png";
import { WatchCondition, WatchKind } from "./watchpoints";

/** Environment variable naming the Kickstart ROM, so callers needn't repeat it on every call. */
const ROM_ENV_VAR = "PUAE_KICKSTART_ROM";

// Bounds on how much emulation one call may ask for. Generous enough for any real use (5000
// frames is ~100 seconds of emulated time), tight enough that a mistyped argument can't hang the
// server for an hour.
const MAX_WARMUP_FRAMES = 5000;
// Each step is a round trip into the emulator, so a large count is slower than a continue with a
// breakpoint and almost never what's actually wanted.
const MAX_STEP_INSTRUCTIONS = 1000;
// Enough for a structure, a copper list or a sprite; past that a hex dump stops being readable
// and the answer belongs in a capture instead.
const MAX_MEMORY_BYTES = 4096;
/** Memory read as a hash or to a file: as much RAM as an Amiga is likely to have. */
const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024;
// A full-screen gradient or per-line palette list runs to a few hundred instructions; the default
// covers that, and the cap keeps a list with no end marker from flooding the reply.
const DEFAULT_COPPER_INSTRUCTIONS = 512;
const MAX_COPPER_INSTRUCTIONS = 4096;
// A contact sheet's limits: 4 columns of half-size (360px) tiles stays under ~1600px, the size
// image viewers — including the ones models read screenshots through — start shrinking at, and
// 16 frames keeps the height there too.
const MAX_SHEET_FRAMES = 16;
const SHEET_COLUMNS = 4;
// Stepping back is one restore plus a replay of up to the gap to the checkpoint, so a large count
// costs about what running that far forward does. A few frames' worth of instructions is plenty.
const MAX_REVERSE_INSTRUCTIONS = 100000;
// Each repeat of reverse-continue/frame is its own restore-and-scan.
const MAX_REVERSE_REPEATS = 50;
// Enough for any one routine; past that the reader wants a profile, not a listing.
const MAX_DISASSEMBLE_INSTRUCTIONS = 1000;

export interface EmulatorToolContext {
  /** Package root — the directory holding `puae/` and `out/`. */
  rootDir: string;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`"${key}" is required and must be a string`);
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function requirePath(args: Record<string, unknown>, key: string): string {
  return expandHome(requireString(args, key));
}

function optionalPath(args: Record<string, unknown>, key: string): string | undefined {
  const v = optionalString(args, key);
  return v === undefined ? undefined : expandHome(v);
}

function boundedNumber(args: Record<string, unknown>, key: string, fallback: number, max: number, min = 1): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`"${key}" must be a number >= ${min}`);
  if (n > max) throw new Error(`"${key}" is capped at ${max} (asked for ${n})`);
  return Math.floor(n);
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((entry) => typeof entry !== "string")) {
    throw new Error(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

type MemoryReadForm = "hex" | "sha256" | "file";
interface MemoryRead {
  address: string;
  bytes: number;
  as: MemoryReadForm;
  out?: string;
}

function memoryReads(args: Record<string, unknown>): MemoryRead[] {
  const v = args.memory;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`"memory" must be an array`);
  return v.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`each "memory" entry must be an object`);
    const read = entry as Record<string, unknown>;
    const as = read.as === undefined ? "hex" : read.as;
    if (as !== "hex" && as !== "sha256" && as !== "file") throw new Error(`memory "as" must be "hex", "sha256" or "file"`);
    // Hex goes into the reply, so it's kept to what a model can usefully read; a hash or a file
    // doesn't, so it can cover a whole buffer — chip RAM entire, if need be.
    const bytes = boundedNumber(read, "bytes", 64, as === "hex" ? MAX_MEMORY_BYTES : MAX_MEMORY_FILE_BYTES);
    if (read.out !== undefined && as !== "file") throw new Error(`memory "out" only applies with "as": "file"`);
    return { address: requireString(read, "address"), bytes, as, out: optionalPath(read, "out") };
  });
}

const EXCEPTIONS_PROPERTY = {
  type: "array",
  items: { type: "string", enum: Object.keys(EXCEPTIONS) },
  description:
    `Exceptions that stop the session at the faulting instruction — the complete set, replacing the current one ([] for none). ` +
    `Default: ${Object.entries(EXCEPTIONS).filter(([, e]) => e.default).map(([n]) => n).join(", ")}. ` +
    "privilege_violation is off by default because exec's Supervisor() raises it on purpose.",
} as const;

/** The `exceptions` argument as vector numbers, or undefined if it wasn't given. */
export function exceptionVectors(args: Record<string, unknown>): number[] | undefined {
  if (args.exceptions === undefined || args.exceptions === null) return undefined;
  return stringArray(args, "exceptions").map((name) => {
    const e = EXCEPTIONS[name.toLowerCase()];
    if (!e) throw new Error(`Unknown exception "${name}" — one of ${Object.keys(EXCEPTIONS).join(", ")}`);
    return e.vector;
  });
}

function describeExceptions(vectors: number[]): string {
  return vectors.length ? vectors.map(exceptionLabel).join(", ") : "no exceptions (a crash won't stop the session)";
}

// A screen buffer or a large table; past that the alignment split needs more slots than exist.
const MAX_WATCH_BYTES = 1 << 20;
const WATCH_KINDS: WatchKind[] = ["write", "read", "access"];

/** A number, "0x"/"$" hex or decimal string (negative allowed) — the forms a value is written in. */
function parseValue(v: unknown, where: string): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    const hex = /^(?:0x|\$)([0-9a-f]+)$/i.exec(t);
    if (hex) return parseInt(hex[1], 16);
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  }
  throw new Error(`${where} must be an integer, or a hex string like "0x1f" or "$1f"`);
}

export function watchAdds(args: Record<string, unknown>): { address: string; length?: number; on: WatchKind; condition?: WatchCondition }[] {
  const v = args.add;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`"add" must be an array`);
  return v.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`add[${i}] must be an object`);
    const w = entry as Record<string, unknown>;
    const on = (w.on ?? "write") as WatchKind;
    if (!WATCH_KINDS.includes(on)) throw new Error(`add[${i}].on must be one of ${WATCH_KINDS.join(", ")}`);
    const length = w.length === undefined ? undefined : boundedNumber(w, "length", 1, MAX_WATCH_BYTES);
    if (w.equals !== undefined && w.changes !== undefined) throw new Error(`add[${i}]: pass "equals" or "changes", not both`);
    if (w.changes !== undefined && w.changes !== true) throw new Error(`add[${i}].changes must be true when given`);
    const condition: WatchCondition | undefined = w.equals !== undefined
      ? { equals: parseValue(w.equals, `add[${i}].equals`) }
      : w.changes === true ? { changes: true } : undefined;
    return { address: requireString(w, "address"), length, on, condition };
  });
}

// Long enough for a scripted interaction; past that it belongs in several calls with a look between.
const MAX_INPUT_ACTIONS = 100;
const KEY_ALIASES: Record<string, string> = { return: "Enter", esc: "Escape", del: "Delete", " ": "Space" };

/** A key name as a RETROK_* code: the DOM KeyboardEvent.code name ("Space", "F1", "KeyA"), any case, or a single letter/digit. */
function resolveKey(name: string, where: string): { code: number; name: string } {
  const lower = name.toLowerCase();
  const candidates = [
    name,
    KEY_ALIASES[lower],
    Object.keys(CODE_TO_RETROK).find((k) => k.toLowerCase() === lower),
    /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : undefined,
    /^[0-9]$/.test(name) ? `Digit${name}` : undefined,
  ];
  for (const c of candidates) {
    if (c !== undefined && CODE_TO_RETROK[c] !== undefined) return { code: CODE_TO_RETROK[c], name: c };
  }
  throw new Error(
    `${where}: unknown key "${name}". Use a key name like Space, Enter, Escape, F1, ArrowLeft, ShiftLeft, ` +
      `a single letter or digit, or one of: ${Object.keys(CODE_TO_RETROK).join(", ")}`,
  );
}

/** emulator_input's `actions`, validated and resolved, before anything runs. */
export function inputActions(args: Record<string, unknown>): InputAction[] {
  const v = args.actions;
  if (!Array.isArray(v) || v.length === 0) throw new Error(`"actions" must be a non-empty array`);
  if (v.length > MAX_INPUT_ACTIONS) throw new Error(`"actions" is capped at ${MAX_INPUT_ACTIONS} per call`);
  return v.map((entry, i): InputAction => {
    const where = `actions[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw new Error(`${where} must have exactly one of: click, press, release, move, key, keyDown, keyUp, joyTap, joyPress, joyRelease, wait`);
    const kind = keys[0];
    const value = (entry as Record<string, unknown>)[kind];
    switch (kind) {
      case "click":
      case "press":
      case "release": {
        const button = MOUSE_BUTTONS[String(value).toLowerCase()];
        if (button === undefined) throw new Error(`${where}.${kind} must be "left", "right" or "middle"`);
        return { kind, button, label: `${kind} ${String(value).toLowerCase()}` };
      }
      case "key":
      case "keyDown":
      case "keyUp": {
        if (typeof value !== "string") throw new Error(`${where}.${kind} must be a key name`);
        const key = resolveKey(value, `${where}.${kind}`);
        return { kind, ...key, label: `${kind} ${key.name}` };
      }
      case "joyTap":
      case "joyPress":
      case "joyRelease": {
        const name = String(value).toLowerCase();
        const bit = JOYSTICK_BITS[name];
        if (bit === undefined) throw new Error(`${where}.${kind} must be one of: ${Object.keys(JOYSTICK_BITS).join(", ")}`);
        return { kind, bit, name, label: `${kind} ${name}` };
      }
      case "move": {
        const [dx, dy] = Array.isArray(value) ? value : [];
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error(`${where}.move must be [dx, dy] in mouse counts, e.g. [40, -10]`);
        return { kind, dx, dy, label: `move ${dx},${dy}` };
      }
      case "wait": {
        const frames = boundedNumber({ wait: value }, "wait", 1, MAX_WARMUP_FRAMES);
        return { kind, frames, label: `wait ${frames}` };
      }
      default:
        throw new Error(`${where}: unknown action "${kind}" — use click, press, release, move, key, keyDown, keyUp, joyTap, joyPress, joyRelease or wait`);
    }
  });
}

const SIZES = { b: 1, w: 2, l: 4 } as const;
// Enough for a patch or a small table; anything bigger is a different program, not an experiment.
const MAX_WRITE_BYTES = 4096;

function writeValue(v: unknown, where: string): string | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) return v;
  throw new Error(`${where} must be a number or a string (hex, symbol, file:line)`);
}

function namedValues(args: Record<string, unknown>, key: string): { name: string; value: string | number }[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`"${key}" must be an object of { name: value }`);
  return Object.entries(v as Record<string, unknown>).map(([name, value]) => ({ name, value: writeValue(value, `${key}.${name}`) }));
}

export function writeRequest(args: Record<string, unknown>): WriteRequest {
  const memory = args.memory;
  if (memory !== undefined && memory !== null && !Array.isArray(memory)) throw new Error(`"memory" must be an array`);
  return {
    memory: ((memory as unknown[] | undefined) ?? []).map((entry, i) => {
      if (typeof entry !== "object" || entry === null) throw new Error(`memory[${i}] must be an object`);
      const w = entry as Record<string, unknown>;
      const address = requireString(w, "address");
      if (w.bytes !== undefined) {
        if (w.value !== undefined) throw new Error(`memory[${i}]: pass "bytes" or "value", not both`);
        const hex = String(w.bytes).replace(/\s+/g, "").replace(/^0x/i, "");
        if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error(`memory[${i}].bytes must be whole bytes of hex, e.g. "4e71 4e75"`);
        if (hex.length / 2 > MAX_WRITE_BYTES) throw new Error(`memory[${i}].bytes is capped at ${MAX_WRITE_BYTES} bytes`);
        return { address, bytes: Buffer.from(hex, "hex") };
      }
      const size = SIZES[w.size as keyof typeof SIZES];
      // Required rather than guessed: the wrong width silently clobbers a neighbouring variable.
      if (!size) throw new Error(`memory[${i}]: "value" needs "size" ("b", "w" or "l")`);
      return { address, value: writeValue(w.value, `memory[${i}].value`), size };
    }),
    custom: namedValues(args, "custom"),
    registers: namedValues(args, "registers"),
  };
}

/**
 * The Kickstart ROM to boot: the explicit argument, else the environment variable. Required —
 * fastLoad injection needs a real ROM, and PUAE's built-in AROS fallback isn't one.
 */
function resolveRom(args: Record<string, unknown>): string {
  const explicit = optionalPath(args, "kickstartRom");
  if (explicit) return explicit;
  // Expanded too: `claude mcp add -e VAR=~/...` quotes the value, so no shell expands it.
  const fromEnv = process.env[ROM_ENV_VAR];
  if (fromEnv) return expandHome(fromEnv);
  throw new Error(
    `No Kickstart ROM: pass "kickstartRom", or set ${ROM_ENV_VAR} in this server's environment ` +
      `(e.g. claude mcp add puae -e ${ROM_ENV_VAR}=/path/to/kick31.rom -- npx -y puae-debugger mcp). ` +
      "ROMs are copyrighted and aren't shipped with this package.",
  );
}

// `.uae` config lines from a { key: value } object, so a caller can say { cpu_model: 68020 }
// without knowing the file format. Values are stringified as-is; every WinUAE key is accepted,
// the same as `emulatorOptions` in a launch.json.
function configLines(args: Record<string, unknown>): string | undefined {
  const config = args.config;
  if (config === undefined || config === null) return undefined;
  if (typeof config !== "object" || Array.isArray(config)) throw new Error(`"config" must be an object`);
  const lines = Object.entries(config as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
  return lines.length ? lines.join("\n") : undefined;
}

function launchOptions(ctx: EmulatorToolContext, args: Record<string, unknown>): LaunchOptions {
  return {
    rootDir: ctx.rootDir,
    program: requirePath(args, "program"),
    debugProgram: optionalPath(args, "debugProgram"),
    kickstartRom: resolveRom(args),
    extraConfig: configLines(args),
  };
}

/** Writes `bytes` to `out` if given, else to a fresh temp file named after the program. */
function writeOutput(out: string | undefined, program: string, suffix: string, bytes: Buffer): string {
  const target = out ?? join(mkdtempSync(join(tmpdir(), "puae-mcp-")), basename(program).replace(/\.[^.]+$/, "") + suffix);
  writeFileSync(target, bytes);
  return target;
}

/**
 * Runs `body` against either an existing session (`session`) or a throwaway one launched for this
 * call (`program`). A one-shot session is always disposed; a caller's own session never is.
 */
async function withSession<T>(
  ctx: EmulatorToolContext,
  registry: SessionRegistry,
  args: Record<string, unknown>,
  body: (session: HeadlessSession) => Promise<T>,
): Promise<T> {
  const sessionId = optionalString(args, "session");
  if (sessionId) {
    if (args.program) throw new Error(`Pass either "session" or "program", not both.`);
    return body(registry.get(sessionId));
  }
  const session = await HeadlessSession.launch(launchOptions(ctx, args));
  try {
    return await body(session);
  } finally {
    session.dispose();
  }
}

// Serial output appended to a reply: enough for a page of kprintf, not a flood.
const MAX_SERIAL_CHARS = 4000;

/** Serial output since the last call, as a block to append to a reply, or "" when there was none. */
function serialNote(session: HeadlessSession): string {
  const { text, dropped } = session.takeSerial();
  if (!text && !dropped) return "";
  const shown = text.length > MAX_SERIAL_CHARS ? text.slice(0, MAX_SERIAL_CHARS) : text;
  const cut = text.length - shown.length;
  return "\nSerial output since the last call (kprintf and anything else written to SERDAT):\n" +
    shown.replace(/\n$/, "") +
    (cut ? `\n… ${cut} more character(s) not shown` : "") +
    (dropped ? `\n… and ${dropped} byte(s) lost — the 64KB capture buffer filled between calls` : "");
}

function formatStop(stop: StopState, budget: number, armed: boolean, catchesCrashes: boolean): string {
  if (!stop.stopped) {
    // With nothing armed, running the whole budget is the expected outcome — the normal way to
    // reach "frame 50" — not a breakpoint that was missed.
    if (!armed) {
      return `Ran ${stop.framesRun} frame(s) with no breakpoints or watches armed` +
        `${catchesCrashes ? ", and no crash" : ""}. Now at ${stop.location}.`;
    }
    return `Still running after ${stop.framesRun} frame(s) — nothing stopped it. Now at ${stop.location}.\n` +
      `Raise maxFrames (currently ${budget}) or check the breakpoint is somewhere this program actually reaches.`;
  }
  // The frame a stop lands in counts as run, so "in frame N" — not "after N frames", which
  // reads as N whole frames having gone by.
  return `Stopped: ${stop.reason} in frame ${stop.framesRun} of this run, at ${stop.location}.` +
    (stop.detail ? `\n${stop.detail}` : "");
}

// Classic hex dump: 16 bytes a line, address on the left, printable ASCII on the right. The ASCII
// column earns its width — it's what makes a string, a pointer table or a run of zeroes obvious
// at a glance instead of needing another call to decode.
function hexDump(address: number, data: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    const row = data.subarray(offset, offset + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${formatAddress(address + offset)}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

function formatInspect(result: InspectResult, reads: MemoryRead[], program: string): string {
  const cpu = result.cpu as unknown as Record<string, string>;
  const registerLine = (names: string[]) => names.map((n) => `${n}=${cpu[n]}`).join(" ");
  const sections = [
    `At ${result.location}`,
    "",
    registerLine(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]),
    registerLine(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
    `pc=${cpu.pc} sr=${cpu.sr} usp=${cpu.usp ?? "-"}`,
    "",
    result.callstack.length
      ? "Call stack (innermost first):\n" + result.callstack.map((f, i) => `  #${i} ${f}`).join("\n")
      : "Call stack: empty (nothing has been called from the entry point yet)",
  ];
  result.memory.forEach((read, i) => {
    const { as, out } = reads[i];
    const at = `${read.requested} (${formatAddress(read.address)}), ${read.data.length} bytes`;
    // The hash covers exactly the bytes read, so two calls agree only if those bytes do.
    const hash = () => createHash("sha256").update(read.data).digest("hex");
    if (as === "sha256") {
      sections.push("", `Memory at ${at}: sha256 ${hash()}`);
    } else if (as === "file") {
      const name = `${program}-${formatAddress(read.address)}`;
      const path = writeOutput(out, name, ".bin", Buffer.from(read.data));
      sections.push("", `Memory at ${at} written to ${path} (sha256 ${hash()})`);
    } else {
      sections.push("", `Memory at ${at}:`, hexDump(read.address, read.data));
    }
  });
  return sections.join("\n");
}

const SESSION_PROPERTY = {
  session: {
    type: "string",
    description: "Id of a session from emulator_launch, to act on the machine as it currently stands. Mutually exclusive with `program`, which launches a throwaway one instead.",
  },
} as const;

// Arguments every emulator tool shares. Repeated per tool rather than factored into a $ref: a
// model reads each schema on its own, and an inlined property with its own description is what
// actually gets used correctly.
const COMMON_PROPERTIES = {
  program: {
    type: "string",
    description: "Path to the Amiga hunk executable to run. Injected directly into RAM (fastLoad), not booted from a disk.",
  },
  ...SESSION_PROPERTY,
  debugProgram: {
    type: "string",
    description: "Path to read debug symbols from, if that isn't the program itself (e.g. an ELF built alongside a hunk executable).",
  },
  kickstartRom: {
    type: "string",
    description: `Path to a Kickstart ROM. Defaults to the ${ROM_ENV_VAR} environment variable if that is set.`,
  },
  config: {
    type: "object",
    description:
      'WinUAE .uae config overrides, e.g. { "cpu_model": 68020, "chipset": "aga", "chipmem_size": 2 }. ' +
      "Defaults are a cycle-exact 68000 OCS machine.",
  },
} as const;

export function emulatorTools(ctx: EmulatorToolContext): ToolDefinition[] {
  // One registry per server. Created here rather than passed in so nothing outside this module
  // can hold a session open behind the tools' back.
  const registry = new SessionRegistry();

  return [
    {
      name: "emulator_launch",
      description:
        "Start a debugging session: boot a machine, inject an Amiga program, and hold it paused " +
        "at its entry point. Returns a session id that emulator_continue, emulator_step, " +
        "emulator_inspect, emulator_screenshot and emulator_capture_profile then act on, so the " +
        "machine keeps its state between calls — this is what to use to run to a breakpoint and " +
        "examine registers and memory there. Set `breakpoints` now or pass them to " +
        "emulator_continue later; either takes an address (0x2140), a symbol name (draw_sprite) " +
        "or a source line (main.s:42). A crash (bus/address error, illegal instruction, zero " +
        "divide) stops the session at the faulting instruction; change that with `exceptions`. " +
        "Call emulator_close when finished. Needs a Kickstart ROM.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          breakpoints: {
            type: "array",
            items: { type: "string" },
            description: 'Breakpoints to arm before the program runs, e.g. ["draw_sprite", "main.s:42", "0x2140"].',
          },
          exceptions: EXCEPTIONS_PROPERTY,
        },
        required: ["program"],
        additionalProperties: false,
      },
      run: async (args) => {
        const exceptions = exceptionVectors(args) ?? DEFAULT_EXCEPTION_STOPS;
        const session = await HeadlessSession.launch(launchOptions(ctx, args));
        let armed: string[] = [];
        try {
          armed = await session.setBreakpoints(stringArray(args, "breakpoints"));
          await session.setExceptionStops(exceptions);
          // So the program can be rerun from its entry point without relaunching.
          await session.saveSnapshot("start");
        } catch (error) {
          session.dispose();
          throw error;
        }
        const id = registry.add(session, requireString(args, "program"));
        return (
          `Session ${id} — paused at entry point ${formatAddress(session.entryPoint)}, before the first instruction.\n` +
          (session.hasSourceInfo
            ? ""
            : "No source-level debug info: breakpoints and memory reads take addresses or hunk symbols only, not file:line.\n") +
          (armed.length ? `Breakpoints: ${armed.join("; ")}\n` : "No breakpoints set.\n") +
          `Stops on: ${describeExceptions(session.listExceptionStops())}.\n` +
          `Snapshot "start" saved here — emulator_snapshot { "restore": "start" } reruns from the entry point.\n` +
          `Continue with emulator_continue { "session": "${id}" }; close it with emulator_close when done.`
        );
      },
    },
    {
      name: "emulator_snapshot",
      description:
        "Save and restore a session's whole machine state, to try several experiments from the " +
        "same point: save, change something with emulator_write, run on and look; then restore " +
        "and try the next idea — no relaunch, no re-running to get back there. A snapshot named " +
        '"start" is saved at launch, so { "restore": "start" } reruns the program from its entry ' +
        "point. Restoring keeps the current breakpoints, watches and exception stops (they're " +
        "debugger state, not machine state). Always replies with the snapshots held.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          save: { type: "string", description: "Save the current state under this name (replacing one of the same name)." },
          restore: { type: "string", description: "Restore the state saved under this name." },
          delete: { type: "string", description: "Delete the snapshot with this name." },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const save = optionalString(args, "save");
        const restore = optionalString(args, "restore");
        const del = optionalString(args, "delete");
        if ([save, restore, del].filter((v) => v !== undefined).length > 1) {
          throw new Error(`Pass one of "save", "restore" or "delete" per call.`);
        }
        const lines: string[] = [];
        if (save !== undefined) {
          const s = await session.saveSnapshot(save);
          lines.push(`Saved "${s.name}" at frame ${s.frame}, ${s.location}.`);
        } else if (restore !== undefined) {
          const s = await session.restoreSnapshot(restore);
          lines.push(`Restored "${s.name}": back at frame ${s.frame}, ${s.location}.`);
        } else if (del !== undefined) {
          session.deleteSnapshot(del);
          lines.push(`Deleted "${del}".`);
        }
        const held = session.listSnapshots();
        lines.push(held.length
          ? "Snapshots:\n" + held.map((s) => `  ${s.name}: frame ${s.frame}, ${s.location} (${(s.bytes / 1048576).toFixed(1)}MB)`).join("\n")
          : "No snapshots held.");
        return lines.join("\n");
      },
    },
    {
      name: "emulator_breakpoints",
      description:
        "Add or remove a session's breakpoints, and choose which exceptions stop it. Always " +
        "replies with everything that can currently stop the session — breakpoints, exception " +
        "stops and watches — so call it with no changes to see that. Breakpoints take an address, " +
        'symbol or file:line; remove them by the same spec, or "all".',
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          add: { type: "array", items: { type: "string" }, description: "Breakpoints to arm." },
          remove: { type: "array", items: { type: "string" }, description: 'Breakpoints to remove, or ["all"].' },
          exceptions: EXCEPTIONS_PROPERTY,
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const exceptions = exceptionVectors(args);
        const lines: string[] = [];
        const removed = await session.removeBreakpoints(stringArray(args, "remove"));
        if (removed.length) lines.push(`Removed: ${removed.join("; ")}`);
        const added = await session.setBreakpoints(stringArray(args, "add"));
        if (added.length) lines.push(`Added: ${added.join("; ")}`);
        if (exceptions) await session.setExceptionStops(exceptions);
        const breakpoints = session.listBreakpoints();
        const watches = session.listWatches();
        lines.push(
          breakpoints.length ? `Breakpoints:\n${breakpoints.map((b) => `  ${b}`).join("\n")}` : "Breakpoints: none",
          `Exception stops: ${describeExceptions(session.listExceptionStops())}`,
          watches.length ? `Watches:\n${watches.map((w) => `  #${w.id} ${w.description}`).join("\n")}` : "Watches: none (see emulator_watch)",
        );
        return lines.join("\n");
      },
    },
    {
      name: "emulator_continue",
      description:
        "Resume a session and run until a breakpoint or a watchpoint (see emulator_watch) fires, or until `maxFrames` " +
        "emulated frames have passed — whichever comes first, so this can't hang on a program " +
        "that never reaches the breakpoint. Reports where it stopped and why. Follow with " +
        "emulator_inspect to read registers, the call stack and memory at that point. Anything the " +
        "program printed to the serial port meanwhile (kprintf) is included in the reply.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          breakpoints: {
            type: "array",
            items: { type: "string" },
            description: "Extra breakpoints to arm before resuming (same forms as emulator_launch).",
          },
          maxFrames: {
            type: "number",
            description: `Frame budget for this run (default 100; one PAL frame is 20ms). Max ${MAX_WARMUP_FRAMES}.`,
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const extra = await session.setBreakpoints(stringArray(args, "breakpoints"));
        const budget = boundedNumber(args, "maxFrames", 100, MAX_WARMUP_FRAMES);
        const stop = await session.continueUntilStop(budget);
        return (extra.length ? `Added breakpoints: ${extra.join("; ")}\n` : "") +
          formatStop(stop, budget, session.hasStopConditions, session.listExceptionStops().length > 0) + serialNote(session);
      },
    },
    {
      name: "emulator_step",
      description:
        "Single-step a session by `count` CPU instructions and report where it lands. Use it to " +
        "walk through the few instructions around a breakpoint; use emulator_continue to cover " +
        "any real distance, since stepping executes one instruction per call into the emulator.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          count: { type: "number", description: `Instructions to step (default 1). Max ${MAX_STEP_INSTRUCTIONS}.` },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const count = boundedNumber(args, "count", 1, MAX_STEP_INSTRUCTIONS);
        const stop = await session.step(count);
        return `Stepped ${count} instruction(s). Now at ${stop.location}.` + serialNote(session);
      },
    },
    {
      name: "emulator_inspect",
      description:
        "Read the state of a paused session: all CPU registers, the call stack (symbolicated), " +
        "the current source location, and optionally hex dumps of memory. Memory addresses take " +
        "the same forms as breakpoints — an address, or a symbol name to dump that variable or " +
        "buffer without looking its address up first. Set `chipset` for the custom chips " +
        "decoded (beam position, DMACON, INTENA/INTREQ, BPLCONx, bitplane/sprite/copper/blitter " +
        "pointers, colours) and `copper` for the active copper list disassembled — on an Amiga " +
        "that is usually where a display bug actually is.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          memory: {
            type: "array",
            description: 'Memory to dump, e.g. [{ "address": "sprite_data", "bytes": 64 }].',
            items: {
              type: "object",
              properties: {
                address: { type: "string", description: "Address (0x2140) or symbol name." },
                bytes: {
                  type: "number",
                  description: `How many bytes to read (default 64; max ${MAX_MEMORY_BYTES} as hex, ${MAX_MEMORY_FILE_BYTES} as a hash or file).`,
                },
                as: {
                  type: "string",
                  enum: ["hex", "sha256", "file"],
                  description:
                    '"hex" (default): a hex dump in the reply. "sha256": just a hash of the bytes — to check two ' +
                    'builds or two runs left a buffer identical, in one call each. "file": the raw bytes written ' +
                    "to a file (with their hash), to compare or examine outside the reply.",
                },
                out: { type: "string", description: 'Where to write the bytes, with "as": "file". Defaults to a temp file.' },
              },
              required: ["address"],
              additionalProperties: false,
            },
          },
          chipset: {
            type: "boolean",
            description: "Include the custom-chip registers, grouped and decoded, with chip pointers symbolicated.",
          },
          copper: {
            type: "boolean",
            description:
              "Include the copper list starting at COP1LC (where the copper restarts each frame), decoded one " +
              "instruction a line. Follows COPJMP1/2 and stops at the end marker or a loop; WAITs past line 255 " +
              "are annotated with the real line.",
          },
          copperAt: {
            type: "string",
            description: "Decode a copper list from this address or symbol instead of COP1LC — e.g. one the program has built but not installed yet. Implies `copper`.",
          },
          copperMax: {
            type: "number",
            description: `Most copper instructions to list (default ${DEFAULT_COPPER_INSTRUCTIONS}, max ${MAX_COPPER_INSTRUCTIONS}).`,
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const reads = memoryReads(args);
        const copperAt = optionalString(args, "copperAt");
        const wantCopper = args.copper === true || copperAt !== undefined;
        const copperMax = boundedNumber(args, "copperMax", DEFAULT_COPPER_INSTRUCTIONS, MAX_COPPER_INSTRUCTIONS);
        const sections = [formatInspect(await session.inspect(reads), reads, `session-${requireString(args, "session")}`)];
        if (args.chipset === true) {
          sections.push("Custom chips:\n" + (await session.chipset()));
        }
        if (wantCopper) {
          const { start, listing } = await session.copperList(copperAt, copperMax);
          sections.push(`Copper list from ${copperAt ?? "COP1LC"} (${formatAddress(start)}), as the copper would run it:\n${listing}`);
        }
        return sections.join("\n\n");
      },
    },
    {
      name: "emulator_reverse",
      description:
        "Go back in time in a session. `step` goes back `count` instructions — e.g. from a crash or " +
        "a watch hit to the instructions that led to it; `continue` goes back to the most recent " +
        "time a breakpoint was hit (breakpoints only, not watches or exceptions); `frame` goes back to " +
        "the start of the current frame. Lands exactly, by restoring a checkpoint and replaying " +
        "forward, so registers, memory and the screen are as they were. History reaches back to the " +
        "oldest checkpoint — taken at each continue/step and every emulated second of running, up " +
        "to 40 — and starts afresh after a snapshot restore.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          mode: { type: "string", enum: ["step", "continue", "frame"], description: 'What to go back by (default "step").' },
          count: {
            type: "number",
            description: `How many: instructions for step (default 1, max ${MAX_REVERSE_INSTRUCTIONS}), breakpoint hits or frames otherwise (default 1, max ${MAX_REVERSE_REPEATS}).`,
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const mode = args.mode === undefined ? "step" : args.mode;
        if (mode !== "step" && mode !== "continue" && mode !== "frame") throw new Error(`"mode" must be "step", "continue" or "frame"`);
        const count = boundedNumber(args, "count", 1, mode === "step" ? MAX_REVERSE_INSTRUCTIONS : MAX_REVERSE_REPEATS);
        const { done, reachedStart, state } = await session.reverse(mode, count);
        const what = mode === "step" ? "instruction" : mode === "continue" ? "breakpoint hit" : "frame";
        const lines: string[] = [];
        if (reachedStart && mode === "step") {
          lines.push(`Can't go back ${count} instruction(s): that's further than the rewind history reaches. Nothing moved.`);
        } else if (reachedStart && mode === "continue") {
          lines.push(done
            ? `Went back ${done} breakpoint hit(s); no earlier hit in the rewind history, so it stopped at the oldest checkpoint.`
            : "No breakpoint hit in the rewind history — back at the oldest checkpoint instead.");
        } else if (reachedStart) {
          lines.push(done ? `Went back ${done} of ${count} frame(s); the rewind history ends there.` : "No earlier frame start in the rewind history. Nothing moved.");
        } else {
          lines.push(`Went back ${done} ${what}${done === 1 ? "" : "s"}.`);
        }
        lines.push(`Now at ${state.location}, frame ${session.frame} of the session.`);
        return lines.join("\n");
      },
    },
    {
      name: "emulator_input",
      description:
        "Send mouse, keyboard and joystick input to a session, as a sequence of actions played in order: " +
        'click/press/release a mouse button ("left", "right", "middle"), move the mouse by [dx, dy] ' +
        "counts, tap/hold/release a key, tap/hold/release a joystick direction or button on the " +
        "joystick port (up, down, left, right, fire, fire2), and wait a number of frames. The program sees it exactly " +
        "as real input — e.g. the left click that exits most demos, to check it shuts down cleanly. " +
        "Every action runs real frames (input is only read once per frame), so breakpoints, watches " +
        "and exception stops still fire; if one does, the rest of the actions are skipped and anything " +
        "still held is reported. Keys are named like the browser's KeyboardEvent.code: Space, Enter, " +
        "Escape, F1, ArrowLeft, ShiftLeft, KeyA — or just a letter or digit. The " +
        "program is injected into RAM, not loaded by AmigaDOS, so it can't rely on the OS beyond " +
        "ROM calls that work in isolation: keys reach code that reads the keyboard itself (the " +
        "CIA-A serial port, handshaking each byte, as demos and games do), not the OS's input handling.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          actions: {
            type: "array",
            description:
              'Played in order, e.g. [{ "move": [40, 0] }, { "click": "left" }, { "wait": 50 }] or ' +
              '[{ "keyDown": "ShiftLeft" }, { "key": "a" }, { "keyUp": "ShiftLeft" }]. A click or key tap ' +
              `holds for 2 frames and releases for 2. Max ${MAX_INPUT_ACTIONS} actions.`,
            items: {
              type: "object",
              properties: {
                click: { type: "string", enum: ["left", "right", "middle"] },
                press: { type: "string", enum: ["left", "right", "middle"] },
                release: { type: "string", enum: ["left", "right", "middle"] },
                move: { type: "array", items: { type: "integer" }, description: "[dx, dy] in mouse counts; long moves are spread across frames." },
                key: { type: "string", description: "Tap a key." },
                keyDown: { type: "string", description: "Hold a key (e.g. a modifier) until keyUp." },
                keyUp: { type: "string" },
                joyTap: { type: "string", enum: Object.keys(JOYSTICK_BITS), description: "Tap a joystick direction or button (joystick port)." },
                joyPress: { type: "string", enum: Object.keys(JOYSTICK_BITS), description: "Hold a joystick direction or button until joyRelease." },
                joyRelease: { type: "string", enum: Object.keys(JOYSTICK_BITS) },
                wait: { type: "integer", description: "Run this many frames with input as it is." },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["session", "actions"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const actions = inputActions(args);
        const result = await session.input(actions);
        const lines = [`Played ${result.played.length} of ${actions.length} action(s): ${result.played.join(", ")}.`];
        if (result.stop) {
          lines.push(formatStop(result.stop, 0, true, true)); // only reached when something stopped it
          if (actions.length > result.played.length) lines.push(`Not played: ${actions.slice(result.played.length).map((a) => a.label).join(", ")}.`);
        } else {
          const where = await session.inspect([]);
          lines.push(`Now at ${where.location}, frame ${session.frame} of the session.`);
        }
        if (result.held.length) lines.push(`Still held down: ${result.held.join(", ")} — release them, or they stay pressed.`);
        return lines.join("\n") + serialNote(session);
      },
    },
    {
      name: "emulator_watch",
      description:
        "Arm or remove watchpoints on a session: stop the next emulator_continue as soon as " +
        "something writes (or reads) an address range or a custom register. The tool for " +
        "memory corruption — 'what is overwriting this?' — and for 'who sets COP1LC/DMACON?'. A " +
        "hit reports the access (value, old value, exact address) and who made it: the CPU with " +
        "its PC, the copper with its list address, or blitter/disk DMA. Watch from the entry " +
        "point by arming right after emulator_launch. The range is watched exactly, not rounded " +
        "up. `equals` or `changes` makes a watch conditional — stop when the value becomes X, or only " +
        "when it really changes — judged on the value after the write, whatever size the write was. " +
        "Always replies with the watches now armed; call with neither add nor remove to list them.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          add: {
            type: "array",
            description: 'Watches to arm, e.g. [{ "address": "player_x", "length": 2 }, { "address": "COP1LC" }, { "address": "0x40000", "length": 1024, "on": "access" }].',
            items: {
              type: "object",
              properties: {
                address: {
                  type: "string",
                  description: "Address, symbol, file:line, or a custom register by name (COLOR00, DMACON, COP1LC — pointer pairs without the H/L).",
                },
                length: {
                  type: "number",
                  description: `Bytes to watch from there (default 1, or the register's size). Max ${MAX_WATCH_BYTES}.`,
                },
                on: {
                  type: "string",
                  enum: ["write", "read", "access"],
                  description: 'Which accesses stop (default "write").',
                },
                equals: {
                  type: ["integer", "string"],
                  description:
                    "Stop only when a write leaves the watched value equal to this (a 1, 2 or 4 byte watch). " +
                    'Judged on the whole value after the write, so a byte write into a word counts. E.g. 0, -1, "0x8000".',
                },
                changes: {
                  type: "boolean",
                  description: "Stop only when a write actually changes the watched value — skipping writes of the value it already holds.",
                },
              },
              required: ["address"],
              additionalProperties: false,
            },
          },
          remove: {
            type: "array",
            items: { type: "number" },
            description: "Ids of watches to remove (from an earlier reply).",
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const adds = watchAdds(args);
        const removes = args.remove === undefined ? [] : args.remove;
        if (!Array.isArray(removes) || removes.some((id) => typeof id !== "number")) {
          throw new Error(`"remove" must be an array of watch ids`);
        }
        const lines: string[] = [];
        for (const id of removes as number[]) {
          const removed = await session.removeWatch(id);
          lines.push(`Removed #${removed.id} (${removed.description}).`);
        }
        for (const add of adds) {
          const entry = await session.addWatch(add.address, add.length, add.on, add.condition);
          const slots = entry.blocks.length > 1 ? ` [${entry.blocks.length} slots]` : "";
          lines.push(`Armed #${entry.id}: ${entry.description}${slots}.`);
        }
        const armed = session.listWatches();
        lines.push(armed.length
          ? "Watches armed:\n" + armed.map((w) => `  #${w.id} ${w.description}`).join("\n")
          : "No watches armed.");
        if (adds.length) lines.push(`Run emulator_continue { "session": "${requireString(args, "session")}" } to stop on the first hit.`);
        return lines.join("\n");
      },
    },
    {
      name: "emulator_write",
      description:
        "Change a paused session's state — memory, custom-chip registers, CPU registers — then " +
        "carry on with emulator_continue/step/screenshot. The quickest way to test an idea " +
        "without a rebuild: set a variable, force a register, patch an instruction, turn a DMA " +
        "channel off. Every write is read back and reported, so a write that didn't land (ROM, " +
        "unmapped memory) says so. Values and addresses take numbers, hex (0x/$), symbols or " +
        "file:line. Memory is written first, then custom registers, then CPU registers, so a PC " +
        "change applies last. DMACON, INTENA, INTREQ and ADKCON are SET/CLR registers: bit 15 " +
        "chooses whether the other bits are set or cleared ($8100 enables bitplane DMA, $0100 " +
        "disables it).",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_PROPERTY,
          memory: {
            type: "array",
            description: 'Memory writes, e.g. [{ "address": "lives", "value": 3, "size": "w" }, { "address": "0xc02140", "bytes": "4e71 4e71" }].',
            items: {
              type: "object",
              properties: {
                address: { type: "string", description: "Address or symbol." },
                value: { type: ["number", "string"], description: "Value to write; needs `size`. Number, hex string, negative decimal string, or a symbol (writes its address — e.g. a pointer)." },
                size: { type: "string", enum: ["b", "w", "l"], description: "Width of `value`: byte, word or long." },
                bytes: { type: "string", description: "Raw bytes as hex, instead of value/size (spaces allowed)." },
              },
              required: ["address"],
              additionalProperties: false,
            },
          },
          custom: {
            type: "object",
            description: 'Custom-chip register writes by name, e.g. { "COLOR00": "0x0f00", "DMACON": "0x0100", "COP1LC": "copperlist" }. Pointer pairs (COP1LC, BPL1PT, SPR0PT, BLTAPT, ...) are written whole.',
          },
          registers: {
            type: "object",
            description: 'CPU register writes, e.g. { "d0": 5, "a0": "buffer", "pc": "main.s:42" }. d0-d7, a0-a7 (or sp), sr, pc, usp.',
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = registry.get(requireString(args, "session"));
        const request = writeRequest(args);
        if (!request.memory.length && !request.custom.length && !request.registers.length) {
          throw new Error(`Nothing to write: pass "memory", "custom" and/or "registers".`);
        }
        const report = await session.write(request);
        return `Wrote ${report.length} value(s):\n` + report.map((line) => `  ${line}`).join("\n");
      },
    },
    {
      name: "emulator_disassemble",
      description:
        "Disassemble 68000 code from emulated memory — what is actually there at run time, so it " +
        "works for optimised or self-modifying code and for binaries with no source. Lists " +
        "`count` instructions from `address` (default: the session's PC, marked =>), optionally " +
        "`before` instructions leading up to it, or the whole routine with `function`. Branch " +
        "targets, absolute addresses, custom registers and CIAs are symbolicated, library calls " +
        "(jsr -198(a6)) are named from the library's own jump table (exec.library AllocMem), and the " +
        "source line is shown wherever the debug info has one. Works on a session or one-shot on a " +
        "`program` (paused at its entry point, so it shows the code as loaded, before it runs).",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          address: {
            type: "string",
            description: "Where to start: an address (0xc02140), a symbol (draw_sprite) or a source line (main.s:42). Default: the current PC.",
          },
          before: {
            type: "number",
            description: `Instructions to show before the address too (default 0, or 5 when listing around the PC). Max ${MAX_DISASSEMBLE_INSTRUCTIONS}.`,
          },
          count: {
            type: "number",
            description: `Instructions to list from the address (default 20). Max ${MAX_DISASSEMBLE_INSTRUCTIONS}.`,
          },
          function: {
            type: "boolean",
            description: "List the whole routine enclosing the address, from its symbol to the next, instead of before/count.",
          },
        },
        additionalProperties: false,
      },
      run: (args) => {
        const address = optionalString(args, "address");
        const before = boundedNumber(args, "before", address === undefined ? 5 : 0, MAX_DISASSEMBLE_INSTRUCTIONS, 0);
        const count = boundedNumber(args, "count", 20, MAX_DISASSEMBLE_INSTRUCTIONS);
        const wholeFunction = args.function === true;
        return withSession(ctx, registry, args, async (session) => {
          const { listing, notes } = await session.disassemble(address, {
            before,
            count,
            wholeFunction,
            maxInstructions: MAX_DISASSEMBLE_INSTRUCTIONS,
          });
          return [listing, ...notes].join("\n");
        });
      },
    },
    {
      name: "emulator_close",
      description:
        "End a session and free its emulated machine. Sessions are also closed automatically " +
        "after a period of inactivity, and only a few may be open at once, so close one as soon " +
        "as you're done with it.",
      inputSchema: {
        type: "object",
        properties: { ...SESSION_PROPERTY },
        required: ["session"],
        additionalProperties: false,
      },
      run: (args) => {
        const id = requireString(args, "session");
        registry.get(id); // Reports unknown/expired ids properly rather than silently doing nothing.
        registry.close(id, "closed by emulator_close");
        const open = registry.list();
        return `Closed session ${id}. ${open.length ? `Still open: ${open.map((s) => s.id).join(", ")}.` : "No sessions open."}`;
      },
    },
    {
      name: "emulator_screenshot",
      description:
        "Run an Amiga program in the emulator and save a PNG of the frame it reaches. Use it to " +
        "see what a program actually draws — whether an effect renders, where a glitch appears, " +
        "whether a change altered the picture — without a person watching a screen. The program " +
        "is injected into RAM and run for `frames` frames (raise that if the effect needs time to " +
        "appear); the PNG is written to disk and its path returned, so it can then be read as an " +
        "image. Set `count` for several frames on one contact sheet — every `every` frames from " +
        "there, each labelled with its frame number and marked = when identical to the emulated " +
        "frame just before it (frame N-1, even when `every` spaces the tiles out — not the previous " +
        "tile) — to see an animation, or a glitch that lasts one frame. A repeat means the picture " +
        "didn't change, which is how a dropped frame usually shows; but one whose picture changes " +
        "anyway (a buffer cleared while on screen) isn't marked. Needs a Kickstart ROM.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          frames: {
            type: "number",
            description: `Emulated frames to run before capturing the screen (default 50, one PAL frame is 20ms). Max ${MAX_WARMUP_FRAMES}.`,
          },
          out: { type: "string", description: "Where to write the PNG. Defaults to a temp file." },
          count: {
            type: "number",
            description: `Frames to put on a contact sheet (default 1: a single screenshot). Max ${MAX_SHEET_FRAMES}, which keeps the sheet small enough to read without being shrunk.`,
          },
          every: {
            type: "number",
            description: "Frames between the ones on the sheet (default 1: consecutive frames, to catch a one-frame glitch; e.g. 10 to watch a slower animation).",
          },
          framesDir: {
            type: "string",
            description:
              "With `count`, also write each frame as its own full-size PNG into this directory (frame-<n>.png), " +
              "to compare frames one by one rather than by cutting up the sheet.",
          },
          size: {
            type: "string",
            enum: ["half", "full"],
            description:
              'Contact-sheet tile size. "half" (default) keeps every pixel of a lores, non-interlaced screen ' +
              '(the framebuffer doubles lores horizontally); use "full" for hires or interlaced screens.',
          },
        },
        additionalProperties: false,
      },
      run: (args) => {
        // Bounds first, before withSession boots anything: a mistyped frame count should cost a
        // message, not a machine (and the wait that comes with one).
        // 0 frames is meaningful on a session: screenshot exactly where it is stopped now.
        const frames = boundedNumber(args, "frames", args.session ? 0 : 50, MAX_WARMUP_FRAMES, 0);
        const count = boundedNumber(args, "count", 1, MAX_SHEET_FRAMES);
        const every = boundedNumber(args, "every", 1, MAX_WARMUP_FRAMES);
        const size = args.size === undefined ? "half" : args.size;
        if (size !== "half" && size !== "full") throw new Error(`"size" must be "half" or "full"`);
        if (count > 1) {
          return withSession(ctx, registry, args, async (session) => {
            const { tiles, stoppedEarly } = await session.frameSequence(frames, count, every);
            if (tiles.length === 0) {
              return "Stopped before the first frame on the sheet — the program hit a breakpoint, a watch or an exception. Nothing written.";
            }
            // Full-size tiles are 720px: two to a row keeps the same ~1600px width limit.
            const sheet = composeSheet(tiles, { half: size === "half", columns: size === "half" ? SHEET_COLUMNS : 2 });
            const name = optionalString(args, "program") ?? `session-${optionalString(args, "session")}`;
            const path = writeOutput(optionalPath(args, "out"), name, ".png", encodePng(sheet.rgba, sheet.width, sheet.height));
            const repeats = tiles.filter((t) => t.repeated).map((t) => t.frame);
            const framesDir = optionalPath(args, "framesDir");
            if (framesDir) {
              mkdirSync(framesDir, { recursive: true });
              for (const t of tiles) writeFileSync(join(framesDir, `frame-${t.frame}.png`), encodePng(t.rgba, t.width, t.height));
            }
            // A hash per frame: the same picture gives the same hash, run to run and build to build,
            // so two runs compare frame by frame without reading a single image.
            const hashes = tiles.map((t) => `  frame ${t.frame}: ${createHash("sha256").update(t.rgba).digest("hex").slice(0, 16)}`);
            return (
              `Wrote a ${sheet.width}x${sheet.height} contact sheet of ${tiles.length} frame(s) to ${path}\n` +
              `Frames ${tiles.map((t) => t.frame).join(", ")} (frame numbers count from the launch; ${every === 1 ? "consecutive" : `every ${every}`}).\n` +
              (repeats.length
                ? `Identical to the emulated frame just before it, frame N-1 (marked =): ${repeats.join(", ")}.\n`
                : "No frame on the sheet is identical to the emulated frame just before it (frame N-1).\n") +
              (stoppedEarly ? `Stopped after ${tiles.length} of ${count}: the program hit a breakpoint, a watch or an exception.\n` : "") +
              (framesDir ? `Each frame also written to ${framesDir} as frame-<n>.png.\n` : "") +
              `Picture hashes (sha256 of the pixels, first 16 hex digits):\n${hashes.join("\n")}\n` +
              "Read that file to see the frames." + serialNote(session)
            );
          });
        }
        return withSession(ctx, registry, args, async (session) => {
          const ran = frames > 0 ? await session.run(frames) : 0;
          const shot = session.screenshot();
          const name = optionalString(args, "program") ?? `session-${optionalString(args, "session")}`;
          const path = writeOutput(optionalPath(args, "out"), name, ".png", shot.png);
          const stoppedEarly = ran < frames ? ` (stopped after ${ran} — the program hit a breakpoint or halted)` : "";
          return (
            `Wrote ${shot.width}x${shot.height} PNG to ${path} (picture hash ${createHash("sha256").update(shot.rgba).digest("hex").slice(0, 16)})\n` +
            (frames > 0 ? `Ran ${frames} frame(s)${stoppedEarly}.\n` : "Captured the session's current frame, without running it on.\n") +
            "Read that file to see the frame." + serialNote(session)
          );
        });
      },
    },
    {
      name: "emulator_capture_profile",
      description:
        "Run an Amiga program and capture a cycle-accurate CPU/DMA profile of it, saved as a " +
        ".puaeprofile file. This is how to answer 'why is this slow' or 'did that optimisation " +
        "help' from source alone: capture, then read the result with profile_dump (and " +
        "profile_check, which this already runs for you and reports below). `warmupFrames` runs " +
        "the program to the point worth measuring before recording starts — set it past any " +
        "loading or setup. Needs a Kickstart ROM.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          warmupFrames: {
            type: "number",
            description: `Frames to run before recording, to skip setup//loading (default 50). Max ${MAX_WARMUP_FRAMES}.`,
          },
          frames: {
            type: "number",
            description: `Frames to record (default 1). Max ${MAX_CAPTURE_FRAMES}. More frames make a longer timeline, not a more accurate one.`,
          },
          out: { type: "string", description: "Where to write the .puaeprofile. Defaults to a temp file." },
        },
        additionalProperties: false,
      },
      run: (args) => {
        // Both bounds checked before anything boots — see emulator_screenshot's note.
        // As with screenshot: on an existing session, default to capturing from where it
        // already stands — that is the whole point of having run it to a breakpoint first.
        const warmupFrames = boundedNumber(args, "warmupFrames", args.session ? 0 : 50, MAX_WARMUP_FRAMES, 0);
        const frames = boundedNumber(args, "frames", 1, MAX_CAPTURE_FRAMES);
        return withSession(ctx, registry, args, async (session) => {
          const ran = warmupFrames > 0 ? await session.run(warmupFrames) : 0;
          const capture = await session.captureProfile(frames);
          const name = optionalString(args, "program") ?? `session-${optionalString(args, "session")}`;
          const path = writeOutput(optionalPath(args, "out"), name, ".puaeprofile", capture.bytes);
          // Verified here rather than left for the caller: a capture whose frames don't add up is
          // not worth reasoning about, and the alternative — the model reading the numbers first
          // and validating afterwards, if at all — is exactly the failure this check exists for.
          const check = renderCheck(analyseProfile(new Uint8Array(capture.bytes)));
          const stoppedEarly = ran < warmupFrames ? ` (stopped after ${ran} — the program hit a breakpoint or halted)` : "";
          return (
            `Captured ${capture.frames} frame(s) to ${path}\n` +
            (warmupFrames > 0
              ? `Warmed up ${warmupFrames} frame(s)${stoppedEarly} from entry point ${formatAddress(session.entryPoint)}.\n`
              : "Captured from where the session was already stopped.\n") +
            "Thumbnails are omitted (headless capture); everything the analysis uses is present.\n\n" +
            `profile_check says:\n${check}\n\n` +
            `Now call profile_dump with file "${path}" to read the per-function costs.` + serialNote(session)
          );
        });
      },
    },
  ];
}
