/**
 * GraphOverview — community-level graph visualization
 *
 * Renders ~6k community nodes instead of the full 175k symbol graph.
 * Click a community → drill into its individual nodes via /api/graph/cluster.
 *
 * Two modes:
 *   overview  — all communities as circles sized by symbolCount
 *   cluster   — individual nodes within one community
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { ChevronLeft, Loader2, X } from '@/lib/lucide-icons';
import { fetchGraphOverview, fetchClusterGraph } from '../services/backend-client';
import { getCommunityColor, NODE_COLORS, NODE_SIZES } from '../lib/constants';

interface Props {
  repo?: string;
  onClose: () => void;
}

type Mode = 'overview' | 'cluster';

// Build a graphology graph from flat node/relationship arrays.
// Simpler than knowledgeGraphToGraphology — no hierarchy positioning needed
// since ForceAtlas2 will handle layout.
function buildClusterGraph(nodes: GraphNode[], relationships: GraphRelationship[]): Graph {
  const graph = new Graph({ multi: false });

  const nodeSet = new Set(nodes.map((n) => n.id));

  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = 10 + Math.random() * 5;
    graph.addNode(n.id, {
      label: n.properties.name ?? n.id,
      x: r * Math.cos(angle),
      y: r * Math.sin(angle),
      size: (NODE_SIZES[n.label as keyof typeof NODE_SIZES] ?? 4) * 0.6,
      color: NODE_COLORS[n.label as keyof typeof NODE_COLORS] ?? '#6b7280',
      nodeType: n.label,
      filePath: n.properties.filePath ?? '',
    });
  });

  relationships.forEach((r) => {
    if (!nodeSet.has(r.sourceId) || !nodeSet.has(r.targetId)) return;
    if (r.sourceId === r.targetId) return;
    if (graph.hasEdge(r.sourceId, r.targetId)) return;
    graph.addEdge(r.sourceId, r.targetId, {
      size: 0.5,
      color: 'rgba(255,255,255,0.12)',
    });
  });

  return graph;
}

export function GraphOverview({ repo, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);

  const [mode, setMode] = useState<Mode>('overview');
  const [clusterLabel, setClusterLabel] = useState<string | null>(null);
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);

  const teardown = useCallback(() => {
    layoutRef.current?.stop();
    layoutRef.current?.kill();
    layoutRef.current = null;
    sigmaRef.current?.kill();
    sigmaRef.current = null;
  }, []);

  const mountSigma = useCallback(
    (graph: Graph, onNodeClick?: (communityLabel: string) => void) => {
      if (!containerRef.current) return;
      teardown();

      const sigma = new Sigma(graph, containerRef.current, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 4,
        defaultNodeColor: '#4b5563',
        defaultEdgeColor: 'rgba(255,255,255,0.08)',
      });

      sigma.on('enterNode', ({ node }: { node: string }) => {
        const attrs = graph.getNodeAttributes(node) as { label?: string };
        setHoveredLabel(attrs.label ?? node);
      });

      sigma.on('leaveNode', () => setHoveredLabel(null));

      if (onNodeClick) {
        sigma.on('clickNode', ({ node }: { node: string }) => {
          const attrs = graph.getNodeAttributes(node) as { communityLabel?: string };
          if (attrs.communityLabel) onNodeClick(attrs.communityLabel);
        });
      }

      sigmaRef.current = sigma;

      const layout = new FA2Layout(graph, {
        settings: {
          gravity: 0.05,
          scalingRatio: 8,
          slowDown: 3,
          barnesHutOptimize: graph.order > 1000,
          barnesHutTheta: 0.5,
        },
      });
      layout.start();
      layoutRef.current = layout;

      const stopAfter = graph.order > 2000 ? 5000 : 2500;
      setTimeout(() => layout.stop(), stopAfter);
    },
    [teardown],
  );

  // Load overview (community nodes + cross-community edges)
  useEffect(() => {
    if (mode !== 'overview') return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchGraphOverview(repo)
      .then((data) => {
        if (cancelled) return;

        const graph = new Graph({ multi: false });
        const n = data.communities.length;

        data.communities.forEach((c, i) => {
          const size = Math.max(4, Math.min(50, Math.sqrt(c.symbolCount + 1) * 2));
          // Initial circular layout — FA2 will refine from here
          graph.addNode(c.id, {
            label: c.label || `cluster-${i}`,
            communityLabel: c.label,
            x: Math.cos((2 * Math.PI * i) / n),
            y: Math.sin((2 * Math.PI * i) / n),
            size,
            color: getCommunityColor(i),
            symbolCount: c.symbolCount,
          });
        });

        data.edges.forEach((e) => {
          if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) return;
          if (e.source === e.target) return;
          if (graph.hasEdge(e.source, e.target)) return;
          const w = Math.max(0.3, Math.min(2.5, Math.log(e.weight + 1) * 0.4));
          graph.addEdge(e.source, e.target, { size: w });
        });

        setNodeCount(graph.order);
        setEdgeCount(graph.size);
        mountSigma(graph, (label: string) => {
          setClusterLabel(label);
          setMode('cluster');
        });
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message ?? 'Failed to load overview');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, repo, mountSigma]);

  // Load cluster drill-down
  useEffect(() => {
    if (mode !== 'cluster' || !clusterLabel) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchClusterGraph(clusterLabel, repo)
      .then((data) => {
        if (cancelled) return;
        const graph = buildClusterGraph(data.nodes, data.relationships);
        setNodeCount(graph.order);
        setEdgeCount(graph.size);
        mountSigma(graph);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message ?? 'Failed to load cluster');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, clusterLabel, repo, mountSigma]);

  // Cleanup on unmount
  useEffect(() => teardown, [teardown]);

  const goBack = useCallback(() => {
    setMode('overview');
    setClusterLabel(null);
    setHoveredLabel(null);
  }, []);

  return (
    <div className="bg-background fixed inset-0 z-50 flex flex-col">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-4">
        <div className="flex items-center gap-3">
          {mode === 'cluster' && (
            <button
              onClick={goBack}
              className="flex items-center gap-1 text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              <ChevronLeft className="h-4 w-4" />
              All communities
            </button>
          )}
          {mode === 'cluster' && <span className="text-text-tertiary">/</span>}
          <span className="text-sm font-medium text-text-primary">
            {mode === 'overview' ? 'Community Graph' : (clusterLabel ?? 'Cluster')}
          </span>
          {!loading && (
            <span className="text-text-tertiary text-xs">
              {nodeCount.toLocaleString()} nodes · {edgeCount.toLocaleString()} edges
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hoveredLabel && (
            <span className="rounded bg-elevated px-2 py-0.5 text-xs text-text-secondary">
              {hoveredLabel}
            </span>
          )}
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1">
        <div ref={containerRef} className="h-full w-full" />

        {loading && (
          <div className="bg-background/70 absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              {mode === 'overview' ? 'Loading communities…' : `Loading ${clusterLabel}…`}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          </div>
        )}

        {mode === 'overview' && !loading && !error && (
          <p className="text-text-tertiary pointer-events-none absolute bottom-4 left-4 text-xs">
            Click a community to explore its symbols
          </p>
        )}
      </div>
    </div>
  );
}
