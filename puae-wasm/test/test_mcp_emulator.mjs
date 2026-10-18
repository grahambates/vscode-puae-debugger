// End-to-end test for the emulator-backed MCP tools (src/mcp/emulatorTools.ts), driven the way a
// real client drives them: spawn `puae-debugger mcp`, speak JSON-RPC over its stdio, and check
// what comes back.
//
// Lives here rather than in the jest suite because it needs the same thing every other script in
// this directory needs — a real Kickstart ROM — and skips the same way when there isn't one.
//
// Two things this catches that a unit test cannot:
//   * stdout discipline. The wasm module logs its own boot progress (frontend_shim.c's EM_ASM
//     console.log, and PUAE's write_log through Emscripten's print), and stdout here IS the
//     protocol stream. That pollution shipped once and broke the client's JSON parser on the
//     first emulator call; any recurrence fails the parse below.
//   * that a headless capture is actually valid — checked against the same invariants
//     profile_check applies, not merely produced without throwing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFixture } from "./fixtures.mjs";

// Presence check only — the server is given the path and reads it itself.
readFixture("kick34005.A500");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const romPath = path.join(repoRoot, "puae", "kick34005.A500");
const program = path.join(repoRoot, "src", "test", "fixtures", "amigaPrograms", "gencop");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "puae-mcp-test-"));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
  if (!ok) failures++;
}

const proc = spawn("node", [path.join(repoRoot, "out", "standalone.js"), "mcp"], {
  stdio: ["pipe", "pipe", "ignore"], // stderr ignored: the emulator's own logging goes there
});

// One JSON object per line, so anything that isn't valid JSON is stdout pollution by definition.
let buffer = "";
const pending = new Map();
let parseErrors = 0;
proc.stdout.on("data", (data) => {
  buffer += data.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } catch {
      parseErrors++;
      console.log(`     stdout pollution: ${line.slice(0, 80)}`);
    }
  }
});

let nextId = 0;
function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const callTool = async (name, args) => (await call("tools/call", { name, arguments: args })).result;

const init = await call("initialize", { protocolVersion: "2025-06-18" });
check("initialize answers with serverInfo", init?.result?.serverInfo?.name === "puae-debugger",
  JSON.stringify(init));

const tools = (await call("tools/list", {})).result.tools.map((t) => t.name);
check("emulator tools are listed", tools.includes("emulator_screenshot") && tools.includes("emulator_capture_profile"),
  tools.join(", "));

