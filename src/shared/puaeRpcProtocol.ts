import type {
  CpuInfo,
  CpuTraceItem,
  CustomRegisters,
  MemoryInfo,
  RegisterSetStatus,
} from "../emulatorProtocol";

export interface RpcOk {
  ok: boolean;
}

export interface RpcBinaryData {
  data: Uint8Array;
}

// Base64-encoded counterpart of RpcBinaryData — see rpc.ts's uint8ToBase64 comment: the
// webview<->extension-host postMessage bridge flattens a raw Uint8Array into a slow per-element
// array-like, which dominates transfer time once a buffer reaches the profiler's typical
// hundreds-of-KB-to-multi-MB sizes. A base64 string crosses that bridge as a single primitive
// value instead, which is dramatically cheaper.
export interface RpcBinaryDataBase64 {
  dataBase64: string;
}

export interface RpcFramebuffer extends RpcBinaryData {
  width: number;
  height: number;
}

// All fields base64-encoded — see RpcBinaryDataBase64's comment.
export interface RpcDmaSnapshot {
  chipBase64: string;
  slowBase64: string;
  fastBase64?: string;
  fastAddr?: number;
  customBase64: string;
  agaColorsBase64: string;
}

export interface RpcProfileData {
  dataBase64: string;
  start: number;
  end: number;
  total: number;
  inRange: number;
  frameCycles?: number;
  isPAL?: boolean;
}

export interface PuaeRpcProtocol {
  pause: { args: { silent?: boolean } | undefined; result: RpcOk };
  run: { args: { silent?: boolean } | undefined; result: RpcOk };
  stepInto: { args: undefined; result: RpcOk };
  eof: { args: undefined; result: RpcOk };
  eol: { args: undefined; result: RpcOk };
  setBreakpoint: { args: { address: number; ignores: number }; result: RpcOk };
  removeBreakpoint: { args: { address: number }; result: RpcOk };
  setWatchpoint: {
    args: {
      address: number;
      ignores: number;
      read?: boolean;
      write?: boolean;
      length?: number;
    };
    result: RpcOk;
  };
  removeWatchpoint: { args: { address: number }; result: RpcOk };
  setRegisterWatch: { args: { regIndex: number }; result: RpcOk };
  removeRegisterWatch: { args: { regIndex: number }; result: RpcOk };
  resetWatchpoints: { args: undefined; result: RpcOk };
  setCatchpoint: { args: { vector: number; ignores: number }; result: RpcOk };
  removeCatchpoint: { args: { vector: number }; result: RpcOk };
  setMemoryProtectionEnabled: { args: { enabled: boolean }; result: RpcOk };
  resetMemoryProtectionRanges: { args: undefined; result: RpcOk };
  addMemoryProtectionRange: { args: { address: number; size: number }; result: RpcOk };
  seedMemoryProtectionLibraries: { args: undefined; result: RpcOk };
  enableCpuLogging: { args: { enabled: boolean }; result: RpcOk };
  load: { args: undefined; result: RpcOk };
  isPaused: { args: undefined; result: { paused: boolean } };
  getCpuInfo: { args: undefined; result: CpuInfo };
  setRegister: { args: { name: string; value: number }; result: RegisterSetStatus };
  jump: { args: { address: number }; result: void };
  getMemoryInfo: { args: undefined; result: MemoryInfo };
  readMemory: { args: { address: number; count: number }; result: RpcBinaryData };
  writeMemory: { args: { address: number; data: Uint8Array }; result: void };
  peek32: { args: { address: number }; result: number };
  peek16: { args: { address: number }; result: number };
  peek8: { args: { address: number }; result: number };
  poke32: { args: { address: number; value: number }; result: void };
  poke16: { args: { address: number; value: number }; result: void };
  poke8: { args: { address: number; value: number }; result: void };
  pokeCustom16: { args: { address: number; value: number }; result: void };
  pokeCustom32: { args: { address: number; value: number }; result: void };
  getAllCustomRegisters: { args: undefined; result: CustomRegisters };
  disassembleCopper: { args: { address: number; count: number }; result: never };
  getCpuTrace: { args: { count?: number }; result: CpuTraceItem[] };
  getCallstack: { args: undefined; result: number[] };
  stepBack: { args: undefined; result: boolean };
  continueReverse: { args: undefined; result: boolean };
  stepBackFrame: { args: undefined; result: boolean };
  profileSetUnwind: {
    args: { data: Uint8Array; startAddr: number; endAddr: number };
    result: RpcOk;
  };
  startProfiling: { args: { numFrames: number }; result: RpcOk };
  getProfileData: { args: undefined; result: RpcProfileData };
  getProfileRegs: { args: undefined; result: { dataBase64: string } };
  getDmaData: { args: undefined; result: RpcBinaryDataBase64 };
  getDmaEvents: { args: undefined; result: RpcBinaryDataBase64 };
  copperTrackingEnable: { args: { enabled: boolean }; result: RpcOk };
  getCopperData: { args: undefined; result: RpcBinaryDataBase64 };
  getFramebuffer: { args: undefined; result: RpcFramebuffer };
  getProfileFullFrameBatch: { args: undefined; result: RpcFramebuffer[] };
  getProfileThumbBatch: { args: undefined; result: RpcFramebuffer[] };
  // One byte per captured frame (0/1) — whether that frame is byte-identical to the one
  // before it. See wasm_profile_get_dup_ptr's comment in frontend_shim.c.
  getProfileFrameDups: { args: undefined; result: RpcBinaryData };
  getDmaFrame: { args: { frameIdx: number }; result: RpcBinaryDataBase64 };
  getDmaEventsFrame: { args: { frameIdx: number }; result: RpcBinaryDataBase64 };
  getCopperFrame: { args: { frameIdx: number }; result: RpcBinaryDataBase64 };
  getDmaSnapshot: { args: undefined; result: RpcDmaSnapshot };
  getAgaColors: { args: undefined; result: RpcBinaryData };
}

