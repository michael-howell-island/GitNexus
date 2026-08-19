/**
 * Tests for resolving the `repo` param when it points at a LINKED GIT WORKTREE
 * of an already-registered repo, rather than the exact path `gitnexus analyze`
 * was run from.
 *
 * `resolveRepoFromCache` used to compare `repo` against each registered
 * `handle.repoPath` by exact string equality only. A repo indexed from the
 * main checkout never equals a linked worktree's path (and vice versa), so
 * resolution threw "Repository ... not found" for every worktree-aware
 * tool call even though the worktree belongs to the exact repo that's
 * indexed. This suite verifies the canonical-root fallback fixes that, and
 * that `detectChanges` runs `git diff` from the caller's actual worktree
 * instead of silently diffing the registered (possibly different) checkout.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { LocalBackend } from '../../src/mcp/local/local-backend';

function initRepo(dir: string): void {
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

function commitAll(dir: string, message: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync(`git commit -q -m "${message}"`, { cwd: dir, stdio: 'ignore' });
}

function makeBackendWithRepo(repoPath: string) {
  const backend = new LocalBackend();
  const repoHandle = {
    id: 'repo1',
    name: 'repo1',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
    lbugPath: path.join(repoPath, '.gitnexus', 'lbug'),
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  return { backend, repoHandle };
}

describe('resolveRepoFromCache — linked worktree path', () => {
  it('resolves a linked worktree path to the repo registered at the main checkout', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-'));
    try {
      initRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-feature');
      execSync(`git worktree add -q -b feature "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      const { backend, repoHandle } = makeBackendWithRepo(repoDir);

      // Before the fix this returned null (exact-path match only), and
      // resolveRepo() would ultimately throw `Repository "<worktreeDir>" not found`.
      const resolved = (backend as any).resolveRepoFromCache(worktreeDir);
      expect(resolved).toBe(repoHandle);
    } finally {
      try {
        execSync('git worktree remove -f wt-feature', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('still returns null for a worktree belonging to an unrelated repo', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-a-'));
    const otherRepoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-wt-b-'));
    try {
      initRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      initRepo(otherRepoDir);
      writeFileSync(path.join(otherRepoDir, 'y.ts'), 'export const y = 1;\n');
      commitAll(otherRepoDir, 'initial');

      const worktreeDir = path.join(otherRepoDir, 'wt-unrelated');
      execSync(`git worktree add -q -b unrelated "${worktreeDir}"`, {
        cwd: otherRepoDir,
        stdio: 'ignore',
      });

      const { backend } = makeBackendWithRepo(repoDir);
      const resolved = (backend as any).resolveRepoFromCache(worktreeDir);
      expect(resolved).toBeNull();
    } finally {
      try {
        execSync('git worktree remove -f wt-unrelated', { cwd: otherRepoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherRepoDir, { recursive: true, force: true });
    }
  });

  it('still resolves a normal (non-worktree) exact repo path as before', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resolve-plain-'));
    try {
      execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
      const { backend, repoHandle } = makeBackendWithRepo(repoDir);
      const resolved = (backend as any).resolveRepoFromCache(repoDir);
      expect(resolved).toBe(repoHandle);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('detectChanges — diffs the caller worktree, not the registered checkout', () => {
  it('auto-detects the linked worktree from process.cwd() and diffs it', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dc-wt-'));
    const originalCwd = process.cwd();
    try {
      initRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-auto');
      execSync(`git worktree add -q -b auto "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });

      // Uncommitted change lives ONLY in the worktree, not the main checkout.
      writeFileSync(path.join(worktreeDir, 'x.ts'), 'export const x = 2;\n');

      const { backend } = makeBackendWithRepo(repoDir);
      (backend as any).ensureInitialized = async () => {};

      process.chdir(worktreeDir);
      const result = await (backend as any).detectChanges(
        (backend as any).repos.get('repo1'),
        { scope: 'unstaged' },
      );

      // changed_files reflects the actual `git diff` output directly (no
      // LadybugDB lookup needed); changed_count depends on a live graph
      // connection this unit test doesn't stand up.
      expect(result.summary.changed_files).toBe(1);
    } finally {
      process.chdir(originalCwd);
      try {
        execSync('git worktree remove -f wt-auto', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('an explicit worktree param overrides auto-detection', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dc-explicit-'));
    try {
      initRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');

      const worktreeDir = path.join(repoDir, 'wt-explicit');
      execSync(`git worktree add -q -b explicit "${worktreeDir}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });
      writeFileSync(path.join(worktreeDir, 'x.ts'), 'export const x = 2;\n');

      const { backend } = makeBackendWithRepo(repoDir);
      (backend as any).ensureInitialized = async () => {};

      const result = await (backend as any).detectChanges(
        (backend as any).repos.get('repo1'),
        { scope: 'unstaged', worktree: worktreeDir },
      );

      expect(result.summary.changed_files).toBe(1);
    } finally {
      try {
        execSync('git worktree remove -f wt-explicit', { cwd: repoDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects a worktree param that does not belong to the resolved repo', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dc-mismatch-a-'));
    const otherDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dc-mismatch-b-'));
    try {
      initRepo(repoDir);
      writeFileSync(path.join(repoDir, 'x.ts'), 'export const x = 1;\n');
      commitAll(repoDir, 'initial');
      initRepo(otherDir);

      const { backend } = makeBackendWithRepo(repoDir);
      (backend as any).ensureInitialized = async () => {};

      const result = await (backend as any).detectChanges(
        (backend as any).repos.get('repo1'),
        { scope: 'unstaged', worktree: otherDir },
      );

      expect(result.error).toMatch(/is not a worktree of repo/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
