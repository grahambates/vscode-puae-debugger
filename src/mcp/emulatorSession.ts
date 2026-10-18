// A complete headless debug session: boot a machine, inject a program the way `fastLoad` does,
// run it, and take a profile capture or a screenshot of the result — with no editor, no browser
// and no person in the loop.
//
// This is the same sequence `DebugAdapter.launchRequest`/`injectProgram` performs, minus DAP:
// read the debug symbols, boot to exec-ready, load the hunks into Amiga RAM, build the SourceMap
// from whichever debug format the file actually contains, and hand that SourceMap to
// `ProfilerManager`. It deliberately reuses those same modules rather than reimplementing any of
// it, so a capture taken here symbolicates identically to one taken from the debugger.

import { readFile } from "fs/promises";
import { parseHunks } from "../amigaHunkParser";
import { loadAmigaProgram } from "../amigaHunkLoader";
import { detectContainer, hasDwarfSections, hasElfStabsSections } from "../debugSymbolFormat";
import { parseDwarf } from "../dwarfParser";
import { sourceMapFromDwarf } from "../dwarfSourceMap";
import { extractElfStabs, sourceMapFromElfStabs } from "../elfStabsSourceMap";
import { sourceMapFromHunks } from "../amigaHunkSourceMap";
import { kickstartSymbolModule } from "../kickstart";
import { encodeCapture } from "../profileFormat";
import { ProfilerManager } from "../profilerManager";
import { SourceMap } from "../sourceMap";
import { describe as describeAddress, formatAddress as formatAddr, resolveBreakpointSpec } from "./breakpointSpec";
import { DecodedLine, decodeRange, formatListing } from "./disassembly";
import { alignedBlocks, Block, customRegisterRange, describeHit, WATCHPOINT_SLOTS, WatchKind } from "./watchpoints";
import { formatChipset, walkCopperList } from "./chipset";
import { copperMoveBefore, isCustomRegisterAddress } from "../hardware";
import { CUSTOM_REGISTER_OFFSETS, customRegisterName } from "../webview/shared/customRegisters";
import { HeadlessEmulator } from "./headlessEmulator";
import { encodePng } from "./png";
import { SheetTile } from "./contactSheet";
import * as path from "path";

export interface LaunchOptions {
  /** Package root — the directory holding `puae/` and `out/`. */
  rootDir: string;
  /** Amiga hunk executable to inject. Always the hunk file, even when symbols live in an ELF. */
  program: string;
  /** File to read debug symbols from, when that isn't `program` itself (e.g. an ELF build). */
  debugProgram?: string;
  /** Kickstart ROM to boot. */
  kickstartRom: string;
  /** Extra `.uae` config lines (cpu_model, chipset, chipmem_size, ...). */
  extraConfig?: string;
}

/**
 * Exceptions that stop a session, by name — the 68k vectors that mean "this program crashed".
 * The defaults match the debugger's own exception filters (`exceptionBreakpointFilters`).
 * Privilege violation is off by default there and here: exec's Supervisor() raises it on purpose.
 */
export const EXCEPTIONS: Record<string, { vector: number; label: string; default: boolean }> = {
  bus_error: { vector: 2, label: "Bus error", default: true },
  address_error: { vector: 3, label: "Address error", default: true },
  illegal_instruction: { vector: 4, label: "Illegal instruction", default: true },
  zero_divide: { vector: 5, label: "Zero divide", default: true },
  chk: { vector: 6, label: "CHK out of bounds", default: false },
  trapv: { vector: 7, label: "TRAPV overflow", default: false },
  privilege_violation: { vector: 8, label: "Privilege violation", default: false },
  line_a: { vector: 10, label: "Line-A emulator", default: false },
  line_f: { vector: 11, label: "Line-F emulator", default: false },
};

export const DEFAULT_EXCEPTION_STOPS = Object.values(EXCEPTIONS).filter((e) => e.default).map((e) => e.vector);

export function exceptionLabel(vector: number): string {
  return Object.values(EXCEPTIONS).find((e) => e.vector === vector)?.label ?? `Exception`;
}

export interface WriteRequest {
  /** `bytes` as given, or `value` encoded big-endian at `size` bytes. */
  memory: { address: string; value?: string | number; size?: 1 | 2 | 4; bytes?: Buffer }[];
  /** By HRM name; a pointer pair (COP1LC, BPL1PT) without its H/L suffix writes both halves. */
  custom: { name: string; value: string | number }[];
  registers: { name: string; value: string | number }[];
}

// What the RPC's setRegister accepts (REG_INDEX in src/webview/puaeApp/rpc.ts).
const WRITABLE_CPU_REGISTERS = new Set([
  "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7",
  "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
  "sr", "pc", "usp",
]);

// Bit 15 chooses whether the other bits set or clear — writing $0100 to DMACON *disables*
// bitplane DMA, which is the opposite of what writing a value usually means.
const SET_CLR_REGISTERS = new Set(["DMACON", "INTENA", "INTREQ", "ADKCON"]);

