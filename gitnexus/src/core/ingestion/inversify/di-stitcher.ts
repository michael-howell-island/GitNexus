/**
 * DI Stitcher — Phase 3
 *
 * Post-graph pass that adds synthetic CALLS edges through Inversify DI boundaries.
 *
 * Problem: when TypeScript code calls `this.httpClient.get(url)` and `httpClient`
 * is typed as `IHttpClient`, the static call graph hits the interface method and
 * stops. The DI container wires `IHttpClient → HttpClient` at runtime, but that
 * binding is invisible to static analysis.
 *
 * Solution: after the graph is built, for every CALLS edge targeting a method
 * defined on an interface, look up the DI-bound concrete and add a synthetic
 * CALLS edge from the same source to the concrete method. Process detection
 * then naturally flows through the DI boundary.
 *
 * Algorithm:
 *   1. Index Interface nodes by their filePath (interface file → interface names)
 *   2. Index Class nodes by name → filePath
 *   3. Index Method nodes by filePath → methodName → nodeId
 *   4. For each CALLS edge:
 *      a. Is the target a method in an interface file?
 *      b. Is that interface in the DI binding index?
 *      c. Find the concrete class's file and the same-named method node
 *      d. Add synthetic CALLS edge with confidence 0.90–0.95
 *
 * The stitcher is read-only over the binding index and only calls
 * graph.addRelationship() — it never removes or mutates existing edges.
 */

