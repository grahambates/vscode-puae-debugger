// Shared helper for the wasm test scripts (test_g*.mjs, test_reset.mjs,
// test_reverse.mjs): reads a fixture file from puae/ (a real Kickstart ROM
// and/or demo ADF — copyrighted, so not committed; see CLAUDE.md). These
// are genuinely useful integration tests (they boot the actual wasm module
// against real firmware and have caught real regressions), but they're
// pointless to run without the fixtures — rather than letting `fs.readFileSync`
// throw a raw ENOENT and fail the whole `npm run test:wasm` chain, skip
// cleanly with a clear message when the fixture isn't present locally.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const fixturesDir = fileURLToPath(new URL("../../puae", import.meta.url));

// Reads `name` (e.g. "kick34005.A500") from puae/, or exits 0 with a
// skip message if it isn't present — call this before any other work, so a
// missing fixture skips fast and doesn't leave a half-booted module behind.
export function readFixture(name) {
  const path = fileURLToPath(new URL("../../puae/" + name, import.meta.url));
  if (!fs.existsSync(path)) {
    console.log(`SKIP ${process.argv[1]}: ${name} not found in ${fixturesDir} (copyrighted, supply your own — see CLAUDE.md)`);
    process.exit(0);
  }
  return fs.readFileSync(path);
}
