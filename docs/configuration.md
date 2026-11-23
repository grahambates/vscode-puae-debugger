# Configuration reference

Full schema with inline documentation is available via IntelliSense in `launch.json`. Key options:

| Option | Purpose |
|---|---|
| `program` | Path to the executable to run |
| `macroListing` | Wide vasm listing from the same directly assembled Hunk executable, for expanded macro and repeat source |
| `debugProgram` | Separate file to read debug symbols from, if different from `program` |
| `fastLoad` | Inject the program directly into memory instead of booting from disk |
| `hardDrivePath` | (non-`fastLoad`) Mount a host directory as `DH0:` instead of the auto-generated single-program disk — lets the program use its own libraries, data files, and `s/startup-sequence` |
| `kickstartRom` | Path to the Kickstart ROM file (required) |
| `emulatorConfigFile` | Base WinUAE-format `.uae` file |
| `emulatorOptions` | Raw WinUAE `.uae` key/value overrides — `quickstart` machine presets (e.g. `"A1200,1"`), CPU/chipset/RAM sizing, floppy/sound/display options, and any other WinUAE key |
| `stopOnEntry` | Pause immediately after launch |

Every WinUAE `.uae` config key is accepted under `emulatorOptions` (a subset has IntelliSense/validation; anything else is passed through verbatim), so existing WinUAE quickstart configs or hand-tuned setups carry over directly. `emulatorConfigFile` can point at a full `.uae` file to use as a base, with `emulatorOptions` overriding individual keys.

## View expanded macro and repeat source

Generate a wide listing alongside a directly assembled Hunk executable. An absolute source path lets the preview link directly to it. Relative source names can be linked when they uniquely match the executable’s debug sources.

```sh
vasmm68k_mot -Fhunkexe -linedebug -L program.lst -Lall -Lbpl=32 -o program /absolute/path/to/main.s
```

Set `macroListing` in your PUAE launch configuration to the listing path, such as `${workspaceFolder}/out/program.lst`. When execution stops in a macro or `rept` block, substituted instructions appear as inlay hints after the instruction and before any trailing comment throughout the active macro invocation or repeat iteration. VS Code controls their visibility through `editor.inlayHints.enabled`. With a matching listing, Step In and Step Over stop within the expansion even when successive instructions share a source line. Step Over still skips calls. The annotations update together when the active invocation or iteration changes and clear when execution resumes. Hover over an inlay hint to see the full expansion with the stopped instruction marked. To open the expansion in its own tab, run **PUAE Debugger: Show Expanded Source**. The read-only tab selects the stopped instruction and links to the macro invocation or `rept` directive and, where available, the mapped template line. Both views use the assembler’s source text and substitute `REPTN` with the iteration number from the listing while preserving other symbols. Relative listing paths resolve from the launch configuration’s workspace folder. The debugger matches listing sections to Hunks in executable order, verifies the listing bytes against the executable, and accounts for loader relocations when checking live memory. This preview supports directly assembled builds.
