# Configuration reference

Full schema with inline documentation is available via IntelliSense in `launch.json`. Key options:

| Option | Purpose |
|---|---|
| `program` | Path to the executable to run |
| `debugProgram` | Separate file to read debug symbols from, if different from `program` |
| `fastLoad` | Inject the program directly into memory instead of booting from disk |
| `hardDrivePath` | (non-`fastLoad`) Mount a host directory as `DH0:` instead of the auto-generated single-program disk — lets the program use its own libraries, data files, and `s/startup-sequence` |
| `kickstartRom` | Path to the Kickstart ROM file (required) |
| `emulatorConfigFile` | Base WinUAE-format `.uae` file |
| `emulatorOptions` | Raw WinUAE `.uae` key/value overrides — `quickstart` machine presets (e.g. `"A1200,1"`), CPU/chipset/RAM sizing, floppy/sound/display options, and any other WinUAE key |
| `stopOnEntry` | Pause immediately after launch |

Every WinUAE `.uae` config key is accepted under `emulatorOptions` (a subset has IntelliSense/validation; anything else is passed through verbatim), so existing WinUAE quickstart configs or hand-tuned setups carry over directly. `emulatorConfigFile` can point at a full `.uae` file to use as a base, with `emulatorOptions` overriding individual keys.