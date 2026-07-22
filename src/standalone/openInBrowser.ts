import { spawn } from "child_process";

/**
 * Opens `url` in the platform's default browser via the OS's own "open a
 * URL" command — `open` (macOS), `xdg-open` (Linux), the `start` cmd.exe
 * builtin (Windows) — rather than a package like `open`, matching this
 * repo's preference for hand-rolled glue over dependencies where reasonable.
 * Failures are logged, not thrown: the caller always prints the URL too, so
 * the user can open it manually either way.
 */
export function openInBrowser(url: string): void {
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
