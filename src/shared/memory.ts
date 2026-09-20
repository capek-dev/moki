export type MemoryKind = 'fact' | 'preference' | 'note';
export type MemoryState = 'active' | 'superseded' | 'contested';
export type MemoryEvidenceStance = 'supporting' | 'contradicting';
export type MemoryEvidenceModality = 'assertion' | 'quotation' | 'hypothetical' | 'intention' | 'uncertainty' | 'third_party';

export type MemoryRecallMode = 'basic' | 'jev';

export interface MemorySettingsState {
  enabled: boolean;
  recall: MemoryRecallMode;
  jevConsent: boolean;
  jevModel: string;
  revision: number;
}

export interface MemoryMutationAttribution {
  surface: 'settings';
  createsConversationEvidence: false;
}

export interface MemorySummary {
  id: string;
  text: string;
  textTruncated: boolean;
  textLength: number;
  kind: MemoryKind;
  state: MemoryState;
  pinned: boolean;
  core: boolean;
  recordedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  revision: number;
}

export interface MemoryPage {
  query: string | null;
  memories: MemorySummary[];
  offset: number;
  nextOffset: number | null;
}

export interface MemoryEvidence {
  id: string;
  memoryRevision: number | null;
  sourceMessageId: string;
  sourceRevision: number;
  sourceCreatedAt: number | null;
  sourceRole: 'user' | 'assistant';
  stance: MemoryEvidenceStance;
  modality: MemoryEvidenceModality;
  provenance: string;
  recordedAt: number;
  valid: boolean;
  invalidReason?: string;
}

export interface MemoryDetail extends MemorySummary {
  textPage: string;
  textOffset: number;
  textNextOffset: number | null;
  evidence: MemoryEvidence[];
  evidenceTruncated: boolean;
}

export interface MemoryConnection {
  id: string;
  kind: 'about' | 'involves' | 'supersedes' | 'contradicts' | 'related_to';
  subjectId: string;
  objectId: string;
  subjectRevision: number;
  objectRevision: number;
  provenance: string;
  explicit: boolean;
  recordedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  sourceMessageId: string | null;
  sourceRevision: number | null;
  sourceRole: 'user' | 'assistant' | null;
  revision: number;
  valid: boolean;
  invalidReason?: string;
}

export interface MemoryConnectionsPage {
  memoryId: string;
  connections: MemoryConnection[];
  offset: number;
  nextOffset: number | null;
}

export interface MemoryRecallSelection {
  memoryId: string;
  revision: number;
}

export interface MemoryRecallInspection {
  messageId: string;
  mode: MemoryRecallMode;
  outcome: string;
  selected: MemoryRecallSelection[];
  candidateCount: number;
  descriptorCount: number;
  descriptorAvailableCount?: number;
  descriptorsTruncated?: boolean;
  selectedDescriptorCount?: number;
  topicSeedCount?: number;
  entitySeedCount?: number;
  lexicalSeedCount?: number;
  expandedEntityCount?: number;
  expandedMemoryCount?: number;
  fallbackReason?: string;
  relationshipCount: number;
  elapsedMs: number;
}

export interface MemoryRecallHistoryRecord extends MemoryRecallInspection {
  id: string;
  conversationId: string;
  createdAt: number;
}

export interface MemoryRecallHistoryPage {
  records: MemoryRecallHistoryRecord[];
  offset: number;
  nextOffset: number | null;
}
