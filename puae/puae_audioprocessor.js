// Ring-buffer AudioWorkletProcessor for the PUAE wasm debugger backend.
// Accepts { l: Float32Array, r: Float32Array } messages of any size from the
// main thread and drains them 128 samples at a time. No fixed slot size means
// the 882-sample-per-tick batching of libretro's pull model doesn't cause gaps.
class PuaeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const CAP = 16384; // ~371ms at 44100Hz
    this.L = new Float32Array(CAP);
    this.R = new Float32Array(CAP);
    this.cap = CAP;
    this.wr = 0;
    this.rd = 0;
    this.count = 0;
    this.port.onmessage = ({ data: { l, r } }) => {
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

  process(inputs, outputs) {
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
registerProcessor('puae-audio-processor', PuaeAudioProcessor);
