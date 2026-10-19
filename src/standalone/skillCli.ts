// `puae-debugger skill install` — copies the packaged skills into a project's (or the user's)
// `.claude/skills/` (or `.agents/skills/`, for Codex and other Agent Skills hosts), so an agent working in an Amiga project gets the playbooks without that
// project having to vendor a copy of this repo.
//
// The skills are the judgement half of the `profile` subcommands and the `mcp` server: which tool
// to reach for first, and which of their answers cannot be read at face value. The tools travel
// with the npm package already; this is how the guidance does too.
//
// An installed copy is stamped with the package version and a hash of what was shipped, in its
// frontmatter's `metadata`. That is what lets a later install update a copy nobody has touched
// without being told to, refuse to silently overwrite one that has been edited, and lets the MCP
// server notice a copy older than itself (see `outdatedSkills`). Copies installed by 1.0.0, which
// carry no stamp, are recognised by content (`LEGACY`).
//
// Like `profile`, this is a subcommand of the existing binary rather than a separate one, and it
// prints to stdout (it never starts the DAP server, so stdout isn't a protocol stream here).

import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

/** The packaged skills, and what each is for (shown after installing). */
export const SKILLS: { name: string; use: string }[] = [
  { name: "puae-profiling", use: "ask why a routine or frame is slow, whether it fits in a frame, or about a .puaeprofile capture" },
  { name: "puae-debugging", use: "ask why a program crashes, what overwrites something, or why the screen is wrong" },
];

/** sha256 of skills shipped before installs were stamped, by the version that shipped them. */
const LEGACY: Record<string, string> = {
  "8be6ff6a49774d5253ceea82fe5920c5d59fb7d553ce1455291f947237a960ba": "1.0.0", // puae-profiling
};

const USAGE = `Usage:
  puae-debugger skill install [--global] [--agents] [--force]

  Installs, or updates, the agent skills that go with these tools:
    puae-profiling  profiling a program: making captures with the MCP tools,
                    reading .puaeprofile files, and which numbers in a profile
                    are not safe to take at face value.
    puae-debugging  debugging a program in the emulator through the MCP tools:
                    which tool answers which symptom, and what not to misread.

  A copy installed by an older version is updated; one that has been edited is
  left as is unless --force is given.

Options:
  --global  Install into your home directory (all projects) instead of this
            project.
  --agents  Install into .agents/skills, where Codex and other agents that
            follow the Agent Skills convention look, instead of Claude Code's
            .claude/skills.
  --force   Also replace copies that have been edited (the old copy is kept
            alongside, as SKILL.md.bak).

  Run through npm exec, put -- before these options (npm exec puae-debugger --
  skill install --force), or npm keeps them for itself.`;

/**
 * Where agents look for skills, under a project or the home directory: Claude Code's own, and the
 * Agent Skills convention's, which Codex uses. The packaged copies live in the first.
 */
export const SKILL_DIRS = { claude: ".claude", agents: ".agents" } as const;
type SkillDir = keyof typeof SKILL_DIRS;

const skillPath = (name: string, dir: SkillDir = "claude") => join(SKILL_DIRS[dir], "skills", name, "SKILL.md");

const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const STAMP = /^metadata:\n {2}puae-debugger-version: "([^"\n]*)"\n {2}puae-debugger-sha256: ([0-9a-f]{64})\n/m;

/** The packaged skill as installed: its frontmatter gains the version and the hash of `source`. */
export function stampSkill(source: string, version: string): string {
  const text = normalize(source);
  const end = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end < 0) throw new Error("Packaged skill has no frontmatter");
  const block = `metadata:\n  puae-debugger-version: "${version}"\n  puae-debugger-sha256: ${sha256(text)}\n`;
  return text.slice(0, end + 1) + block + text.slice(end + 1);
}

export type InstalledState =
  | { kind: "current" }
  /** Installed by `from` and untouched since, but the package now ships something different. */
  | { kind: "outdated"; from: string }
  /** Changed since it was installed — by `from`, when that's known. */
  | { kind: "edited"; from?: string };

/** How an installed copy compares with the packaged `source` — both as file text. */
export function installedState(source: string, installed: string): InstalledState {
  const text = normalize(installed);
  const current = sha256(normalize(source));
  const stamp = STAMP.exec(text);
  if (stamp) {
    const [, from, shipped] = stamp;
    if (sha256(text.replace(STAMP, "")) !== shipped) return { kind: "edited", from };
    return shipped === current ? { kind: "current" } : { kind: "outdated", from };
  }
  const hash = sha256(text);
  if (hash === current) return { kind: "current" };
  return LEGACY[hash] ? { kind: "outdated", from: LEGACY[hash] } : { kind: "edited" };
}