function encodeBigEndian(value: number, size: 1 | 2 | 4): Buffer {
  const out = Buffer.alloc(size);
  if (size === 1) out.writeUInt8(value & 0xff);
  else if (size === 2) out.writeUInt16BE(value & 0xffff);
  else out.writeUInt32BE(value >>> 0);
  return out;
}

function hexBytes(bytes: Buffer): string {
  return bytes.length <= 16 ? bytes.toString("hex").replace(/(..)(?!$)/g, "$1 ") : `${bytes.length} bytes`;
}

/** Where execution is, and why it stopped there. */
export interface StopState {
  /** False when the frame budget ran out with the program still running normally. */
  stopped: boolean;
  /** "BREAKPOINT_REACHED", "WATCHPOINT_REACHED", "STEP", ... — undefined if nothing stopped it. */
  reason?: string;
  framesRun: number;
  pc: number;
  /** Human-readable: address, enclosing symbol and source line, as far as the debug info goes. */
  location: string;
  /** For a watchpoint stop: what was accessed, by whom, and the value. */
  detail?: string;
}

/** One step of emulator_input, already resolved (key names to RETROK_* codes). */
export type InputAction = { label: string } & (
  | { kind: "click" | "press" | "release"; button: number }
  | { kind: "key" | "keyDown" | "keyUp"; code: number; name: string }
  | { kind: "move"; dx: number; dy: number }
  | { kind: "wait"; frames: number }
);

/** DOM MouseEvent.button numbering, which wasm_set_mouse_button takes. */
export const MOUSE_BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2 };
const MOUSE_BUTTON_NAMES = ["left", "middle", "right"];
// How long a click or a key tap is held, and then released, in frames. One frame can be missed by
// a program that polls in its vertical-blank interrupt; two is reliably seen by either.
const INPUT_HOLD_FRAMES = 2;
// Mouse counts per frame for a long move: comfortably inside the 8-bit counters' ±127.
const MOUSE_STEP = 32;

export interface SnapshotInfo {
  name: string;
  /** Frames run since launch when it was taken. */
  frame: number;
  location: string;
  bytes: number;
}

// Each is a full machine state — ~1.6MB on a default A500, up to ~10MB with fast RAM — on top of
// the dispatcher's own rewind history, so a handful is plenty for comparing experiments.
const MAX_SNAPSHOTS = 16;

export interface WatchEntry {
  id: number;
  description: string;
  start: number;
  length: number;
  blocks: Block[];
}

export interface InspectResult {
  cpu: Awaited<ReturnType<HeadlessEmulator["getCpuInfo"]>>;
  location: string;
  callstack: string[];
  memory: { address: number; requested: string; data: Buffer }[];
}

export class HeadlessSession {
  private readonly watches = new Map<number, WatchEntry>();
  private nextWatchId = 1;
  /** Armed breakpoints, by address, with how each was asked for. */
  private readonly breakpoints = new Map<number, string>();
  private exceptionStops = new Set<number>();
  /** Mouse buttons and keys currently held down by emulator_input. */
  private readonly held = new Set<string>();
  private readonly snapshots = new Map<string, SnapshotInfo & { state: { data: Uint8Array; instrCount: string } }>();
  private framesRun = 0;

  private constructor(
    private readonly emulator: HeadlessEmulator,
    private readonly sourceMap: SourceMap,
    private readonly profiler: ProfilerManager,
    private readonly info: {
      programName: string;
      debugBytes: Buffer;
      baseDir: string;
      segmentOffsets: number[];
      entryPoint: number;
      hasSourceInfo: boolean;
      kickstart?: { sha1: string; name: string };
    },
  ) {}

