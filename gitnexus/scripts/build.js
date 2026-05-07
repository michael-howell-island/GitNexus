#!/usr/bin/env node
/**
 * Build script that compiles gitnexus and inlines gitnexus-shared into the dist.
 *
 * Steps:
 *  1. Build gitnexus-shared (tsc)
 *  2. Build gitnexus (tsc)
 *  3. Build gitnexus-web (vite) → dist/web
 *  4. Copy gitnexus-shared/dist → dist/_shared
 *  5. Rewrite bare 'gitnexus-shared' specifiers → relative paths
 *  6. Make CLI entry executable
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED_ROOT = path.resolve(ROOT, '..', 'gitnexus-shared');
const WEB_ROOT = path.resolve(ROOT, '..', 'gitnexus-web');
const DIST = path.join(ROOT, 'dist');
const SHARED_DEST = path.join(DIST, '_shared');
const WEB_DEST = path.join(DIST, 'web');

// ── 1. Build gitnexus-shared ───────────────────────────────────────
console.log('[build] compiling gitnexus-shared…');
const rootTsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const sharedTscLocal = path.join(SHARED_ROOT, 'node_modules', '.bin', 'tsc');
const sharedTsc = fs.existsSync(sharedTscLocal) ? sharedTscLocal : rootTsc;
execSync(`"${sharedTsc}"`, { cwd: SHARED_ROOT, stdio: 'inherit', shell: true });

// ── 2. Build gitnexus ──────────────────────────────────────────────
console.log('[build] compiling gitnexus…');
execSync(`"${rootTsc}"`, { cwd: ROOT, stdio: 'inherit', shell: true });

// ── 3. Build gitnexus-web (if present) ────────────────────────────
if (fs.existsSync(WEB_ROOT)) {
  console.log('[build] building gitnexus-web…');
  // Run vite directly (skip tsc — type-checking is for dev, not packaging)
  const viteBin = path.join(WEB_ROOT, 'node_modules', '.bin', 'vite');
  const viteBuild = spawnSync(viteBin, ['build'], {
    cwd: WEB_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (viteBuild.status !== 0) process.exit(viteBuild.status ?? 1);
  console.log('[build] copying gitnexus-web dist → dist/web…');
  fs.cpSync(path.join(WEB_ROOT, 'dist'), WEB_DEST, { recursive: true });
} else {
  console.log('[build] gitnexus-web not found — skipping web UI build');
}

// ── 4. Copy shared dist ────────────────────────────────────────────
console.log('[build] copying shared module into dist/_shared…');
fs.cpSync(path.join(SHARED_ROOT, 'dist'), SHARED_DEST, { recursive: true });

// ── 5. Rewrite imports ─────────────────────────────────────────────
console.log('[build] rewriting gitnexus-shared imports…');
let rewritten = 0;

function rewriteFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes('gitnexus-shared')) return;

  const relDir = path.relative(path.dirname(filePath), SHARED_DEST);
  // Always use posix separators and point to the package index
  const relImport = relDir.split(path.sep).join('/') + '/index.js';

  const updated = content
    .replace(/from\s+['"]gitnexus-shared['"]/g, `from '${relImport}'`)
    .replace(/import\(\s*['"]gitnexus-shared['"]\s*\)/g, `import('${relImport}')`);

  if (updated !== content) {
    fs.writeFileSync(filePath, updated);
    rewritten++;
  }
}

function walk(dir, extensions, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, cb);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      cb(full);
    }
  }
}

walk(DIST, ['.js', '.d.ts'], rewriteFile);

// ── 6. Make CLI entry executable ────────────────────────────────────
const cliEntry = path.join(DIST, 'cli', 'index.js');
if (fs.existsSync(cliEntry)) fs.chmodSync(cliEntry, 0o755);

console.log(`[build] done — rewrote ${rewritten} files.`);