/**
 * Returns the process exit code. `packageRoot`, `installRoot`, `version` and `env` are parameters
 * for tests; the defaults are the installed package (out/'s parent, as in server.ts), the cwd or
 * home dir, the package's own version, and the process environment.
 */
export function runSkillCli(
  argv: string[],
  packageRoot = join(__dirname, ".."),
  installRoot?: string,
  version: string = __PUAE_DEBUGGER_VERSION__,
  env: NodeJS.ProcessEnv = process.env,
): number {
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
  let dir: SkillDir = "claude";
  // `npm exec puae-debugger skill install --force` never passes --force on: npm takes it as its
  // own option. It does say so in the environment, though, so honour that as the same thing.
  let force = env.npm_config_force === "true";
  for (const arg of argv.slice(1)) {
    if (arg === "--global") global = true;
    else if (arg === "--agents") dir = "agents";
    else if (arg === "--force") force = true;
    else {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }

  const root = installRoot ?? (global ? homedir() : process.cwd());
  const changed: string[] = [];
  let keptEdited = false;
  for (const skill of SKILLS) {
    const sourcePath = join(packageRoot, skillPath(skill.name));
    if (!existsSync(sourcePath)) {
      console.error(`Packaged skill not found at ${sourcePath}`);
      return 1;
    }
    const source = readFileSync(sourcePath, "utf8");
    const target = join(root, skillPath(skill.name, dir));
    const state = existsSync(target) ? installedState(source, readFileSync(target, "utf8")) : undefined;
    if (state?.kind === "current") {
      console.log(`Up to date: ${target}`);
      continue;
    }
    if (state?.kind === "edited" && !force) {
      const by = state.from ? ` since puae-debugger ${state.from} installed it` : ", or wasn't installed by puae-debugger";
      console.log(`Left as is: ${target} has been changed${by}. Pass --force to replace it (your copy is kept as SKILL.md.bak).`);
      keptEdited = true;
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (state?.kind === "edited") copyFileSync(target, `${target}.bak`);
      writeFileSync(target, stampSkill(source, version));
    } catch (err) {
      console.error(`Could not install ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    changed.push(skill.name);
    if (!state) console.log(`Installed ${skill.name} -> ${target}`);
    else if (state.kind === "outdated") console.log(`Updated ${skill.name} from ${state.from} to ${version} -> ${target}`);
    else console.log(`Replaced ${skill.name} -> ${target} (your copy is at ${target}.bak)`);
  }

  if (changed.length > 0) {
    console.log(global ? "Available in every project." : "Available in this project.");
    for (const skill of SKILLS.filter((s) => changed.includes(s.name))) {
      console.log(`  ${skill.name} loads automatically when you ${skill.use}.`);
    }
  }
  // Nonzero only when something wasn't brought up to date, so a script can tell.
  return keptEdited ? 1 : 0;
}

/**
 * Installed skills that are older than this package's, for the MCP server to mention — found in
 * the project (`cwd`) and the user's own skills, in both SKILL_DIRS: the server can't tell which
 * agent started it. A copy changed since it was installed counts only when it was installed by
 * another version: an edit to a current copy is the user's choice. One line per copy, each saying
 * what to run; empty when there's nothing to say.
 */
export function outdatedSkills(packageRoot: string, version: string, cwd = process.cwd(), home = homedir()): string[] {
  const notes: string[] = [];
  const roots = [{ root: cwd, flag: "" }];
  if (resolve(home) !== resolve(cwd)) roots.push({ root: home, flag: " --global" });
  const places = roots.flatMap(({ root, flag }) =>
    (Object.keys(SKILL_DIRS) as SkillDir[]).map((dir) => ({ root, dir, flag: flag + (dir === "agents" ? " --agents" : "") })),
  );
  for (const { root, dir, flag } of places) {
    for (const { name } of SKILLS) {
      const target = join(root, skillPath(name, dir));
      const sourcePath = join(packageRoot, skillPath(name));
      if (!existsSync(target) || !existsSync(sourcePath)) continue;
      let state: InstalledState;
      try {
        state = installedState(readFileSync(sourcePath, "utf8"), readFileSync(target, "utf8"));
      } catch {
        continue;
      }
      if (state.kind === "current" || (state.kind === "edited" && state.from === version)) continue;
      const from = state.from ? `puae-debugger ${state.from}` : "an unknown version";
      const edited = state.kind === "edited" ? ", and has been edited since" : "";
      const force = state.kind === "edited" ? " --force" : "";
      notes.push(`${target} is from ${from}${edited}; update it with \`npx puae-debugger@${version} skill install${flag}${force}\``);
    }
  }
  return notes;
}
