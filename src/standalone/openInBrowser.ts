import { ChildProcess, spawn } from "child_process";

interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * Chrome-specific launch commands to try before falling back to the
 * platform's default browser — this emulator leans heavily on WebGL/
 * WebAssembly, and Chrome's performance there is meaningfully better than
 * Firefox/Safari for it, so it's worth preferring when installed even if
 * it isn't the user's OS-level default.
 */
function chromeCandidates(url: string): LaunchCommand[] {
  if (process.platform === "darwin") {
    // -a resolves "Google Chrome" via Launch Services (works regardless of
    // exact install location), rather than hardcoding a path under /Applications.
    return [{ command: "open", args: ["-a", "Google Chrome", url] }];
  }
  if (process.platform === "win32") {
    // A bare "chrome" resolves via the registry's App Paths key, which the
    // standard installer registers — no hardcoded Program Files path
    // needed. The empty "" arg is the window-title placeholder `start`
    // expects before the target when the target might contain spaces.
    return [{ command: "cmd", args: ["/c", "start", "", "chrome", url] }];
  }
  // Linux: try common package/binary names, most-likely-installed first.
  return ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"].map((command) => ({
    command,
    args: [url],
  }));
}

/**
 * Spawns `command`, resolving `true` if it looks like it actually launched
 * a browser and `false` if it clearly didn't (missing binary, or — for
 * macOS's `open -a`, a separate short-lived launcher process rather than
 * the browser itself — a non-zero exit meaning Launch Services couldn't
 * find the named app). A launch that's still running (Linux's case: the
 * spawned process *is* the browser) or exits 0 both count as success.
 */
function tryLaunch({ command, args }: LaunchCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      settle(false);
      return;
    }
    child.on("error", () => settle(false)); // e.g. ENOENT — command doesn't exist
    child.on("exit", (code) => {
      if (code === 0) settle(true);
      else if (code !== null) settle(false); // non-zero: e.g. "app not found"
      // code === null (killed by signal): fall through to the timeout below.
    });
    child.unref();
    // Nothing exited within a beat and no error fired — either it's a
    // launcher still doing its thing, or (Linux) the spawned process *is*
    // the browser and is simply still running. Either way, good enough to
    // call it launched rather than waiting indefinitely.
    setTimeout(() => settle(true), 800);
  });
}

/**
 * Opens `url` in the platform's default browser via the OS's own "open a
 * URL" command — `open` (macOS), `xdg-open` (Linux), the `start` cmd.exe
 * builtin (Windows) — rather than a package like `open`, matching this
 * repo's preference for hand-rolled glue over dependencies where reasonable.
 * Failures are logged, not thrown: the caller always prints the URL too, so
 * the user can open it manually either way.
 */
async function openInDefaultBrowser(url: string): Promise<void> {
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      console.error(`Couldn't auto-open a browser (open ${url} manually): ${error.message}`);
    });
    child.unref();
  } catch (error) {
    console.error(
      `Couldn't auto-open a browser (open ${url} manually): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Opens `url`, preferring Chrome when it's installed (see chromeCandidates'
 * doc comment for why) and falling back to the platform's default browser
 * otherwise. Callers don't need to await this — errors are logged, not
 * thrown, same contract as the previous synchronous version.
 */
export async function openInBrowser(url: string): Promise<void> {
  for (const candidate of chromeCandidates(url)) {
    if (await tryLaunch(candidate)) return;
  }
  await openInDefaultBrowser(url);
}
