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

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { analyseProfile } from "../profileAnalysis";
import { renderCheck } from "../profileReport";
import { MAX_CAPTURE_FRAMES } from "../shared/profilerTypes";
import { formatAddress } from "./breakpointSpec";
import { HeadlessSession, InspectResult, LaunchOptions, StopState, WriteRequest } from "./emulatorSession";
import { ToolDefinition } from "./jsonRpc";
import { expandHome } from "./paths";
import { SessionRegistry } from "./sessionRegistry";

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
// A full-screen gradient or per-line palette list runs to a few hundred instructions; the default
// covers that, and the cap keeps a list with no end marker from flooding the reply.
const DEFAULT_COPPER_INSTRUCTIONS = 512;
const MAX_COPPER_INSTRUCTIONS = 4096;
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

function memoryReads(args: Record<string, unknown>): { address: string; bytes: number }[] {
  const v = args.memory;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`"memory" must be an array`);
  return v.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`each "memory" entry must be an object`);
    const read = entry as Record<string, unknown>;
    const bytes = boundedNumber(read, "bytes", 64, MAX_MEMORY_BYTES);
    return { address: requireString(read, "address"), bytes };
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

function formatStop(stop: StopState, budget: number): string {
  if (!stop.stopped) {
    return `Still running after ${stop.framesRun} frame(s) — nothing stopped it. Now at ${stop.location}.\n` +
      `Raise maxFrames (currently ${budget}) or check the breakpoint is somewhere this program actually reaches.`;
  }
  return `Stopped: ${stop.reason} after ${stop.framesRun} frame(s), at ${stop.location}.`;
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

function formatInspect(result: InspectResult): string {
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
  for (const read of result.memory) {
    sections.push("", `Memory at ${read.requested} (${formatAddress(read.address)}), ${read.data.length} bytes:`,
      hexDump(read.address, read.data));
  }
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
        "or a source line (main.s:42). Call emulator_close when finished. Needs a Kickstart ROM.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          breakpoints: {
            type: "array",
            items: { type: "string" },
            description: 'Breakpoints to arm before the program runs, e.g. ["draw_sprite", "main.s:42", "0x2140"].',
          },
        },
        required: ["program"],
        additionalProperties: false,
      },
      run: async (args) => {
        const session = await HeadlessSession.launch(launchOptions(ctx, args));
        let armed: string[] = [];
        try {
          armed = await session.setBreakpoints(stringArray(args, "breakpoints"));
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
          `Continue with emulator_continue { "session": "${id}" }; close it with emulator_close when done.`
        );
      },
    },
    {
      name: "emulator_continue",
      description:
        "Resume a session and run until a breakpoint fires, or until `maxFrames` " +
        "emulated frames have passed — whichever comes first, so this can't hang on a program " +
        "that never reaches the breakpoint. Reports where it stopped and why. Follow with " +
        "emulator_inspect to read registers, the call stack and memory at that point.",
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
        return (extra.length ? `Added breakpoints: ${extra.join("; ")}\n` : "") + formatStop(stop, budget);
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
        return `Stepped ${count} instruction(s). Now at ${stop.location}.`;
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
                bytes: { type: "number", description: `How many bytes to read (default 64, max ${MAX_MEMORY_BYTES}).` },
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
        const sections = [formatInspect(await session.inspect(reads))];
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
        "targets, absolute addresses, custom registers and CIAs are symbolicated, and the source " +
        "line is shown wherever the debug info has one. Works on a session or one-shot on a " +
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
        "image. Needs a Kickstart ROM.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          frames: {
            type: "number",
            description: `Emulated frames to run before capturing the screen (default 50, one PAL frame is 20ms). Max ${MAX_WARMUP_FRAMES}.`,
          },
          out: { type: "string", description: "Where to write the PNG. Defaults to a temp file." },
        },
        additionalProperties: false,
      },
      run: (args) => {
        // Bounds first, before withSession boots anything: a mistyped frame count should cost a
        // message, not a machine (and the wait that comes with one).
        // 0 frames is meaningful on a session: screenshot exactly where it is stopped now.
        const frames = boundedNumber(args, "frames", args.session ? 0 : 50, MAX_WARMUP_FRAMES, 0);
        return withSession(ctx, registry, args, async (session) => {
          const ran = frames > 0 ? await session.run(frames) : 0;
          const shot = session.screenshot();
          const name = optionalString(args, "program") ?? `session-${optionalString(args, "session")}`;
          const path = writeOutput(optionalPath(args, "out"), name, ".png", shot.png);
          const stoppedEarly = ran < frames ? ` (stopped after ${ran} — the program hit a breakpoint or halted)` : "";
          return (
            `Wrote ${shot.width}x${shot.height} PNG to ${path}\n` +
            (frames > 0 ? `Ran ${frames} frame(s)${stoppedEarly}.\n` : "Captured the session's current frame, without running it on.\n") +
            "Read that file to see the frame."
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
            `Now call profile_dump with file "${path}" to read the per-function costs.`
          );
        });
      },
    },
  ];
}
