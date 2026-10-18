import { homedir } from "os";
import { join } from "path";

/**
 * Expands a leading `~` (alone, or followed by a separator) to the home directory. Tool
 * arguments arrive as plain strings with no shell in between to do this, and a path like
 * `~/Documents/WinUAE/Kickstarts/Kick13.rom` is exactly what a model or a person will write.
 * `~user` forms are left alone.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}
