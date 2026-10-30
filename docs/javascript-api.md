# JavaScript automation API

Install `puae-debugger` and import `puae-debugger/api`. The API runs PUAE in a Node.js worker thread by default, using the same backend and debug session as the MCP server. No editor, browser, MCP client or child process is needed. ESM and CommonJS are supported; TypeScript declarations are included.

```sh
npm install --save-dev puae-debugger
```

Supply your own Kickstart ROM using `kickstartRom` or the `PUAE_KICKSTART_ROM` environment variable. Programs must be Amiga hunk executables; `debugProgram` can point to a separate ELF with DWARF or STABS symbols. This uses the MCP server's fast-load path, which injects the program after AmigaOS initializes.

```js
import assert from 'node:assert/strict';
import { puae } from 'puae-debugger/api';

const amiga = await puae.launch({
  program: './build/demo.exe',
  kickstartRom: '/path/to/kick.rom',
  breakpoints: ['draw_frame'],
  // debugProgram: './build/demo.elf',
  // extraConfig: 'chipset=aga\nchipmem_size=4\n',
});

try {
  const stop = await amiga.runUntil('draw_frame', { frames: 300 });
  assert.equal(stop.reason, 'BREAKPOINT_REACHED');
  const { cpu, location, callstack } = await amiga.inspect();
  console.log(location, cpu, callstack);

  await amiga.breakpoints.clear();
  await amiga.keyboard.press('Space');
  await amiga.run({ frames: 50 });
  await amiga.screenshot({ path: 'screen.png' });

  const capture = await amiga.captureProfile({ frames: 2, path: 'frame.puaeprofile' });
  const analysis = await puae.profiles.analyse(capture.bytes, { callTree: true });
  assert.equal(analysis.findings.filter(f => f.severity === 'error').length, 0);
  console.log(puae.profiles.summarize(analysis.frames));
} finally {
  await amiga.close();
}
```

CommonJS: `const { puae } = require('puae-debugger/api')`. Named exports `launch` and `profiles` are also available.

Each launch creates an independent machine, paused at entry, with the crash exception stops enabled and a `start` snapshot. `exceptions: []` disables those stops; otherwise pass an array of 68k vector numbers. `EXCEPTIONS` exports the supported named vectors and defaults. `rootDir` optionally selects a custom package directory containing `puae/` and `out/`.

Await each operation before calling another on the same machine. Overlapping operations reject with an error, so debugger state cannot be interleaved accidentally. Separate machines can be used independently, each on its own worker. `close()` is idempotent; await pending work before closing. Sessions have no MCP idle eviction or registry limit. Closing terminates the worker and releases its WASM instance. With `isolate: false`, WASM memory is reclaimed by Node's garbage collector.

Frames are emulated time, independent of wall-clock time. `run()` resumes, advances up to its budget, and pauses again. Inspect `stopped`, `reason`, `detail`, `framesRun`, `pc` and `location` on its result: a budget expiring returns `stopped: false`. Most operations return structured data. Disassembly includes an `instructions` array alongside its readable listing; `custom.registers()` returns numeric register values, while `custom.read()` and copper listings retain readable text. Addresses accept numbers, hex strings, symbols or `file:line` wherever the corresponding MCP operation supports them. Numeric memory values use Amiga big-endian order.

