#!/usr/bin/env node
/**
 * Bundle app + package a standalone binary.
 * Does NOT include user data/config under data/.
 *
 * Output: dist/atelier
 * Runtime data: <binary-dir>/data/ (created on first run)
 */
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const distDir = path.join(root, 'dist');
const entryOut = path.join(buildDir, 'server.cjs');

const platform = process.platform;
const arch = process.arch;
const targetMap = {
  'darwin-arm64': 'node22-macos-arm64',
  'darwin-x64': 'node22-macos-x64',
  'linux-x64': 'node22-linux-x64',
  'linux-arm64': 'node22-linux-arm64',
  'win32-x64': 'node22-win-x64',
};
const pkgTarget = process.env.PKG_TARGET || targetMap[`${platform}-${arch}`];
if (!pkgTarget) {
  console.error(`Unsupported platform: ${platform}-${arch}`);
  process.exit(1);
}

const binaryBase = process.env.BINARY_NAME || 'atelier';
const outBase = path.join(distDir, binaryBase.replace(/\.exe$/i, ''));

console.log('→ clean build/ dist/');
rmSync(buildDir, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

console.log('→ esbuild bundle server → build/server.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'server/index.js')],
  outfile: entryOut,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  legalComments: 'none',
  // Mark as packaged layout so public resolves beside entry
  define: {
    'process.env.ATELIER_PACKAGED': '"1"',
  },
  // Ensure __dirname exists; import.meta.url branch becomes unused in CJS
  banner: {
    js: '/* atelier bundle */',
  },
  logLevel: 'info',
});

console.log('→ copy public assets (exclude user data)');
cpSync(path.join(root, 'public'), path.join(buildDir, 'public'), { recursive: true });

const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
writeFileSync(
  path.join(buildDir, 'build-info.json'),
  JSON.stringify(
    {
      name: pkgJson.name,
      version: pkgJson.version,
      builtAt: new Date().toISOString(),
      target: pkgTarget,
    },
    null,
    2,
  ),
);

// Resolve pkg CLI
const pkgCandidates = [
  path.join(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js'),
  path.join(root, 'node_modules/pkg/lib-es5/bin.js'),
];
const pkgBin = pkgCandidates.find((p) => existsSync(p));
if (!pkgBin) {
  console.error('pkg not found. Run: npm install');
  process.exit(1);
}

// pkg assets config (relative to project root)
const pkgConfigPath = path.join(buildDir, 'pkg.json');
writeFileSync(
  pkgConfigPath,
  JSON.stringify(
    {
      pkg: {
        assets: ['public/**/*'],
        targets: [pkgTarget],
        outputPath: distDir,
      },
    },
    null,
    2,
  ),
);

console.log(`→ pkg ${pkgTarget} → dist/${binaryBase}`);
execFileSync(
  process.execPath,
  [
    pkgBin,
    entryOut,
    '--config',
    pkgConfigPath,
    '--targets',
    pkgTarget,
    '--output',
    outBase,
    '--compress',
    'GZip',
  ],
  { cwd: root, stdio: 'inherit' },
);

// Locate produced binary
const produced = readdirSync(distDir)
  .map((name) => path.join(distDir, name))
  .filter((p) => existsSync(p));

if (!produced.length) {
  console.error('No binary produced in dist/');
  process.exit(1);
}

for (const p of produced) {
  if (platform !== 'win32') {
    try {
      chmodSync(p, 0o755);
    } catch {
      /* ignore */
    }
  }
  console.log(`  created: ${p}`);
}

console.log('');
console.log('✓ Build complete');
console.log(`  Run:  ./run.sh`);
console.log(`    or ./dist/${path.basename(produced[0])}`);
console.log('  Data is created beside the binary (./dist/data), not your project data/');
