/**
 * Inversify DI Module Parser — Phase 1
 *
 * Scans all "di/Module.ts" files under the apps repo and extracts interface→concrete bindings.
 * Uses a character-level scanner to handle multi-line chains and nested generics.
 *
 * Handles:
 *   container.bind<IFoo>(Types.IFoo).to(Foo).inSingletonScope()
 *   container.bind<IFoo<Bar>>(Types.IFoo).to(Foo)          ← nested generics
 *   container.bind<IFoo>(Types.IFoo).toService(Types.OtherFoo)  ← alias
 *   container.bind<IFoo>(Types.IFoo).toDynamicValue(...)   ← flagged, not stitched
 *   container.bind<IFoo>(Types.IFoo).toConstantValue(...)  ← skipped
 *   container.bind<IFoo>(Types.IFoo).toFactory(...)        ← skipped
 *
 * Multi-line chains and private/protected method factoring (bindMerges, etc.)
 * are handled by scanning the full file content rather than line-by-line.
 *
 * Architecture notes:
 *   - No ts-morph / AST dependency — fast regex + char scanner
 *   - Binding symbols (e.g. Types.IFoo) are preserved for Phase 2 resolution
 *   - Multiple bindings to same symbol are stored as arrays (multi-inject pattern)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BindingKind =
  | 'to'
  | 'toService'
  | 'toDynamicValue'
  | 'toConstantValue'
  | 'toFactory'
  | 'toSelf'
  | 'unknown';

export type BindingScope = 'singleton' | 'transient' | 'request' | 'none';

export interface DiBinding {
  /** Base interface name from the generic type arg, e.g. 'IHttpClient'.
   *  For complex generics like IFoo<Bar>, this is the outer type name only. */
  interfaceName: string;
  /** Full generic string if nested, e.g. 'IFoo<Bar<Baz>>'. Same as interfaceName when simple. */
  interfaceGeneric: string;
  /** Symbol identifier expression, e.g. 'HttpModuleTypes.IHttpClient' */
  symbol: string;
  /** Concrete class name from .to(Foo), or null for non-resolvable bindings */
  concreteName: string | null;
  /** For toService: the target symbol expression, e.g. 'NetworkModuleTypes.NetworkEntryPoint' */
  aliasTarget: string | null;
  kind: BindingKind;
  scope: BindingScope;
  /** Absolute path to the Module.ts file containing this binding */
  moduleFile: string;
  /** 0-indexed character offset of the '.bind<' start in the file */
  offset: number;
}

export interface ParsedModule {
  /** Absolute path to the Module.ts file */
  file: string;
  /** Class name of the module, e.g. 'HttpModule' */
  className: string | null;
  bindings: DiBinding[];
  /** Bindings that could not be fully parsed (for debugging) */
  skipped: Array<{ offset: number; reason: string; snippet: string }>;
}

// ─── Character-level scanner helpers ─────────────────────────────────────────

/**
 * Starting at `start` (which points to '<'), scan forward balancing angle
 * brackets to handle nested generics, returning the content and end position.
 * Returns null if unclosed within maxLen chars.
 */
function scanAngles(
  src: string,
  start: number,
  maxLen = 2000,
): { content: string; end: number } | null {
  let depth = 0;
  let i = start;
  const limit = Math.min(src.length, start + maxLen);
  while (i < limit) {
    const ch = src[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    } else if (ch === '(') {
      // Entered a function type (e.g. () => IFoo) — bail, these are factory types we skip
      break;
    } else if (ch === '{') {
      // Entered an object type — bail
      break;
    } else if (ch === '[') {
      // Array type suffix (e.g. IFoo[]) or nested array in generic — skip the brackets
      // Find the matching ] and continue
      i++;
      while (i < limit && src[i] !== ']') i++;
      // fall through to i++ at end of loop
    }
    i++;
  }
  return null;
}

/**
 * Starting at `start` (which points to '('), scan forward balancing parens,
 * skipping string literals. Returns content and end position after ')'.
 * Returns null if unclosed within maxLen chars.
 */
