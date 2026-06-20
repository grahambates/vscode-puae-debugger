/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { WebviewEmulator } from "./webviewEmulator";

export interface CpuInfo {
  pc: string;
  // data regs
  d0: string;
  d1: string;
  d2: string;
  d3: string;
  d4: string;
  d5: string;
  d6: string;
  d7: string;
  // address regs
  a0: string;
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  a5: string;
  a6: string;
  a7: string;
  sr: string;
  // stack pointers
  usp: string;
  isp: string;
  msp: string;
  vbr: string;
  irc: string;
  sfc: string;
  dfc: string;
  // cache
  cacr: string;
  caar: string;
}

export enum MemSrc {
  NONE = 0,
  CHIP = 1,
  CHIP_MIRROR = 2,
  SLOW = 3,
  SLOW_MIRROR = 4,
  FAST = 5,
  CIA = 6,
  CIA_MIRROR = 7,
  RTC = 8,
  CUSTOM = 9,
  CUSTOM_MIRROR = 10,
  AUTOCONF = 11,
  ZOR = 12,
  ROM = 13,
  ROM_MIRROR = 14,
  WOM = 15,
  EXT = 16,
}

export interface MemoryInfo {
  hasRom: boolean;
  hasWom: boolean;
  hasExt: boolean;
  hasBootRom: boolean;
  hasKickRom: boolean;
  womLock: boolean;
  romMask: string;
  extMask: string;
  chipMask: string;
  cpuMemSrc: MemSrc[];
  agnusMemSrc: MemSrc[];
}

/**
 * Returns true if the given address is backed by memory, based on a
 * (possibly absent) cached memory map. Shared by VAmiga and PuaeEmulator.
 */
export function isValidMemoryAddress(
  memoryInfo: MemoryInfo | undefined,
  address: number,
): boolean {
  if (memoryInfo) {
    // Check mem type of bank
    const bank = address >>> 16;
    const type = memoryInfo.cpuMemSrc[bank];
    return type !== MemSrc.NONE;
  } else {
    // Any 24 bit address
    return address >= 0 && address < 0x1000_0000;
  }
}

/**
 * Get the contiguous memory region bounds for a given address, based on a
 * (possibly absent) cached memory map. Shared by VAmiga and PuaeEmulator.
 * Returns the start and end addresses of the continuous block of the same memory type.
 */
export function getMemoryRegionForAddress(
  memoryInfo: MemoryInfo | undefined,
  address: number,
): { start: number; end: number } | null {
  if (!memoryInfo) {
    // Default to 16MB address space
    return { start: 0, end: 0x1000_0000 };
  }

  const bank = address >>> 16;
  const type = memoryInfo.cpuMemSrc[bank];

  if (type === MemSrc.NONE) {
    return null; // Invalid address
  }

  // Find the start of this memory region (scan backwards)
  let startBank = bank;
  while (startBank > 0 && memoryInfo.cpuMemSrc[startBank - 1] === type) {
    startBank--;
  }

  // Find the end of this memory region (scan forwards)
  let endBank = bank;
  while (endBank < 255 && memoryInfo.cpuMemSrc[endBank + 1] === type) {
    endBank++;
  }

  return {
    start: startBank << 16,
    end: ((endBank + 1) << 16) - 1,
  };
}

export interface CpuTraceItem {
  pc: string;
  instruction: string;
  flags: string;
  length: number;
}

export interface CustomRegisters {
  [name: string]: {
    value: string;
  };
}

export interface RegisterSetStatus {
  value: string;
}

export interface MemResult {
  address: string;
  data: string;
}

export interface Disassembly {
  instructions: Array<{
    addr: string;
    instruction: string;
    hex: string;
  }>;
}

export interface Segment {
  start: number;
  size: number;
}

export interface StopMessage {
  hasMessage: boolean;
  name: "BREAKPOINT_REACHED" | "WATCHPOINT_REACHED" | "CATCHPOINT_REACHED";
  payload: {
    pc: number;
    vector: number;
  };
}

export interface AttachedMessage {
  type: "attached";
  segments: Segment[];
}

export interface EmulatorStateMessage {
  type: "emulator-state";
  state: string;
  message: StopMessage;
}

