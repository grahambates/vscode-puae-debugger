import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toJavaScriptStringLiteral, walkHardDrive } from "../puaeEmulator";
import { stableStringify } from "../webviewEmulator";

describe("stableStringify", () => {
  it("treats recursively reordered object keys as equal", () => {
    const a = {
      emulatorOptions: { cpu_model: 68000, chipset: "ocs" },
      stopOnEntry: true,
    };
    const b = {
      stopOnEntry: true,
      emulatorOptions: { chipset: "ocs", cpu_model: 68000 },
    };

    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("distinguishes changes to nested emulator options", () => {
    const a = { emulatorOptions: { cpu_model: 68000 } };
    const b = { emulatorOptions: { cpu_model: 68020 } };

    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it("preserves array order", () => {
    expect(stableStringify({ values: [1, 2] })).not.toBe(
      stableStringify({ values: [2, 1] }),
    );
  });
});

describe("toJavaScriptStringLiteral", () => {
  it("produces executable literals for special-character filenames", () => {
    const filename = "Bob's\\demo\nrelease.exe";
    const literal = toJavaScriptStringLiteral(filename);

    const evaluate = new Function(`return ${literal}`) as () => string;
    expect(evaluate()).toBe(filename);
  });
});

describe("walkHardDrive", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hddrive-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists files with base64-encoded contents", () => {
    writeFileSync(join(root, "mygame"), Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const entries = walkHardDrive(root);

    expect(entries).toEqual([
      { path: "mygame", dir: false, dataB64: Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64") },
    ]);
  });

  it("lists directories before their contents, with forward-slash relative paths", () => {
    mkdirSync(join(root, "s"));
    writeFileSync(join(root, "s", "startup-sequence"), "stack 8192\nmygame\n");
    mkdirSync(join(root, "libs"));
    writeFileSync(join(root, "libs", "foo.library"), "lib-data");
    writeFileSync(join(root, "mygame"), "exe-data");

    const entries = walkHardDrive(root);
    const paths = entries.map((e) => e.path);

    // Each directory must appear before anything nested inside it.
    expect(paths.indexOf("s")).toBeLessThan(paths.indexOf("s/startup-sequence"));
    expect(paths.indexOf("libs")).toBeLessThan(paths.indexOf("libs/foo.library"));

    const startupEntry = entries.find((e) => e.path === "s/startup-sequence");
    expect(startupEntry?.dir).toBe(false);
    expect(Buffer.from(startupEntry!.dataB64!, "base64").toString("utf-8")).toBe("stack 8192\nmygame\n");

    const sDirEntry = entries.find((e) => e.path === "s");
    expect(sDirEntry?.dir).toBe(true);
    expect(sDirEntry?.dataB64).toBeUndefined();
  });

  it("returns an empty list for an empty directory", () => {
    expect(walkHardDrive(root)).toEqual([]);
  });

  it("handles nested subdirectories recursively", () => {
    mkdirSync(join(root, "data", "levels"), { recursive: true });
    writeFileSync(join(root, "data", "levels", "level1.dat"), "level-data");

    const entries = walkHardDrive(root);
    const paths = entries.map((e) => e.path);

    expect(paths).toContain("data");
    expect(paths).toContain("data/levels");
    expect(paths).toContain("data/levels/level1.dat");
    expect(paths.indexOf("data")).toBeLessThan(paths.indexOf("data/levels"));
    expect(paths.indexOf("data/levels")).toBeLessThan(paths.indexOf("data/levels/level1.dat"));
  });
});
