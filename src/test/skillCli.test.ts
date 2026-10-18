// Tests for `puae-debugger skill install`, against the repo's own packaged skills and a temp
// directory standing in for the user's project.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { runSkillCli, SKILLS } from "../standalone/skillCli";

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const installed = (root: string, name: string) => path.join(root, ".claude", "skills", name, "SKILL.md");

describe("skill install", () => {
  let root: string;
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "skill-test-"));
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    err = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    log.mockRestore();
    err.mockRestore();
  });

  it("installs every packaged skill", () => {
    expect(runSkillCli(["install"], PACKAGE_ROOT, root)).toBe(0);
    for (const { name } of SKILLS) {
      expect(readFileSync(installed(root, name), "utf8")).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    }
  });

  it("adds a missing skill without touching one already installed", () => {
    // Someone who installed the profiling skill before the debugging one existed.
    runSkillCli(["install"], PACKAGE_ROOT, root);
    writeFileSync(installed(root, "puae-profiling"), "local edits");
    rmSync(path.dirname(installed(root, "puae-debugging")), { recursive: true });
    expect(runSkillCli(["install"], PACKAGE_ROOT, root)).toBe(0);
    expect(readFileSync(installed(root, "puae-profiling"), "utf8")).toBe("local edits");
    expect(existsSync(installed(root, "puae-debugging"))).toBe(true);
  });

  it("fails when there's nothing to do, and --force updates", () => {
    runSkillCli(["install"], PACKAGE_ROOT, root);
    writeFileSync(installed(root, "puae-profiling"), "stale");
    expect(runSkillCli(["install"], PACKAGE_ROOT, root)).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toMatch(/--force/);
    expect(runSkillCli(["install", "--force"], PACKAGE_ROOT, root)).toBe(0);
    expect(readFileSync(installed(root, "puae-profiling"), "utf8")).not.toBe("stale");
  });
});
