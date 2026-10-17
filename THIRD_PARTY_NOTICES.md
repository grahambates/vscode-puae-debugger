# Third-Party Notices

PUAE Debugger contains software derived from third-party projects. The
notices below do not imply endorsement by the original authors. Copyright
notices and license headers in individual source files remain applicable.

## libretro-uae / PUAE

The emulator source in `puae-wasm/libretro-uae/` and the generated
`puae/puae.js` and `puae/puae.wasm` are derived from
[libretro-uae](https://github.com/libretro/libretro-uae), which is itself
derived from UAE and WinUAE.

The applicable upstream license is the GNU General Public License version 2.
See `puae-wasm/libretro-uae/COPYING`, `LICENSES/GPL-2.0-only.txt`, and the
copyright and license notices in the upstream source tree. Some bundled
upstream files and dependencies carry additional compatible licenses; their
file-level notices remain authoritative.

This project adds and modifies the wasm frontend and debugging integration.

## vscode-amiga-debug

Portions of the debugger, profiler, hardware visualizers, documentation data
(including the Kickstart symbol files in `kickstart/symbols/`), and webview code
are adapted from
[vscode-amiga-debug](https://github.com/BartmanAbyss/vscode-amiga-debug),
copyright Bartman/Abyss and contributors. Bartman/Abyss also contributed
directly to this project's history, while it was distributed under GPL
version 3.

The upstream project is distributed under the GNU General Public License
version 3 (`LICENSES/GPL-3.0-only.txt`). Bartman/Abyss has given permission for
his contributions, both those adapted from vscode-amiga-debug and those made
directly to this project, to be distributed under GPL version 2 as part of this
project.

## vscode-js-profile-visualizer

Parts of the profiler viewer (flame graph, top-down/bottom-up call trees, time
view, middle-out compression, filtering and display helpers) derive, via
vscode-amiga-debug, from
[vscode-js-profile-visualizer](https://github.com/microsoft/vscode-js-profile-visualizer),
copyright Microsoft Corporation, distributed under the MIT License. See
`LICENSES/MIT-vscode-js-profile-visualizer.txt`.

## Amiga Hardware Reference Manual

The custom-register documentation shown in the profiler and DMA tooltips
(`src/webview/shared/customRegisterDocs.ts`) is transcribed from the Amiga
Hardware Reference Manual, by way of vscode-amiga-debug's register docs.

## engine9000-public

Portions of the emulator debugging architecture and integration are adapted
from [engine9000-public](https://github.com/alpine9000/engine9000-public),
copyright Enable Software Pty Ltd and contributors.

Unless otherwise specified by its upstream file-level notices,
engine9000-public is distributed under the GNU General Public License version
2. See `LICENSES/GPL-2.0-only.txt`. The upstream project also contains
components under other licenses; applicable notices must be retained for any
such component incorporated here.

## Modifications and source

The third-party material has been modified for the VS Code extension,
browser/webview, and WebAssembly architecture. The Git history records the
dates and content of those modifications.

The corresponding source for the checked-in JavaScript and WebAssembly
binaries consists of this repository at the matching release tag, including
the pinned `puae-wasm/libretro-uae/` source and the build scripts under
`puae-wasm/` and `scripts/`.