export interface EmulatorOutputMessage {
  type: "emulator-output";
  data: string;
}
export interface ExecReadyMessage {
  type: "exec-ready";
}

export interface RpcResponseMessage {
  type: "rpcResponse";
  id: string;
  result: any;
}

export type EmulatorMessage =
  | AttachedMessage
  | EmulatorStateMessage
  | EmulatorOutputMessage
  | ExecReadyMessage
  | RpcResponseMessage;

/**
 * Type guard to check if a message is an AttachedMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an AttachedMessage
 */
export function isAttachedMessage(
  message: EmulatorMessage,
): message is AttachedMessage {
  return message.type === "attached";
}

/**
 * Type guard to check if a message is an EmulatorStateMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an EmulatorStateMessage
 */
export function isEmulatorStateMessage(
  message: EmulatorMessage,
): message is EmulatorStateMessage {
  return message.type === "emulator-state";
}

/**
 * Type guard to check if a message is an EmulatorOutputMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an EmulatorOutputMessage
 */
export function isEmulatorOutputMessage(
  message: EmulatorMessage,
): message is EmulatorOutputMessage {
  return message.type === "emulator-output";
}

/**
 * Type guard to check if a message is an ExecReadyMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an ExecReadyMessage
 */
export function isExecReadyMessage(
  message: EmulatorMessage,
): message is ExecReadyMessage {
  return message.type === "exec-ready";
}

/**
 * Type guard to check if a message is an RpcResponseMessage.
 *
 * @param message The emulator message to check
 * @returns True if the message is an RpcResponseMessage
 */
export function isRpcResponseMessage(
  message: EmulatorMessage,
): message is RpcResponseMessage {
  return message.type === "rpcResponse";
}

/**
 * Options for opening the vAmiga emulator.
 */
export interface OpenOptions {
  programPath?: string;
  kickstartRom?: string;
  kickstartExt?: string;
  cpuRevision?: "68000" | "68010" | "68020" | "68030" | "fake_68030";
  chipRam?: "256k" | "512k" | "1M" | "2M";
  slowRam?: "0" | "256k" | "512k";
  fastRam?: "0" | "256k" | "512k" | "1M" | "2M" | "8M";
  showNavBar?: boolean;
  wideScreen?: boolean;
  darkMode?: boolean;
  enableMouse?: boolean;
  displayZoom?:
    | "viewport tracking"
    | "borderless"
    | "narrow"
    | "standard"
    | "wider"
    | "overscan"
    | "extreme";
  useGpu?: boolean;
  agnusRevision?: "OCS_OLD" | "OCS" | "ECS_1MB" | "ECS_2MB";
  deniseRevision?: "OCS" | "ECS";
  cpuSpeed?:
    | "7MHz"
    | "14Hz"
    | "21Hz"
    | "28Hz"
    | "35Hz"
    | "43Hz"
    | "57Hz"
    | "85Hz"
    | "99Hz";
  blitterAccuracy?: 0 | 1 | 2;
  floppyDriveCount?: 1 | 2 | 3 | 4;
  driveSpeed?: -1 | 1 | 2 | 4 | 8;
}

// Option enums to call param values:
const cpuRevision: Record<string, number> = {
  "68000": 0,
  "68010": 1,
  "68020": 2,
  fake_68030: 4,
};
const cpuSpeed = {
  "7MHz": 0,
  "14Hz": 2,
  "21Hz": 3,
  "28Hz": 4,
  "35Hz": 5,
  "43Hz": 6,
  "57Hz": 8,
  "85Hz": 12,
  "99Hz": 14,
};
const chipRam = { "256k": 256, "512k": 512, "1M": 1024, "2M": 2048 };
const slowRam = { "0": 0, "256k": 256, "512k": 512 };
const fastRam = {
  "0": 0,
  "256k": 256,
  "512k": 512,
  "1M": 1024,
  "2M": 2048,
  "8M": 8192,
};

/** `OpenOptions.cpuRevision` values vAmiga can map to its `CPURev` enum. */
const VAMIGA_CPU_REVISIONS = new Set(["68000", "68010", "68020", "fake_68030"]);

