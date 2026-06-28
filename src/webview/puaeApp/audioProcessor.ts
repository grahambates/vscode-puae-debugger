// Ring-buffer AudioWorkletProcessor for the PUAE wasm debugger backend.
// Accepts { l: Float32Array, r: Float32Array } messages of any size from the
// main thread and drains them 128 samples at a time. No fixed slot size means
// the variable per-tick sample count (~883 at the real PAL frame rate) doesn't
// need to divide evenly into anything.
//
// Runs in the AudioWorkletGlobalScope, which the DOM lib doesn't describe —
// declare just the bits this file uses.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void;

interface AudioChunkMessage {
  l: Float32Array;
  r: Float32Array;
  reset?: undefined;
}
interface ResetMessage {
  reset: true;
  l?: undefined;
  r?: undefined;
}

class PuaeAudioProcessor extends AudioWorkletProcessor {
  // Generous headroom matters more than low latency here — this drives a
  // debugger's emulator, not an instrument, so an extra few hundred ms of
  // audio latency is imperceptible. The catch-up loop in app.ts's frame()
  // can legitimately push a multi-tick burst (e.g. after even a small
  // scheduling hiccup), and a tight cap leaves that burst nowhere to go but
  // truncated — an audible click. A much bigger cap absorbs it.
  private static readonly CAP = 131072; // ~2.97s at 44100Hz
  private readonly L = new Float32Array(PuaeAudioProcessor.CAP);
  private readonly R = new Float32Array(PuaeAudioProcessor.CAP);
  private readonly cap = PuaeAudioProcessor.CAP;
  private wr = 0;
  private rd = 0;
  private count = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<AudioChunkMessage | ResetMessage>) => {
      if (data.reset) {
        // Discard everything — used when resuming from a suspended context,
        // where whatever's queued is stale (it was never being drained).
        this.wr = 0; this.rd = 0; this.count = 0;
        return;
      }
      const { l, r } = data;
      const n = l.length;
      const space = this.cap - this.count;
      const toCopy = Math.min(n, space);
      for (let i = 0; i < toCopy; i++) {
        this.L[this.wr] = l[i];
        this.R[this.wr] = r[i];
        this.wr = (this.wr + 1) % this.cap;
      }
      this.count += toCopy;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const n = outL.length; // always 128
    const avail = Math.min(n, this.count);
    for (let i = 0; i < avail; i++) {
      outL[i] = this.L[this.rd];
      outR[i] = this.R[this.rd];
      this.rd = (this.rd + 1) % this.cap;
    }
    this.count -= avail;
    return true;
  }
}
registerProcessor("puae-audio-processor", PuaeAudioProcessor);
