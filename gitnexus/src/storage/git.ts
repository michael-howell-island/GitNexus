import { execSync } from 'child_process';
import { statSync } from 'fs';
import path from 'path';

// Git utilities for repository detection, commit tracking, and diff analysis

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const getCurrentCommit = (repoPath: string): string => {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
  } catch {
    return '';
  }
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    const raw = execSync('git rev-parse --show-toplevel', { cwd: fromPath }).toString().trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
  }
};

/**
 * Get the *canonical* repository root, dereferencing git worktrees.
 *
 * Unlike `getGitRoot` (which returns the WORKTREE's own root when called
 * inside a linked worktree), this uses `git rev-parse --git-common-dir` —
 * the shared `.git` directory, identical for the main checkout and every
 * linked worktree of the same repo — and returns its parent. So a linked
 * worktree and its main checkout both resolve to the same canonical root,
 * which is what `resolveRepoFromCache` needs to recognise them as "the
 * same indexed repo" instead of two unrelated paths.
 *
 * Returns `null` when the path is not inside a git repository or `git` is
 * not available.
 */
export const getCanonicalRepoRoot = (fromPath: string): string | null => {
  try {
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: fromPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!commonDir) return null;
    // Common dir is `<repo>/.git` for both the main checkout and all linked
    // worktrees. Its parent is the canonical repo root.
    return path.dirname(path.resolve(commonDir));
  } catch {
    return null;
  }
};

/**
 * Check whether a directory contains a .git entry (file or folder).
 *
 * This is intentionally a simple filesystem check rather than running
 * `git rev-parse`, so it works even when git is not installed or when
 * the directory is a git-worktree root (which has a .git file, not a
 * directory).  Use `isGitRepo` for a definitive git answer.
 *
 * @param dirPath - Absolute path to the directory to inspect.
 * @returns `true` when `.git` is present, `false` otherwise.
 */
export const hasGitDir = (dirPath: string): boolean => {
  try {
    statSync(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
};