/**
 * Subset of JSON params that can be passed to vAmiga in URL hash
 */
interface CallParams {
  url?: string;
  kickstart_rom_url?: string;
  kickstart_ext_url?: string;
  navbar?: boolean;
  wide?: boolean;
  dark?: boolean;
  mouse?: boolean;
  display?:
    | "viewport tracking"
    | "borderless"
    | "narrow"
    | "standard"
    | "wider"
    | "overscan"
    | "extreme";
  gpu?: boolean;
  // Hardware configuration options
  agnus_revision?: "OCS_OLD" | "OCS" | "ECS_1MB" | "ECS_2MB";
  denise_revision?: "OCS" | "ECS";
  cpu_revision?: number;
  cpu_overclocking?: number;
  chip_ram?: number;
  slow_ram?: number;
  fast_ram?: number;
  blitter_accuracy?: number;
  floppy_drive_count?: number;
  drive_speed?: number;
}

const defaultOptions: Partial<OpenOptions> = {
  showNavBar: false,
  enableMouse: true,
};

export class VAmiga extends WebviewEmulator {
  public static readonly viewType = "vamiga-debugger.webview";
  // Options used to generate the current panel; compared against new open
  // options to decide between a "load" reuse and a full panel recreation.
  private panelOptions?: OpenOptions;

  /**
   * Opens the VAmiga emulator webview panel
   */
  public open(options?: Record<string, unknown>): void {
    const optionsWithDefaults: OpenOptions = {
      ...defaultOptions,
      ...(options as OpenOptions | undefined),
    };
    if (!this.panel) {
      return this.initPanel(optionsWithDefaults);
    }
    if (this.optionsMatch(optionsWithDefaults, this.panelOptions)) {
      this.panel.reveal();
      this.invalidateCache();
      this.memoryInfo = undefined;
      const callParams = this.optionsToCallParams(optionsWithDefaults);
      this.sendCommand("load", callParams);
    } else {
      this.panel.dispose();
      this.initPanel(optionsWithDefaults);
    }
  }

  /**
   * vAmiga's getCpuTrace RPC returns the trace wrapped as `{ trace }`; unwrap
   * it (the base class default returns the response as-is).
   */
  public async getCpuTrace(count = 256): Promise<CpuTraceItem[]> {
    const res = await this.sendRpcCommand("getCpuTrace", { count });
    return res.trace;
  }

  // Helper methods:

