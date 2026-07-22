import { base64ToUint8, uint8ToBase64 } from "./base64";

// Plain JSON.stringify/JSON.parse has no TypedArray support at all: a
// Uint8Array isn't Array.isArray, so JSON.stringify serializes only its own
// enumerable indexed properties as a plain object ({"0":1,"1":2,...}) and
// drops `.length` entirely (it's a non-enumerable prototype accessor).
// `new Uint8Array(thatObject)` then reads a missing `.length` as 0 — e.g.
// writeMemory's injected program bytes silently become a zero-length write.
// vscode's own webview<->extension-host postMessage bridge doesn't have this
// particular failure mode (see base64.ts's uint8ToBase64 comment — it
// flattens TypedArrays into an array-like that *does* preserve `.length`,
// just slowly for large buffers), so this only needs to exist for the
// standalone server's WebSocket transport (BrowserWebviewHost <-> app.ts's
// WS branch). Tags any Uint8Array value and round-trips it through base64
// instead of relying on JSON's native (non-)handling of it.
const TAG = "__u8__";

interface TaggedUint8 {
  [TAG]: string;
}

function isTaggedUint8(value: unknown): value is TaggedUint8 {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[TAG] === "string"
  );
}

export function encodeWsMessage(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v instanceof Uint8Array ? ({ [TAG]: uint8ToBase64(v) } satisfies TaggedUint8) : v,
  );
}

export function decodeWsMessage(text: string): unknown {
  return JSON.parse(text, (_key, v) => (isTaggedUint8(v) ? base64ToUint8(v[TAG]) : v));
}
