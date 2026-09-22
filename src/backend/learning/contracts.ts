import type { EntityKind, RelationshipKind } from '@backend/memory/graph-repository';
import type { EvidenceModality, MemoryKind } from '@backend/memory/repository';

export const LEARNING_IDLE_MS = 2 * 60_000;
export const LEARNING_COOLDOWN_MS = 5 * 60_000;
export const LEARNING_MAX_PENDING_MS = 15 * 60_000;
export const LEARNING_MAX_MESSAGES = 10;
export const LEARNING_MAX_SOURCE_CHARS = 12_000;
export const LEARNING_MAX_PROPOSALS = 40;
export const LEARNING_MAX_AUTOMATIC_ATTEMPTS = 3;
export const LEARNING_REVIEW_TIMEOUT_MS = 60_000;
export const LEARNING_SOURCE_EXCERPT_MAX = 600;
export const LEARNING_INSPECTOR_PAGE_MAX = 50;
export const LEARNING_INSPECTOR_OFFSET_MAX = 10_000;
export const LEARNING_DISPATCH_TIMEOUT_MS = 90_000;
export const LEARNING_RUN_DETAIL_MAX_BYTES = 48_000;

export type LearningProvider = 'deepseek' | 'codex';
export type LearningRunStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
export type LearningProposalStatus = 'pending' | 'applied' | 'rejected' | 'suppressed' | 'stale';

export type LearningProposal =
  | {
      kind: 'memory';
      action: 'add';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      text: string;
      memoryKind: MemoryKind;
      modality?: EvidenceModality;
      topics?: string[];
    }
  | {
      kind: 'memory';
      action: 'confirm';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      memoryId: string;
      expectedMemoryRevision: number;
      modality?: EvidenceModality;
    }
  | {
      kind: 'memory';
      action: 'correct';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      memoryId: string;
      expectedMemoryRevision: number;
      text: string;
      memoryKind?: MemoryKind;
      modality?: EvidenceModality;
      topics?: string[];
    }
  | {
      kind: 'topic';
      action: 'create';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      label: string;
      description?: string | null;
      memoryId?: string;
      expectedMemoryRevision?: number;
    }
  | {
      kind: 'entity';
      action: 'create';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      entityKind: EntityKind;
      label: string;
      description?: string | null;
      memoryId?: string;
      expectedMemoryRevision?: number;
    }
  | {
      kind: 'relationship';
      action: 'create';
      sourceMessageId: string;
      sourceRevision: number;
      sourceRole: 'user';
      relationshipKind: RelationshipKind;
      subjectId: string;
      objectId: string;
      expectedSubjectRevision: number;
      expectedObjectRevision: number;
      provenance?: string;
    };

export interface LearningSettingsState {
  enabled: boolean;
  paused: boolean;
  provider: LearningProvider;
  model: string;
  revision: number;
}

export interface LearningSource {
  rowid: number;
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  revision: number;
  createdAt: number | null;
}

export type LearningHistoryResource = 'memory' | 'topic' | 'entity' | 'relationship';

export interface LearningHistoryRecord {
  id: string;
  runId: string;
  operationId: string;
  resourceType: LearningHistoryResource;
  resourceId: string;
  action: 'add' | 'correct';
  memoryId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  afterRevision: number;
  createdAt: number;
  undoneAt: number | null;
}

export interface LearningRunSummary {
  id: string;
  status: LearningRunStatus;
  outcome: 'changes' | 'no_changes' | 'failed' | 'cancelled' | 'pending';
  cursorStart: number;
  cursorEnd: number;
  attempt: number;
  cancelRequested: boolean;
  provider: LearningProvider;
  model: string;
  /** `captured` at review time, `recaptured` at retry, or unavailable for legacy runs. */
  sourceManifest: 'unavailable' | 'captured' | 'recaptured';
  proposalCount: number;
  appliedCount: number;
  rejectedCount: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export type LearningSourceState = 'current' | 'changed' | 'deleted' | 'legacy_unknown';

export interface LearningRunSource {
  messageId: string;
  capturedRevision: number | null;
  role: 'user' | 'assistant';
  state: LearningSourceState;
  currentRevision: number | null;
  currentText: string | null;
  currentTextIsHistoricalSnapshot: false;
}

export interface LearningReviewContext {
  memories: Array<{ id: string; revision: number; kind: MemoryKind; text: string }>;
  topics: Array<{ id: string; revision: number; label: string }>;
  routingLabels?: string[];
  entities: Array<{ id: string; revision: number; kind: EntityKind; label: string }>;
}

export interface LearningProposalInspection {
  proposalId: string;
  operationId: string;
  kind: LearningProposal['kind'];
  status: LearningProposalStatus;
  rejection: string | null;
  sourceMessageId: string;
  sourceRevision: number;
  summary: Record<string, unknown>;
}

export interface LearningRunDetail {
  run: LearningRunSummary;
  sources: LearningRunSource[];
  proposals: LearningProposalInspection[];
  changes: Array<
    Pick<
      LearningHistoryRecord,
      'id' | 'resourceType' | 'resourceId' | 'action' | 'before' | 'after' | 'afterRevision' | 'createdAt' | 'undoneAt'
    >
  >;
  /** True when the serialized inspector response hit its bounded budget. */
  truncated: boolean;
}

export interface LearningRunPage {
  runs: LearningRunSummary[];
  offset: number;
  nextOffset: number | null;
}

/** Review result plus optional Jev source-support verdicts keyed by proposal index. */
export interface LearningReviewerOutcome {
  proposals: readonly LearningProposal[];
  rejections?: ReadonlyMap<number, string>;
}

export interface LearningReviewer {
  (
    sources: readonly LearningSource[],
    signal: AbortSignal,
    context: LearningReviewContext,
  ): Promise<readonly LearningProposal[] | LearningReviewerOutcome>;
}

export interface LearningTimer {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface LearningClock {
  now(): number;
  timer?: LearningTimer;
}
