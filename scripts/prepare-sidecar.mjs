#!/usr/bin/env node
/**
 * Copy the pkg-built backend binary into src-tauri/binaries/ with the
 * target-triple suffix Tauri expects for externalBin sidecars.
 * Run after `node scripts/build-binary.mjs`.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hostTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  const out = execSync('rustc -Vv', { encoding: 'utf8' });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error('cannot determine host target triple from rustc -Vv');
  return m[1];
}

const triple = hostTriple();
const isWin = triple.includes('windows');
const src = path.join(root, 'dist', isWin ? 'atelier.exe' : 'atelier');
if (!existsSync(src)) {
  console.error(`sidecar source not found: ${src}\nRun: node scripts/build-binary.mjs`);
  process.exit(1);
}

const destDir = path.join(root, 'src-tauri', 'binaries');
mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, `atelier-${triple}${isWin ? '.exe' : ''}`);
copyFileSync(src, dest);
if (!isWin) chmodSync(dest, 0o755);
console.log(`sidecar ready: ${dest}`);