function scanParens(
  src: string,
  start: number,
  maxLen = 6000,
): { content: string; end: number } | null {
  let depth = 0;
  let i = start;
  const limit = Math.min(src.length, start + maxLen);
  while (i < limit) {
    const ch = src[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < limit && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return null;
}

/** Advance past whitespace, newlines, and line comments (// ...). */
function skipWs(src: string, i: number): number {
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      // Single-line comment: skip to end of line
      while (i < src.length && src[i] !== '\n') i++;
    } else {
      break;
    }
  }
  return i;
}

/** Match literal `lit` at position `i`. Returns index after it, or -1. */
function matchLit(src: string, i: number, lit: string): number {
  return src.startsWith(lit, i) ? i + lit.length : -1;
}

/**
 * Read an identifier (word chars) or qualified name (word chars + '.') starting at i.
 * Used for method names and symbol expressions like 'HttpModuleTypes.IHttpClient'.
 */
function readIdent(src: string, i: number): { name: string; end: number } | null {
  const start = i;
  while (i < src.length && /[\w$.]/.test(src[i])) i++;
  if (i === start) return null;
  return { name: src.slice(start, i), end: i };
}

// ─── Class name extractor ─────────────────────────────────────────────────────

function extractClassName(src: string): string | null {
  const m = src.match(/class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+BaseModule/);
  return m?.[1] ?? null;
}

// ─── Core parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single Module.ts file content and extract all DI bindings.
 * The `filePath` is used only for attribution in the output.
 */
