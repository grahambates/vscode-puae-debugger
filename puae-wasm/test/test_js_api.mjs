// Exercise the installed public entry point (ESM), runtime asset lookup and actual wasm.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { puae, withEmulator, compareImages } from "puae-debugger/api";
import { readFixture } from "./fixtures.mjs";
readFixture("kick34005.A500");
assert.equal(typeof createRequire(import.meta.url)("puae-debugger/api").launch, "function");
const options = {
  program: fileURLToPath(new URL("../../src/test/fixtures/amigaPrograms/gencop", import.meta.url)),
  kickstartRom: fileURLToPath(new URL("../../puae/kick34005.A500", import.meta.url)),
};
const parentConsole = console.log;
const emulator = await puae.launch(options);
assert.equal(console.log, parentConsole);
try {
  const entry = await emulator.registers.read();
  assert.equal(parseInt(entry.pc, 16), emulator.entryPoint);
  const code = await emulator.memory.read(emulator.entryPoint, 4);
  assert.equal(code.length, 4);
  assert.equal(await emulator.memory.readWord(emulator.entryPoint), code.readUInt16BE(0));
  assert.equal(await emulator.memory.readLong(emulator.entryPoint), code.readUInt32BE(0));
  assert.equal((await emulator.waitForMemory(emulator.entryPoint, { equals: code.readUInt16BE(0) })).framesRun, 0);
  const listing = await emulator.disassemble();
  assert.equal(listing.instructions[0].address, emulator.entryPoint);
  await emulator.step();
  const nextPc = parseInt((await emulator.registers.read()).pc, 16);
  await emulator.snapshots.restore("start");
  assert.equal((await emulator.runUntil(nextPc, { frames: 10 })).pc, nextPc);
  assert.deepEqual(await emulator.breakpoints.list(), []);
  await emulator.breakpoints.add(nextPc);
  await emulator.snapshots.restore("start");
  await emulator.runUntil(nextPc, { frames: 10 });
  assert.equal((await emulator.breakpoints.list()).length, 1);
  await emulator.breakpoints.clear();
  await emulator.snapshots.restore("start");
  assert.equal((await emulator.registers.read()).pc, entry.pc);
  const state = await emulator.run({ frames: 3 });
  assert.equal(state.stopped, false);
  assert.equal(state.framesRun, 3);
  const image = await emulator.screenshot();
  assert.equal(image.png.subarray(1, 4).toString(), "PNG");
  assert.equal(compareImages(image, image).matches, true);
  assert.equal(typeof (await emulator.custom.registers()).COLOR00, "number");
  await emulator.keyboard.down('Space');
  await emulator.releaseAll();
  assert.deepEqual((await emulator.input([])).held, []);
  const sequence = await emulator.frameSequence({ frames: 2 });
  assert.equal(sequence.tiles.length, 2);
  const beforeCapture = await emulator.timing.mark();
  const capture = await emulator.captureProfile({ frames: 1 });
  const captureTiming = await emulator.timing.elapsed(beforeCapture);
  assert.ok(captureTiming.colourClocks > 0 && captureTiming.instructions > 0);
  const analysis = await puae.profiles.analyse(capture.bytes, { callTree: true, copper: true });
  assert.equal(analysis.frames.length, 1);
  assert.equal(analysis.findings.filter(f => f.severity === "error").length, 0);
  // A known five-instruction loop lets us check exact instruction deltas across both
  // single stepping and breakpoint stops, independently of a demo's symbols or workload.
  await emulator.snapshots.restore('start');
  await emulator.memory.write(emulator.entryPoint, new Uint8Array([
    0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71, 0x4e, 0x71, 0x60, 0xf6,
  ]));
  await emulator.custom.write('DMACON', 0x7fff);
  await emulator.registers.write('sr', 0x2700);
  await emulator.registers.write('pc', emulator.entryPoint);
  const mark = await emulator.timing.mark();
  assert.equal((await emulator.timing.elapsed(mark)).colourClocks, 0);
  await emulator.step({ count: 2 });
  const elapsed = await emulator.timing.elapsed(mark);
  assert.equal(elapsed.instructions, 2);
  assert.ok(elapsed.colourClocks >= 4);
  const measured = await emulator.timing.measure({ from: emulator.entryPoint, to: emulator.entryPoint + 4, frames: 10 });
  assert.equal(measured.instructions, 2);
  assert.ok(measured.colourClocks >= 4);
  const benchmark = await emulator.timing.benchmark({ from: emulator.entryPoint, to: emulator.entryPoint, samples: 4, warmup: 2, frames: 10 });
  assert.equal(benchmark.samples.length, 4);
  assert.ok(benchmark.samples.every(sample => sample.instructions === 5 && sample.colourClocks >= 13));
  assert.equal(benchmark.instructions.mean, 5);
  assert.equal(benchmark.colourClocks.total, benchmark.samples.reduce((sum, sample) => sum + sample.colourClocks, 0));
  await emulator.snapshots.restore('start');
  await assert.rejects(emulator.timing.elapsed(mark), /rewound or restored/);
  const beforeReverse = await emulator.timing.mark();
  await emulator.step({ count: 2 });
  await emulator.reverse();
  await assert.rejects(emulator.timing.elapsed(beforeReverse), /rewound or restored/);
  console.log('OK JavaScript API: colour-clock and instruction checkpoints, exact code intervals, repeated benchmarks and rewind invalidation');
  console.log("OK JavaScript API: ESM/CJS, launch, memory, step, restore, run, screenshots and profile analysis");
} finally {
  await emulator.close();
}
await assert.rejects(emulator.inspect(), /closed/);

// Hard deadlines stop a busy worker, without blocking timers in the parent.
const logged = [];
const timed = await puae.launch({ ...options, log: line => logged.push(line) });
assert.ok(logged.some(line => line.includes('[shim]')));
let responsive = false;
setTimeout(() => { responsive = true; }, 0);
await assert.rejects(timed.run({ frames: 5000, timeoutMs: 1 }), /timed out/);
assert.equal(responsive, true);
await assert.rejects(timed.inspect(), /closed/);
await timed.close();
const aborted = await puae.launch(options);
const controller = new AbortController();
setTimeout(() => controller.abort(), 1);
await assert.rejects(aborted.run({ frames: 5000, signal: controller.signal }), /aborted/);
await aborted.close();

// In-process callers get routed core diagnostics without modifying global console.
const localLogs = [];
const local = await puae.launch({ ...options, isolate: false, log: line => localLogs.push(line) });
assert.ok(localLogs.some(line => line.includes('[shim]')));
assert.equal(console.log, parentConsole);
await local.close();

// The fixture keeps the original failure and writes artifacts before teardown.
const artifacts = await mkdtemp(join(tmpdir(), 'puae-api-artifacts-'));
try {
  const failure = new Error('deliberate assertion failure');
  await assert.rejects(withEmulator(options, async () => { throw failure; }, { directory: artifacts }), error => error === failure);
  const [dir] = await readdir(artifacts);
  const names = await readdir(join(artifacts, dir));
  assert.ok(names.includes('screen.png') && names.includes('state.json') && names.includes('serial.txt'));
  assert.match(await readFile(join(artifacts, dir, 'failure.txt'), 'utf8'), /deliberate assertion/);
} finally {
  await rm(artifacts, { recursive: true, force: true });
}
console.log('OK JavaScript API: waits, structured results, input cleanup, quiet/logged workers, deadlines, abort and failure artifacts');
