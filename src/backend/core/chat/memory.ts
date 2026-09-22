import type { MemoryGraphRepository } from '@backend/memory/graph-repository';
import type { MemoryRepository } from '@backend/memory/repository';
import {
  recallBasic,
  type BasicRecallResult,
  type MemoryHostConfig,
} from '@backend/memory/recall';
import { recallJev, type JevRecallResult } from '@backend/memory/jev';
import type { SelectionEvidence } from '@backend/tools/scoring';

export interface TurnMemory {
  recalled: BasicRecallResult | JevRecallResult;
  config: MemoryHostConfig;
}

interface RecallTurnMemoryOptions {
  memories: MemoryRepository;
  graph: MemoryGraphRepository;
  evidence: SelectionEvidence;
  signal: AbortSignal;
  turnSignal: AbortSignal;
  jevKey?: string;
  config(): MemoryHostConfig;
}

function policyChangedRecall(
  memories: MemoryRepository,
  config: MemoryHostConfig,
): JevRecallResult {
  const basic = recallBasic(memories, config);
  return {
    ...basic,
    inspection: {
      mode: 'basic',
      outcome: 'memory_policy_changed',
      selected: basic.entries.slice(0, 16).map((entry) => ({
        memoryId: entry.memory.id,
        revision: entry.memory.revision,
      })),
      candidateCount: basic.candidateCount,
      descriptorCount: 0,
      relationshipCount: 0,
      elapsedMs: 0,
    },
  };
}

/** Recall once. A policy-change abort falls back locally without cancelling chat. */
export async function recallTurnMemory(
  options: RecallTurnMemoryOptions,
): Promise<TurnMemory> {
  let config = options.config();
  let recalled: BasicRecallResult | JevRecallResult;

  try {
    recalled = await recallJev(
      options.memories,
      options.graph,
      options.evidence,
      config,
      options.signal,
      options.jevKey === undefined ? undefined : { key: options.jevKey },
    );
  } catch (error) {
    if (options.turnSignal.aborted || !options.signal.aborted) throw error;
    config = options.config();
    recalled = policyChangedRecall(options.memories, config);
  }

  if (options.signal.aborted) {
    config = options.config();
    recalled = policyChangedRecall(options.memories, config);
  }
  return { recalled, config };
}
