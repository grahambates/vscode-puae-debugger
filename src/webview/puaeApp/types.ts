// Loose typing for the Emscripten-generated PUAE wasm module (puae.js,
// MODULARIZE=1 UMD output). The module exposes hundreds of `_wasm_*` C
// exports plus the standard Emscripten heap views/FS/cwrap helpers — typing
// every export individually isn't worth it here, so callers index into it
// with an `any`-returning signature and rely on call-site argument types.
export interface PuaeModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  UTF8ToString(ptr: number): string;
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: unknown[]) => unknown;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [exportName: string]: any;
}

// createPuaeModule is a global set by puae.js (Emscripten MODULARIZE=1 UMD output).
declare global {
  function createPuaeModule(opts?: { locateFile?: (path: string) => string }): Promise<PuaeModule>;

  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
