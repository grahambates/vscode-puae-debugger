# AGENTS.md

Guidance for working in this repo (vscode-puae-debugger), a VS Code extension
that debugs Amiga programs against an in-browser/webview PUAE (WinUAE-derived)
emulator backend (`puae/`, `puae-wasm/` — the C source). The same debug adapter
also ships as a standalone npm CLI (`puae-debugger`).

## Repo layout (the parts that aren't obvious)

- `src/` — the extension host (TypeScript, Node, bundled by esbuild to
  `out/extension.js`).
- `src/standalone/` — the standalone DAP server / CLI (`puae-debugger` bin,
  bundled to `out/standalone.js`): serves the webviews to a browser tab over
  HTTP/WebSocket, plus the offline `profile dump|check` and `skill install`
  subcommands.
- `src/mcp/` — the `puae-debugger mcp` MCP server, including a headless
  emulator that loads `puae.wasm` + `out/puaeRpc.mjs` directly in Node.
- `src/webview/` — webview-side TypeScript (React for `memoryViewer`,
  `profilerViewer`, `stateViewer`; plain DOM for `puaeApp`). Excluded from the
  root `tsconfig.json`; type-checked separately via
  `src/webview/tsconfig.json` (`npm run check-types` runs both).
- `src/shared/` — code with **no Node or vscode imports**, shared between the
  extension host and webviews (e.g. `copperDisassembler.ts`,
  `profilerTypes.ts`). Anything reusable on both sides goes here.
- `puae/` — static assets served into the PUAE webview panel: `index.html`,
  `puae.js`/`puae.wasm` (Emscripten build output — **checked in**, see
  below), `vscodeDefaultTheme.css`. `debug.html` is a standalone dev/test
  page, not used by the extension. `demo.adf` is a test fixture.
- `src/webview/puaeApp/` — the PUAE webview's app logic (boot/render loop,
  RPC dispatcher, audio worklet processor, the copper-overlay hover
  tooltip), TypeScript, bundled by `esbuild.js` to `out/puaeApp.js` /
  `out/puaeAudioProcessor.js` / `out/puaeRpc.mjs` (the last one is a
  standalone non-bundled-with-app build, importable directly under plain
  Node — used by the MCP headless emulator and `puae-wasm/test/*.mjs`).
- `puae-wasm/` — the C source for the PUAE wasm backend: `puae_debug.c`/
  `puae_debug.h` (the debug-bridge glue this project adds, labeled
  `puae_debug:` in comments) / `frontend_shim.c` (the minimal libretro
  frontend driving it from JS), `libretro-uae/` (a **git submodule**,
  patched fork of libretro-uae), `build.sh` (builds `puae.js`/`puae.wasm`,
  normally invoked via `npm run build:wasm`), `test/*.mjs` (Node-driven
  integration tests, run by `npm run test:wasm`).
- `kickstart/symbols/*.elf` — Kickstart ROM symbol tables. Not loaded at
  runtime: `npm run gen:kickstart-symbols` compiles them into
  `src/kickstartSymbols.ts`.
- `.claude/skills/puae-profiling/` — the profiling skill, shipped in the npm
  package and installed into users' projects by `puae-debugger skill install`.

## Building/rebuilding the PUAE wasm binary

**`puae/puae.js`/`puae/puae.wasm` are prebuilt, checked-in binaries.**
Any change to `puae-wasm/` C sources (`puae_debug.c`/`.h`, `frontend_shim.c`,
`puae-wasm/libretro-uae/**`) requires rebuilding them — the source change
alone does nothing at runtime until rebuilt. Comment-only C changes don't.

emsdk is installed at `~/emsdk` (already activated/built). Build with
**`npm run build:wasm`**, which wraps `scripts/build-wasm.mjs`:

- **macOS/Linux:** it runs `build.sh` directly and expects emsdk on `PATH`,
  which it isn't in a fresh shell — source it in the same command:

  ```bash
  source ~/emsdk/emsdk_env.sh > /dev/null 2>&1 && npm run build:wasm
  ```

- **Windows:** there's no native Emscripten toolchain; emsdk lives in WSL2
  (Ubuntu, also at `~/emsdk`), and the wrapper shells out to
  `wsl -e bash -lc "source ~/emsdk/emsdk_env.sh && cd <repo path via wslpath> && bash build.sh"`
  automatically. Equivalent manual invocation:

  ```bash
  wsl -e bash -lc "source ~/emsdk/emsdk_env.sh > /dev/null 2>&1 && cd /mnt/c/Users/hello/Documents/projects/vscode-puae-debugger/puae-wasm && bash build.sh"
  ```

  `source ~/emsdk/emsdk_env.sh` must run in the *same* `bash -lc` call as the
  build — env vars don't persist between separate `wsl` invocations. Run it as
  `bash build.sh`, not `./build.sh`: a `core.autocrlf = true` checkout can give
  shell scripts CRLF endings, breaking the shebang. `.gitattributes` forces LF
  for `*.sh`, but an older working tree may need
  `sed -i 's/\r$//' puae-wasm/build.sh`.