// --- emulator_screenshot ---
const pngPath = path.join(outDir, "shot.png");
const shot = await callTool("emulator_screenshot", { program, kickstartRom: romPath, frames: 30, out: pngPath });
check("emulator_screenshot succeeds", shot.isError !== true, shot.content?.[0]?.text);
check("emulator_screenshot writes a file", fs.existsSync(pngPath));
if (fs.existsSync(pngPath)) {
  const png = fs.readFileSync(pngPath);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  check("screenshot is a PNG", signature.every((b, i) => png[i] === b), png.subarray(0, 8).toString("hex"));
  // IHDR's width/height, big-endian at a fixed offset — the emulator's full PAL framebuffer,
  // not a thumbnail.
  check("screenshot is the full framebuffer", png.readUInt32BE(16) === 720 && png.readUInt32BE(20) === 574,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
}

// --- emulator_capture_profile ---
const capturePath = path.join(outDir, "capture.puaeprofile");
const capture = await callTool("emulator_capture_profile", {
  program, kickstartRom: romPath, warmupFrames: 20, frames: 2, out: capturePath,
});
check("emulator_capture_profile succeeds", capture.isError !== true, capture.content?.[0]?.text);
check("capture is written", fs.existsSync(capturePath));
const captureText = capture.content?.[0]?.text ?? "";
check("capture reports the entry point", /entry point 0x[0-9a-f]+/.test(captureText), captureText.slice(0, 120));
// The tool runs profile_check itself; a headless capture that doesn't add up is the whole risk.
check("captured frames pass profile_check", captureText.includes("OK — no findings"), captureText);

// ...and the capture is readable by the analysis tools, which is the point of producing it.
const dump = await callTool("profile_dump", { file: capturePath, functions: 3 });
check("profile_dump reads the headless capture", dump.isError !== true && /Frame 0:/.test(dump.content[0].text),
  dump.content?.[0]?.text?.slice(0, 120));
check("capture symbolicates to real function names", /WaitRaster/.test(dump.content[0].text),
  dump.content?.[0]?.text?.slice(0, 200));

// The DMA snapshot must be the state at the start of the frame it's attached to (the last one),
// copied C-side at the true frame boundary — reconstruction replays the frame's writes over it.
// Read back through the CLI's JSON, which carries the manifest's per-frame metadata.
{
  const { spawnSync } = await import("node:child_process");
  const json = spawnSync("node", [path.join(repoRoot, "out", "standalone.js"), "profile", "dump", capturePath, "--json"], { encoding: "utf8" });
  let meta;
  try { meta = JSON.parse(json.stdout).manifest.frameMeta; } catch { meta = undefined; }
  check("the capture's snapshot is the last frame's start state", meta?.[meta.length - 1]?.snapshotAtFrameStart === true,
    JSON.stringify(meta));
}

// A restore must not cost an extra frame: PUAE never presents the first frame after a restore,
// so without ending that frame at the true boundary, "run N frames" after a restore ran N+1.
// Rerunning from the launch snapshot must therefore land on exactly the same picture.
{
  const launch = await callTool("emulator_launch", { program, kickstartRom: romPath });
  const session = /Session (s\d+)/.exec(launch.content?.[0]?.text ?? "")?.[1];
  const first = path.join(outDir, "rerun-a.png");
  const second = path.join(outDir, "rerun-b.png");
  await callTool("emulator_screenshot", { session, frames: 20, out: first });
  await callTool("emulator_snapshot", { session, restore: "start" });
  await callTool("emulator_screenshot", { session, frames: 20, out: second });
  check("a rerun from the launch snapshot reproduces the same frame",
    fs.existsSync(first) && fs.existsSync(second) && fs.readFileSync(first).equals(fs.readFileSync(second)));
  // ...and a one-shot screenshot at the same frame agrees with the session's.
  const oneShot = path.join(outDir, "oneshot.png");
  await callTool("emulator_screenshot", { program, kickstartRom: romPath, frames: 20, out: oneShot });
  check("a one-shot screenshot matches a session's at the same frame",
    fs.existsSync(oneShot) && fs.readFileSync(oneShot).equals(fs.readFileSync(first)));
  await callTool("emulator_close", { session });
}

// Reverse execution lands exactly: forward N instructions then back N is where it started.
{
  const launch = await callTool("emulator_launch", { program, kickstartRom: romPath, breakpoints: ["WaitRaster"] });
  const session = /Session (s\d+)/.exec(launch.content?.[0]?.text ?? "")?.[1];
  await callTool("emulator_continue", { session, maxFrames: 30 });
  const regs = async () => ((await callTool("emulator_inspect", { session })).content?.[0]?.text ?? "").split("\n").filter((l) => /^(d0|a0|pc)=/.test(l)).join("\n");
  const before = await regs();
  await callTool("emulator_step", { session, count: 7 });
  const back = await callTool("emulator_reverse", { session, mode: "step", count: 7 });
  check("emulator_reverse steps back", back.isError !== true && /Went back 7 instructions/.test(back.content?.[0]?.text ?? ""), back.content?.[0]?.text);
  check("stepping back lands exactly where stepping forward started", before.length > 0 && (await regs()) === before);
  await callTool("emulator_close", { session });
}

// --- argument handling ---
const missing = await callTool("emulator_screenshot", { program: "/definitely/not/here.exe", kickstartRom: romPath });
check("a missing program is an isError result, not a crash", missing.isError === true,
  missing.content?.[0]?.text);
const overCap = await callTool("emulator_capture_profile", { program, kickstartRom: romPath, frames: 9999 });
check("an out-of-range frame count is refused before booting", overCap.isError === true && /capped/.test(overCap.content[0].text),
  overCap.content?.[0]?.text);

// --- a persistent session: run to a breakpoint, look around, run on ---
// The one-shot tools above can't test any of this: the whole point is that the machine survives
// between calls, so what one call left behind is what the next one sees.
{
  const launch = await callTool("emulator_launch", { program, kickstartRom: romPath, breakpoints: ["moveloop"] });
  check("emulator_launch starts a session", launch.isError !== true, launch.content?.[0]?.text);
  const sessionId = /Session (s\d+)/.exec(launch.content[0].text)?.[1];
  check("emulator_launch returns a session id", !!sessionId, launch.content[0].text);
  check("emulator_launch resolves a symbol breakpoint to an address",
    /moveloop -> 0x[0-9a-f]{8}/.test(launch.content[0].text), launch.content[0].text);

  const cont = await callTool("emulator_continue", { session: sessionId, maxFrames: 200 });
  check("emulator_continue stops at the breakpoint", /Stopped: BREAKPOINT_REACHED/.test(cont.content[0].text),
    cont.content?.[0]?.text);
  check("the stop reports a source location, not just an address", /\.s:\d+/.test(cont.content[0].text),
    cont.content?.[0]?.text);

  const inspect = await callTool("emulator_inspect", { session: sessionId, memory: [{ address: "moveloop", bytes: 32 }] });
  const inspectText = inspect.content?.[0]?.text ?? "";
  check("emulator_inspect reports registers", /d0=0x[0-9a-f]{8}.*d7=0x[0-9a-f]{8}/.test(inspectText), inspectText);
  // Frame 0 is the current PC, per StackManager's convention — getCallstack() alone is
  // outermost-first and omits it, which is exactly the mistake this asserts against.
  check("call stack starts at the current location", /#0 0x[0-9a-f]{8} \(moveloop/.test(inspectText), inspectText);
  check("emulator_inspect dumps requested memory", /Memory at moveloop \(0x[0-9a-f]{8}\), 32 bytes:/.test(inspectText),
    inspectText);

  const stepped = await callTool("emulator_step", { session: sessionId, count: 3 });
  check("emulator_step moves the PC", /Stepped 3 instruction\(s\)\. Now at 0x[0-9a-f]{8}/.test(stepped.content[0].text),
    stepped.content?.[0]?.text);
  check("stepping lands past the breakpoint address", !/Now at 0x[0-9a-f]*\(moveloop,/.test(stepped.content[0].text),
    stepped.content?.[0]?.text);

  // The breakpoint is still armed: a second continue reaches it again on the next iteration.
  const again = await callTool("emulator_continue", { session: sessionId, maxFrames: 200 });
  check("breakpoints stay armed across continues", /Stopped: BREAKPOINT_REACHED/.test(again.content[0].text),
    again.content?.[0]?.text);

  // ...and a screenshot of a session defaults to "as it stands now", without running it on.
  const sessionShot = path.join(outDir, "session.png");
  const shotResult = await callTool("emulator_screenshot", { session: sessionId, out: sessionShot });
  check("emulator_screenshot works on a live session",
    shotResult.isError !== true && fs.existsSync(sessionShot), shotResult.content?.[0]?.text);
  check("a session screenshot doesn't advance the machine",
    /without running it on/.test(shotResult.content?.[0]?.text ?? ""), shotResult.content?.[0]?.text);

  const closed = await callTool("emulator_close", { session: sessionId });
  check("emulator_close frees the session", /Closed session/.test(closed.content[0].text), closed.content?.[0]?.text);
  const afterClose = await callTool("emulator_inspect", { session: sessionId });
  check("using a closed session explains itself", afterClose.isError === true && /is gone/.test(afterClose.content[0].text),
    afterClose.content?.[0]?.text);
}

check("no stdout pollution across the whole session", parseErrors === 0, `${parseErrors} unparseable line(s)`);

proc.kill();
fs.rmSync(outDir, { recursive: true, force: true });
console.log("");
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
