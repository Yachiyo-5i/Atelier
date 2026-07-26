#!/usr/bin/env node
/**
 * Prepare the macOS-universal backend sidecar for `tauri build --target
 * universal-apple-darwin`.
 *
 * pkg binaries CANNOT be lipo'd: pkg appends the JS snapshot at absolute file
 * offsets, and fat repacking shifts the slices, corrupting at least one arch.
 * Instead:
 *   - build untouched per-arch pkg binaries into .sidecar-stage/
 *   - the "universal sidecar" is a tiny dispatcher script that execs the
 *     matching arch binary from Contents/Resources/sidecar/ at runtime
 *   - per-arch triple names (required by Tauri's per-arch compile passes) get
 *     the same dispatcher content; only the Resources binaries actually run
 *   - .sidecar-stage/ is bundled via src-tauri/tauri.universal.conf.json
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('universal sidecar build is macOS-only');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// NOTE: must live outside build/ and dist/ — build-binary.mjs wipes both.
const stage = path.join(root, '.sidecar-stage');
const outDir = path.join(root, 'src-tauri', 'binaries');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(outDir, { recursive: true });

for (const [arch, pkgTarget] of [
  ['arm64', 'node22-macos-arm64'],
  ['x64', 'node22-macos-x64'],
]) {
  console.log(`\n=== pkg ${pkgTarget} ===`);
  execFileSync(process.execPath, [path.join(root, 'scripts/build-binary.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PKG_TARGET: pkgTarget },
  });
  const slice = path.join(stage, `atelier-${arch}`);
  copyFileSync(path.join(root, 'dist', 'atelier'), slice);
  chmodSync(slice, 0o755);
}

const dispatcher = `#!/bin/sh
# Atelier sidecar dispatcher: pkg binaries cannot be lipo'd, so the app ships
# one untouched binary per arch under Resources/sidecar/ and picks at runtime.
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  arm64) exec "$DIR/../Resources/sidecar/atelier-arm64" "$@" ;;
  *)     exec "$DIR/../Resources/sidecar/atelier-x64" "$@" ;;
esac
`;

for (const triple of [
  'universal-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]) {
  const dest = path.join(outDir, `atelier-${triple}`);
  writeFileSync(dest, dispatcher);
  chmodSync(dest, 0o755);
}

console.log(`\nuniversal sidecar dispatcher staged: ${outDir}`);
console.log(`arch binaries staged: ${stage}`);
console.log('build with: npx tauri build --target universal-apple-darwin --config src-tauri/tauri.universal.conf.json');
