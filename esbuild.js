// NOTE: If you modify this build script, you need to restart the watch task
// (stop it in the Terminal panel and restart debugging)

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // Clean old build output (except for the bundled files we're about to create)
  const fs = require('fs');
  if (fs.existsSync('out') && !watch) {
    const files = fs.readdirSync('out');
    for (const file of files) {
      if (file.endsWith('.js') && !file.startsWith('extension') ||
          file.endsWith('.js.map') && !file.startsWith('extension') ||
          file.endsWith('.mjs') ||
          file.endsWith('.d.ts')) {
        try {
          fs.unlinkSync(`out/${file}`);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
    }
  }

  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: [
      'src/extension.ts'
    ],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outdir: 'out',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  // Standalone DAP server (`npm run standalone` / `node out/standalone.js`)
  // — nvim-dap (or any other DAP client) talks DAP to it over TCP; the PUAE
  // emulator screen is served to a plain browser tab instead of a vscode
  // webview. No `vscode` import anywhere in its dependency graph, so unlike
  // extensionCtx above it needs no `external: ['vscode']`.
  const standaloneCtx = await esbuild.context({
    entryPoints: [
      'src/standalone/server.ts'
    ],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/standalone.js',
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  // Build webviews
  const webviewCtx = await esbuild.context({
    entryPoints: [
      'src/webview/memoryViewer/main.tsx',
      'src/webview/stateViewer/main.tsx',
      'src/webview/profilerViewer/main.tsx'
    ],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: production ? false : 'inline', // Inline sourcemap for webview debugging
    sourcesContent: !production, // Embed sources in sourcemap for webview debugging
    platform: 'browser',
    outdir: 'out',
    entryNames: '[dir]',
    logLevel: 'silent',
    jsx: 'automatic',
    jsxDev: !production,
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });
  // PUAE webview app bundle — loaded via `<script type="module">` from
  // puae/index.html / puae/debug.html (see PuaeEmulator.getHtmlForWebview).
  // Format 'esm' (not the React webviews' 'iife') so it can keep exporting
  // `main`/`REG_NAMES` the same way the page's inline module script expects.
  const puaeAppCtx = await esbuild.context({
    entryPoints: ['src/webview/puaeApp/app.ts'],
    bundle: true,
    format: 'esm',
    minify: production,
    sourcemap: production ? false : 'inline',
    sourcesContent: !production,
    platform: 'browser',
    outfile: 'out/puaeApp.js',
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  // PUAE audio worklet processor — loaded via audioWorklet.addModule(), runs
  // in AudioWorkletGlobalScope (no imports/exports, just registerProcessor).
  const puaeAudioCtx = await esbuild.context({
    entryPoints: ['src/webview/puaeApp/audioProcessor.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: production ? false : 'inline',
    platform: 'browser',
    outfile: 'out/puaeAudioProcessor.js',
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  // PUAE RPC dispatcher, built standalone (not inlined into puaeApp.js) so
  // puae-wasm/test/*.mjs can `import` it directly under plain Node, the way
  // they imported puae/puae_rpc.js before the TypeScript port.
  const puaeRpcCtx = await esbuild.context({
    entryPoints: ['src/webview/puaeApp/rpc.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: 'out/puaeRpc.mjs',
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  if (watch) {
    await extensionCtx.watch();
    await standaloneCtx.watch();
    await webviewCtx.watch();
    await puaeAppCtx.watch();
    await puaeAudioCtx.watch();
    await puaeRpcCtx.watch();
  } else {
    await extensionCtx.rebuild();
    await standaloneCtx.rebuild();
    await webviewCtx.rebuild();
    await puaeAppCtx.rebuild();
    await puaeAudioCtx.rebuild();
    await puaeRpcCtx.rebuild();
    await extensionCtx.dispose();
    await standaloneCtx.dispose();
    await webviewCtx.dispose();
    await puaeAppCtx.dispose();
    await puaeAudioCtx.dispose();
    await puaeRpcCtx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});