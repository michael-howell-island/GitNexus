import { isVerboseIngestionEnabled } from './utils/verbose.js';
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob } from 'glob';
import { createIgnoreFilter, shouldIgnorePath } from '../../config/ignore-service.js';

export interface FileEntry {
  path: string;
  content: string;
}

/** Lightweight entry — path + size from stat, no content in memory */
export interface ScannedFile {
  path: string;
  size: number;
}

/** Path-only reference (for type signatures) */
export interface FilePath {
  path: string;
}

const READ_CONCURRENCY = 128;

/** Skip files larger than 512KB — they're usually generated/vendored and crash tree-sitter */
const MAX_FILE_SIZE = 512 * 1024;

const execFileAsync = promisify(execFile);

/**
 * List repository files via `git ls-files`.
 * Returns null if git is unavailable or the directory isn't a git repo.
 */
const listGitFiles = async (repoPath: string): Promise<string[] | null> => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: repoPath, maxBuffer: 100 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

/**
 * Phase 1: Scan repository — stat files to get paths + sizes, no content loaded.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 */
export const walkRepositoryPaths = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ScannedFile[]> => {
  // Fast path: git ls-files (~50ms vs 10-60s for glob on large repos)
  let rawPaths = await listGitFiles(repoPath);

  if (!rawPaths) {
    // Fallback: glob (non-git repos or --skip-git mode)
    const ignoreFilter = await createIgnoreFilter(repoPath);
    rawPaths = await glob('**/*', {
      cwd: repoPath,
      nodir: true,
      dot: false,
      ignore: ignoreFilter,
    });
  }

  // Post-filter: git doesn't know about DEFAULT_IGNORE_LIST / IGNORED_EXTENSIONS / IGNORED_FILES
  const filtered = rawPaths.filter((p) => !shouldIgnorePath(p));

  const entries: ScannedFile[] = [];
  let processed = 0;
  let skippedLarge = 0;
  const skippedLargePaths: string[] = [];

  for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
    const batch = filtered.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) {
          skippedLarge++;
          skippedLargePaths.push(relativePath.replace(/\\/g, '/'));
          return null;
        }
        return { path: relativePath.replace(/\\/g, '/'), size: stat.size };
      }),
    );

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
        onProgress?.(processed, filtered.length, result.value.path);
      } else {
        onProgress?.(processed, filtered.length, batch[results.indexOf(result)]);
      }
    }
  }

  if (skippedLarge > 0) {
    console.warn(
      `  Skipped ${skippedLarge} large files (>${MAX_FILE_SIZE / 1024}KB, likely generated/vendored)`,
    );
    if (isVerboseIngestionEnabled()) {
      for (const p of skippedLargePaths) {
        console.warn(`  - ${p}`);
      }
    }
  }

  return entries;
};

/**
 * Phase 2: Read file contents for a specific set of relative paths.
 * Returns a Map for O(1) lookup. Silently skips files that fail to read.
 */
export const readFileContents = async (
  repoPath: string,
  relativePaths: string[],
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();

  for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
    const batch = relativePaths.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { path: relativePath, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.path, result.value.content);
      }
    }
  }

  return contents;
};

/**
 * Legacy API — scans and reads everything into memory.
 * Used by sequential fallback path only.
 */
export const walkRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<FileEntry[]> => {
  const scanned = await walkRepositoryPaths(repoPath, onProgress);
  const contents = await readFileContents(
    repoPath,
    scanned.map((f) => f.path),
  );
  return scanned
    .filter((f) => contents.has(f.path))
    .map((f) => ({ path: f.path, content: contents.get(f.path)! }));
};
