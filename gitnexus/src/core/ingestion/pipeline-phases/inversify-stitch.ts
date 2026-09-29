import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { runDiStitchPass, type StitchResult } from '../inversify/di-stitcher.js';
import { logger } from '../../logger.js';

export interface InversifyStitchOutput {
  syntheticEdgesAdded: number;
  interfacesResolved: number;
  isCompleted: boolean;
}

export const INVERSIFY_ROOT_ENV = 'APPS_REPO_ROOT';

export function isInversifyStitchEnabled(
  options: { inversifyStitch?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return options.inversifyStitch === true || Boolean(env[INVERSIFY_ROOT_ENV]);
}

export const inversifyStitchPhase: PipelinePhase<InversifyStitchOutput> = {
  name: 'inversifyStitch',
  deps: ['mro', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<InversifyStitchOutput> {
    const { totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    ctx.onProgress({
      phase: 'enriching',
      percent: 98,
      message: 'Stitching Inversify DI bindings...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    const root = process.env[INVERSIFY_ROOT_ENV] || ctx.repoPath;
    const result: StitchResult | null = await runDiStitchPass(ctx.graph, root);
    if (result === null) {
      logger.warn(`[inversifyStitch] stitch pass failed for ${root}; no di-resolved edges added`);
      return { syntheticEdgesAdded: 0, interfacesResolved: 0, isCompleted: false };
    }

    logger.info(
      `[inversifyStitch] ${result.syntheticEdgesAdded} di-resolved CALLS edges across ${result.interfacesResolved} interface bindings`,
    );
    return {
      syntheticEdgesAdded: result.syntheticEdgesAdded,
      interfacesResolved: result.interfacesResolved,
      isCompleted: true,
    };
  },
};