  /** Boots a machine, injects `program`, and leaves it paused at the program's entry point. */
  public static async launch(options: LaunchOptions): Promise<HeadlessSession> {
    const debugProgramPath = options.debugProgram ?? options.program;
    const debugBytes = await readFile(debugProgramPath);
    const container = detectContainer(debugBytes);

    // Program loading always needs the (always hunk-format) bootable executable, even when the
    // symbols come from an ELF built alongside it — same split as a fastLoad launch config's
    // `program`/`debugProgram`.
    const hunkBytes = debugProgramPath === options.program ? debugBytes : await readFile(options.program);
    const hunks = parseHunks(container === "elf" ? hunkBytes : debugBytes);

    const romBytes = await readFile(options.kickstartRom);
    const kickstartSymbols = kickstartSymbolModule(romBytes);

    const emulator = await HeadlessEmulator.boot({
      rootDir: options.rootDir,
      kickstartRomPath: options.kickstartRom,
      extraConfig: options.extraConfig,
    });

    let loaded;
    try {
      loaded = await loadAmigaProgram(emulator, hunks);
    } catch (error) {
      emulator.dispose();
      throw error;
    }
    const segmentOffsets = loaded.allocations.map((a) => a.address);

    // Same format detection as DebugAdapter.attach(): the container and, within ELF, the debug
    // format are decided by the file's bytes, never its extension. Unlike the debugger, debug
    // info is optional here — a screenshot or a capture of a stripped binary needs none — so
    // anything without it falls back to the hunk file's own symbols, if any, and bare addresses.
    const baseDir = path.dirname(path.dirname(options.program));
    let sourceMap: SourceMap | undefined;
    if (container === "elf") {
      const dwarf = parseDwarf(debugBytes);
      if (hasDwarfSections(dwarf)) {
        sourceMap = sourceMapFromDwarf(dwarf, segmentOffsets, baseDir);
      } else if (hasElfStabsSections(dwarf)) {
        sourceMap = sourceMapFromElfStabs(dwarf, extractElfStabs(debugBytes, dwarf), segmentOffsets);
      }
    }
    sourceMap ??= sourceMapFromHunks(hunks, segmentOffsets, { requireDebugInfo: false });
    const hasSourceInfo = sourceMap.getSourceFiles().length > 0;
    // Lets ROM/OS leaves in a capture resolve to "[Kick] <name>" instead of a bare address.
    if (kickstartSymbols) {
      sourceMap.addSymbolModule(kickstartSymbols.segment, kickstartSymbols.symbols);
    }
    emulator.setSourceMap(sourceMap);

    const profiler = new ProfilerManager(
      () => emulator,
      () => sourceMap,
    );

    return new HeadlessSession(emulator, sourceMap, profiler, {
      programName: path.basename(options.program),
      debugBytes,
      baseDir,
      segmentOffsets,
      entryPoint: loaded.entryPoint,
      hasSourceInfo,
      kickstart: kickstartSymbols ? { sha1: kickstartSymbols.sha1, name: kickstartSymbols.name } : undefined,
    });
  }

  public get entryPoint(): number {
    return this.info.entryPoint;
  }

  /** False for a stripped binary: source-line breakpoints won't resolve, only addresses/symbols. */
  public get hasSourceInfo(): boolean {
    return this.info.hasSourceInfo;
  }

  public get segmentOffsets(): number[] {
    return this.info.segmentOffsets;
  }

  /**
   * Resumes and runs `frames` emulated frames (stopping early on a breakpoint/watchpoint), then
   * leaves the machine paused again. Pausing afterwards is what makes a screenshot or capture
   * that follows describe the frame this call ended on, rather than one somewhere after it.
   */
  public async run(frames: number): Promise<number> {
    await this.emulator.run();
    const ran = this.emulator.runFrames(frames);
    this.framesRun += ran;
    if (this.emulator.isPaused()) {
      // Stopped early on a breakpoint/watch. The caller reports that as a short run; consume the
      // stop so a later emulator_continue doesn't attribute it to its own run.
      this.emulator.consumeStopMessage();
    } else {
      await this.emulator.pause(true);
    }
    return ran;
  }

  // --- Interactive debugging ---

  /** Resolves each spec (address, symbol or file:line) and arms a breakpoint there. */
  public async setBreakpoints(specs: string[]): Promise<string[]> {
    const descriptions: string[] = [];
    for (const spec of specs) {
      const resolved = resolveBreakpointSpec(spec, this.sourceMap);
      if (!this.breakpoints.has(resolved.address)) {
        await this.emulator.setBreakpoint(resolved.address);
        this.breakpoints.set(resolved.address, resolved.description);
      }
      descriptions.push(resolved.description);
    }
    return descriptions;
  }

  /**
   * Removes breakpoints by the same specs they were set with (or any spec resolving to the same
   * address), or every one for "all". Returns what was removed.
   */
  public async removeBreakpoints(specs: string[]): Promise<string[]> {
    const addresses = specs.includes("all")
      ? [...this.breakpoints.keys()]
      : specs.map((spec) => {
          const address = resolveBreakpointSpec(spec, this.sourceMap).address;
          if (!this.breakpoints.has(address)) {
            throw new Error(`No breakpoint at ${spec} (${formatAddr(address)}). Set: ${this.listBreakpoints().join("; ") || "none"}`);
          }
          return address;
        });
    const removed: string[] = [];
    for (const address of addresses) {
      await this.emulator.removeBreakpoint(address);
      removed.push(this.breakpoints.get(address)!);
      this.breakpoints.delete(address);
    }
    return removed;
  }

  public listBreakpoints(): string[] {
    return [...this.breakpoints.values()];
  }

  /** Replaces the set of exception vectors that stop execution. */
  public async setExceptionStops(vectors: number[]): Promise<void> {
    for (const vector of this.exceptionStops) {
      if (!vectors.includes(vector)) await this.emulator.removeCatchpoint(vector);
    }
    for (const vector of vectors) {
      if (!this.exceptionStops.has(vector)) await this.emulator.setCatchpoint(vector);
    }
    this.exceptionStops = new Set(vectors);
  }

  public listExceptionStops(): number[] {
    return [...this.exceptionStops].sort((a, b) => a - b);
  }

  /** Whether anything the caller armed — not just the crash catchers — could stop a run. */
  public get hasStopConditions(): boolean {
    return this.breakpoints.size > 0 || this.watches.size > 0;
  }

