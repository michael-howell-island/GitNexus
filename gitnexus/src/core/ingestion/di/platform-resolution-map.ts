/**
 * Platform Resolution Map — Phase 2
 *
 * Builds per-platform interface→concrete binding maps by reading the
 * composition files in libs/island/di-modules/ and merging them with
 * the binding index from Phase 1.
 *
 * Architecture:
 *   - Each platform's active set = CommonModules + platform-specific arrays
 *   - No inheritance/override: platforms pick modules explicitly (flat union)
 *   - Platform-specific bindings win if same symbol appears in both (shouldn't happen)
 *   - The desktop platform uses 4 composition files merged together
 *
 * Composition file structure:
 *   di-modules/
 *   ├─ common/src/CommonModules.ts          (all platforms share this)
 *   ├─ desktop/src/CoreDesktopModules.ts
 *   ├─ desktop/src/FeatureDesktopModules.ts
 *   ├─ desktop/src/SecurityDesktopModules.ts
 *   ├─ desktop/src/IntegrationDesktopModules.ts
 *   ├─ desktop-mv3/src/DesktopModules.ts
 *   ├─ lite/src/LiteModules.ts
 *   ├─ lite-firefox/src/LiteFirefoxModules.ts
 *   ├─ lite-safari/src/LiteSafariModules.ts
 *   ├─ lite-mv3/src/LiteMv3Modules.ts
 *   ├─ ios/src/IosModules.ts
 *   └─ android/src/AndroidModules.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { BindingIndex, DiBinding } from './inversify-module-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Platform =
  | 'desktop'
  | 'desktop-mv3'
  | 'lite'
  | 'lite-firefox'
  | 'lite-safari'
  | 'lite-mv3'
  | 'ios'
  | 'android'
  | 'common';

export interface PlatformResolutionMap {
  platform: Platform;
  /** interfaceName → concrete bindings active for this platform */
  concreteBindings: Map<string, DiBinding[]>;
  /** interfaceName → toService aliases active for this platform */
  serviceAliases: Map<string, DiBinding[]>;
  /** Module class names included in this platform's active set */
  activeModuleClasses: Set<string>;
  stats: {
    activeModuleCount: number;
    resolvedBindingCount: number;
    unresolvedModuleCount: number;
  };
}

// ─── Composition file definitions ─────────────────────────────────────────────

interface PlatformCompositionDef {
  platform: Platform;
  /** Relative paths from di-modules/ root to composition files for this platform */
  compositionFiles: string[];
}

const COMPOSITION_DEFS: PlatformCompositionDef[] = [
  {
    platform: 'desktop',
    compositionFiles: [
      'common/src/CommonModules.ts',
      'desktop/src/CoreDesktopModules.ts',
      'desktop/src/FeatureDesktopModules.ts',
      'desktop/src/SecurityDesktopModules.ts',
      'desktop/src/IntegrationDesktopModules.ts',
    ],
  },
  {
    platform: 'desktop-mv3',
    compositionFiles: ['common/src/CommonModules.ts', 'desktop-mv3/src/DesktopModules.ts'],
  },
  {
    platform: 'lite',
    compositionFiles: ['common/src/CommonModules.ts', 'lite/src/LiteModules.ts'],
  },
  {
    platform: 'lite-firefox',
    compositionFiles: ['common/src/CommonModules.ts', 'lite-firefox/src/LiteFirefoxModules.ts'],
  },
  {
    platform: 'lite-safari',
    compositionFiles: ['common/src/CommonModules.ts', 'lite-safari/src/LiteSafariModules.ts'],
  },
  {
    platform: 'lite-mv3',
    compositionFiles: ['common/src/CommonModules.ts', 'lite-mv3/src/LiteMv3Modules.ts'],
  },
  {
    platform: 'ios',
    compositionFiles: ['common/src/CommonModules.ts', 'ios/src/IosModules.ts'],
  },
  {
    platform: 'android',
    compositionFiles: ['common/src/CommonModules.ts', 'android/src/AndroidModules.ts'],
  },
];

// ─── Composition file parser ──────────────────────────────────────────────────

/**
 * Extract module class names from a composition file.
 * Looks for array literals like:
 *   export const FooModules = [ FooModule, BarModule, BazModule ]
 *
 * Returns all identifiers found inside array literals in the file.
 * Simple regex approach: sufficient given the architecture's regularity.
 */
export function parseCompositionFile(src: string): string[] {
  const classNames: string[] = [];

  // Find all array literals in the file and extract identifiers from them.
  // Pattern: [ Identifier, Identifier, ... ] — may span multiple lines
  const ARRAY_PATTERN = /\[\s*([\w\s,\n\r]+?)\s*\]/g;

  for (const arrayMatch of src.matchAll(ARRAY_PATTERN)) {
    const arrayContent = arrayMatch[1];
    // Split by comma or newline, trim, filter to valid identifiers (PascalCase module names)
    const items = arrayContent
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Z]\w+$/.test(s)); // Module class names are PascalCase
    classNames.push(...items);
  }

  // Deduplicate while preserving order
  return [...new Set(classNames)];
}

// ─── Platform map builder ─────────────────────────────────────────────────────

/**
 * Load and parse a single composition file, returning its module class names.
 * Returns empty array if file doesn't exist (graceful — some platforms may not
 * have all expected files yet).
 */
async function loadCompositionFile(filePath: string): Promise<string[]> {
  try {
    const src = await fs.readFile(filePath, 'utf-8');
    return parseCompositionFile(src);
  } catch {
    return [];
  }
}

