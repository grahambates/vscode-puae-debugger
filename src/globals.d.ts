// Build-time constants injected by esbuild's `define` (see esbuild.js).
//
// Declared, never defined, in src/: the value comes from the build, so assigning one here would
// defeat the point. Under ts-jest — which never runs esbuild — src/test/jestSetup.ts stands in
// with a placeholder, so a test importing one of these modules doesn't hit a ReferenceError.

/** package.json's "version" at build time. Reported by the MCP server (src/mcp/server.ts). */
declare const __PUAE_DEBUGGER_VERSION__: string;
