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
import { describe as describeAddress, resolveBreakpointSpec } from "./breakpointSpec";
import { formatChipset, walkCopperList } from "./chipset";
import { HeadlessEmulator } from "./headlessEmulator";
import { encodePng } from "./png";
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
}

export interface InspectResult {
  cpu: Awaited<ReturnType<HeadlessEmulator["getCpuInfo"]>>;
  location: string;
  callstack: string[];
  memory: { address: number; requested: string; data: Buffer }[];
}

export class HeadlessSession {
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
    if (!this.emulator.isPaused()) await this.emulator.pause(true);
    return ran;
  }

  // --- Interactive debugging ---

  /** Resolves each spec (address, symbol or file:line) and arms a breakpoint there. */
  public async setBreakpoints(specs: string[]): Promise<string[]> {
    const descriptions: string[] = [];
    for (const spec of specs) {
      const resolved = resolveBreakpointSpec(spec, this.sourceMap);
      await this.emulator.setBreakpoint(resolved.address);
      descriptions.push(resolved.description);
    }
    return descriptions;
  }

  /**
   * Runs until a breakpoint (or watchpoint/catchpoint) fires or `maxFrames` frames elapse,
   * whichever comes first — the frame budget is what stops "continue" from hanging forever on a
   * program that never reaches the breakpoint it was given.
   */
  public async continueUntilStop(maxFrames: number): Promise<StopState> {
    await this.emulator.run();
    const ran = this.emulator.runFrames(maxFrames);
    const hitBreakpoint = this.emulator.isPaused();
    if (!hitBreakpoint) await this.emulator.pause(true);
    // Consumed once per stop (see consumeStopMessage), so read it here and carry it in the
    // returned state rather than asking again later.
    const stop = hitBreakpoint ? this.emulator.consumeStopMessage() : undefined;
    return this.describeStop(ran, hitBreakpoint ? stop?.name ?? "BREAKPOINT_REACHED" : undefined);
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
