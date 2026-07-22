// Chunked to avoid blowing the call stack on String.fromCharCode(...bytes)
// for large buffers (profiler captures/framebuffers can reach multi-MB).
// Shared between rpc.ts (base64-encoding wasm-heap reads for the postMessage
// bridge — see puaeRpcProtocol.ts's RpcBinaryDataBase64 comment) and
// wsRpcCodec.ts (base64-encoding Uint8Array values for the standalone
// server's WebSocket RPC bridge, which has no TypedArray support at all).
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
