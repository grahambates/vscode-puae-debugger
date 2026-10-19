// Tests for `puae-debugger skill install`, against the repo's own packaged skills and a temp
// directory standing in for the user's project.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { installedState, outdatedSkills, runSkillCli, SKILLS, stampSkill } from "../standalone/skillCli";

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const installed = (root: string, name: string) => path.join(root, ".claude", "skills", name, "SKILL.md");
const packaged = (name: string) => readFileSync(installed(PACKAGE_ROOT, name), "utf8");
const OLD_SKILL = "---\nname: puae-profiling\ndescription: old\n---\n\nOld advice.\n";

describe("skill install", () => {
  let root: string;
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  const output = () => [...log.mock.calls, ...err.mock.calls].flat().join("\n");
  const install = (...args: string[]) => runSkillCli(["install", ...args], PACKAGE_ROOT, root, "2.0.0", {});
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

  it("installs every packaged skill, stamped with the version", () => {
    expect(install()).toBe(0);
    for (const { name } of SKILLS) {
      const text = readFileSync(installed(root, name), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      expect(text).toMatch(/\nmetadata:\n {2}puae-debugger-version: "2\.0\.0"\n {2}puae-debugger-sha256: [0-9a-f]{64}\n---\n/);
      expect(installedState(packaged(name), text)).toEqual({ kind: "current" });
    }
  });

  it("installs into .agents/skills with --agents, for Codex", () => {
    expect(install("--agents")).toBe(0);
    for (const { name } of SKILLS) {
      const text = readFileSync(path.join(root, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(installedState(packaged(name), text)).toEqual({ kind: "current" });
    }
    expect(existsSync(path.join(root, ".claude"))).toBe(false);
  });

  it("reports an up-to-date install as such, and succeeds", () => {
    install();
    const before = readFileSync(installed(root, "puae-profiling"), "utf8");
    log.mockClear();
    expect(install()).toBe(0);
    expect(output()).toMatch(/Up to date/);
    expect(readFileSync(installed(root, "puae-profiling"), "utf8")).toBe(before);
  });

  it("updates a copy an older version installed, without --force", () => {
    install();
    writeFileSync(installed(root, "puae-profiling"), stampSkill(OLD_SKILL, "1.5.0"));
    expect(install()).toBe(0);
    expect(output()).toMatch(/Updated puae-profiling from 1\.5\.0 to 2\.0\.0/);
    expect(installedState(packaged("puae-profiling"), readFileSync(installed(root, "puae-profiling"), "utf8"))).toEqual({ kind: "current" });
  });

  it("leaves an edited copy alone unless --force, which keeps a backup", () => {
    install();
    const edited = readFileSync(installed(root, "puae-profiling"), "utf8") + "\nMy own note.\n";
    writeFileSync(installed(root, "puae-profiling"), edited);
    expect(install()).toBe(1);
    expect(output()).toMatch(/changed since puae-debugger 2\.0\.0 installed it.*--force/);
    expect(readFileSync(installed(root, "puae-profiling"), "utf8")).toBe(edited);

    expect(install("--force")).toBe(0);
    expect(readFileSync(`${installed(root, "puae-profiling")}.bak`, "utf8")).toBe(edited);
    expect(installedState(packaged("puae-profiling"), readFileSync(installed(root, "puae-profiling"), "utf8"))).toEqual({ kind: "current" });
  });

  it("takes --force from npm when `npm exec` kept the flag for itself", () => {
    install();
    writeFileSync(installed(root, "puae-profiling"), "edited");
    expect(runSkillCli(["install"], PACKAGE_ROOT, root, "2.0.0", { npm_config_force: "true" })).toBe(0);
    expect(readFileSync(`${installed(root, "puae-profiling")}.bak`, "utf8")).toBe("edited");
  });

  it("treats an unstamped copy it doesn't recognise as edited", () => {
    mkdirSync(path.dirname(installed(root, "puae-profiling")), { recursive: true });
    writeFileSync(installed(root, "puae-profiling"), "someone else's skill");
    expect(install()).toBe(1);
    expect(output()).toMatch(/wasn't installed by puae-debugger/);
    expect(readFileSync(installed(root, "puae-profiling"), "utf8")).toBe("someone else's skill");
    // The other skill is still installed.
    expect(existsSync(installed(root, "puae-debugging"))).toBe(true);
  });

  it("accepts an unstamped copy identical to the packaged one, CRLF or not", () => {
    const source = packaged("puae-debugging");
    expect(installedState(source, source)).toEqual({ kind: "current" });
    expect(installedState(source, source.replace(/\n/g, "\r\n"))).toEqual({ kind: "current" });
  });

});

describe("outdatedSkills", () => {
  let cwd: string;
  let home: string;
  const put = (dir: string, name: string, text: string) => {
    mkdirSync(path.dirname(installed(dir, name)), { recursive: true });
    writeFileSync(installed(dir, name), text);
  };
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "skill-cwd-"));
    home = mkdtempSync(path.join(tmpdir(), "skill-home-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("is empty when nothing is installed, or everything is current", () => {
    expect(outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home)).toEqual([]);
    put(cwd, "puae-profiling", stampSkill(packaged("puae-profiling"), "1.9.0"));
    expect(outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home)).toEqual([]);
  });

  it("names each outdated copy with the command that updates it", () => {
    put(cwd, "puae-profiling", stampSkill(OLD_SKILL, "1.5.0"));
    put(home, "puae-debugging", stampSkill(OLD_SKILL, "1.6.0"));
    const notes = outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/puae-profiling.*from puae-debugger 1\.5\.0; .*`npx puae-debugger@2\.0\.0 skill install`/);
    expect(notes[1]).toMatch(/puae-debugging.*from puae-debugger 1\.6\.0; .*skill install --global`/);
  });

  it("checks .agents/skills too, and says to pass --agents", () => {
    const at = path.join(home, ".agents", "skills", "puae-profiling", "SKILL.md");
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, stampSkill(OLD_SKILL, "1.5.0"));
    const notes = outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/\.agents.*skill install --global --agents`/);
  });

  it("ignores edits to a current copy, but not an edited old one", () => {
    put(cwd, "puae-profiling", stampSkill(packaged("puae-profiling"), "2.0.0") + "\nMine.\n");
    expect(outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home)).toEqual([]);
    put(cwd, "puae-profiling", stampSkill(OLD_SKILL, "1.5.0") + "\nMine.\n");
    expect(outdatedSkills(PACKAGE_ROOT, "2.0.0", cwd, home)[0]).toMatch(/edited since.*skill install --force`/);
  });
});
