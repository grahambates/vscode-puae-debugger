// `puae-debugger skill install` — copies the packaged skills into a project's (or the user's)
// `.claude/skills/`, so an agent working in an Amiga project gets the playbooks without that
// project having to vendor a copy of this repo.
//
// The skills are the judgement half of the `profile` subcommands and the `mcp` server: which tool
// to reach for first, and which of their answers cannot be read at face value. The tools travel
// with the npm package already; this is how the guidance does too.
//
// Like `profile`, this is a subcommand of the existing binary rather than a separate one, and it
// prints to stdout (it never starts the DAP server, so stdout isn't a protocol stream here).

import { copyFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** The packaged skills, and what each is for (shown after installing). */
export const SKILLS: { name: string; use: string }[] = [
  { name: "puae-profiling", use: "ask why a routine or frame is slow, or about a .puaeprofile capture" },
  { name: "puae-debugging", use: "ask why a program crashes, what overwrites something, or why the screen is wrong" },
];

const USAGE = `Usage:
  puae-debugger skill install [--global] [--force]

  Installs the agent skills that go with these tools:
    puae-profiling  reading a .puaeprofile capture: what to run first, and which
                    numbers in a profile are not safe to take at face value.
    puae-debugging  debugging a program in the emulator through the MCP tools:
                    which tool answers which symptom, and what not to misread.

Options:
  --global  Install into ~/.claude/skills (all projects) instead of
            ./.claude/skills (this project only).
  --force   Overwrite installed copies (to update them).`;

const skillPath = (name: string) => join(".claude", "skills", name, "SKILL.md");

/**
 * Returns the process exit code. `packageRoot` and `installRoot` are parameters for tests; the
 * defaults are the installed package (out/'s parent, as in server.ts) and the cwd or home dir.
 */
export function runSkillCli(argv: string[], packageRoot = join(__dirname, ".."), installRoot?: string): number {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  if (sub !== "install") {
    console.error(`Unknown skill subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }

  let global = false;
  let force = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--global") global = true;
    else if (arg === "--force") force = true;
    else {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }

  const root = installRoot ?? (global ? homedir() : process.cwd());
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const skill of SKILLS) {
    const source = join(packageRoot, skillPath(skill.name));
    if (!existsSync(source)) {
      console.error(`Packaged skill not found at ${source}`);
      return 1;
    }
    const target = join(root, skillPath(skill.name));
    // An existing copy is left alone rather than failing the whole install: someone who installed
    // one skill before the other existed should still get the new one by running this again.
    if (existsSync(target) && !force) {
      skipped.push(target);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    } catch (err) {
      console.error(`Could not install ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    installed.push(skill.name);
    console.log(`Installed ${skill.name} -> ${target}`);
  }

  for (const target of skipped) console.log(`Already installed, left as is: ${target} (pass --force to update it)`);
  if (installed.length === 0) {
    console.error("Nothing installed — every skill is already present. Pass --force to update them.");
    return 1;
  }
  console.log(global ? "Available in every project." : "Available in this project.");
  for (const skill of SKILLS.filter((s) => installed.includes(s.name))) {
    console.log(`  ${skill.name} loads automatically when you ${skill.use}.`);
  }
  return 0;
}