Notes/gotchas:

- **`EXPORTED_FUNCTIONS` in `build.sh` (Stage 4's final `emcc` link) is a
  hardcoded allowlist.** Any new `wasm_*` C export needs to be added to that
  list (e.g. `"_wasm_my_new_export"`) or it silently won't exist on the JS
  `Module` object — no build error, just `M._wasm_my_new_export is not a
  function` at runtime. Easy to forget; check this list whenever adding a
  wasm export.
- The build takes a few minutes (libretro-uae + ~30 grafted libretro-common/
  zlib/7zip objects + final link). Run it with a generous timeout and/or in
  the background.
- Outputs go straight to `../puae/puae.js` / `../puae/puae.wasm` — no copy
  step needed afterward.
- After rebuilding, re-run `node esbuild.js` (or `npm run compile`) to make
  sure the TS side still matches — the wasm export list and the TS
  `PuaeModule` interface (`src/webview/puaeApp/types.ts`, loosely typed via
  index signature) aren't statically checked against each other.

## Testing

- `npm run test:unit` (jest) — pure TS, no wasm/ROM needed, fast.
- `npm run test:wasm` — runs `puae-wasm/test/*.mjs` directly under Node
  against the built `puae.wasm`. **Requires a real Kickstart ROM at
  `puae/kick34005.A500`**, which is gitignored and never committed (it's
  copyrighted — supply your own). `puae/demo.adf` is committed. A missing
  fixture makes each script print a `SKIP ...` line and exit 0 (via
  `puae-wasm/test/fixtures.mjs`'s `readFixture`) rather than failing — that's
  an environment gap, not a regression.
- `npm test` runs both, with `pretest` (`compile` + `lint`) auto-running
  first via npm's lifecycle hook.

## Packaging (VSIX and npm)

The repo publishes two artifacts from one `package.json`, and each has its own
**allowlist** of shipped files:

- **VSIX** — `.vscodeignore` excludes everything (`**`) and re-includes only
  what the extension loads at runtime. Packaging reads the working tree, so
  this is what keeps local files (the Kickstart ROM, `.puaeprofile` captures,
  `.claude/` state) out of the published extension.
- **npm** — the `files` array in `package.json`.

Any new file loaded at runtime (a new `out/` bundle, a `puae/` asset) must be
added to **both**, or it works locally and is missing once installed. Check
with `npx @vscode/vsce ls` and `npm pack --dry-run`.

Everything except `@vscode/codicons` is bundled by esbuild, so runtime
libraries belong in `devDependencies`. `dependencies` is only for packages
resolved from `node_modules` at runtime — currently just codicons (its CSS and
font are served to the webviews).

## Licensing

The project is GPL-2.0-only. `THIRD_PARTY_NOTICES.md` and `LICENSES/` record
where adapted code came from — keep them current. In particular:

- Don't bring in GPL-3.0-only code (or code under other GPL-2-incompatible
  licenses): the emulator core and engine9000-derived glue are GPL-2-only,
  and they run in the same process as the TypeScript.
- Porting code from elsewhere (including vscode-amiga-debug) is still
  copying it; keep the original's copyright/licence notices and add an entry
  to `THIRD_PARTY_NOTICES.md`. Some of vscode-amiga-debug's profiler UI is
  itself Microsoft MIT code from vscode-js-profile-visualizer.

## Conventions

- Never `npm install` / add dependencies without checking this is actually
  needed — this project leans on hand-rolled glue (e.g. its own RPC
  dispatcher) rather than libraries where reasonable.
- When porting/adding code shared between the extension host and a webview,
  put it in `src/shared/` and make sure it has zero `vscode`/Node-only
  imports — both `tsconfig.json` (root) and `src/webview/tsconfig.json`
  type-check it.
- `src/webview/puaeApp/` is TypeScript (ported from plain JS) to match the
  other webviews and reuse `src/shared/` code (e.g.
  `copperDisassembler.ts`). The old `puae/puae_app.js` / `puae_rpc.js` /
  `puae_audioprocessor.js` are deleted; don't recreate them — extend the TS
  sources and let `esbuild.js` bundle them.
