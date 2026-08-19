/**
 * Watch Command
 *
 * Monitors a repo's .git/HEAD for changes (commits, branch switches) and
 * automatically triggers `gitnexus analyze` when HEAD moves.
 *
 * The MCP server stays fully usable during analysis — it serves the previous
 * index until the new one is ready, then reconnects automatically (within 5s
 * of analysis completing via the meta.json indexedAt check in local-backend).
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'node:child_process';
import { getStoragePaths } from '../storage/repo-manager.js';

export interface WatchOptions {
  embeddings?: boolean;
}

export const watchCommand = async (repoPath?: string, options: WatchOptions = {}) => {
  const targetPath = path.resolve(repoPath || process.cwd());
  const gitHeadPath = path.join(targetPath, '.git', 'HEAD');

  if (!fs.existsSync(gitHeadPath)) {
    console.error(`[gitnexus watch] Not a git repository: ${targetPath}`);
    process.exit(1);
  }

  let isAnalyzing = false;
  let pendingAnalysis = false;

  function readHead(): string {
    try {
      return fs.readFileSync(gitHeadPath, 'utf-8').trim();
    } catch {
      return '';
    }
  }

  // Initialize lastHead from meta.json so we detect commits made while watch
  // wasn't running and kick off an immediate analysis on startup if needed.
  let lastHead = '';
  try {
    const { storagePath } = getStoragePaths(targetPath);
    const raw = await fsPromises.readFile(path.join(storagePath, 'meta.json'), 'utf-8');
    lastHead = JSON.parse(raw).lastCommit || '';
  } catch {
    // No existing index — use current HEAD as baseline (don't analyze on first start)
    lastHead = readHead();
  }

  function maybeAnalyze() {
    if (isAnalyzing) {
      pendingAnalysis = true;
      return;
    }

    const currentHead = readHead();
    if (!currentHead || currentHead === lastHead) return;

    isAnalyzing = true;
    lastHead = currentHead;

    const shortHead =
      currentHead.length > 40
        ? currentHead // symbolic ref like "ref: refs/heads/main"
        : currentHead.slice(0, 7);
    console.log(`[gitnexus watch] HEAD changed (${shortHead}) — starting analysis...`);

    const cliPath = process.argv[1];
    const args = ['analyze', targetPath];
    if (options.embeddings) args.push('--embeddings');

    // Pass heap flag so analyze doesn't need to re-exec itself
    const nodeOptions = `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim();

    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });

    child.on('close', (code) => {
      isAnalyzing = false;
      if (code === 0) {
        console.log('[gitnexus watch] Analysis complete. MCP index updated within 5s.');
      } else {
        console.error(`[gitnexus watch] Analysis exited with code ${code}.`);
      }
      if (pendingAnalysis) {
        pendingAnalysis = false;
        maybeAnalyze();
      }
    });
  }

  // Event-driven watch on .git/HEAD — fires on commit, checkout, rebase, merge
  let fsWatchActive = false;
  try {
    fs.watch(gitHeadPath, () => maybeAnalyze());
    fsWatchActive = true;
  } catch {
    // fs.watch can fail on some network mounts or container environments
  }

  // 60s polling fallback — catches missed events on Linux inotify/NFS/WSL
  setInterval(() => maybeAnalyze(), 60_000);

  // Analyze immediately if commits happened while watch wasn't running
  maybeAnalyze();

  console.log(`[gitnexus watch] Watching ${targetPath}`);
  console.log(
    fsWatchActive
      ? '[gitnexus watch] Monitoring .git/HEAD for commits and branch switches (+ 60s poll fallback).'
      : '[gitnexus watch] fs.watch unavailable — using 60s poll only.',
  );
  console.log('[gitnexus watch] Press Ctrl+C to stop.\n');

  // Keep the process alive
  process.stdin.resume();
  process.on('SIGINT', () => {
    console.log('\n[gitnexus watch] Stopped.');
    process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
};