export function parseModuleContent(src: string, filePath: string): ParsedModule {
  const className = extractClassName(src);
  const bindings: DiBinding[] = [];
  const skipped: ParsedModule['skipped'] = [];

  // Find every '.bind<' occurrence. Using matchAll to avoid .exec() in source.
  const BIND_PATTERN = /\.bind</g;

  for (const match of src.matchAll(BIND_PATTERN)) {
    const bindStart = match.index!; // position of '.'
    const angleStart = bindStart + 5; // '.bind' is 5 chars, '<' is next

    // 1. Extract generic type argument (the interface type), handling nesting
    const angles = scanAngles(src, angleStart);
    if (!angles) {
      skipped.push({
        offset: bindStart,
        reason: 'unclosed angle bracket in generic',
        snippet: src.slice(bindStart, bindStart + 80),
      });
      continue;
    }
    const interfaceGeneric = angles.content.trim();
    // Base name: everything before the first '<' for complex generics
    const interfaceName = interfaceGeneric.split('<')[0].trim();

    // 2. After '>', expect '(' for the DI symbol identifier
    let pos = skipWs(src, angles.end);
    if (pos >= src.length || src[pos] !== '(') {
      skipped.push({
        offset: bindStart,
        reason: 'expected ( after generic type arg',
        snippet: src.slice(bindStart, bindStart + 80),
      });
      continue;
    }
    const symbolParens = scanParens(src, pos);
    if (!symbolParens) {
      skipped.push({
        offset: bindStart,
        reason: 'unclosed ( in symbol identifier',
        snippet: src.slice(bindStart, bindStart + 80),
      });
      continue;
    }
    const symbol = symbolParens.content.trim();
    pos = symbolParens.end;

    // 3. Expect chained '.' followed by binding method (possibly after newlines)
    pos = skipWs(src, pos);
    const dotPos = matchLit(src, pos, '.');
    if (dotPos < 0) {
      skipped.push({
        offset: bindStart,
        reason: 'no chained method after symbol paren',
        snippet: src.slice(bindStart, bindStart + 120),
      });
      continue;
    }
    pos = dotPos;

    const methodIdent = readIdent(src, pos);
    if (!methodIdent) {
      skipped.push({
        offset: bindStart,
        reason: 'could not read method name',
        snippet: src.slice(bindStart, bindStart + 100),
      });
      continue;
    }
    const method = methodIdent.name;
    pos = methodIdent.end;

    // 4. Parse binding by method type
    let kind: BindingKind = 'unknown';
    let concreteName: string | null = null;
    let aliasTarget: string | null = null;
    let scope: BindingScope = 'none';

    if (method === 'to') {
      kind = 'to';
      pos = skipWs(src, pos);
      if (pos >= src.length || src[pos] !== '(') {
        skipped.push({
          offset: bindStart,
          reason: '.to() missing (',
          snippet: src.slice(bindStart, bindStart + 100),
        });
        continue;
      }
      const toParens = scanParens(src, pos);
      if (!toParens) {
        skipped.push({
          offset: bindStart,
          reason: '.to() unclosed (',
          snippet: src.slice(bindStart, bindStart + 100),
        });
        continue;
      }
      // Trim any type assertion or whitespace — concrete is a simple identifier
      concreteName = toParens.content.trim().split(/[\s<(]/)[0] || null;
      pos = toParens.end;
    } else if (method === 'toSelf') {
      kind = 'toSelf';
      concreteName = interfaceName; // self-binding: concrete = interface
      pos = skipWs(src, pos);
      const selfParens = scanParens(src, pos);
      if (selfParens) pos = selfParens.end;
    } else if (method === 'toService') {
      kind = 'toService';
      pos = skipWs(src, pos);
      const serviceParens = scanParens(src, pos);
      if (!serviceParens) {
        skipped.push({
          offset: bindStart,
          reason: '.toService() unclosed (',
          snippet: src.slice(bindStart, bindStart + 100),
        });
        continue;
      }
      aliasTarget = serviceParens.content.trim();
      pos = serviceParens.end;
    } else if (method === 'toDynamicValue') {
      kind = 'toDynamicValue';
      pos = skipWs(src, pos);
      // Scan past the factory function body — may be large
      const dynParens = scanParens(src, pos, 10000);
      if (dynParens) pos = dynParens.end;
    } else if (method === 'toConstantValue') {
      kind = 'toConstantValue';
      pos = skipWs(src, pos);
      const constParens = scanParens(src, pos, 4000);
      if (constParens) pos = constParens.end;
    } else if (method === 'toFactory') {
      kind = 'toFactory';
      pos = skipWs(src, pos);
      const factParens = scanParens(src, pos, 4000);
      if (factParens) pos = factParens.end;
    } else if (method === 'toAutoFactory' || method === 'toAutoNamedFactory') {
      // Inversify factory variants — return factory functions, not concrete instances
      // Treat like toDynamicValue: flag as dynamic, skip stitching
      kind = 'toDynamicValue';
      pos = skipWs(src, pos);
      const autoParens = scanParens(src, pos, 4000);
      if (autoParens) pos = autoParens.end;
    } else {
      // Unknown or future Inversify method
      skipped.push({
        offset: bindStart,
        reason: `unknown binding method: ${method}`,
        snippet: src.slice(bindStart, bindStart + 100),
      });
      continue;
    }

    // 5. Optionally parse scope modifier: .inSingletonScope() / .inTransientScope() / .inRequestScope()
    const savedPos = pos;
    pos = skipWs(src, pos);
    const scopeDotPos = matchLit(src, pos, '.');
    if (scopeDotPos >= 0) {
      const scopeIdent = readIdent(src, scopeDotPos);
      if (scopeIdent?.name === 'inSingletonScope') {
        scope = 'singleton';
        const sp = scanParens(src, skipWs(src, scopeIdent.end));
        if (sp) pos = sp.end;
      } else if (scopeIdent?.name === 'inTransientScope') {
        scope = 'transient';
        const sp = scanParens(src, skipWs(src, scopeIdent!.end));
        if (sp) pos = sp.end;
      } else if (scopeIdent?.name === 'inRequestScope') {
        scope = 'request';
        const sp = scanParens(src, skipWs(src, scopeIdent!.end));
        if (sp) pos = sp.end;
      } else {
        pos = savedPos; // not a scope modifier, leave pos before '.'
      }
    } else {
      pos = savedPos;
    }

    bindings.push({
      interfaceName,
      interfaceGeneric,
      symbol,
      concreteName,
      aliasTarget,
      kind,
      scope,
      moduleFile: filePath,
      offset: bindStart,
    });
  }

  return { file: filePath, className, bindings, skipped };
}

// ─── File and directory scanning ──────────────────────────────────────────────

/** Parse a single Module.ts file from disk. */
export async function parseModuleFile(filePath: string): Promise<ParsedModule> {
  const src = await fs.readFile(filePath, 'utf-8');
  return parseModuleContent(src, filePath);
}

/**
 * Scan all "di/Module.ts" files under `rootDir` and parse their bindings.
 * Uses glob to find files (covers both standard and nested DI paths).
 */
export async function scanAllModules(rootDir: string): Promise<ParsedModule[]> {
  const files = await glob('**/di/Module.ts', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

  const results = await Promise.all(files.map((f) => parseModuleFile(f)));
  return results;
}

// ─── Binding index ────────────────────────────────────────────────────────────

/**
 * Flat index for fast lookup during graph stitching.
 * Built once from all ParsedModules, used repeatedly by the stitcher.
 */
export interface BindingIndex {
  /** interfaceName → all concrete bindings (multi-inject → multiple entries) */
  concreteBindings: Map<string, DiBinding[]>;
  /** interfaceName → toService alias bindings (resolved in Phase 2) */
  serviceAliases: Map<string, DiBinding[]>;
  /** moduleClassName → ParsedModule (for Phase 2 platform composition lookup) */
  modulesByClass: Map<string, ParsedModule>;
  modules: ParsedModule[];
  stats: {
    totalFiles: number;
    totalBindings: number;
    concreteCount: number;
    serviceAliasCount: number;
    dynamicCount: number;
    skippedCount: number;
  };
}

export function buildBindingIndex(modules: ParsedModule[]): BindingIndex {
  const concreteBindings = new Map<string, DiBinding[]>();
  const serviceAliases = new Map<string, DiBinding[]>();
  const modulesByClass = new Map<string, ParsedModule>();
  let concreteCount = 0;
  let serviceAliasCount = 0;
  let dynamicCount = 0;
  let skippedCount = 0;

  for (const mod of modules) {
    if (mod.className) modulesByClass.set(mod.className, mod);
    skippedCount += mod.skipped.length;

    for (const b of mod.bindings) {
      if (b.kind === 'to' || b.kind === 'toSelf') {
        concreteCount++;
        const list = concreteBindings.get(b.interfaceName) ?? [];
        list.push(b);
        concreteBindings.set(b.interfaceName, list);
      } else if (b.kind === 'toService') {
        serviceAliasCount++;
        const list = serviceAliases.get(b.interfaceName) ?? [];
        list.push(b);
        serviceAliases.set(b.interfaceName, list);
      } else if (b.kind === 'toDynamicValue' || b.kind === 'toFactory') {
        dynamicCount++;
      }
    }
  }

  return {
    concreteBindings,
    serviceAliases,
    modulesByClass,
    modules,
    stats: {
      totalFiles: modules.length,
      totalBindings: modules.reduce((n, m) => n + m.bindings.length, 0),
      concreteCount,
      serviceAliasCount,
      dynamicCount,
      skippedCount,
    },
  };
}

// ─── CLI runner (for validation) ─────────────────────────────────────────────

const isMain =
  process.argv[1]?.endsWith('inversify-module-parser.ts') ||
  process.argv[1]?.endsWith('inversify-module-parser.js');

if (isMain) {
  const rootDir = process.argv[2] ?? path.join(process.env['HOME'] ?? '', 'work/apps');
  process.stderr.write(`Scanning ${rootDir} ...\n`);
  scanAllModules(rootDir)
    .then((modules) => {
      const idx = buildBindingIndex(modules);
      const sampleConcretes = [...idx.concreteBindings.entries()].slice(0, 20).map(([k, vs]) => ({
        interface: k,
        concretes: vs.map((b) => ({
          concrete: b.concreteName,
          scope: b.scope,
          file: b.moduleFile.split('/').slice(-5).join('/'),
        })),
      }));
      const sampleAliases = [...idx.serviceAliases.entries()].slice(0, 10).map(([k, vs]) => ({
        interface: k,
        aliasTargets: vs.map((b) => b.aliasTarget),
      }));
      const skippedSample = modules.flatMap((m) => m.skipped).slice(0, 10);

      process.stdout.write(
        JSON.stringify(
          { stats: idx.stats, sampleConcretes, sampleAliases, skippedSample },
          null,
          2,
        ) + '\n',
      );
    })
    .catch((err: unknown) => {
      process.stderr.write(String(err) + '\n');
      process.exit(1);
    });
}