| Capability | API |
| --- | --- |
| Execution | `run({ frames: 500 })`, `step({ count: 1 })` |
| Reverse execution | `reverse({ mode: 'step', count: 1 })`; modes also include `'frame'` and `'continue'` |
| Registers and call stack | `inspect()`, `registers.read()`, `registers.write('d0', 42)` |
| Breakpoints | `breakpoints.add('main', 'demo.s:42', 0x2000)`, `remove(...)`, `clear()`, `list()` |
| Exceptions | `exceptions.set([2, 3, 4, 5])`, `exceptions.list()` |
| Memory | `memory.read('buffer', 128)` → Buffer; `memory.write('buffer', bytes)`; `memory.writeValue('counter', 42, 2)` |
| Watchpoints | `watches.add('counter', { bytes: 2, kind: 'write', condition: { equals: 42 } })`, `remove(id)`, `list()` |
| Custom registers | `custom.read()`, `custom.write('COLOR00', 0xf00)`, `custom.copperList({ address: 'copper', count: 128 })` |
| Batch writes | `write({ registers: [{ name: 'd0', value: 42 }], custom: [], memory: [] })` |
| Disassembly | `disassemble('main', { before: 4, count: 20 })`, or `{ wholeFunction: true }` |
| Snapshots | `snapshots.save('before')`, `restore('before')`, `delete('before')`, `list()` |
| Keyboard | `keyboard.press('Space')`, `down('ArrowLeft')`, `up('ArrowLeft')`; DOM keyboard codes |
| Mouse | `mouse.move(32, -10)`, `click('left')`, `down('right')`, `up('right')` |
| Joystick | `joystick.press('fire')`, `down('left')`, `up('left')`; also right/up/down/fire2 |
| Input sequences | `input(actions)` accepts typed `InputAction` objects, including `{ kind: 'wait', frames: 10, label: 'wait' }` |
| Serial output | `serial.read()` → `{ text, dropped }`, consumes output since last read |
| Screenshot | `screenshot({ path })` → `{ png, rgba, width, height }`; path is optional |
| Contact sheet | `frameSequence({ frames: 4, every: 10, warmup: 0, columns: 4, half: true, path })` → PNG, RGBA, tiles, stoppedEarly |
| Profile capture | `captureProfile({ frames: 1, path })` → `{ bytes, frames }`; path is optional |
| Session metadata | `entryPoint`, `segmentOffsets`, `hasSourceInfo`, `frame` |
| Cleanup | `await close()` |

A keyboard press, mouse click or joystick press holds and releases the input across emulated frames. `down()` and `up()` each advance one frame. Any breakpoint, watchpoint or exception can interrupt an input sequence; inspect its `stop` and `held` fields before continuing. A press interrupted before release remains held; call `releaseAll()` to clear every held key, mouse button and joystick input without advancing execution. Snapshots preserve machine state; debugger breakpoints, watches and exception stops remain as currently configured.

Budgets match the MCP interface: `run` accepts 1–5000 frames, `step` 1–1000 instructions, and reverse step 1–100000 instructions (other reverse modes 1–50 repetitions). Contact sheets have at most 16 frames. Memory reads accept up to 16 MB. Invalid frame budgets reject before running. Profile capture can advance an additional frame to align the recording; `frame` reflects that advance. Headless profiles omit browser-generated JPEG thumbnails.

For one-shot work, launch a machine, take the screenshot or capture, and close it in `finally`, as above. Screenshot tiles include raw pixels, frame numbers and repetition flags, so scripts can save individual frames or compare them. Use Node's `crypto.createHash('sha256')` on RGBA pixels or memory buffers for the same hashes available through MCP, and `fs.writeFile()` to export raw memory.

## Profile analysis

`profiles.analyse(pathOrBytes, options)` accepts a saved capture path or the bytes returned by `captureProfile`. It always runs the same physical invariant checks as `profile_check`; inspect `analysis.findings` before relying on costs.

Options cover all `profile_dump` analyses: `callTree`, `callers`, `instructions`, `stalls`, `flame` (true or `{ from, to }` raster lines), `blits`, `copper`, `iterations` and `accesses`. Results include per-frame function costs and the requested details as structured objects. Times are colour clocks (two 68000 CPU cycles), matching MCP and the CLI.

```js
const before = await puae.profiles.analyse('before.puaeprofile');
const after = await puae.profiles.analyse('after.puaeprofile', {
  instructions: 'draw_frame',
  accesses: 'COLOR00',
});
console.log(puae.profiles.diff(before.frames, after.frames));
```

`analyseProfile(bytes, options)`, `summarizeFunctions(frames)` and `diffProfiles(beforeFrames, afterFrames)` are also named exports for synchronous in-memory analysis. To save an analysis, serialize the result with `JSON.stringify()` and write it with Node's filesystem API.

## Condition-based waits

```js
await amiga.runUntil('draw_frame', { frames: 300 });
await amiga.waitForMemory('ready', { equals: 1, size: 2, frames: 100 });
const { text } = await amiga.waitForSerial(/PASS|FAIL/, { frames: 500 });
const count = await amiga.memory.readLong('counter');
const message = await amiga.memory.readString('message', { maxBytes: 256 });
```

