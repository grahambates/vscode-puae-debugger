// Integration test for the hardDrivePath feature (src/puaeEmulator.ts's
// walkHardDrive + src/webview/puaeApp/app.ts's DH0: reconstruction +
// rpc.ts's getCurrentProcess(M, expectedCommand)): boots with a DH0: MEMFS
// tree built by hand (mirroring what app.ts's hardDriveManifestB64 branch
// does), running an executable under a name other than the legacy hardcoded
// "file", and confirms getCurrentProcess only matches the correct expected
// name — not the old default, not a wrong one.
import createPuaeModule from "../../puae/puae.js";
import { setupRpcDispatcher, tryExec, getCurrentProcess } from "../../out/puaeRpc.mjs";
import { readFixture } from "./fixtures.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const kickRom = readFixture("kick34005.A500");
const hunkExe = fs.readFileSync(fileURLToPath(new URL("../hunk.exe", import.meta.url)));

const M = await createPuaeModule();
M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", kickRom);
M.FS.writeFile(
  "/uae_system/puae_libretro_global.uae",
  "nr_floppies=0\nfloppy0type=-1\nfilesystem=rw,dh0:/uae_system/dh0\n",
);

// Mirror app.ts's hardDriveManifestB64 branch: a directory tree with the
// program under a custom name (not "file") plus its own startup-sequence —
// exactly what a real hardDrivePath directory would contain, walked and
// replayed verbatim (see puaeEmulator.ts's walkHardDrive).
M.FS.mkdir("/uae_system/dh0");
M.FS.writeFile("/uae_system/dh0/mygame", hunkExe);
M.FS.mkdir("/uae_system/dh0/s");
M.FS.writeFile("/uae_system/dh0/s/startup-sequence", "mygame");

const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
console.log("wasm_boot ->", ok);
if (!ok) { console.log("FAIL: wasm_boot failed"); process.exit(1); }

const pending = new Map();
let nextRpcId = 1;
function postMessage(msg) {
  if (msg.type === "rpcResponse" && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
}
const rpc = setupRpcDispatcher(M, postMessage);

// Non-fastLoad boot: tick from frame 0 (no fastLoad warm-up) until tryExec
// arms the AllocMem breakpoint, then keep ticking/resuming past AmigaOS's
// own startup tasks until our "mygame" CLI process shows up — mirrors
// app.ts's frame() loop (usesDh0 branch), condensed into a plain loop.
let armed = false;
let allocMemAddr = 0;
let proc = null;
const MAX_TICKS = 3000;
for (let i = 0; i < MAX_TICKS && !proc; i++) {
  M._wasm_tick();
  if (!armed) {
    const r = tryExec(M);
    if (r.ready) { armed = true; allocMemAddr = r.allocMemAddr; }
    continue;
  }
  if (M._wasm_is_paused()) {
    // Verify the detection logic is genuinely name-sensitive at this exact
    // point in boot, not just "returns something" — checked every hit so at
    // least one of these observations lands on a real (non-"mygame") AmigaOS
    // startup task, not only on the final match.
    if (getCurrentProcess(M, "file") !== null) {
      console.log("FAIL: getCurrentProcess(M, 'file') should never match — nothing on DH0: is named 'file'");
      process.exit(1);
    }
    if (getCurrentProcess(M, "wrongname") !== null) {
      console.log("FAIL: getCurrentProcess(M, 'wrongname') should never match");
      process.exit(1);
    }
    const candidate = getCurrentProcess(M, "mygame");
    if (candidate) {
      proc = candidate;
      M._wasm_remove_breakpoint(allocMemAddr);
    } else {
      M._wasm_resume();
    }
  }
}

if (!proc) {
  console.log(`FAIL: "mygame" CLI process not detected within ${MAX_TICKS} ticks`);
  process.exit(1);
}

console.log(`OK   getCurrentProcess matched command="${proc.command}" with ${proc.segments.length} segment(s)`);
if (proc.command !== "mygame") {
  console.log(`FAIL: expected command "mygame", got "${proc.command}"`);
  process.exit(1);
}
if (proc.segments.length === 0) {
  console.log("FAIL: expected at least one segment");
  process.exit(1);
}
for (const seg of proc.segments) {
  if (!(seg.start > 0) || !(seg.size > 0)) {
    console.log(`FAIL: implausible segment ${JSON.stringify(seg)}`);
    process.exit(1);
  }
}
console.log("OK   segments look plausible:", proc.segments.map(s => `0x${s.start.toString(16)}+${s.size}`));

console.log("\nAll checks passed.");
process.exit(0);
