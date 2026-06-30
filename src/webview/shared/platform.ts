// Whether the webview is running on macOS, for Cmd-vs-Ctrl modifier-key labeling
// ("Cmd+Click" vs "Ctrl+Click" hints, jump-to-source modifier checks).
export const isMac = navigator.platform.toLowerCase().includes("mac");