`runUntil()` installs a temporary breakpoint and removes it afterwards, preserving breakpoints that were already present. If already at the target it returns immediately. Other stops, including crashes, interrupt the wait rather than being silently resumed.

Memory and serial waits check the current state first, then poll after each emulated frame. Memory values are unsigned big-endian, with `size: 1 | 2 | 4` (default 2). If a condition is satisfied on a frame that also stops, the wait succeeds and includes that stop; otherwise a debugger stop interrupts the wait. `WaitError` includes `lastStop` and, for memory/serial waits, the last `actual` value or accumulated output. Conditions are observed at frame boundaries; use a watchpoint when a transient write must be caught.

Serial waits consume output and return all text collected, including any tail after a match. A string pattern matches a substring; regular expressions are supported without changing the caller's regex state. Dropped serial bytes or more than 1 MB of collected text fail explicitly. Read helpers `readByte`, `readWord` and `readLong` return unsigned numbers; `readString` reads a null-terminated string with a bounded byte budget and Latin-1 encoding by default. Missing terminators throw instead of returning a truncated string.

## Logging, deadlines and cancellation

Core diagnostics are silent by default. Pass `log: line => console.error(line)` to `launch()` to collect them. Worker diagnostics are routed to this callback without modifying the caller's console or stdout. A throwing logger closes its worker and rejects pending work.

`launch({ timeoutMs: 60000, ... })` sets a wall-clock deadline for boot and operations (default 30000 ms). `run`, `runUntil`, `waitForMemory`, `waitForSerial`, `step`, `reverse` and `captureProfile` accept an operation-specific `timeoutMs` and `signal`. Frame budgets and wall-clock deadlines serve different purposes: a frame budget leaves the machine paused and available for inspection; a wall-clock deadline or abort terminates its worker and permanently closes the machine.

```js
await amiga.run({ frames: 5000, signal: controller.signal, timeoutMs: 10000 });
// From another task, even while a run is busy:
await amiga.terminate();
```

A signal can also cancel launch. `terminate()` is a hard stop that can interrupt a busy worker. `close()` provides ordinary teardown after awaited work. Always await the run promise too, handling its rejection after cancellation.

Set `isolate: false` to run on the calling thread. This mode has no hard cancellation or wall-clock deadlines; it rejects launch cancellation/deadline options and operation signals. Core logs still use the supplied logger, but incidental helper diagnostics can use the calling thread's console. Use worker isolation for responsive applications and parallel test runs.

## Screenshot comparisons and test fixtures

`compareImages(actual, expected, options)` accepts screenshots or `{ rgba, width, height }` objects. It compares all four RGBA channels, returns `matches`, `differentPixels`, `comparedPixels` and `diffRatio`, and produces a PNG difference image with changed pixels in red. Dimensions must match. `tolerance` is an absolute per-channel difference from 0–255; `maxDiffRatio` permits a fraction of differing unmasked pixels from 0–1. Both default to zero.

```js
import { withEmulator, compareImages } from 'puae-debugger/api';
import { writeFile } from 'node:fs/promises';

await withEmulator({ program, kickstartRom }, async amiga => {
  await amiga.runUntil('ready');
  const before = await amiga.screenshot();
  await amiga.run({ frames: 50 });
  const after = await amiga.screenshot();
  const diff = compareImages(after, before, {
    tolerance: 2,
    maxDiffRatio: 0.001,
    ignore: [{ x: 0, y: 0, width: 80, height: 16 }],
  });
  if (!diff.matches) {
    await writeFile('difference.png', diff.png);
    throw new Error(`${diff.differentPixels} pixels changed`);
  }
}, { directory: './test-results' });
```

`withEmulator(options, callback, { directory })` launches and closes a machine around an async callback. On callback failure it saves `failure.txt`, `screen.png`, `state.json` and unread `serial.txt` in a unique directory before teardown. Unavailable artifacts are recorded as error files (for example, after worker termination); artifact failures do not replace the original test error. The optional logger receives the artifact directory path. The callback's return value is preserved on success. Await emulator operations inside the callback. The helper works with Node's test runner or another test framework and does not add dependencies.
