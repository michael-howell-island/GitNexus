import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  walkRepositoryPaths,
  readFileContents,
} from '../../src/core/ingestion/filesystem-walker.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSymbolTable } from '../../src/core/ingestion/symbol-table.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

// ============================================================================
// E2E: .gitignore + .gitnexusignore + unsupported language skip
// ============================================================================

describe('ignore + language-skip E2E', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-e2e-ignore-skip-'));

    // Create directory structure
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'vendor'), { recursive: true });

    // .gitignore — excludes data/ and *.log
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'data/\n*.log\n');

    // .gitnexusignore — excludes vendor/
    await fs.writeFile(path.join(tmpDir, '.gitnexusignore'), 'vendor/\n');

    // Source files (should be indexed)
    await fs.writeFile(
      path.join(tmpDir, 'src', 'index.ts'),
      "import { greet } from './greet';\n\nexport function main(): string {\n  return greet();\n}\n",
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'greet.ts'),
      "export function greet(): string {\n  return 'hello';\n}\n",
    );

    // Swift file — triggers language skip when grammar unavailable
    await fs.writeFile(
      path.join(tmpDir, 'src', 'App.swift'),
      'class App {\n    func run() {\n        print("running")\n    }\n}\n',
    );

    // Files that should be excluded
    await fs.writeFile(path.join(tmpDir, 'data', 'seed.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'vendor', 'lib.js'), 'var x = 1;\n');
    await fs.writeFile(path.join(tmpDir, 'debug.log'), 'debug log entry\n');
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // ── File Discovery ──────────────────────────────────────────────────

  describe('file discovery (walkRepositoryPaths)', () => {
    it('includes source files from src/', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/greet.ts');
    });

    it('includes .swift files (discovery does not filter by language)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      // Swift file should be discovered — language skip happens at parse time
      expect(paths).toContain('src/App.swift');
    });

    it('excludes gitignored directories (data/)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.includes('data/'))).toBe(true);
    });

    it('excludes gitignored file patterns (*.log)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.endsWith('.log'))).toBe(true);
    });

    it('excludes gitnexusignored directories (vendor/)', async () => {
      const files = await walkRepositoryPaths(tmpDir);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));

      expect(paths.every((p) => !p.includes('vendor/'))).toBe(true);
    });
  });

  // ── Parsing ─────────────────────────────────────────────────────────

  describe('parsing (processParsing)', () => {
    it('parses TypeScript files into graph nodes and skips Swift gracefully', async () => {
      // Phase 1: discover files
      const scannedFiles = await walkRepositoryPaths(tmpDir);
      const relativePaths = scannedFiles.map((f) => f.path);

      // Phase 2: read contents
      const contentMap = await readFileContents(tmpDir, relativePaths);
      const files = Array.from(contentMap.entries()).map(([p, content]) => ({
        path: p,
        content,
      }));

      // Phase 3: parse (sequential — no worker pool)
      const graph = createKnowledgeGraph();
      const symbolTable = createSymbolTable();
      const astCache = createASTCache();

      // Should NOT throw even if Swift grammar is unavailable
      await processParsing(graph, files, symbolTable, astCache);

      // TypeScript files should produce Function nodes
      const nodes = graph.nodes;
      const functionNodes = nodes.filter((n) => n.label === 'Function');
      const functionNames = functionNodes.map((n) => n.properties.name);

      expect(functionNames).toContain('main');
      expect(functionNames).toContain('greet');

      // Function nodes should reference the correct source files
      const fnFilePaths = functionNodes.map((n) =>
        (n.properties.filePath as string).replace(/\\/g, '/'),
      );
      expect(fnFilePaths.some((p) => p.includes('index.ts'))).toBe(true);
      expect(fnFilePaths.some((p) => p.includes('greet.ts'))).toBe(true);

      // Swift behavior depends on grammar availability
      if (!isLanguageAvailable(SupportedLanguages.Swift)) {
        // No Swift-sourced nodes should appear in the graph
        const swiftNodes = nodes.filter((n) =>
          (n.properties.filePath as string | undefined)?.endsWith('.swift'),
        );
        expect(swiftNodes).toHaveLength(0);
      }
      // If Swift IS available, Swift nodes may appear — that's fine
    });
  });
});

describe('expanded ignore list', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-expand-ignore-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'export const x = 1;');

    const ignoredDirs = [
      '.worktrees',
      '.claude',
      '.nx',
      '.yarn',
      '.cursor',
      '.run',
      '.pre-commit-hooks',
      'storybook-static',
      '__generated__',
      '.pnpm',
    ];
    for (const dir of ignoredDirs) {
      await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
      await fs.writeFile(path.join(tmpDir, dir, 'file.ts'), 'nope');
    }
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('excludes all newly added ignore directories', async () => {
    const files = await walkRepositoryPaths(tmpDir);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/app.ts');
    expect(paths.every((p) => !p.includes('.worktrees/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.claude/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.nx/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.yarn/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.cursor/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.run/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.pre-commit-hooks/'))).toBe(true);
    expect(paths.every((p) => !p.includes('storybook-static/'))).toBe(true);
    expect(paths.every((p) => !p.includes('__generated__/'))).toBe(true);
    expect(paths.every((p) => !p.includes('.pnpm/'))).toBe(true);
  });
});
