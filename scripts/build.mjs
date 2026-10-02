// Builds the deployable app into dist/app:
//   dist/app/server.mjs        the whole server (one file, no node_modules)
//   dist/app/web/…             the web app (index.html + assets)
//   dist/app/web/guides/…      the guides from docs/, as web pages
// Usage: node scripts/build.mjs [--watch] [--web-only|--server-only]
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { writeGuides } from './lib/guides.mjs';

const watch = process.argv.includes('--watch');
const only = process.argv.find((a) => a === '--web-only' || a === '--server-only');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
// The PDF viewer for drawing review (decision #23): pdf.js, copied from the
// devDependency into the web assets under a versioned folder. It runs in the
// browser only; the server still has no dependencies.
const pdfjsVersion = JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json', 'utf8')).version;
const pdfjsBase = `/assets/pdfjs-${pdfjsVersion}/`;

const serverOpts = {
  entryPoints: ['server/src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/app/server.mjs',
  tsconfig: 'tsconfig.json',
  legalComments: 'none',
  banner: { js: '// Engineering Board server: generated file, do not edit. Source: server/src' },
  logLevel: 'info',
};

const webOpts = {
  entryPoints: { app: 'web/src/main.tsx', theme: 'web/src/theme-init.ts' },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['chrome110', 'edge110', 'firefox115', 'safari16'],
  outdir: 'dist/app/web/assets',
  tsconfig: 'web/tsconfig.json',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), __PDFJS_BASE__: JSON.stringify(pdfjsBase) },
  logLevel: 'info',
};

function writeStatic() {
  mkdirSync('dist/app/web', { recursive: true });
  if (existsSync('web/public')) cpSync('web/public', 'dist/app/web', { recursive: true });
  const stamp = watch ? Date.now().toString(36) : version;
  writeFileSync('dist/app/web/index.html', readFileSync('web/index.html', 'utf8').replaceAll('__VERSION__', stamp));
  writeGuides('dist/app/web/guides', version); // served at /guides/user-guide.html
  const pdfjsOut = `dist/app/web${pdfjsBase}`;
  const src = 'node_modules/pdfjs-dist';
  mkdirSync(pdfjsOut, { recursive: true });
  // the "legacy" build carries polyfills, so older Edge/Chrome on office PCs can show drawings too
  for (const f of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE']) cpSync(`${src}/${f}`, `${pdfjsOut}${f.split('/').pop()}`);
  for (const d of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) cpSync(`${src}/${d}`, `${pdfjsOut}${d}`, { recursive: true });
}

if (!watch && only !== '--server-only') rmSync('dist/app/web', { recursive: true, force: true });
if (only !== '--server-only') writeStatic();

if (watch) {
  const ctxs = [];
  if (only !== '--server-only') ctxs.push(await context(webOpts));
  if (only !== '--web-only') ctxs.push(await context(serverOpts));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching… (reload the browser after changes)');
} else {
  if (only !== '--server-only') await build(webOpts);
  if (only !== '--web-only') await build(serverOpts);
}