export type PuaeRpcCommand = keyof PuaeRpcProtocol;
export type PuaeRpcArgs<K extends PuaeRpcCommand> = PuaeRpcProtocol[K]["args"];
export type PuaeRpcResult<K extends PuaeRpcCommand> = PuaeRpcProtocol[K]["result"];
export type PuaeRpcResultValue = PuaeRpcProtocol[PuaeRpcCommand]["result"];

export type PuaeRpcRequest = {
  [K in PuaeRpcCommand]: {
    command: K;
    args: (PuaeRpcArgs<K> extends undefined ? object : PuaeRpcArgs<K>) & {
      _rpcId: string;
    };
  };
}[PuaeRpcCommand];

export type PuaeInboundMessage = PuaeRpcRequest;
export type PuaeInboundCommand = PuaeInboundMessage["command"];

/**
 * Non-correlated argument view used inside the switch-based webview dispatcher.
 * The host request builders retain the stricter command/argument correlation.
 */
export interface PuaeDispatcherArgs {
  _rpcId?: string;
  silent?: boolean;
  address: number;
  count: number;
  value: number;
  data: Uint8Array | ArrayBuffer;
  name: string;
  ignores?: number;
  read?: boolean;
  write?: boolean;
  length?: number;
  regIndex: number;
  vector: number;
  enabled: boolean;
  size: number;
  startAddr: number;
  endAddr: number;
  numFrames?: number;
  frameIdx?: number;
}

export interface PuaeRpcResponse<K extends PuaeRpcCommand = PuaeRpcCommand> {
  type: "rpcResponse";
  id: string;
  result: PuaeRpcResult<K> | { error: string };
}

export interface PuaeRpcClient {
  sendRpcCommand<K extends PuaeRpcCommand>(
    command: K,
    ...params: undefined extends PuaeRpcArgs<K>
      ? [args?: PuaeRpcArgs<K>, timeoutMs?: number]
      : [args: PuaeRpcArgs<K>, timeoutMs?: number]
  ): Promise<PuaeRpcResult<K>>;
}
