import { normalizeMemoryTopics } from '@backend/memory/categories';
import type { EntityKind, RelationshipKind } from '@backend/memory/graph-repository';
import type { EvidenceModality, MemoryKind } from '@backend/memory/repository';
import type { LearningProposal } from '@backend/learning/contracts';
import {
  bounded,
  choice,
  exactProposalFields,
  optionalDescription,
  positive,
  proposalSource,
  requireUuid,
} from '@backend/learning/validation';

const EVIDENCE_MODALITIES: readonly EvidenceModality[] = [
  'assertion',
  'quotation',
  'hypothetical',
  'intention',
  'uncertainty',
  'third_party',
];
const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'note'];
const ENTITY_KINDS: readonly EntityKind[] = [
  'person',
  'project',
  'trip',
  'event',
  'place',
  'accessibility',
  'organization',
  'other',
];
const RELATIONSHIP_KINDS: readonly RelationshipKind[] = [
  'about',
  'involves',
  'supersedes',
  'contradicts',
  'related_to',
];
const MAX_TEXT = 16_000;
const MAX_LABEL = 200;
const MAX_PROVENANCE = 400;

export function normalizeLearningProposal(value: LearningProposal): LearningProposal {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid learning proposal.');
  }
  if (value.sourceRole !== 'user') {
    throw new Error('Learning proposals require user attribution.');
  }

  const source = proposalSource(value);
  if (value.kind === 'memory') {
    return normalizeMemoryProposal(value, source);
  }
  if (value.kind === 'topic') {
    return normalizeTopicProposal(value, source);
  }
  if (value.kind === 'entity') {
    return normalizeEntityProposal(value, source);
  }
  if (value.kind === 'relationship') {
    return normalizeRelationshipProposal(value, source);
  }
  throw new Error('Invalid learning proposal kind.');
}

function normalizeMemoryProposal(
  value: Extract<LearningProposal, { kind: 'memory' }>,
  source: ReturnType<typeof proposalSource>,
): LearningProposal {
  if (value.action === 'add') {
    exactProposalFields(value as unknown as Record<string, unknown>, [
      'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
      'text', 'memoryKind', 'modality', 'topics',
    ]);
    const topics = normalizeMemoryTopics(value.topics);
    return {
      ...value,
      ...source,
      text: bounded(value.text, 'memory text', MAX_TEXT),
      memoryKind: choice(value.memoryKind, MEMORY_KINDS, 'memory kind'),
      modality: choice(value.modality ?? 'assertion', EVIDENCE_MODALITIES, 'evidence modality'),
      ...(topics === undefined ? {} : { topics }),
    };
  }

  if (value.action === 'confirm') {
    exactProposalFields(value as unknown as Record<string, unknown>, [
      'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
      'memoryId', 'expectedMemoryRevision', 'modality',
    ]);
    return {
      ...value,
      ...source,
      memoryId: requireUuid(value.memoryId, 'memory id'),
      expectedMemoryRevision: positive(value.expectedMemoryRevision, 'memory revision'),
      modality: choice(value.modality ?? 'assertion', EVIDENCE_MODALITIES, 'evidence modality'),
    };
  }

  if (value.action !== 'correct') throw new Error('Invalid learning proposal kind.');
  exactProposalFields(value as unknown as Record<string, unknown>, [
    'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
    'memoryId', 'expectedMemoryRevision', 'text', 'memoryKind', 'modality', 'topics',
  ]);
  const topics = normalizeMemoryTopics(value.topics);
  return {
    ...value,
    ...source,
    memoryId: requireUuid(value.memoryId, 'memory id'),
    expectedMemoryRevision: positive(value.expectedMemoryRevision, 'memory revision'),
    text: bounded(value.text, 'memory text', MAX_TEXT),
    modality: choice(value.modality ?? 'assertion', EVIDENCE_MODALITIES, 'evidence modality'),
    ...(value.memoryKind === undefined
      ? {}
      : { memoryKind: choice(value.memoryKind, MEMORY_KINDS, 'memory kind') }),
    ...(topics === undefined ? {} : { topics }),
  };
}

function normalizeTopicProposal(
  value: Extract<LearningProposal, { kind: 'topic' }>,
  source: ReturnType<typeof proposalSource>,
): LearningProposal {
  if (value.action !== 'create') throw new Error('Invalid topic proposal action.');
  exactProposalFields(value as unknown as Record<string, unknown>, [
    'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
    'label', 'description', 'memoryId', 'expectedMemoryRevision',
  ]);
  return {
    ...value,
    ...source,
    label: bounded(value.label, 'topic label', MAX_LABEL),
    description: optionalDescription(value.description),
    ...(value.memoryId === undefined
      ? {}
      : {
          memoryId: requireUuid(value.memoryId, 'memory id'),
          expectedMemoryRevision: positive(value.expectedMemoryRevision, 'memory revision'),
        }),
  };
}

function normalizeEntityProposal(
  value: Extract<LearningProposal, { kind: 'entity' }>,
  source: ReturnType<typeof proposalSource>,
): LearningProposal {
  if (value.action !== 'create') throw new Error('Invalid entity proposal action.');
  exactProposalFields(value as unknown as Record<string, unknown>, [
    'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
    'entityKind', 'label', 'description', 'memoryId', 'expectedMemoryRevision',
  ]);
  return {
    ...value,
    ...source,
    entityKind: choice(value.entityKind, ENTITY_KINDS, 'entity kind'),
    label: bounded(value.label, 'entity label', MAX_LABEL),
    description: optionalDescription(value.description),
    ...(value.memoryId === undefined
      ? {}
      : {
          memoryId: requireUuid(value.memoryId, 'memory id'),
          expectedMemoryRevision: positive(value.expectedMemoryRevision, 'memory revision'),
        }),
  };
}

function normalizeRelationshipProposal(
  value: Extract<LearningProposal, { kind: 'relationship' }>,
  source: ReturnType<typeof proposalSource>,
): LearningProposal {
  if (value.action !== 'create') throw new Error('Invalid relationship proposal action.');
  exactProposalFields(value as unknown as Record<string, unknown>, [
    'kind', 'action', 'sourceMessageId', 'sourceRevision', 'sourceRole',
    'relationshipKind', 'subjectId', 'objectId', 'expectedSubjectRevision',
    'expectedObjectRevision', 'provenance',
  ]);
  return {
    ...value,
    ...source,
    relationshipKind: choice(value.relationshipKind, RELATIONSHIP_KINDS, 'relationship kind'),
    subjectId: requireUuid(value.subjectId, 'subject id'),
    objectId: requireUuid(value.objectId, 'object id'),
    expectedSubjectRevision: positive(value.expectedSubjectRevision, 'subject revision'),
    expectedObjectRevision: positive(value.expectedObjectRevision, 'object revision'),
    provenance: bounded(value.provenance ?? 'background learning', 'relationship provenance', MAX_PROVENANCE),
  };
}
