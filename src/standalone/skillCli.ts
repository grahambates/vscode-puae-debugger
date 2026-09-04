// `puae-debugger skill install` — copies the packaged `puae-profiling` skill into a project's
// (or the user's) `.claude/skills/`, so an agent working in an Amiga project gets the profiler
// playbook without that project having to vendor a copy of this repo.
//
// The skill is the judgement half of `profile dump`/`profile check` and the `mcp` server: which
// command to reach for first, and which numbers in a capture cannot be read at face value. The
// tools travel with the npm package already; this is how the guidance does too.
//
// Like `profile`, this is a subcommand of the existing binary rather than a separate one, and it
// prints to stdout (it never starts the DAP server, so stdout isn't a protocol stream here).

import { copyFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const USAGE = `Usage:
  puae-debugger skill install [--global] [--force]

  Installs the "puae-profiling" skill, which teaches an agent how to read a
  .puaeprofile capture: what to run first, and which numbers in a profile are
  not safe to take at face value.

Options:
  --global  Install into ~/.claude/skills (all projects) instead of
            ./.claude/skills (this project only).
  --force   Overwrite an existing installed copy.`;

// The packaged skill, relative to the package root. __dirname is out/ in both a dev checkout and
// an installed package, so the root is one level up — same derivation as server.ts's rootDir.
const SKILL_RELATIVE_PATH = join(".claude", "skills", "puae-profiling", "SKILL.md");

/** Returns the process exit code. */
export function runSkillCli(argv: string[]): number {
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

  const source = join(__dirname, "..", SKILL_RELATIVE_PATH);
  if (!existsSync(source)) {
    console.error(`Packaged skill not found at ${source}`);
    return 1;
  }

  const target = join(global ? homedir() : process.cwd(), SKILL_RELATIVE_PATH);
  if (existsSync(target) && !force) {
    console.error(`${target} already exists — pass --force to overwrite it.`);
    return 1;
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  } catch (err) {
    console.error(`Could not install the skill: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`Installed puae-profiling -> ${target}`);
  console.log(
    global
      ? "Available in every project. Ask about a .puaeprofile capture and it loads automatically."
      : "Available in this project. Ask about a .puaeprofile capture and it loads automatically.",
  );
  return 0;
}