  /**
   * Runs until a breakpoint (or watchpoint/catchpoint) fires or `maxFrames` frames elapse,
   * whichever comes first — the frame budget is what stops "continue" from hanging forever on a
   * program that never reaches the breakpoint it was given.
   */
  public async continueUntilStop(maxFrames: number): Promise<StopState> {
    await this.emulator.run();
    const ran = this.emulator.runFrames(maxFrames);
    this.framesRun += ran;
    const hitBreakpoint = this.emulator.isPaused();
    if (!hitBreakpoint) await this.emulator.pause(true);
    // Consumed once per stop (see consumeStopMessage), so read it here and carry it in the
    // returned state rather than asking again later.
    const stop = hitBreakpoint ? this.emulator.consumeStopMessage() : undefined;
    const state = await this.describeStop(ran, hitBreakpoint ? stop?.name ?? "BREAKPOINT_REACHED" : undefined);
    if (stop?.name === "CATCHPOINT_REACHED") {
      const p = stop.payload as Record<string, number | undefined>;
      const vector = p.vector ?? 0;
      const pc = p.pc ?? 0;
      // Bus and address errors are group-0 exceptions: the PC a 68000 records for them has run
      // ahead of the faulting instruction (prefetch), typically by 2-10 bytes. Saying "raised by
      // the instruction at" would point at an innocent one.
      const where = vector === 2 || vector === 3
        ? `reported at ${describeAddress(pc, this.sourceMap)} — on a 68000 that PC runs ahead of the ` +
          "faulting instruction (prefetch), so the culprit is usually one or two instructions before it"
        : `raised by the instruction at ${describeAddress(pc, this.sourceMap)}`;
      state.detail = `${exceptionLabel(vector)} (vector ${vector}) ${where}. ` +
        "The CPU has already entered the exception handler, which is why it's stopped there. " +
        `emulator_disassemble { "address": "${formatAddr(pc)}", "before": 8 } shows the code leading up to it.`;
    } else if (stop?.name === "WATCHPOINT_REACHED") {
      const p = stop.payload as Record<string, number | undefined>;
      const watchAddress = p.pc ?? 0;
      const watch = this.listWatches().find((w) => w.blocks.some((b) => b.address === watchAddress));
      state.detail = `${watch ? `watch #${watch.id} (${watch.description}): ` : ""}` +
        describeHit({ ...p, watchAddress, copperInstruction: await copperMoveBefore(p.copperPc, p.addr, (a, n) => this.emulator.readMemory(a, n)) }, this.sourceMap);
    }
    return state;
  }

  /**
   * `count` frames for a contact sheet: the first after `warmup` frames, then one every `every`
   * frames. Each is checked against the frame immediately before it (not the previous sample), so
   * "repeated" means the picture really didn't change from one frame to the next. Stops early,
   * with what it has, if a breakpoint, watch or exception halts the run.
   */
  public async frameSequence(warmup: number, count: number, every: number): Promise<{ tiles: SheetTile[]; stoppedEarly: boolean }> {
    const tiles: SheetTile[] = [];
    let previous: Uint8Array | undefined;
    const grab = () => this.emulator.readFramebuffer();
    const advance = async (frames: number): Promise<boolean> => {
      if (frames === 0) return true;
      if (frames > 1) {
        if ((await this.run(frames - 1)) < frames - 1) return false;
        previous = grab().rgba;
      }
      return (await this.run(1)) === 1;
    };
    for (let i = 0; i < count; i++) {
      if (!(await advance(i === 0 ? warmup : every))) return { tiles, stoppedEarly: true };
      const fb = grab();
      const repeated = previous !== undefined && Buffer.compare(previous, fb.rgba) === 0;
      tiles.push({ rgba: fb.rgba, width: fb.width, height: fb.height, frame: this.framesRun, repeated });
      previous = fb.rgba;
    }
    return { tiles, stoppedEarly: false };
  }

  // --- Input ---

