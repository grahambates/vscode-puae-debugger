// Wraps puae-wasm/build.sh so it can be run as `npm run build:wasm` instead
// of the manual WSL2 invocation documented in CLAUDE.md.
//
// There's no Emscripten toolchain on native Windows, so the actual build
// must run under WSL2 there — this just automates the
// `wsl -e bash -lc "source ~/emsdk/emsdk_env.sh && cd <path> && bash build.sh"`
// invocation, translating the repo path via `wsl wslpath` rather than
// assuming a fixed /mnt/<drive> layout. On any other platform (the build
// also works under a native Linux/macOS emsdk setup, e.g. CI), it just runs
// build.sh directly, assuming emsdk is already sourced into the
// environment npm itself is running in — the same prerequisite build.sh
// already documents.

import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const puaeWasmDir = path.resolve(__dirname, "..", "puae-wasm");

let result;
if (process.platform === "win32") {
  // `-e` runs wslpath directly (bypassing the default-shell command-line
  // re-parsing `wsl <command> <args>` does without it, which was stripping
  // backslashes out of the Windows path before wslpath ever saw it).
  const wslPath = execFileSync("wsl", ["-e", "wslpath", "-a", puaeWasmDir], { encoding: "utf8" }).trim();
  const command = `source ~/emsdk/emsdk_env.sh > /dev/null 2>&1 && cd '${wslPath}' && bash build.sh`;
  result = spawnSync("wsl", ["-e", "bash", "-lc", command], { stdio: "inherit" });
} else {
  result = spawnSync("bash", ["build.sh"], { cwd: puaeWasmDir, stdio: "inherit" });
}

process.exit(result.status ?? 1);