/**
 * Build the resolution map for a single platform.
 */
async function buildPlatformMap(
  def: PlatformCompositionDef,
  diModulesRoot: string,
  index: BindingIndex,
): Promise<PlatformResolutionMap> {
  // Load all composition files for this platform and merge module class names
  const allClassNames: string[] = [];
  for (const relPath of def.compositionFiles) {
    const absPath = path.join(diModulesRoot, relPath);
    const names = await loadCompositionFile(absPath);
    allClassNames.push(...names);
  }

  const activeModuleClasses = new Set(allClassNames);

  // Build binding maps from the modules active for this platform
  const concreteBindings = new Map<string, DiBinding[]>();
  const serviceAliases = new Map<string, DiBinding[]>();
  let resolvedBindingCount = 0;
  let unresolvedModuleCount = 0;

  for (const className of activeModuleClasses) {
    const mod = index.modulesByClass.get(className);
    if (!mod) {
      unresolvedModuleCount++;
      continue;
    }

    for (const b of mod.bindings) {
      if (b.kind === 'to' || b.kind === 'toSelf') {
        resolvedBindingCount++;
        const list = concreteBindings.get(b.interfaceName) ?? [];
        // Platform-specific: if same interface already bound, append (multi-inject)
        list.push(b);
        concreteBindings.set(b.interfaceName, list);
      } else if (b.kind === 'toService') {
        const list = serviceAliases.get(b.interfaceName) ?? [];
        list.push(b);
        serviceAliases.set(b.interfaceName, list);
      }
    }
  }

  return {
    platform: def.platform,
    concreteBindings,
    serviceAliases,
    activeModuleClasses,
    stats: {
      activeModuleCount: activeModuleClasses.size,
      resolvedBindingCount,
      unresolvedModuleCount,
    },
  };
}

/**
 * Build resolution maps for all platforms.
 *
 * @param appsRoot - Root of the apps repo, e.g. ~/work/apps
 * @param index - Binding index from Phase 1
 */
export async function buildAllPlatformMaps(
  appsRoot: string,
  index: BindingIndex,
): Promise<Map<Platform, PlatformResolutionMap>> {
  const diModulesRoot = path.join(appsRoot, 'libs/island/di-modules');
  const maps = new Map<Platform, PlatformResolutionMap>();

  await Promise.all(
    COMPOSITION_DEFS.map(async (def) => {
      const platformMap = await buildPlatformMap(def, diModulesRoot, index);
      maps.set(def.platform, platformMap);
    }),
  );

  return maps;
}

// ─── Union resolution helper ──────────────────────────────────────────────────

/**
 * Build a union resolution map across all platforms.
 * Useful for graph stitching when the call site's platform is unknown —
 * we can offer all possible concretes with a note about which platforms they're active in.
 *
 * For most symbols in CommonModules, this equals any single platform's map.
 */
export function buildUnionResolutionMap(platformMaps: Map<Platform, PlatformResolutionMap>): {
  concreteBindings: Map<string, DiBinding[]>;
  serviceAliases: Map<string, DiBinding[]>;
} {
  const concreteBindings = new Map<string, DiBinding[]>();
  const serviceAliases = new Map<string, DiBinding[]>();

  for (const platformMap of platformMaps.values()) {
    for (const [interfaceName, bindings] of platformMap.concreteBindings) {
      const list = concreteBindings.get(interfaceName) ?? [];
      for (const b of bindings) {
        // Deduplicate: same concrete from same file only once
        if (
          !list.some(
            (existing) =>
              existing.moduleFile === b.moduleFile && existing.concreteName === b.concreteName,
          )
        ) {
          list.push(b);
        }
      }
      concreteBindings.set(interfaceName, list);
    }

    for (const [interfaceName, aliases] of platformMap.serviceAliases) {
      const list = serviceAliases.get(interfaceName) ?? [];
      for (const b of aliases) {
        if (
          !list.some(
            (existing) =>
              existing.moduleFile === b.moduleFile && existing.aliasTarget === b.aliasTarget,
          )
        ) {
          list.push(b);
        }
      }
      serviceAliases.set(interfaceName, list);
    }
  }

  return { concreteBindings, serviceAliases };
}

// ─── toService alias resolution ───────────────────────────────────────────────

/**
 * Resolve a toService chain: IFoo → toService(BarModuleTypes.Bar) → concrete bound to Bar symbol.
 *
 * Returns the resolved concrete DiBinding(s), or empty if unresolvable.
 * Follows at most `maxDepth` alias hops to avoid cycles.
 */
export function resolveServiceAlias(
  interfaceName: string,
  platformMap: PlatformResolutionMap,
  maxDepth = 3,
): DiBinding[] {
  let current = interfaceName;
  const visited = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    const concretes = platformMap.concreteBindings.get(current);
    if (concretes && concretes.length > 0) return concretes;

    const aliases = platformMap.serviceAliases.get(current);
    if (!aliases || aliases.length === 0) break;

    // Follow the first alias (multiple aliases for same interface are rare in this codebase)
    const alias = aliases[0];
    if (!alias.aliasTarget) break;

    // The alias target is a symbol expression like 'NetworkModuleTypes.NetworkEntryPoint'
    // We need to find which interface name maps to that symbol in the binding index.
    // Simple heuristic: the last part of the qualified name (after '.') is often the interface name
    const targetSymbolLast = alias.aliasTarget.split('.').pop() ?? alias.aliasTarget;
    current = targetSymbolLast;
  }

  return [];
}