  /**
   * Plays `actions` in order, running real frames as it goes — the core only polls input once per
   * frame, so a press, a hold and a release each need frames of their own. Stops at once if a
   * breakpoint, watch or exception fires mid-way (the rest of the actions are not played), and
   * reports anything still held down then: a button left pressed stays pressed.
   */
  public async input(actions: InputAction[]): Promise<{ played: string[]; stop?: StopState; held: string[] }> {
    const played: string[] = [];
    const run = async (frames: number): Promise<StopState | undefined> => {
      const state = await this.continueUntilStop(frames);
      return state.stopped ? state : undefined;
    };
    const finish = (stop?: StopState) => ({ played, stop, held: [...this.held].sort() });

    for (const action of actions) {
      let stop: StopState | undefined;
      switch (action.kind) {
        case "click":
        case "key": {
          this.setInput(action, true);
          stop = await run(INPUT_HOLD_FRAMES);
          if (!stop) {
            this.setInput(action, false);
            stop = await run(INPUT_HOLD_FRAMES);
          }
          break;
        }
        case "press":
        case "keyDown":
          this.setInput(action, true);
          stop = await run(1);
          break;
        case "release":
        case "keyUp":
          this.setInput(action, false);
          stop = await run(1);
          break;
        case "move": {
          // The Amiga's mouse counters are 8-bit: much more than ±127 in one frame reads as
          // movement the other way. Spread a long move over frames instead.
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(action.dx), Math.abs(action.dy)) / MOUSE_STEP));
          let sentX = 0;
          let sentY = 0;
          for (let i = 1; i <= steps && !stop; i++) {
            const x = Math.round((action.dx * i) / steps);
            const y = Math.round((action.dy * i) / steps);
            this.emulator.mouseMove(x - sentX, y - sentY);
            sentX = x;
            sentY = y;
            stop = await run(1);
          }
          break;
        }
        case "wait":
          stop = await run(action.frames);
          break;
      }
      played.push(action.label);
      if (stop) return finish(stop);
    }
    return finish();
  }

  private setInput(action: InputAction, down: boolean): void {
    if (action.kind === "click" || action.kind === "press" || action.kind === "release") {
      this.emulator.mouseButton(action.button, down);
      const name = `mouse ${MOUSE_BUTTON_NAMES[action.button]}`;
      if (down) this.held.add(name); else this.held.delete(name);
    } else if (action.kind === "key" || action.kind === "keyDown" || action.kind === "keyUp") {
      this.emulator.key(action.code, down);
      if (down) this.held.add(action.name); else this.held.delete(action.name);
    }
  }

  // --- Snapshots ---

  /**
   * Saves the whole machine under `name` (replacing one of the same name), so an experiment —
   * a patched variable, a forced register, a different input — can be rewound and tried again
   * from exactly the same point instead of relaunching and re-running to it.
   */
  public async saveSnapshot(name: string): Promise<SnapshotInfo> {
    if (!this.snapshots.has(name) && this.snapshots.size >= MAX_SNAPSHOTS) {
      throw new Error(`Already holding ${MAX_SNAPSHOTS} snapshots (${[...this.snapshots.keys()].join(", ")}); delete one first.`);
    }
    const state = await this.emulator.saveState();
    const pc = parseInt((await this.emulator.getCpuInfo()).pc, 16);
    const info: SnapshotInfo = {
      name,
      frame: this.framesRun,
      location: describeAddress(pc, this.sourceMap),
      bytes: state.data.length,
    };
    this.snapshots.set(name, { ...info, state });
    return info;
  }

  /**
   * Puts the machine back exactly as it was at `name`. Breakpoints, watches and exception stops
   * are debugger state, not machine state, so they stay as they are now.
   */
  public async restoreSnapshot(name: string): Promise<SnapshotInfo> {
    const snapshot = this.snapshots.get(name);
    if (!snapshot) {
      throw new Error(`No snapshot "${name}". Saved: ${[...this.snapshots.keys()].join(", ") || "none"}`);
    }
    await this.emulator.loadState(snapshot.state);
    // A stop pending from before the restore belongs to the abandoned timeline.
    this.emulator.consumeStopMessage();
    this.framesRun = snapshot.frame;
    const { state: _state, ...info } = snapshot;
    return info;
  }

  public deleteSnapshot(name: string): void {
    if (!this.snapshots.delete(name)) throw new Error(`No snapshot "${name}"`);
  }

  public listSnapshots(): SnapshotInfo[] {
    return [...this.snapshots.values()].map(({ state: _state, ...info }) => info);
  }

  /** Frames run since launch, as of the current state — restoring a snapshot winds it back too. */
  public get frame(): number {
    return this.framesRun;
  }

  // --- Watchpoints ---

  /**
   * Arms a watch on `spec` — an address/symbol/file:line (`length` bytes, default the natural
   * size: 2 for a custom register, else 1) or a custom register by name (COLOR00, COP1LC).
   * Returns its description; the id is for removing it later.
   */
  public async addWatch(spec: string, length: number | undefined, kind: WatchKind): Promise<WatchEntry> {
    // A program symbol wins over a custom-register name, in the unlikely case both exist.
    const custom = this.sourceMap.getSymbols()[spec] === undefined ? customRegisterRange(spec) : undefined;
    const start = custom ? custom.address : resolveBreakpointSpec(spec, this.sourceMap).address;
    const size = length ?? custom?.size ?? 1;
    const blocks = alignedBlocks(start, size);
    const used = [...this.watches.values()].flatMap((w) => w.blocks);
    if (used.length + blocks.length > WATCHPOINT_SLOTS) {
      throw new Error(
        `Watching ${size} bytes at ${formatAddr(start)} needs ${blocks.length} watchpoint slot(s); ` +
          `${WATCHPOINT_SLOTS - used.length} of ${WATCHPOINT_SLOTS} are free. Remove a watch or narrow the range.`,
      );
    }
    // The RPC keys watchpoints by block address and silently ignores a second one at the same
    // address, so an overlap would quietly keep the first watch's read/write kind.
    const clash = blocks.find((b) => used.some((u) => u.address === b.address));
    if (clash) {
      const owner = [...this.watches.values()].find((w) => w.blocks.some((b) => b.address === clash.address))!;
      throw new Error(`Overlaps watch #${owner.id} (${owner.description}); remove that one first.`);
    }
    for (const block of blocks) {
      await this.emulator.setWatchpoint(block.address, 0, {
        read: kind !== "write",
        write: kind !== "read",
        length: block.size,
      });
    }
    const label = custom ? spec.toUpperCase() : describeAddress(start, this.sourceMap);
    const entry: WatchEntry = {
      id: this.nextWatchId++,
      description: `${kind} ${label}${size > 1 ? `, ${size} bytes` : ""}`,
      start,
      length: size,
      blocks,
    };
    this.watches.set(entry.id, entry);
    return entry;
  }

  public async removeWatch(id: number): Promise<WatchEntry> {
    const entry = this.watches.get(id);
    if (!entry) {
      throw new Error(`No watch #${id}. Armed: ${this.listWatches().map((w) => `#${w.id}`).join(", ") || "none"}`);
    }
    for (const block of entry.blocks) await this.emulator.removeWatchpoint(block.address);
    this.watches.delete(id);
    return entry;
  }

  public listWatches(): WatchEntry[] {
    return [...this.watches.values()];
  }

  /** Single-steps `count` instructions, stopping early if something else halts execution. */
  public async step(count: number): Promise<StopState> {
    for (let i = 0; i < count; i++) {
      await this.emulator.stepInto();
    }
    return this.describeStop(0, "STEP");
  }

  /** Registers, call stack and current location — everything "where am I" needs. */
  public async inspect(reads: { address: string; bytes: number }[]): Promise<InspectResult> {
    const cpu = await this.emulator.getCpuInfo();
    const pc = parseInt(cpu.pc, 16);
    const callstack = await this.buildCallstack(pc);
    const memory: InspectResult["memory"] = [];
    for (const read of reads) {
      const address = resolveBreakpointSpec(read.address, this.sourceMap).address;
      const data = await this.emulator.readMemory(address, read.bytes);
      memory.push({ address, requested: read.address, data });
    }
    return {
      cpu,
      location: describeAddress(pc, this.sourceMap),
      callstack,
      memory,
    };
  }

  /**
   * A disassembly listing around `at` (an address, symbol or file:line; default the PC), or of
   * the whole routine enclosing it.
   *
   * Instructions *before* an address are the hard part: 68k instructions are 2-10 bytes, so
   * decoding backwards has no reliable starting point. When a routine symbol encloses the address
   * the listing decodes forward from that symbol, which is aligned by construction; only without
   * one does it fall back to guessing a start and checking the decode lands on the address.
   */
  public async disassemble(
    at: string | undefined,
    options: { before: number; count: number; wholeFunction: boolean; maxInstructions: number },
  ): Promise<{ listing: string; notes: string[] }> {
    const pc = parseInt((await this.emulator.getCpuInfo()).pc, 16);
    const address = at !== undefined ? resolveBreakpointSpec(at, this.sourceMap).address : pc;
    if (address & 1) throw new Error(`${formatAddr(address)} is odd — 68000 instructions are word-aligned`);
    const routine = this.sourceMap.findSymbolOffset(address, true);
    const routineStart = routine ? address - routine.offset : undefined;
    const notes: string[] = [];
    const read = async (from: number, bytes: number) =>
      new Uint8Array(await this.emulator.readMemory(from, bytes));

    if (options.wholeFunction) {
      if (!routine || routineStart === undefined) {
        throw new Error(`No symbol encloses ${formatAddr(address)}, so there's no routine to list — pass before/count instead.`);
      }
      const length = this.sourceMap.getSymbolLengths(true)?.[routine.symbol] ?? options.maxInstructions * 2;
      const end = routineStart + length;
      const mem = await read(routineStart, Math.min(length, options.maxInstructions * 10) + 10);
      const lines = decodeRange(mem, routineStart, routineStart, options.maxInstructions, end, this.sourceMap);
      const last = lines[lines.length - 1];
      if (last && last.address + last.length < end) {
        notes.push(`(${routine.symbol} continues past ${options.maxInstructions} instructions; listing cut short)`);
      }
      return { listing: formatListing(lines, pc, this.sourceMap), notes };
    }

    // Decode forward from the routine start when it's near enough to be worth it; else from a
    // guessed start far enough back for `before` instructions of the longest kind.
    const MAX_ROUTINE_LOOKBACK = 4096;
    const fromRoutine = options.before > 0 && routineStart !== undefined && address - routineStart <= MAX_ROUTINE_LOOKBACK;
    const lo = options.before === 0 ? address : fromRoutine ? routineStart! : Math.max(0, address - options.before * 10);
    const mem = await read(lo, address - lo + options.count * 10 + 10);
    let before: DecodedLine[] = [];
    if (options.before > 0) {
      if (fromRoutine) {
        before = decodeRange(mem, lo, lo, Infinity, address, this.sourceMap);
        const last = before[before.length - 1];
        if (last && last.address + last.length !== address) {
          notes.push(`(decoding from ${routine!.symbol} doesn't land on ${formatAddr(address)} — it's mid-instruction, or the routine holds data)`);
        }
      } else {
        // Try starts from furthest back to nearest; the first whose decode lands exactly on the
        // address is plausibly in sync. Not guaranteed — data or a coincidental alignment can fool it.
        for (let start = lo; start < address; start += 2) {
          const attempt = decodeRange(mem, lo, start, Infinity, address, this.sourceMap);
          const last = attempt[attempt.length - 1];
          if (last && last.address + last.length === address) { before = attempt; break; }
        }
        notes.push(before.length
          ? "(no enclosing symbol: the lines before the target were decoded from a guessed start and may be misaligned)"
          : "(no enclosing symbol, and no start before the target decodes cleanly onto it; listing from the target only)");
      }
      before = before.slice(-options.before);
    }
    const after = decodeRange(mem, lo, address, options.count, Infinity, this.sourceMap);
    return { listing: formatListing([...before, ...after], pc, this.sourceMap), notes };
  }

  /**
   * Applies writes to memory, custom registers and CPU registers, in that order (so a PC change
   * comes last, after anything it depends on is in place), and reports each one as it reads back.
   *
   * Reading back matters: a write to ROM or to unmapped space is silently dropped by the bus, and
   * reporting "wrote $0F00" for a write that never landed is how an experiment goes wrong without
   * anyone noticing.
   */
  public async write(request: WriteRequest): Promise<string[]> {
    const report: string[] = [];
    const value = (v: string | number) => this.resolveValue(v);

    for (const op of request.memory) {
      const address = resolveBreakpointSpec(op.address, this.sourceMap).address;
      const where = describeAddress(address, this.sourceMap);
      const bytes = op.bytes ?? encodeBigEndian(value(op.value!), op.size!);
      if (isCustomRegisterAddress(address)) {
        // Custom registers are word-wide; the byte-wise memory path would split each write in two.
        report.push(await this.writeCustom(address, bytes, where));
        continue;
      }
      await this.emulator.writeMemory(address, bytes);
      const back = await this.emulator.readMemory(address, bytes.length);
      report.push(back.equals(bytes)
        ? `${where}: wrote ${hexBytes(bytes)}`
        : `${where}: wrote ${hexBytes(bytes)} but it reads back ${hexBytes(back)} — ROM, unmapped, or not RAM`);
    }

    for (const op of request.custom) {
      const name = op.name.toUpperCase();
      // A 32-bit pointer pair (COP1LC, BPL1PT, ...) is named without its H/L suffix.
      const word = CUSTOM_REGISTER_OFFSETS[name];
      const pair = CUSTOM_REGISTER_OFFSETS[`${name}H`];
      const offset = word ?? pair;
      if (offset === undefined) {
        throw new Error(`Unknown custom register "${op.name}" — use its HRM name (COLOR00, DMACON, COP1LC, BPL1PT, ...)`);
      }
      const bytes = encodeBigEndian(value(op.value), word === undefined ? 4 : 2);
      report.push(await this.writeCustom(0xdff000 + offset, bytes, name));
    }

    for (const op of request.registers) {
      const name = op.name.toLowerCase() === "sp" ? "a7" : op.name.toLowerCase();
      if (!WRITABLE_CPU_REGISTERS.has(name)) {
        throw new Error(`Can't write register "${op.name}" — writable: ${[...WRITABLE_CPU_REGISTERS].join(", ")}`);
      }
      const v = value(op.value) >>> 0;
      await this.emulator.setRegister(name, name === "sr" ? v & 0xffff : v);
      const now = (await this.emulator.getCpuInfo()) as unknown as Record<string, string>;
      const shown = name === "pc" ? describeAddress(parseInt(now.pc, 16), this.sourceMap) : now[name];
      report.push(`${name} = ${shown}`);
    }
    return report;
  }

  /** A number, or an address/symbol/file:line — the same forms breakpoints take — or a negative decimal. */
  private resolveValue(v: string | number): number {
    if (typeof v === "number") return v;
    if (/^-\d+$/.test(v.trim())) return parseInt(v, 10);
    return resolveBreakpointSpec(v, this.sourceMap).address;
  }

  private async writeCustom(address: number, bytes: Buffer, label: string): Promise<string> {
    if (address & 1 || (bytes.length !== 2 && bytes.length !== 4)) {
      throw new Error(`${label}: custom registers take word (2-byte) or long (4-byte) writes at an even address`);
    }
    const name = customRegisterName(address & 0x1fe) ?? label;
    if (bytes.length === 2) await this.emulator.pokeCustom16(address, bytes.readUInt16BE(0));
    else await this.emulator.pokeCustom32(address, bytes.readUInt32BE(0));
    // The poke goes through the CPU's write path, so a watch on this register fires on our own
    // write. Drop that hit, or the next emulator_continue would report it as the program's.
    if (this.watches.size) this.emulator.consumeStopMessage();
    // Most custom registers are write-only, so there's no reading back the address itself; the
    // emulator's own shadow copy, where it exposes one, is the honest "did it take" answer.
    const regs = await this.emulator.getAllCustomRegisters();
    const shadowName = bytes.length === 4 ? name.replace(/H$/, "") : name;
    const now = regs[shadowName]?.value;
    const setClr = SET_CLR_REGISTERS.has(name)
      ? ` (${bytes[0] & 0x80 ? "SET" : "CLR"} write: bit 15 ${bytes[0] & 0x80 ? "set" : "clear"}, so it ${bytes[0] & 0x80 ? "sets" : "clears"} the other bits given)`
      : "";
    return `${shadowName}: wrote $${bytes.toString("hex")}${setClr}${now !== undefined ? `, now reads ${now}` : ""}`;
  }

  /** Custom-chip registers, grouped and decoded, with chip pointers symbolicated. */
  public async chipset(): Promise<string> {
    const regs = await this.emulator.getAllCustomRegisters();
    return formatChipset(regs, (address) => describeAddress(address, this.sourceMap));
  }

  /**
   * The copper list decoded as the copper would run it: from `start` (an address or symbol — a
   * list the program has built but not installed yet) or else COP1LC, where the copper restarts
   * every frame.
   */
  public async copperList(start: string | undefined, maxInstructions: number): Promise<{ start: number; listing: string }> {
    const regs = await this.emulator.getAllCustomRegisters();
    const address = start !== undefined
      ? resolveBreakpointSpec(start, this.sourceMap).address
      : Number(regs.COP1LC?.value ?? NaN);
    if (!Number.isFinite(address)) throw new Error("COP1LC isn't available from this emulator build");
    const listing = await walkCopperList((a, n) => this.emulator.readMemory(a, n), {
      start: address,
      cop2lc: Number(regs.COP2LC?.value ?? 0),
      maxInstructions,
      describeAddress: (a) => describeAddress(a, this.sourceMap),
    });
    return { start: address, listing };
  }

  /**
   * The call chain as innermost-first call-site addresses, following the same convention as
   * `StackManager.getRealCallstack` so this agrees with the debugger's own Call Stack view.
   *
   * Three details, all of them from that method and none of them guessable from the raw array:
   * `getCallstack()` emits **outermost-first**, the current PC is not in it (it is frame 0), and
   * an exception stop leaves the interrupted PC on top, duplicating frame 0.
   *
   * Frames below the program's own are usually Kickstart's, left over from boot: a fastLoad
   * program is jumped to rather than called, so nothing ever popped them.
   */
  private async buildCallstack(pc: number): Promise<string[]> {
    let callSites = await this.emulator.getCallstack();
    if (callSites.length > 0 && callSites[callSites.length - 1] === pc) {
      callSites = callSites.slice(0, -1);
    }
    return [pc, ...[...callSites].reverse()].map((frame) => describeAddress(frame, this.sourceMap));
  }

  /** Where execution currently sits, plus why it stopped there. */
  private async describeStop(framesRun: number, reason: string | undefined): Promise<StopState> {
    const cpu = await this.emulator.getCpuInfo();
    const pc = parseInt(cpu.pc, 16);
    return {
      stopped: reason !== undefined,
      reason,
      framesRun,
      pc,
      location: describeAddress(pc, this.sourceMap),
    };
  }

  /** The current frame as a PNG. */
  public screenshot(): { png: Buffer; width: number; height: number } {
    const { rgba, width, height } = this.emulator.readFramebuffer();
    return { png: encodePng(rgba, width, height), width, height };
  }

  /**
   * Captures `frames` frames and encodes them as a self-contained `.puaeprofile` document — the
   * same bytes the profiler's "Save" button writes, so `profile_check`/`profile_dump` (and the
   * extension's own profile viewer) read it with no special-casing.
   *
   * Thumbnails are the one thing missing: they're JPEG-encoded with OffscreenCanvas in the
   * webview, which doesn't exist here. `ProfilerManager` already treats that as non-fatal, and
   * the format has always had them optional, so a headless capture simply carries none.
   */
  public async captureProfile(frames: number): Promise<{ bytes: Buffer; frames: number }> {
    await this.profiler.capture(frames);
    const raws = this.profiler.getAllRaw();
    if (!raws || raws.length === 0) throw new Error("Capture produced no frames");
    // Plus the one unrecorded frame wasm_profile_start runs first to reach a frame boundary.
    this.framesRun += raws.length + 1;
    const bytes = encodeCapture(raws, {
      elf: this.info.debugBytes,
      programName: this.info.programName,
      capturedAt: Date.now(),
      segmentOffsets: this.info.segmentOffsets,
      baseDir: this.info.baseDir,
      kickstart: this.info.kickstart,
    });
    return { bytes, frames: raws.length };
  }

  public dispose(): void {
    this.emulator.dispose();
  }
}