import { generateId } from '../../../lib/utils.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { BindingIndex, DiBinding, BindingScope } from './inversify-module-parser.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StitchResult {
  syntheticEdgesAdded: number;
  interfacesResolved: number;
  interfacesMissing: number;
  concretesMissing: number;
  /** Breakdown of how many synthetic edges each interface generated */
  topInterfaces: Array<{ interface: string; edges: number }>;
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

function scopeConfidence(scope: BindingScope): number {
  switch (scope) {
    case 'singleton':
      return 0.95;
    case 'transient':
    case 'request':
      return 0.9;
    default:
      return 0.85;
  }
}

// ─── Main stitcher ────────────────────────────────────────────────────────────

/**
 * Stitch DI bindings into the graph.
 *
 * @param graph - The KnowledgeGraph built by the ingestion pipeline (mutated in-place)
 * @param bindingIndex - Phase 1/2 output: interface → concrete bindings
 * @returns stats about what was stitched
 */
export function stitchDiBindings(graph: KnowledgeGraph, bindingIndex: BindingIndex): StitchResult {
  // ── Step 1: Build lookup tables from the graph ────────────────────────────

  /**
   * interfaceFileMap: filePath → Set of interface names defined in that file.
   * Used to check if a CALLS target's filePath is an interface file.
   */
  const interfaceFileMap = new Map<string, Set<string>>();

  /**
   * classToFile: concrete class name → the filePath that defines it.
   * Used to find where to look for the concrete method node.
   */
  const classToFile = new Map<string, string>();

  /**
   * methodsByFile: filePath → (methodName → nodeId).
   * Used to look up a method node in a concrete class's file.
   * When multiple methods share a name (overloads), we keep the first — good enough.
   */
  const methodsByFile = new Map<string, Map<string, string>>();

  for (const node of graph.iterNodes()) {
    const { label, properties } = node;
    const { name, filePath } = properties;
    if (!name || !filePath) continue;

    if (label === 'Interface') {
      let names = interfaceFileMap.get(filePath);
      if (!names) {
        names = new Set();
        interfaceFileMap.set(filePath, names);
      }
      names.add(name);
    } else if (label === 'Class') {
      // Last-write wins when multiple classes share a name (very rare).
      classToFile.set(name, filePath);
    } else if (label === 'Method' || label === 'Function') {
      let fileMap = methodsByFile.get(filePath);
      if (!fileMap) {
        fileMap = new Map();
        methodsByFile.set(filePath, fileMap);
      }
      if (!fileMap.has(name)) {
        fileMap.set(name, node.id);
      }
    }
  }

  // ── Step 2: Quick-filter — only interface names that have DI bindings ─────

  // The binding index may have thousands of interface names; we only care about
  // the subset that also appear in interfaceFileMap values.
  const stitchableInterfaces = new Set<string>();
  for (const names of interfaceFileMap.values()) {
    for (const name of names) {
      if (bindingIndex.concreteBindings.has(name)) {
        stitchableInterfaces.add(name);
      }
    }
  }

  // interfaceNameToBindings: interface name → DI bindings (filtered to only stitchable ones)
  const interfaceNameToBindings = new Map<string, DiBinding[]>();
  for (const name of stitchableInterfaces) {
    const bindings = bindingIndex.concreteBindings.get(name);
    if (bindings && bindings.length > 0) {
      interfaceNameToBindings.set(name, bindings);
    }
  }

  // ── Step 3: Add interface-method → concrete-method bridge edges ──────────
  //
  // GitNexus drops CALLS edges to interface methods when it can't resolve the
  // receiver type statically. So there are no "CALLS to interface method" edges
  // to stitch. Instead we add direct bridges:
  //
  //   IHttpClient.request  →  HttpClient.request   (synthetic, di-resolved)
  //
  // Any graph traversal that reaches an interface method node (now or in future)
  // will cross the bridge to the concrete. Process detection traverses CALLS
  // edges transitively, so these bridges enable it to see through DI boundaries.

  let syntheticEdgesAdded = 0;
  let interfacesResolved = 0;
  let interfacesMissing = 0;
  let concretesMissing = 0;
  const interfaceEdgeCounts = new Map<string, number>();

  for (const node of graph.iterNodes()) {
    const { label, properties } = node;
    if (label !== 'Method' && label !== 'Function') continue;

    const filePath = properties.filePath;
    if (!filePath) continue;

    // Is this node defined in an interface file?
    const interfaceNamesInFile = interfaceFileMap.get(filePath);
    if (!interfaceNamesInFile) continue;

    const methodName = properties.name;
    if (!methodName) continue;

    // For each interface defined in this file that has DI bindings
    for (const interfaceName of interfaceNamesInFile) {
      const bindings = interfaceNameToBindings.get(interfaceName);
      if (!bindings) {
        interfacesMissing++;
        continue;
      }

      interfacesResolved++;

      for (const binding of bindings) {
        const concreteName = binding.concreteName;
        if (!concreteName) continue;

        const concreteFile = classToFile.get(concreteName);
        if (!concreteFile) {
          concretesMissing++;
          continue;
        }

        const concreteFileMethods = methodsByFile.get(concreteFile);
        if (!concreteFileMethods) {
          concretesMissing++;
          continue;
        }

        const concreteMethodId = concreteFileMethods.get(methodName);
        if (!concreteMethodId) {
          concretesMissing++;
          continue;
        }

        // Don't self-loop
        if (concreteMethodId === node.id) continue;

        const syntheticId = generateId(
          'CALLS',
          `di-bridge:${node.id}:${interfaceName}.${methodName}->${concreteMethodId}`,
        );

        graph.addRelationship({
          id: syntheticId,
          sourceId: node.id,
          targetId: concreteMethodId,
          type: 'CALLS',
          confidence: scopeConfidence(binding.scope),
          reason: 'di-resolved',
        });

        syntheticEdgesAdded++;
        interfaceEdgeCounts.set(interfaceName, (interfaceEdgeCounts.get(interfaceName) ?? 0) + 1);
      }
    }
  }

  const topInterfaces = [...interfaceEdgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([iface, edges]) => ({ interface: iface, edges }));

  return {
    syntheticEdgesAdded,
    interfacesResolved,
    interfacesMissing,
    concretesMissing,
    topInterfaces,
  };
}

// ─── Convenience wrapper with DI module scanning ──────────────────────────────

/**
 * Full DI stitch pass: scan the apps repo for DI modules, build the binding
 * index, and stitch the graph.
 *
 * Intended to be called from run-analyze.ts between pipeline completion and
 * LadybugDB loading.
 *
 * @param graph - The built KnowledgeGraph (mutated in-place)
 * @param appsRoot - Root of the apps repo, e.g. ~/work/apps
 * @returns stitching stats, or null if appsRoot is unreachable
 */
export async function runDiStitchPass(
  graph: KnowledgeGraph,
  appsRoot: string,
): Promise<StitchResult | null> {
  try {
    const { scanAllModules, buildBindingIndex } = await import('./inversify-module-parser.js');
    const { buildAllPlatformMaps, buildUnionResolutionMap } =
      await import('./platform-resolution-map.js');

    const modules = await scanAllModules(appsRoot);
    const index = buildBindingIndex(modules);

    // Use the union of all platform maps — most bindings are in CommonModules
    // and apply to all platforms. Platform-specific divergence is rare enough
    // that the union approach avoids false negatives without meaningful false positives.
    const platformMaps = await buildAllPlatformMaps(appsRoot, index);
    const union = buildUnionResolutionMap(platformMaps);

    // Build a BindingIndex-shaped object from the union for the stitcher
    const unionIndex: BindingIndex = {
      concreteBindings: union.concreteBindings,
      serviceAliases: union.serviceAliases,
      modulesByClass: index.modulesByClass,
      modules: index.modules,
      stats: index.stats,
    };

    return stitchDiBindings(graph, unionIndex);
  } catch {
    // Graceful failure — if apps root doesn't exist or parsing fails, don't
    // break the analysis of other repos
    return null;
  }
}
