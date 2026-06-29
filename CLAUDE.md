# CLAUDE.md

Guidance for working in this repo (vscode-vamiga-debugger), a VS Code extension
that debugs Amiga programs against two in-browser/webview emulator backends:
**vAmiga** (`vamiga/`, `vamigaweb_fork/` — the C++ source) and **PUAE**
(`puae/`, `puae-wasm/` — the C source, currently the active development
focus, branch `puae-spike`).

## Repo layout (the parts that aren't obvious)

- `src/` — the extension host (TypeScript, Node, bundled by esbuild to
  `out/extension.js`).
- `src/webview/` — webview-side TypeScript (React for `memoryViewer`,
  `profilerViewer`, `stateViewer`; plain DOM for `puaeApp`). Excluded from the
  root `tsconfig.json`; type-checked separately via
  `src/webview/tsconfig.json` (`npm run check-types` runs both).
- `src/shared/` — code with **no Node or vscode imports**, shared between the
  extension host and webviews (e.g. `copperDisassembler.ts`,
  `profilerTypes.ts`). Anything reusable on both sides goes here.
- `puae/` — static assets served into the PUAE webview panel: `index.html`,
  `debug.html` (a standalone dev/test page, not used by the extension),
  `puae.js`/`puae.wasm` (Emscripten build output — **checked in**, see
  below), `puae_rpc.js`'s C-side pieces are gone now (ported to
  `src/webview/puaeApp/`, see below).
- `src/webview/puaeApp/` — the PUAE webview's app logic (boot/render loop,
  RPC dispatcher, audio worklet processor, the copper-overlay hover
  tooltip), TypeScript, bundled by `esbuild.js` to `out/puaeApp.js` /
  `out/puaeAudioProcessor.js` / `out/puaeRpc.mjs` (the last one is a
  standalone non-bundled-with-app build, importable directly under plain
  Node — see `puae-wasm/test/*.mjs`).
- `puae-wasm/` — the C source for the PUAE wasm backend: `puae_debug.c`/
  `puae_debug.h` (the debug-bridge glue this project adds, labeled
  `puae_debug:` in comments) / `frontend_shim.c` (the minimal libretro
  frontend driving it from JS), `libretro-uae/` (a **git submodule**,
  patched fork of libretro-uae, branch `vscode_vamiga_debugger`),
  `build.sh` (builds `puae.js`/`puae.wasm`, normally invoked via `npm run
  build:wasm`), `test/*.mjs` (Node-driven integration tests, run by `npm
  run test:wasm`).
- `vamigaweb_fork/` — the C++ vAmiga core (a fork, not a submodule — check
  `git log` there before assuming it's pristine upstream vAmiga).

## Building/rebuilding the PUAE wasm binary

**`puae/puae.js`/`puae/puae.wasm` are prebuilt, checked-in binaries.**
Any change to `puae-wasm/` C sources (`puae_debug.c`/`.h`, `frontend_shim.c`,
`puae-wasm/libretro-uae/**`) requires rebuilding them — the source change
alone does nothing at runtime until rebuilt.

There is **no Emscripten toolchain on the Windows/PowerShell/Git-Bash side**.
The toolchain lives in **WSL2** (Ubuntu), with emsdk already installed at
`~/emsdk` (already activated/built — `~/emsdk/upstream/emscripten/emcc`
exists).

Run **`npm run build:wasm`** to build — it wraps `scripts/build-wasm.mjs`,
which on Windows shells out to `wsl -e bash -lc "source ~/emsdk/emsdk_env.sh
&& cd <repo path translated via wslpath> && bash build.sh"` automatically (on
non-Windows platforms it just runs `build.sh` directly, assuming emsdk is
already on `PATH`). Equivalent manual invocation, if you need to tweak
something the wrapper doesn't expose:

```bash
wsl -e bash -lc "source ~/emsdk/emsdk_env.sh > /dev/null 2>&1 && cd /mnt/c/Users/hello/Documents/projects/vscode-vamiga-debugger/puae-wasm && bash build.sh"
```

Notes/gotchas, all hit during the first attempt at this:

- **Don't run `./build.sh` directly** — on a Windows checkout (`core.autocrlf
  = true`), shell scripts get checked out with CRLF line endings, which
  breaks bash's shebang (`/usr/bin/env: 'bash\r'`) and the script body. Either
  invoke as `bash build.sh` (works even with CRLF, since `bash` itself
  tolerates `\r` better than the kernel's shebang line does — though it can
  still choke mid-script on some constructs) or, more robustly, make sure the
  file is LF on disk (`sed -i 's/\r$//' puae-wasm/build.sh`). A root
  `.gitattributes` (`*.sh text eol=lf`) now forces this for future checkouts,
  but a pre-existing working tree may still have CRLF until re-checked-out.
- **`source ~/emsdk/emsdk_env.sh` must run in the *same* `bash -lc` invocation
  as the build** (or you must use the full path to `emcc`/`emar`/`emranlib`
  directly) — env vars from one `wsl -e bash -lc "..."` call don't persist to
  a separate one.
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
  against the built `puae.wasm`. **Requires local-only files not committed to
  the repo**: `puae/kick34005.A500` (a real Kickstart ROM) and `puae/demo.adf`
  — copyrighted, so you need to supply your own. Without them, each script
  prints a `SKIP ...` line and exits 0 (via `puae-wasm/test/fixtures.mjs`'s
  `readFixture`) rather than failing — that's an environment gap, not a
  regression, if you don't have the files.
- `npm test` runs both, with `pretest` (`compile` + `lint`) auto-running
  first via npm's lifecycle hook.

## Conventions

- Never `npm install` / add dependencies without checking this is actually
  needed — this project leans on hand-rolled glue (e.g. its own RPC
  dispatcher) rather than libraries where reasonable.
- When porting/adding code shared between the extension host and a webview,
  put it in `src/shared/` and make sure it has zero `vscode`/Node-only
  imports — both `tsconfig.json` (root) and `src/webview/tsconfig.json`
  type-check it.
- `src/webview/puaeApp/` is now TypeScript (ported from plain JS) to match
  the other webviews and reuse `src/shared/` code (e.g.
  `copperDisassembler.ts`). The old `puae/puae_app.js` / `puae_rpc.js` /
  `puae_audioprocessor.js` are deleted; don't recreate them — extend the TS
  sources and let `esbuild.js` bundle them.
