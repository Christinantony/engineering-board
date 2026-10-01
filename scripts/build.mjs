// Builds the deployable app into dist/app:
//   dist/app/server.mjs        the whole server (one file, no node_modules)
//   dist/app/web/…             the web app (index.html + assets)
// Usage: node scripts/build.mjs [--watch] [--web-only|--server-only]
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const only = process.argv.find((a) => a === '--web-only' || a === '--server-only');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

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
  entryPoints: { app: 'web/src/main.tsx' },
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
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

function writeStatic() {
  mkdirSync('dist/app/web', { recursive: true });
  if (existsSync('web/public')) cpSync('web/public', 'dist/app/web', { recursive: true });
  const stamp = watch ? Date.now().toString(36) : version;
  writeFileSync('dist/app/web/index.html', readFileSync('web/index.html', 'utf8').replaceAll('__VERSION__', stamp));
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
