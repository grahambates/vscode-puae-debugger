// NOTE: If you modify this build script, you need to restart the watch task
// (stop it in the Terminal panel and restart debugging)

const esbuild = require('esbuild');
// Read for its "version" only, injected into the standalone bundle below.
const pkg = require('./package.json');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Restores the executable bit on a bin output after every build.
 *
 * esbuild writes the file fresh each time, which drops the mode — so although the banner on the
 * standalone bundle makes it a valid executable script, `./out/standalone.js` and, more sharply,
 * an `npm link`ed `puae-debugger` on PATH both stop working the moment it is rebuilt: npm sets +x
 * when it links or installs a bin, and nothing sets it again afterwards. Cheap to reapply, and it
 * runs for watch rebuilds too.
 *
 * @param {string} outfile
 * @returns {import('esbuild').Plugin}
 */
const makeExecutablePlugin = (outfile) => ({
  name: 'make-executable',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      try {
        require('fs').chmodSync(outfile, 0o755);
      } catch (error) {
        console.error(`could not chmod +x ${outfile}: ${error.message}`);
      }
    });
  },
});

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

  const apiCtx = await esbuild.context({
    entryPoints: ['src/api/index.ts'], bundle: true, format: 'cjs', platform: 'node',
    outfile: 'out/api.js', minify: production, sourcemap: !production,
    logLevel: 'silent', plugins: [esbuildProblemMatcherPlugin, {
      name: 'api-declarations',
      setup(build) {
        build.onEnd(result => {
          if (result.errors.length) return;
          require('child_process').execFileSync(process.execPath, [
            require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.api.json',
          ], { stdio: 'inherit' });
        });
      },
    }],
  });

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
    // Makes the bundle directly executable (`./out/standalone.js` or via the
    // package's "bin" entry / `npx`) without touching server.ts itself.
    banner: {
      js: '#!/usr/bin/env node',
    },
    // The version the MCP server reports to its client (src/mcp/server.ts),
    // taken from package.json at build time. Injected rather than read at
    // runtime because a bundle's path back to its own package.json differs
    // between this checkout, an installed package and ts-jest — and rather
    // than hardcoded, because a hand-synced copy silently drifts on the first
    // version bump. Declared for TypeScript in src/globals.d.ts; ts-jest,
    // which never runs this build, gets a stub from src/test/jestSetup.ts.
    define: {
      __PUAE_DEBUGGER_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      esbuildProblemMatcherPlugin,
      makeExecutablePlugin('out/standalone.js'),
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
    await apiCtx.watch();
    await extensionCtx.watch();
    await standaloneCtx.watch();
    await webviewCtx.watch();
    await puaeAppCtx.watch();
    await puaeAudioCtx.watch();
    await puaeRpcCtx.watch();
  } else {
    await apiCtx.rebuild();
    await extensionCtx.rebuild();
    await standaloneCtx.rebuild();
    await webviewCtx.rebuild();
    await puaeAppCtx.rebuild();
    await puaeAudioCtx.rebuild();
    await puaeRpcCtx.rebuild();
    await apiCtx.dispose();
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