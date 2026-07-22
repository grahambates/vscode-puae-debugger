import { createReadStream, existsSync, statSync } from "fs";
import { ServerResponse } from "http";
import { extname, resolve, sep } from "path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serves a single file under `rootDir` at `urlPath` (used for `puae/`,
 * `out/`, and `node_modules/@vscode/codicons/dist/` — the same files
 * `VscodePuaeEmulator` serves via `webview.asWebviewUri` in the vscode host
 * — and, with a stripped prefix, the profiler's per-capture bulk blobs, see
 * `StandaloneProfilerViewerProvider`). Rejects any resolved path escaping
 * `rootDir` (`..` traversal, encoded or otherwise) with 403 rather than
 * serving it. Returns `false` (having sent a 404) if `urlPath` doesn't map
 * to a file under `rootDir` at all, so the caller can fall through to other
 * routes.
 */
export function serveStaticFile(
  rootDir: string,
  urlPath: string,
  res: ServerResponse,
): boolean {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = decodedPath.replace(/^\/+/, "");
  const resolvedRoot = resolve(rootDir) + sep;
  const resolvedPath = resolve(rootDir, relativePath);

  if (!resolvedPath.startsWith(resolvedRoot)) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    return false;
  }

  const contentType = CONTENT_TYPES[extname(resolvedPath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(resolvedPath).pipe(res);
  return true;
}

export function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
}
