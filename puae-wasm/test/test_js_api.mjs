// Exercise the installed public entry point (ESM), runtime asset lookup and actual wasm.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { puae } from "puae-debugger/api";
import { readFixture } from "./fixtures.mjs";
readFixture("kick34005.A500");
assert.equal(typeof createRequire(import.meta.url)("puae-debugger/api").launch, "function");
const emulator = await puae.launch({
  program: fileURLToPath(new URL("../../src/test/fixtures/amigaPrograms/gencop", import.meta.url)),
  kickstartRom: fileURLToPath(new URL("../../puae/kick34005.A500", import.meta.url)),
});
try {
  const entry = await emulator.registers.read();
  assert.equal(parseInt(entry.pc, 16), emulator.entryPoint);
  const code = await emulator.memory.read(emulator.entryPoint, 4);
  assert.equal(code.length, 4);
  await emulator.step();
  await emulator.snapshots.restore("start");
  assert.equal((await emulator.registers.read()).pc, entry.pc);
  const state = await emulator.run({ frames: 3 });
  assert.equal(state.stopped, false);
  assert.equal(state.framesRun, 3);
  const image = await emulator.screenshot();
  assert.equal(image.png.subarray(1, 4).toString(), "PNG");
  const sequence = await emulator.frameSequence({ frames: 2 });
  assert.equal(sequence.tiles.length, 2);
  const capture = await emulator.captureProfile({ frames: 1 });
  const analysis = await puae.profiles.analyse(capture.bytes, { callTree: true, copper: true });
  assert.equal(analysis.frames.length, 1);
  assert.equal(analysis.findings.filter(f => f.severity === "error").length, 0);
  console.log("OK JavaScript API: ESM/CJS, launch, memory, step, restore, run, screenshots and profile analysis");
} finally {
  await emulator.close();
}
await assert.rejects(emulator.inspect(), /closed/);
