import fs from "node:fs";
import createPuaeModule from "../puae/puae.js";
import { tryExec, getCurrentProcess } from "../puae/puae_rpc.js";

const M = await createPuaeModule();

M.FS.mkdir("/uae_system");
M.FS.writeFile("/uae_system/kick34005.A500", fs.readFileSync("../puae/kick34005.A500"));

// Mount /uae_system/dh0 as a bootable DH0: hard disk (filesystem=rw,dh0:...,
// the directory-mount approach from puaeEmulator.ts's buildExtraConfig).
// chipmem_size=4 (2MB) + fastmem_size=2 (2MB): the default A500 512KB chip
// ram isn't enough room for hunk.exe's ~490KB of segments plus OS overhead.
M.FS.writeFile(
  "/uae_system/puae_libretro_global.uae",
  "filesystem=rw,dh0:/uae_system/dh0\nnr_floppies=0\nfloppy0type=-1\nchipmem_size=4\nfastmem_size=2\n",
);

// Program + startup-sequence (matches puae_app.js's programB64 handling).
M.FS.mkdir("/uae_system/dh0");
M.FS.writeFile("/uae_system/dh0/file", fs.readFileSync("./hunk.exe"));
M.FS.mkdir("/uae_system/dh0/s");
M.FS.writeFile("/uae_system/dh0/s/startup-sequence", "file");

const ok = M.ccall("wasm_boot", "number", ["string"], [""]);
console.log("wasm_boot ->", ok);

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`OK   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// Drive the boot + attach sequence exactly as puae_app.js's frame() does:
// tick, poll tryExec() until it arms the AllocMem breakpoint (execReady),
// then on each breakpoint hit check getCurrentProcess() — resume if it's
// not our "file" CLI process yet, stop once it is.
//
// The DH0: filesys handler runs on a real pthread now (Emscripten
// -pthread/-sUSE_PTHREADS); its MEMFS calls are proxied to this (main)
// thread and only get processed when the event loop turns, so we must
// yield after every tick or the proxy queue starves and uaehf.device hangs
// forever in WaitPort(). puae_app.js's render loop (driven by a
// setInterval-based tick worker, ~1-2 ticks per callback) yields between
// callbacks the same way.
let execReady = false;
let attached = false;
let allocMemAddr = 0;
let proc = null;

const MAX_TICKS = 6000;
let i = 0;
for (; i < MAX_TICKS && !attached; i++) {
  M._wasm_tick();
  await new Promise((r) => setImmediate(r));

  if (!execReady) {
    const r = tryExec(M);
    if (r.ready) {
      execReady = true;
      allocMemAddr = r.allocMemAddr;
    }
  }

  if (M._wasm_is_paused()) {
    if (execReady) {
      proc = getCurrentProcess(M);
      if (proc) {
        M._wasm_remove_breakpoint(allocMemAddr);
        attached = true;
      } else {
        M._wasm_resume();
      }
    } else {
      M._wasm_resume();
    }
  }
}

console.log(`Finished after ${i} ticks (execReady=${execReady}, attached=${attached})`);

check("execReady becomes true within MAX_TICKS", execReady);
check("attached to the 'file' CLI process within MAX_TICKS", attached, JSON.stringify(proc));
check("getCurrentProcess.command is 'file'", proc?.command === "file", JSON.stringify(proc));
check(
  "getCurrentProcess.segments is non-empty",
  Array.isArray(proc?.segments) && proc.segments.length > 0,
  JSON.stringify(proc),
);

if (proc?.segments) {
  for (const seg of proc.segments) {
    check(
      `segment start 0x${seg.start.toString(16)} is a plausible address`,
      seg.start > 0 && seg.start < 0x10000000,
      JSON.stringify(seg),
    );
    check(
      `segment size 0x${seg.size.toString(16)} is plausible`,
      seg.size > 0 && seg.size < 0x100000,
      JSON.stringify(seg),
    );
  }
}

console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
