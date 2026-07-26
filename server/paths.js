import path from 'path';

/**
 * Resolve the directory of the server entry / bundle.
 * Avoids import.meta so esbuild can emit clean CJS for pkg.
 */
function resolveModuleDir() {
  // esbuild/pkg CJS bundle provides __dirname (snapshot or build folder)
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }

  // ESM dev: node server/index.js  →  .../server
  const entry = process.argv[1];
  if (entry) {
    return path.dirname(path.resolve(entry));
  }

  return process.cwd();
}

const moduleDir = resolveModuleDir();

/** True when running inside a pkg snapshot binary */
export function isPackaged() {
  return Boolean(process.pkg);
}

/**
 * Writable app home (config/images live here).
 * Priority: ATELIER_HOME > executable dir when packaged > project root in dev.
 */
export function getAppHome() {
  if (process.env.ATELIER_HOME) {
    return path.resolve(process.env.ATELIER_HOME);
  }
  if (isPackaged()) {
    return path.dirname(process.execPath);
  }
  if (process.env.ATELIER_PACKAGED === '1') {
    return process.cwd();
  }
  return path.resolve(moduleDir, '..');
}

/**
 * Static frontend directory.
 * Packaged/bundled layout places public next to the server entry.
 */
export function getPublicDir() {
  if (process.env.PUBLIC_DIR) {
    return path.resolve(process.env.PUBLIC_DIR);
  }
  if (isPackaged() || process.env.ATELIER_PACKAGED === '1') {
    return path.join(moduleDir, 'public');
  }
  return path.resolve(moduleDir, '../public');
}

export function getDataDir() {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }
  return path.join(getAppHome(), 'data');
}
