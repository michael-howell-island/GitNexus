/**
 * TopologyGraph — folder-hierarchy visualization for large codebases.
 *
 * Rendering model (same pattern as SvgTree in pr-manager):
 *  - d3.stratify() builds the hierarchy from the flat folder tree
 *  - Custom row/column layout: x = row * ROW_H, y = depth * COL_W
 *  - Pure SVG — no force-directed layout, fully deterministic
 *  - Bézier curves for cross-folder CALLS edges
 *  - Click folder to expand / collapse children
 *  - Drag to pan, wheel to zoom
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type MouseEvent,
  type WheelEvent,
} from 'react';
import { Loader2, AlertCircle } from '@/lib/lucide-icons';
import { fetchTopology, type TopologyFolder, type TopologyEdge } from '../services/backend-client';

// ── Layout constants ──────────────────────────────────────────────────────

const ROW_H = 28; // vertical spacing between nodes
const COL_W = 200; // horizontal spacing per depth level
const BOX_H = 20; // node box height
const BOX_PAD = 8; // horizontal padding inside box
const FONT_SIZE = 11;
const CH_W = 6.5; // approximate char width at FONT_SIZE in monospace
const MAX_LABEL = 28; // characters before truncation

// ── Types ─────────────────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  nodeCount: number;
  fileCount: number;
  depth: number;
  x: number; // SVG y (row position)
  y: number; // SVG x (column position)
  hasChildren: boolean;
  isExpanded: boolean;
  children: LayoutNode[];
  parentId: string | null;
}

// ── Helper: build layout tree with expand/collapse state ──────────────────

function buildLayout(
  folder: TopologyFolder,
  expanded: Set<string>,
  depth: number,
  rowRef: { current: number },
): LayoutNode {
  const isExpanded = expanded.has(folder.id);
  const hasChildren = folder.children.length > 0;

  const node: LayoutNode = {
    id: folder.id,
    name: folder.name,
    nodeCount: folder.nodeCount,
    fileCount: folder.fileCount,
    depth,
    x: rowRef.current++ * ROW_H,
    y: depth * COL_W,
    hasChildren,
    isExpanded,
    children: [],
    parentId: null, // filled by parent after recursion
  };

  if (isExpanded && hasChildren) {
    for (const child of folder.children) {
      const childNode = buildLayout(child, expanded, depth + 1, rowRef);
      childNode.parentId = folder.id;
      node.children.push(childNode);
    }
  }

  return node;
}

function collectNodes(node: LayoutNode, out: LayoutNode[] = []): LayoutNode[] {
  out.push(node);
  for (const child of node.children) collectNodes(child, out);
  return out;
}

// ── Helper: label width ───────────────────────────────────────────────────

function labelWidth(name: string): number {
  const label = name.length > MAX_LABEL ? name.slice(0, MAX_LABEL - 1) + '…' : name;
  return label.length * CH_W + BOX_PAD * 2 + 16; // 16 for chevron
}

function truncate(name: string): string {
  return name.length > MAX_LABEL ? name.slice(0, MAX_LABEL - 1) + '…' : name;
}

// ── NodeBox ───────────────────────────────────────────────────────────────

function NodeBox({
  node,
  isSelected,
  onToggle,
  onSelect,
}: {
  node: LayoutNode;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const w = labelWidth(node.name);
  const label = truncate(node.name);

  // Color by depth
  const depthColors = [
    { fill: 'rgba(139,92,246,0.15)', stroke: 'rgba(139,92,246,0.5)' },
    { fill: 'rgba(59,130,246,0.12)', stroke: 'rgba(59,130,246,0.4)' },
    { fill: 'rgba(16,185,129,0.10)', stroke: 'rgba(16,185,129,0.35)' },
    { fill: 'rgba(245,158,11,0.10)', stroke: 'rgba(245,158,11,0.35)' },
  ];
  const color = isSelected
    ? { fill: 'rgba(139,92,246,0.35)', stroke: 'rgba(139,92,246,0.9)' }
    : depthColors[Math.min(node.depth, depthColors.length - 1)];

  return (
    <g
      transform={`translate(${node.y},${node.x})`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        if (node.hasChildren) onToggle(node.id);
        onSelect(node.id);
      }}
    >
      {/* Box */}
      <rect
        x={0}
        y={-BOX_H / 2}
        width={w}
        height={BOX_H}
        rx={3}
        fill={color.fill}
        stroke={color.stroke}
        strokeWidth={isSelected ? 1.5 : 1}
      />

      {/* Chevron */}
      {node.hasChildren && (
        <text
          x={6}
          y={0}
          dominantBaseline="central"
          fontSize={9}
          fill={color.stroke}
          style={{ userSelect: 'none' }}
        >
          {node.isExpanded ? '▾' : '▸'}
        </text>
      )}

      {/* Label */}
      <text
        x={node.hasChildren ? 18 : BOX_PAD}
        y={0}
        dominantBaseline="central"
        fontSize={FONT_SIZE}
        fill={isSelected ? '#e2e8f0' : '#94a3b8'}
        fontFamily="monospace"
        style={{ userSelect: 'none' }}
      >
        {label}
      </text>

      {/* Node count badge */}
      <text
        x={w + 6}
        y={0}
        dominantBaseline="central"
        fontSize={9}
        fill="rgba(148,163,184,0.5)"
        fontFamily="monospace"
        style={{ userSelect: 'none' }}
      >
        {node.nodeCount.toLocaleString()}
      </text>
    </g>
  );
}

// ── Main component ────────────────────────────────────────────────────────

interface Props {
  repo?: string;
}

