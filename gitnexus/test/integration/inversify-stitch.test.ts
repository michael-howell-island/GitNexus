import { describe, expect, it } from 'vitest';
import path from 'path';
import { FIXTURES, runPipelineFromRepo } from './resolvers/helpers.js';

const fixture = path.join(FIXTURES, 'inversify-stitch-app');

function diResolvedEdges(graph: Awaited<ReturnType<typeof runPipelineFromRepo>>['graph']) {
  const edges: Array<{ source: string; target: string; confidence: number }> = [];
  for (const rel of graph.iterRelationshipsByType('CALLS')) {
    if (rel.reason !== 'di-resolved') continue;
    const source = graph.getNode(rel.sourceId);
    const target = graph.getNode(rel.targetId);
    edges.push({
      source: `${source?.properties.filePath}:${source?.properties.name}`,
      target: `${target?.properties.filePath}:${target?.properties.name}`,
      confidence: rel.confidence,
    });
  }
  return edges;
}

describe('inversifyStitch phase', () => {
  it('bridges an interface method to its Inversify-bound concrete method', async () => {
    const result = await runPipelineFromRepo(fixture, () => {}, {
      workerPoolSize: 1,
      inversifyStitch: true,
    });
    expect(diResolvedEdges(result.graph)).toEqual([
      {
        source: 'libs/greeting/src/IGreeter.ts:greet',
        target: 'libs/greeting/src/Greeter.ts:greet',
        confidence: 0.95,
      },
    ]);
  }, 120_000);

  it('adds no di-resolved edges when the phase is off', async () => {
    const previousRoot = process.env.APPS_REPO_ROOT;
    delete process.env.APPS_REPO_ROOT;
    try {
      const result = await runPipelineFromRepo(fixture, () => {}, { workerPoolSize: 1 });
      expect(diResolvedEdges(result.graph)).toEqual([]);
    } finally {
      if (previousRoot !== undefined) process.env.APPS_REPO_ROOT = previousRoot;
    }
  }, 120_000);
});