  private initPanel(options: OpenOptions) {
    const column = this.getConfiguredViewColumn();

    const localResourceRoots = [
      this.extensionUri,
      ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) || []),
    ];

    if (options.programPath) {
      if (!existsSync(options.programPath)) {
        throw new Error(
          `Program file not found: ${options.programPath}`,
        );
      }
      const progDir = dirname(options.programPath);
      localResourceRoots.push(vscode.Uri.file(progDir));
    }
    if (options.kickstartRom) {
      if (!existsSync(options.kickstartRom)) {
        throw new Error(
          `Kickstart ROM file not found: ${options.kickstartRom}`,
        );
      }
    }
    if (options.kickstartExt) {
      if (!existsSync(options.kickstartExt)) {
        throw new Error(
          `Kickstart extension ROM file not found: ${options.kickstartExt}`,
        );
      }
    }

    // Create new panel
    this.panel = vscode.window.createWebviewPanel(
      VAmiga.viewType,
      "VAmiga",
      {
        viewColumn: column,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep webview alive when hidden
        localResourceRoots,
      },
    );

    const callParams = this.optionsToCallParams(options);
    this.panel.webview.html = this.getHtmlForWebview(callParams);
    this.panelOptions = options;

    // Handle webview lifecycle
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelOptions = undefined;
    });

    // Set up RPC response handler and message delegation (shared base logic)
    this.panel.webview.onDidReceiveMessage((message) =>
      this.handlePanelMessage(message),
    );
  }

  private absolutePathToWebviewUri(absolutePath: string): vscode.Uri {
    if (!this.panel) {
      throw new Error("Panel not initialized");
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }
    const fileUri = vscode.Uri.file(absolutePath);
    return this.panel.webview.asWebviewUri(fileUri);
  }

  private absolutePathToDataUri(absolutePath: string): string {
    if (!existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }
    const data = readFileSync(absolutePath);
    return `data:application/octet-stream;base64,${data.toString("base64")}`;
  }

  private getHtmlForWebview(callParams: CallParams): string {
    if (!this.panel) {
      throw new Error("Panel not initialized");
    }
    const webview = this.panel.webview;

    const vamigaUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "vamiga"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css",
      ),
    );

    // CSP: scripts from the webview resource scheme plus inline (the page's
    // own inline classic/module scripts), wasm-unsafe-eval for wasm
    // execution, workers for the emulation-timing Worker, connect for the
    // data-URI ROM/program fetches. Mirrors puae's CSP (src/puaeEmulator.ts).
    const src = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src ${src} 'unsafe-inline' 'wasm-unsafe-eval'`,
      `style-src ${src} 'unsafe-inline'`,
      `font-src ${src}`,
      `worker-src ${src} blob:`,
      `connect-src ${src} data:`,
      `img-src data:`,
    ].join("; ");

    // Read the HTML template from the vamiga directory
    const templatePath = join(
      this.extensionUri.fsPath,
      "vamiga",
      "index.html",
    );
    let htmlContent = readFileSync(templatePath, "utf8");

    htmlContent = htmlContent.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<link href="${codiconsUri}" rel="stylesheet">`,
    );

    // Replace template variables
    htmlContent = htmlContent.replace(/\$\{vamigaUri\}/g, vamigaUri.toString());
    htmlContent = htmlContent.replace(
      "__CALL_PARAMS__",
      JSON.stringify(callParams),
    );

    return htmlContent;
  }

  private optionsToCallParams(options: OpenOptions): CallParams {
    if (options.cpuRevision && !VAMIGA_CPU_REVISIONS.has(options.cpuRevision)) {
      throw new Error(
        `vAmiga doesn't support a real ${options.cpuRevision} CPU — use ` +
          `cpuRevision: "fake_68030" for an approximate 68030, or ` +
          `debug type "puae" for a real 68030+ CPU.`,
      );
    }
    // When no Kickstart ROM is configured, embed the bundled AROS ROMs as
    // data URIs and pass them via kickstart_rom_url/kickstart_ext_url — the
    // same direct wasm_loadfile path used for real Kickstart ROMs. This is
    // more reliable than the AROS:true / fetchOpenROMS path which depends on
    // IndexedDB storage working in the VS Code webview context.
    const arosRomPath = join(this.extensionUri.fsPath, "vamiga", "roms", "aros-rom-20250219.bin");
    const arosExtPath = join(this.extensionUri.fsPath, "vamiga", "roms", "aros-ext-20250219.bin");
    const romUrl = options.kickstartRom
      ? this.absolutePathToDataUri(options.kickstartRom)
      : this.absolutePathToDataUri(arosRomPath);
    const extUrl = options.kickstartExt
      ? this.absolutePathToDataUri(options.kickstartExt)
      : this.absolutePathToDataUri(arosExtPath);

    const params: CallParams = {
      navbar: options.showNavBar,
      wide: options.wideScreen,
      dark: options.darkMode,
      mouse: options.enableMouse,
      display: options.displayZoom,
      gpu: options.useGpu,
      agnus_revision: options.agnusRevision,
      denise_revision: options.deniseRevision,
      cpu_revision: options.cpuRevision
        ? cpuRevision[options.cpuRevision]
        : undefined,
      cpu_overclocking: options.cpuSpeed ? cpuSpeed[options.cpuSpeed] : undefined,
      chip_ram: options.chipRam ? chipRam[options.chipRam] : undefined,
      slow_ram: options.slowRam ? slowRam[options.slowRam] : undefined,
      fast_ram: options.fastRam ? fastRam[options.fastRam] : undefined,
      blitter_accuracy: options.blitterAccuracy,
      floppy_drive_count: options.floppyDriveCount,
      drive_speed: options.driveSpeed,
      url: options.programPath
        ? this.absolutePathToWebviewUri(options.programPath).toString()
        : undefined,
      kickstart_rom_url: romUrl,
      kickstart_ext_url: extUrl,
    };
    return params;
  }
}