export function TopologyGraph({ repo }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [data, setData] = useState<{ root: TopologyFolder; edges: TopologyEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(3);

  // Expand/collapse state — start with root's direct children expanded
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  // Pan/zoom state
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);
  const dragging = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null,
  );

  // ── Fetch data ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTopology(depth, repo)
      .then((result) => {
        if (cancelled) return;
        setData({ root: result.root, edges: result.edges });

        // Auto-expand root's direct children
        const firstLevel = new Set(result.root.children.map((c) => c.id));
        firstLevel.add(result.root.id);
        setExpanded(firstLevel);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message ?? 'Failed to load topology');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [depth, repo]);

  // ── Build layout ────────────────────────────────────────────────────────

  const layoutRoot = useMemo(() => {
    if (!data) return null;
    const rowRef = { current: 0 };
    return buildLayout(data.root, expanded, 0, rowRef);
  }, [data, expanded]);

  const allNodes = useMemo(() => (layoutRoot ? collectNodes(layoutRoot) : []), [layoutRoot]);

  const nodeMap = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // ── Node position map (right edge for edge anchoring) ──────────────────

  const nodePos = useMemo(() => {
    const m = new Map<string, { x: number; y: number; rightX: number }>();
    for (const node of allNodes) {
      m.set(node.id, {
        x: node.y,
        y: node.x,
        rightX: node.y + labelWidth(node.name),
      });
    }
    return m;
  }, [allNodes]);

  // ── Visible cross-folder edges ──────────────────────────────────────────

  const visibleEdges = useMemo(() => {
    if (!data) return [];
    return data.edges.filter(
      (e) => nodeMap.has(e.source) && nodeMap.has(e.target) && e.source !== e.target,
    );
  }, [data, nodeMap]);

  // ── Tree connector lines (L-shaped, parent → child) ────────────────────

  const treeLinks = useMemo(() => {
    const links: Array<{ src: LayoutNode; tgt: LayoutNode }> = [];
    for (const node of allNodes) {
      if (node.parentId) {
        const parent = nodeMap.get(node.parentId);
        if (parent) links.push({ src: parent, tgt: node });
      }
    }
    return links;
  }, [allNodes, nodeMap]);

  // ── Interactions ────────────────────────────────────────────────────────

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleMouseDown = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      dragging.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    },
    [pan],
  );

  const handleMouseMove = useCallback((e: MouseEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragging.current.startX;
    const dy = e.clientY - dragging.current.startY;
    setPan({ x: dragging.current.panX + dx, y: dragging.current.panY + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const handleWheel = useCallback((e: WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.min(3, Math.max(0.2, z * factor)));
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building topology…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-red-400">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!layoutRoot) return null;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-void">
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <span className="text-xs text-text-muted">Depth</span>
        {[2, 3, 4, 5].map((d) => (
          <button
            key={d}
            onClick={() => setDepth(d)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              depth === d
                ? 'border border-accent/40 bg-accent/30 text-accent'
                : 'border border-border-subtle bg-elevated text-text-muted hover:text-text-secondary'
            }`}
          >
            {d}
          </button>
        ))}
        <span className="ml-2 text-xs text-text-muted">
          {allNodes.length} folders · {visibleEdges.length} edges
        </span>
      </div>

      {/* Reset view */}
      <button
        onClick={() => {
          setPan({ x: 40, y: 40 });
          setZoom(1);
        }}
        className="absolute top-3 right-3 z-10 rounded border border-border-subtle bg-elevated px-2 py-0.5 text-xs text-text-muted hover:text-text-secondary"
      >
        Reset view
      </button>

      {/* SVG canvas */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
        onClick={() => setSelected(null)}
      >
        <defs>
          <marker
            id="topo-arrow-call"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L6,3 z" fill="rgba(251,146,60,0.6)" />
          </marker>
        </defs>

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Tree connector lines */}
          {treeLinks.map(({ src, tgt }, i) => (
            <path
              key={`tl-${i}`}
              d={`M${src.y + 8},${src.x} L${src.y + 8},${tgt.x} L${tgt.y},${tgt.x}`}
              fill="none"
              stroke="rgba(63,63,70,0.5)"
              strokeWidth={1}
            />
          ))}

          {/* Cross-folder CALLS edges */}
          {visibleEdges.map((e, i) => {
            const src = nodePos.get(e.source);
            const tgt = nodePos.get(e.target);
            if (!src || !tgt) return null;
            const spread = Math.abs(src.y - tgt.y) * 0.35 + 50;
            const mx = Math.max(src.rightX, tgt.rightX) + spread;
            const strokeW = Math.min(3, Math.max(0.5, Math.log(e.weight + 1) * 0.4));
            return (
              <path
                key={`ce-${i}`}
                d={`M${src.rightX},${src.y} Q${mx},${(src.y + tgt.y) / 2} ${tgt.rightX},${tgt.y}`}
                fill="none"
                stroke="rgba(251,146,60,0.45)"
                strokeWidth={strokeW}
                strokeDasharray="4 3"
                markerEnd="url(#topo-arrow-call)"
              />
            );
          })}

          {/* Folder nodes */}
          {allNodes.map((node) => (
            <NodeBox
              key={node.id}
              node={node}
              isSelected={selected === node.id}
              onToggle={toggleExpanded}
              onSelect={setSelected}
            />
          ))}
        </g>
      </svg>

      {/* Selected folder info */}
      {selected && nodeMap.has(selected) && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-border-subtle bg-elevated/95 px-4 py-2 backdrop-blur-sm">
          <span className="font-mono text-sm text-text-primary">{nodeMap.get(selected)!.name}</span>
          <span className="ml-3 text-xs text-text-muted">
            {nodeMap.get(selected)!.nodeCount.toLocaleString()} symbols ·{' '}
            {nodeMap.get(selected)!.fileCount.toLocaleString()} files
          </span>
        </div>
      )}
    </div>
  );
}
