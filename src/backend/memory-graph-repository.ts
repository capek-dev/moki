import type { Database } from 'bun:sqlite';
import { installMemoryCategorySchema, backfillMemoryCategories } from '@backend/memory-categories';
import { assertSourceEvidenceAllowed } from '@backend/memory-repository';
import type { MemoryRecord, MemoryState } from '@backend/memory-repository';

export type TopicRecord = {
  id: string;
  label: string;
  description: string | null;
  aliases: string[];
  recordedAt: number;
  revision: number;
};

export type EntityKind = 'person' | 'project' | 'trip' | 'event' | 'place' | 'accessibility' | 'organization' | 'other';
export type EntityRecord = {
  id: string;
  kind: EntityKind;
  label: string;
  description: string | null;
  aliases: string[];
  recordedAt: number;
  revision: number;
};

export type RelationshipKind = 'about' | 'involves' | 'supersedes' | 'contradicts' | 'related_to';
export type RelationshipInvalidReason = 'source_missing' | 'source_deleted' | 'source_revised' | 'source_streaming' | 'conversation_excluded' | 'endpoint_revised' | 'endpoint_deleted';
export type RelationshipRecord = {
  id: string;
  kind: RelationshipKind;
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
  // Structural source and endpoint validity only. Date applicability is separate.
  valid: boolean;
  invalidReason?: RelationshipInvalidReason;
};

export type CreateTopicInput = {
  id?: string;
  label: string;
  description?: string | null;
  aliases?: string[];
  recordedAt?: number;
};
export type UpdateTopicInput = Partial<Pick<CreateTopicInput, 'label' | 'description' | 'aliases'>>;
export type CreateEntityInput = {
  id?: string;
  kind: EntityKind;
  label: string;
  description?: string | null;
  aliases?: string[];
  recordedAt?: number;
};
export type UpdateEntityInput = Partial<Pick<CreateEntityInput, 'kind' | 'label' | 'description' | 'aliases'>>;
export type MemoryTopicInput = {
  memoryId: string;
  topicId: string;
  expectedMemoryRevision: number;
  expectedTopicRevision: number;
};
export type CreateRelationshipInput = {
  id?: string;
  kind: RelationshipKind;
  subjectId: string;
  objectId: string;
  expectedSubjectRevision: number;
  expectedObjectRevision: number;
  provenance: string;
  explicit: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
  sourceMessageId?: string | null;
  sourceRevision?: number | null;
  recordedAt?: number;
};
export type BoundedReadOptions = { limit?: number; offset?: number };
export type MemoryRoutingDescriptor = {
  kind: 'topic' | 'entity';
  id: string;
  label: string;
  aliases: string[];
  description: string | null;
};
export type EffectiveMemoryRead = {
  memory: MemoryRecord;
  durableState: MemoryState;
  derivedState: 'superseded' | 'contested' | null;
  effectiveState: MemoryState;
  applicableAt: number;
};
export type EffectiveMemoryReadOptions = BoundedReadOptions & { applicableAt?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_LABEL_MAX = 160;
const ENTITY_LABEL_MAX = 200;
const DESCRIPTION_MAX = 2000;
const ALIAS_MAX = 120;
const MAX_ALIASES = 20;
const PROVENANCE_MAX = 400;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ENTITY_KINDS: readonly EntityKind[] = ['person', 'project', 'trip', 'event', 'place', 'accessibility', 'organization', 'other'];
const RELATIONSHIP_KINDS: readonly RelationshipKind[] = ['about', 'involves', 'supersedes', 'contradicts', 'related_to'];
const SYMMETRIC_KINDS: readonly RelationshipKind[] = ['contradicts', 'related_to'];

type TopicRow = Omit<TopicRecord, 'aliases'> & { aliases: string };
type EntityRow = Omit<EntityRecord, 'aliases'> & { aliases: string };
type RelationshipRow = Omit<RelationshipRecord, 'explicit' | 'valid' | 'invalidReason'> & {
  explicit: number;
  currentSubjectRevision: number | null;
  currentObjectRevision: number | null;
  sourceExists: string | null;
  currentSourceRevision: number | null;
  sourceStatus: string | null;
  sourceExcluded: number;
};
type EffectiveMemoryRow = Omit<MemoryRecord, 'pinned' | 'core'> & { pinned: number; core: number; derivedState: 'superseded' | 'contested' | null };

type Endpoint = { type: 'memory' | 'entity'; id: string; revision: number };

export function installMemoryGraphSchema(db: Database) {
  installMemoryCategorySchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      recordedAt INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
    );
    CREATE INDEX IF NOT EXISTS topics_label_idx ON topics (label, id);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('person', 'project', 'trip', 'event', 'place', 'accessibility', 'organization', 'other')),
      label TEXT NOT NULL,
      description TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      recordedAt INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
    );
    CREATE INDEX IF NOT EXISTS entities_kind_label_idx ON entities (kind, label, id);
    CREATE TABLE IF NOT EXISTS memory_topics (
      memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      topicId TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      PRIMARY KEY (memoryId, topicId)
    );
    CREATE INDEX IF NOT EXISTS memory_topics_topic_idx ON memory_topics (topicId, memoryId);
    CREATE TABLE IF NOT EXISTS memory_relationships (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('about', 'involves', 'supersedes', 'contradicts', 'related_to')),
      subjectId TEXT NOT NULL,
      objectId TEXT NOT NULL,
      subjectRevision INTEGER NOT NULL CHECK (subjectRevision >= 1),
      objectRevision INTEGER NOT NULL CHECK (objectRevision >= 1),
      provenance TEXT NOT NULL,
      explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
      recordedAt INTEGER NOT NULL,
      validFrom INTEGER,
      validUntil INTEGER,
      sourceMessageId TEXT,
      sourceRevision INTEGER CHECK (sourceRevision IS NULL OR sourceRevision >= 1),
      sourceRole TEXT CHECK (sourceRole IS NULL OR sourceRole IN ('user', 'assistant')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      CHECK (validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom),
      CHECK ((sourceMessageId IS NULL AND sourceRevision IS NULL AND sourceRole IS NULL) OR (sourceMessageId IS NOT NULL AND sourceRevision IS NOT NULL AND sourceRole IS NOT NULL)),
      UNIQUE (kind, subjectId, objectId)
    );
    CREATE INDEX IF NOT EXISTS memory_relationships_subject_idx ON memory_relationships (subjectId, kind, objectId);
    CREATE INDEX IF NOT EXISTS memory_relationships_object_idx ON memory_relationships (objectId, kind, subjectId);
    CREATE INDEX IF NOT EXISTS memory_relationships_source_idx ON memory_relationships (sourceMessageId, sourceRevision);
  `);
}

function stableId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function nonEmpty(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return nonEmpty(value, name, max);
}
function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}
function optionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return timestamp(value, name);
}
function revision(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Invalid ${name}.`);
  return value as T;
}
function aliases(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALIASES) throw new Error('Invalid aliases.');
  const result = value.map((item) => nonEmpty(item, 'alias', ALIAS_MAX));
  if (new Set(result.map((item) => item.toLocaleLowerCase())).size !== result.length) throw new Error('Duplicate aliases.');
  return result;
}
function interval(validFrom: number | null, validUntil: number | null) {
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw new Error('Invalid validity interval.');
}
function parseAliases(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return aliases(parsed);
  } catch {
    throw new Error('Invalid stored aliases.');
  }
}
function decodeTopic(row: TopicRow): TopicRecord { return { ...row, aliases: parseAliases(row.aliases) }; }
function decodeEntity(row: EntityRow): EntityRecord { return { ...row, aliases: parseAliases(row.aliases) }; }

export function applicableAt(value: number = Date.now()): number {
  return timestamp(value, 'applicableAt');
}

export function isApplicableAt(validFrom: number | null, validUntil: number | null, value: number = Date.now()): boolean {
  const instant = applicableAt(value);
  return (validFrom === null || validFrom <= instant) && (validUntil === null || instant < validUntil);
}

// A relationship can be structurally valid while being outside its validity interval.
export function relationshipApplicableAt(relationship: Pick<RelationshipRecord, 'valid' | 'validFrom' | 'validUntil'>, value: number = Date.now()): boolean {
  return relationship.valid && isApplicableAt(relationship.validFrom, relationship.validUntil, value);
}

export class MemoryGraphRepository {
  constructor(private readonly db: Database, installSchema = true) {
    if (installSchema) this.db.transaction(() => installMemoryGraphSchema(this.db))();
  }

  createTopic(input: CreateTopicInput): TopicRecord {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'topic id');
    const label = nonEmpty(input.label, 'topic label', TOPIC_LABEL_MAX);
    const description = optionalText(input.description, 'topic description', DESCRIPTION_MAX);
    const aliasList = aliases(input.aliases);
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt');
    this.db.transaction(() => this.db.query('INSERT INTO topics (id, label, description, aliases, recordedAt, revision) VALUES (?, ?, ?, ?, ?, 1)').run(id, label, description, JSON.stringify(aliasList), recordedAt))();
    return this.getTopic(id)!;
  }

  getTopic(id: string): TopicRecord | null {
    const row = this.db.query<TopicRow, [string]>('SELECT * FROM topics WHERE id = ?').get(stableId(id, 'topic id'));
    return row ? decodeTopic(row) : null;
  }
  listTopics(options: BoundedReadOptions = {}): TopicRecord[] {
    const { limit, offset } = this.bounds(options);
    return this.db.query<TopicRow, [number, number]>('SELECT * FROM topics ORDER BY label, id LIMIT ? OFFSET ?').all(limit, offset).map(decodeTopic);
  }
  updateTopic(id: string, expectedRevision: number, patch: UpdateTopicInput): TopicRecord {
    const topicId = stableId(id, 'topic id');
    const expected = revision(expectedRevision, 'topic revision');
    this.db.transaction(() => {
      const current = this.db.query<TopicRow, [string]>('SELECT * FROM topics WHERE id = ?').get(topicId);
      if (!current) throw new Error('Topic not found.');
      if (current.revision !== expected) throw new Error('Topic revision conflict.');
      const label = patch.label === undefined ? current.label : nonEmpty(patch.label, 'topic label', TOPIC_LABEL_MAX);
      const description = patch.description === undefined ? current.description : optionalText(patch.description, 'topic description', DESCRIPTION_MAX);
      const aliasList = patch.aliases === undefined ? parseAliases(current.aliases) : aliases(patch.aliases);
      const result = this.db.query('UPDATE topics SET label = ?, description = ?, aliases = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(label, description, JSON.stringify(aliasList), topicId, expected);
      if (result.changes !== 1) throw new Error('Topic revision conflict.');
    })();
    return this.getTopic(topicId)!;
  }

  createEntity(input: CreateEntityInput): EntityRecord {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'entity id');
    const kind = choice(input.kind, ENTITY_KINDS, 'entity kind');
    const label = nonEmpty(input.label, 'entity label', ENTITY_LABEL_MAX);
    const description = optionalText(input.description, 'entity description', DESCRIPTION_MAX);
    const aliasList = aliases(input.aliases);
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt');
    this.db.transaction(() => this.db.query('INSERT INTO entities (id, kind, label, description, aliases, recordedAt, revision) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, kind, label, description, JSON.stringify(aliasList), recordedAt))();
    return this.getEntity(id)!;
  }
  getEntity(id: string): EntityRecord | null {
    const row = this.db.query<EntityRow, [string]>('SELECT * FROM entities WHERE id = ?').get(stableId(id, 'entity id'));
    return row ? decodeEntity(row) : null;
  }
  listEntities(options: BoundedReadOptions & { kind?: EntityKind } = {}): EntityRecord[] {
    const { limit, offset } = this.bounds(options);
    const kind = options.kind === undefined ? undefined : choice(options.kind, ENTITY_KINDS, 'entity kind');
    const rows = kind === undefined
      ? this.db.query<EntityRow, [number, number]>('SELECT * FROM entities ORDER BY kind, label, id LIMIT ? OFFSET ?').all(limit, offset)
      : this.db.query<EntityRow, [string, number, number]>('SELECT * FROM entities WHERE kind = ? ORDER BY label, id LIMIT ? OFFSET ?').all(kind, limit, offset);
    return rows.map(decodeEntity);
  }
  updateEntity(id: string, expectedRevision: number, patch: UpdateEntityInput): EntityRecord {
    const entityId = stableId(id, 'entity id');
    const expected = revision(expectedRevision, 'entity revision');
    this.db.transaction(() => {
      const current = this.db.query<EntityRow, [string]>('SELECT * FROM entities WHERE id = ?').get(entityId);
      if (!current) throw new Error('Entity not found.');
      if (current.revision !== expected) throw new Error('Entity revision conflict.');
      const kind = patch.kind === undefined ? current.kind : choice(patch.kind, ENTITY_KINDS, 'entity kind');
      const label = patch.label === undefined ? current.label : nonEmpty(patch.label, 'entity label', ENTITY_LABEL_MAX);
      const description = patch.description === undefined ? current.description : optionalText(patch.description, 'entity description', DESCRIPTION_MAX);
      const aliasList = patch.aliases === undefined ? parseAliases(current.aliases) : aliases(patch.aliases);
      const result = this.db.query('UPDATE entities SET kind = ?, label = ?, description = ?, aliases = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(kind, label, description, JSON.stringify(aliasList), entityId, expected);
      if (result.changes !== 1) throw new Error('Entity revision conflict.');
    })();
    return this.getEntity(entityId)!;
  }

  addMemoryTopic(input: MemoryTopicInput) {
    const memoryId = stableId(input.memoryId, 'memory id');
    const topicId = stableId(input.topicId, 'topic id');
    const expectedMemoryRevision = revision(input.expectedMemoryRevision, 'memory revision');
    const expectedTopicRevision = revision(input.expectedTopicRevision, 'topic revision');
    this.db.transaction(() => {
      const memory = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(memoryId);
      if (!memory) throw new Error('Memory not found.');
      if (memory.revision !== expectedMemoryRevision) throw new Error('Memory revision conflict.');
      const topic = this.db.query<{ revision: number }, [string]>('SELECT revision FROM topics WHERE id = ?').get(topicId);
      if (!topic) throw new Error('Topic not found.');
      if (topic.revision !== expectedTopicRevision) throw new Error('Topic revision conflict.');
      const duplicate = this.db.query('SELECT 1 FROM memory_topics WHERE memoryId = ? AND topicId = ?').get(memoryId, topicId);
      if (duplicate) throw new Error('Duplicate memory topic membership.');
      this.db.query('INSERT INTO memory_topics (memoryId, topicId) VALUES (?, ?)').run(memoryId, topicId);
    })();
  }
  removeMemoryTopic(memoryId: string, topicId: string, expectedMemoryRevision: number, expectedTopicRevision: number) {
    const id = stableId(memoryId, 'memory id');
    const topic = stableId(topicId, 'topic id');
    const expectedMemory = revision(expectedMemoryRevision, 'memory revision');
    const expectedTopic = revision(expectedTopicRevision, 'topic revision');
    this.db.transaction(() => {
      const memory = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(id);
      if (!memory) throw new Error('Memory not found.');
      if (memory.revision !== expectedMemory) throw new Error('Memory revision conflict.');
      const currentTopic = this.db.query<{ revision: number }, [string]>('SELECT revision FROM topics WHERE id = ?').get(topic);
      if (!currentTopic) throw new Error('Topic not found.');
      if (currentTopic.revision !== expectedTopic) throw new Error('Topic revision conflict.');
      this.db.query('DELETE FROM memory_topics WHERE memoryId = ? AND topicId = ?').run(id, topic);
    })();
  }
  topicsForMemory(memoryId: string, options: BoundedReadOptions = {}): TopicRecord[] {
    const id = stableId(memoryId, 'memory id');
    const { limit, offset } = this.bounds(options);
    return this.db.query<TopicRow, [string, number, number]>('SELECT t.* FROM topics t JOIN memory_topics mt ON mt.topicId = t.id WHERE mt.memoryId = ? ORDER BY t.label, t.id LIMIT ? OFFSET ?').all(id, limit, offset).map(decodeTopic);
  }
  memoriesForTopic(topicId: string, options: BoundedReadOptions = {}): string[] {
    const id = stableId(topicId, 'topic id');
    const { limit, offset } = this.bounds(options);
    return this.db.query<{ memoryId: string }, [string, number, number]>('SELECT memoryId FROM memory_topics WHERE topicId = ? ORDER BY memoryId LIMIT ? OFFSET ?').all(id, limit, offset).map((row) => row.memoryId);
  }

  /** Explicit bounded repair before routing, never during descriptor pagination. */
  prepareRoutingCategories(): number {
    return backfillMemoryCategories(this.db);
  }

  /** Bounded routing input. Counts and memory text are intentionally absent. */
  listRoutingDescriptors(options: BoundedReadOptions = {}): MemoryRoutingDescriptor[] {
    const { limit, offset } = this.bounds(options);
    const rows = this.db.query<{ kind: 'topic' | 'entity'; id: string; label: string; aliases: string; description: string | null }, [number, number]>(`
      SELECT kind, id, label, aliases, description FROM (
        SELECT 'topic' AS kind, id, label, aliases, description FROM topics
        UNION ALL
        SELECT 'entity' AS kind, id, label, aliases, description FROM entities
        UNION ALL
        SELECT 'topic' AS kind, c.topicId AS id, c.label, '[]' AS aliases,
          CASE WHEN MIN(c.origin) = MAX(c.origin) AND MIN(c.origin) = 'reviewer'
            THEN 'Automatically categorized memories. Routing metadata, not factual evidence.'
            ELSE 'Automatically categorized memories, including broad local-rule labels for older records. Routing metadata, not factual evidence.' END AS description
        FROM memory_routing_categories c JOIN memories m ON m.id = c.memoryId AND m.revision = c.memoryRevision
        WHERE m.state = 'active'
          AND (m.validFrom IS NULL OR m.validFrom <= unixepoch('now') * 1000)
          AND (m.validUntil IS NULL OR m.validUntil > unixepoch('now') * 1000)
          AND (
            EXISTS (SELECT 1 FROM memory_evidence e JOIN messages s ON s.id = e.sourceMessageId
              WHERE e.memoryId = m.id AND e.memoryRevision = m.revision AND e.stance = 'supporting'
                AND e.sourceRole = 'user' AND s.role = 'user' AND s.revision = e.sourceRevision AND s.status <> 'streaming'
                AND NOT (e.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
            OR ((m.core = 1 OR m.pinned = 1) AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memoryId = m.id))
          ) GROUP BY c.topicId, c.label
      ) ORDER BY kind, label, id LIMIT ? OFFSET ?`).all(limit, offset);
    return rows.map((row) => ({ kind: row.kind, id: row.id, label: row.label, aliases: parseAliases(row.aliases), description: row.description }));
  }

  /** Expand selected entities by exactly one supported, currently valid hop. */
  expandEntityIds(ids: readonly string[], limit = 24): string[] {
    const selected = [...new Set(ids)].map((id) => stableId(id, 'entity id')).slice(0, 64);
    if (!selected.length) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid entity expansion limit.');
    const placeholders = selected.map(() => '?').join(',');
    const rows = this.db.query<{ id: string }, (string | number)[]>(`
      SELECT id FROM (
        SELECT r.objectId AS id FROM memory_relationships r
        WHERE r.kind = 'involves' AND r.subjectId IN (${placeholders}) AND r.sourceMessageId IS NOT NULL AND r.sourceRole = 'user'
          AND EXISTS (SELECT 1 FROM messages s WHERE s.id = r.sourceMessageId AND s.role = 'user' AND s.revision = r.sourceRevision AND s.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
          AND EXISTS (SELECT 1 FROM entities subjectEntity WHERE subjectEntity.id = r.subjectId AND subjectEntity.revision = r.subjectRevision)
          AND EXISTS (SELECT 1 FROM entities objectEntity WHERE objectEntity.id = r.objectId AND objectEntity.revision = r.objectRevision)
        UNION
        SELECT r.subjectId AS id FROM memory_relationships r
        WHERE r.kind = 'involves' AND r.objectId IN (${placeholders}) AND r.sourceMessageId IS NOT NULL AND r.sourceRole = 'user'
          AND EXISTS (SELECT 1 FROM messages s WHERE s.id = r.sourceMessageId AND s.role = 'user' AND s.revision = r.sourceRevision AND s.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
          AND EXISTS (SELECT 1 FROM entities subjectEntity WHERE subjectEntity.id = r.subjectId AND subjectEntity.revision = r.subjectRevision)
          AND EXISTS (SELECT 1 FROM entities objectEntity WHERE objectEntity.id = r.objectId AND objectEntity.revision = r.objectRevision)
      ) WHERE id NOT IN (${selected.map(() => '?').join(',')}) ORDER BY id LIMIT ?`).all(...selected, ...selected, ...selected, limit);
    return [...selected, ...rows.map((row) => stableId(row.id, 'expanded entity id'))].slice(0, limit + selected.length);
  }

  /** Expand memory associations by exactly one related_to hop. */
  expandRelatedMemoryIds(ids: readonly string[], limit = 24): string[] {
    const selected = [...new Set(ids)].map((id) => stableId(id, 'memory id')).slice(0, 80);
    if (!selected.length) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid memory expansion limit.');
    const placeholders = selected.map(() => '?').join(',');
    const rows = this.db.query<{ id: string }, (string | number)[]>(`
      SELECT id FROM (
        SELECT r.objectId AS id FROM memory_relationships r WHERE r.kind = 'related_to' AND r.subjectId IN (${placeholders}) AND r.sourceMessageId IS NOT NULL AND r.sourceRole = 'user'
          AND EXISTS (SELECT 1 FROM messages s WHERE s.id = r.sourceMessageId AND s.role = 'user' AND s.revision = r.sourceRevision AND s.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
          AND EXISTS (SELECT 1 FROM memories subjectMemory WHERE subjectMemory.id = r.subjectId AND subjectMemory.revision = r.subjectRevision)
          AND EXISTS (SELECT 1 FROM memories objectMemory WHERE objectMemory.id = r.objectId AND objectMemory.revision = r.objectRevision)
        UNION
        SELECT r.subjectId AS id FROM memory_relationships r WHERE r.kind = 'related_to' AND r.objectId IN (${placeholders}) AND r.sourceMessageId IS NOT NULL AND r.sourceRole = 'user'
          AND EXISTS (SELECT 1 FROM messages s WHERE s.id = r.sourceMessageId AND s.role = 'user' AND s.revision = r.sourceRevision AND s.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
          AND EXISTS (SELECT 1 FROM memories subjectMemory WHERE subjectMemory.id = r.subjectId AND subjectMemory.revision = r.subjectRevision)
          AND EXISTS (SELECT 1 FROM memories objectMemory WHERE objectMemory.id = r.objectId AND objectMemory.revision = r.objectRevision)
      ) WHERE id NOT IN (${selected.map(() => '?').join(',')}) ORDER BY id LIMIT ?`).all(...selected, ...selected, ...selected, limit);
    return rows.map((row) => stableId(row.id, 'expanded memory id'));
  }

  createRelationship(input: CreateRelationshipInput): RelationshipRecord {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'relationship id');
    const kind = choice(input.kind, RELATIONSHIP_KINDS, 'relationship kind');
    let subjectId = stableId(input.subjectId, 'relationship subject id');
    let objectId = stableId(input.objectId, 'relationship object id');
    let subjectExpected = revision(input.expectedSubjectRevision, 'subject revision');
    let objectExpected = revision(input.expectedObjectRevision, 'object revision');
    if (SYMMETRIC_KINDS.includes(kind) && objectId < subjectId) {
      [subjectId, objectId] = [objectId, subjectId];
      [subjectExpected, objectExpected] = [objectExpected, subjectExpected];
    }
    const provenance = nonEmpty(input.provenance, 'relationship provenance', PROVENANCE_MAX);
    if (typeof input.explicit !== 'boolean') throw new Error('Invalid relationship explicit flag.');
    const validFrom = optionalTimestamp(input.validFrom, 'validFrom');
    const validUntil = optionalTimestamp(input.validUntil, 'validUntil');
    interval(validFrom, validUntil);
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt');
    const sourceMessageId = input.sourceMessageId === undefined || input.sourceMessageId === null ? null : nonEmpty(input.sourceMessageId, 'source message id', 100);
    const sourceRevision = input.sourceRevision === undefined || input.sourceRevision === null ? null : revision(input.sourceRevision, 'source revision');
    if (sourceMessageId === null || sourceRevision === null) throw new Error('Relationship source is required.');
    let result: RelationshipRecord | null = null;
    this.db.transaction(() => {
      const subject = this.endpoint(kind, subjectId, 'subject');
      const object = this.endpoint(kind, objectId, 'object');
      this.validateRelationship(kind, subject, object);
      if (subject.revision !== subjectExpected) throw new Error('Subject revision conflict.');
      if (object.revision !== objectExpected) throw new Error('Object revision conflict.');
      if (kind === 'supersedes') {
        const cycle = this.db.query<{ found: number }, [string, string]>(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT r.objectId FROM memory_relationships r JOIN chain c ON r.subjectId = c.id WHERE r.kind = 'supersedes') SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`).get(objectId, subjectId);
        if (cycle) throw new Error('Supersession cycle.');
      }
      let sourceRole: 'user' | 'assistant' | null = null;
      if (sourceMessageId !== null) {
        const source = this.db.query<{ id: string; revision: number; role: 'user' | 'assistant'; status: string }, [string]>('SELECT id, revision, role, status FROM messages WHERE id = ?').get(sourceMessageId);
        if (!source) throw new Error('Source message not found.');
        if (source.status === 'streaming') throw new Error('Streaming source cannot support relationship.');
        if (source.revision !== sourceRevision) throw new Error('Source revision conflict.');
        assertSourceEvidenceAllowed(this.db, sourceMessageId, sourceRevision);
        sourceRole = source.role;
      }
      const duplicate = this.db.query('SELECT 1 FROM memory_relationships WHERE kind = ? AND subjectId = ? AND objectId = ?').get(kind, subjectId, objectId);
      if (duplicate) throw new Error('Duplicate relationship.');
      this.db.query('INSERT INTO memory_relationships (id, kind, subjectId, objectId, subjectRevision, objectRevision, provenance, explicit, recordedAt, validFrom, validUntil, sourceMessageId, sourceRevision, sourceRole, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, kind, subjectId, objectId, subjectExpected, objectExpected, provenance, input.explicit ? 1 : 0, recordedAt, validFrom, validUntil, sourceMessageId, sourceRevision, sourceRole);
      result = this.getRelationship(id);
    })();
    return result!;
  }

  getRelationship(id: string): RelationshipRecord | null {
    const row = this.relationshipQuery('r.id = ?').get(stableId(id, 'relationship id'));
    return row ? this.decodeRelationship(row) : null;
  }
  listRelationships(options: BoundedReadOptions & { kind?: RelationshipKind; endpointId?: string } = {}): RelationshipRecord[] {
    const { limit, offset } = this.bounds(options);
    const kind = options.kind === undefined ? undefined : choice(options.kind, RELATIONSHIP_KINDS, 'relationship kind');
    const endpointId = options.endpointId === undefined ? undefined : stableId(options.endpointId, 'endpoint id');
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (kind !== undefined) { conditions.push('r.kind = ?'); params.push(kind); }
    if (endpointId !== undefined) { conditions.push('(r.subjectId = ? OR r.objectId = ?)'); params.push(endpointId, endpointId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.query<RelationshipRow, (string | number)[]>(`${this.relationshipSql()} ${where} ORDER BY r.recordedAt, r.id LIMIT ? OFFSET ?`).all(...params, limit, offset).map((row) => this.decodeRelationship(row));
  }
  getEffectiveMemory(id: string, applicableAtTime: number = Date.now()): EffectiveMemoryRead | null {
    const memoryId = stableId(id, 'memory id');
    const at = applicableAt(applicableAtTime);
    const row = this.db.query<EffectiveMemoryRow, [number, string]>(`${this.effectiveMemorySql()} WHERE m.id = ?`).get(at, memoryId);
    return row ? this.decodeEffectiveMemory(row, at) : null;
  }
  listEffectiveMemories(options: EffectiveMemoryReadOptions = {}): EffectiveMemoryRead[] {
    const { limit, offset } = this.bounds(options);
    const at = applicableAt(options.applicableAt);
    return this.db.query<EffectiveMemoryRow, [number, number, number]>(`${this.effectiveMemorySql()} ORDER BY m.recordedAt DESC, m.id LIMIT ? OFFSET ?`).all(at, limit, offset).map((row) => this.decodeEffectiveMemory(row, at));
  }
  removeRelationship(id: string, expectedRevision: number) {
    const relationshipId = stableId(id, 'relationship id');
    const expected = revision(expectedRevision, 'relationship revision');
    const result = this.db.query('DELETE FROM memory_relationships WHERE id = ? AND revision = ?').run(relationshipId, expected);
    if (result.changes !== 1) throw new Error('Relationship revision conflict.');
  }

  private endpoint(kind: RelationshipKind, id: string, label: string): Endpoint {
    const isMemory = kind === 'about' ? label === 'subject' : kind !== 'involves';
    if (isMemory) {
      const row = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(id);
      if (!row) throw new Error(`${label === 'subject' ? 'Subject' : 'Object'} memory not found.`);
      return { type: 'memory', id, revision: row.revision };
    }
    const row = this.db.query<{ revision: number }, [string]>('SELECT revision FROM entities WHERE id = ?').get(id);
    if (!row) throw new Error(`${label === 'subject' ? 'Subject' : 'Object'} entity not found.`);
    return { type: 'entity', id, revision: row.revision };
  }
  private validateRelationship(kind: RelationshipKind, subject: Endpoint, object: Endpoint) {
    if (subject.id === object.id) throw new Error('Relationship cannot link an endpoint to itself.');
    if (kind === 'about' && (subject.type !== 'memory' || object.type !== 'entity')) throw new Error('About requires memory to entity endpoints.');
    if (kind === 'involves') {
      if (subject.type !== 'entity' || object.type !== 'entity') throw new Error('Involves requires entity endpoints.');
      const row = this.db.query<{ kind: EntityKind }, [string]>('SELECT kind FROM entities WHERE id = ?').get(subject.id);
      if (!row || (row.kind !== 'trip' && row.kind !== 'event')) throw new Error('Involves subject must be a trip or event.');
    }
    if (['supersedes', 'contradicts', 'related_to'].includes(kind) && (subject.type !== 'memory' || object.type !== 'memory')) throw new Error(`${kind} requires memory endpoints.`);
  }
  private relationshipSql() {
    return `SELECT r.id, r.kind, r.subjectId, r.objectId, r.subjectRevision, r.objectRevision, r.provenance, r.explicit, r.recordedAt, r.validFrom, r.validUntil, r.sourceMessageId, r.sourceRevision, r.sourceRole, r.revision, CASE WHEN r.kind = 'involves' THEN se.revision ELSE sm.revision END AS currentSubjectRevision, CASE WHEN r.kind IN ('about', 'involves') THEN oe.revision ELSE om.revision END AS currentObjectRevision, src.id AS sourceExists, src.revision AS currentSourceRevision, src.status AS sourceStatus, CASE WHEN EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = src.conversationId) THEN 1 ELSE 0 END AS sourceExcluded FROM memory_relationships r LEFT JOIN memories sm ON r.kind IN ('about', 'supersedes', 'contradicts', 'related_to') AND sm.id = r.subjectId LEFT JOIN memories om ON r.kind IN ('supersedes', 'contradicts', 'related_to') AND om.id = r.objectId LEFT JOIN entities se ON r.kind = 'involves' AND se.id = r.subjectId LEFT JOIN entities oe ON r.kind IN ('about', 'involves') AND oe.id = r.objectId LEFT JOIN messages src ON src.id = r.sourceMessageId`;
  }
  private effectiveMemorySql() {
    const validRelationship = `r.sourceMessageId IS NOT NULL
      AND r.sourceRevision IS NOT NULL
      AND r.sourceRole = 'user'
       AND EXISTS (SELECT 1 FROM messages src WHERE src.id = r.sourceMessageId AND src.role = 'user' AND src.revision = r.sourceRevision AND src.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = src.conversationId)))
      AND EXISTS (SELECT 1 FROM memories subjectMemory WHERE subjectMemory.id = r.subjectId AND subjectMemory.revision = r.subjectRevision)
      AND EXISTS (SELECT 1 FROM memories objectMemory WHERE objectMemory.id = r.objectId AND objectMemory.revision = r.objectRevision)
      AND (r.validFrom IS NULL OR r.validFrom <= clock.applicableAt)
      AND (r.validUntil IS NULL OR clock.applicableAt < r.validUntil)`;
    return `WITH clock(applicableAt) AS (SELECT ?)
      SELECT m.*,
        CASE
          WHEN EXISTS (SELECT 1 FROM memory_relationships r CROSS JOIN clock WHERE r.kind = 'supersedes' AND r.explicit = 1 AND r.objectId = m.id AND ${validRelationship}) THEN 'superseded'
          WHEN EXISTS (SELECT 1 FROM memory_relationships r CROSS JOIN clock WHERE r.kind = 'contradicts' AND (r.subjectId = m.id OR r.objectId = m.id) AND ${validRelationship}) THEN 'contested'
          ELSE NULL
        END AS derivedState
      FROM memories m CROSS JOIN clock`;
  }
  private relationshipQuery(where: string) {
    return this.db.query<RelationshipRow, [string]>(`${this.relationshipSql()} WHERE ${where}`);
  }
  private decodeRelationship(row: RelationshipRow): RelationshipRecord {
    let invalidReason: RelationshipInvalidReason | undefined;
    if (row.sourceMessageId === null || row.sourceRevision === null || row.sourceRole === null) invalidReason = 'source_missing';
    else if (row.sourceExists === null) invalidReason = 'source_deleted';
    else if (row.sourceStatus === 'streaming') invalidReason = 'source_streaming';
    else if (row.sourceExcluded === 1 && row.provenance === 'background learning') invalidReason = 'conversation_excluded';
    else if (row.currentSourceRevision !== row.sourceRevision) invalidReason = 'source_revised';
    if (!invalidReason && (row.currentSubjectRevision === null || row.currentObjectRevision === null)) invalidReason = 'endpoint_deleted';
    if (!invalidReason && (row.currentSubjectRevision !== row.subjectRevision || row.currentObjectRevision !== row.objectRevision)) invalidReason = 'endpoint_revised';
    return { id: row.id, kind: row.kind, subjectId: row.subjectId, objectId: row.objectId, subjectRevision: row.subjectRevision, objectRevision: row.objectRevision, provenance: row.provenance, explicit: row.explicit === 1, recordedAt: row.recordedAt, validFrom: row.validFrom, validUntil: row.validUntil, sourceMessageId: row.sourceMessageId, sourceRevision: row.sourceRevision, sourceRole: row.sourceRole, revision: row.revision, valid: !invalidReason, ...(invalidReason ? { invalidReason } : {}) };
  }
  private decodeEffectiveMemory(row: EffectiveMemoryRow, at: number): EffectiveMemoryRead {
    const memory: MemoryRecord = { ...row, pinned: row.pinned === 1, core: row.core === 1 };
    const derivedState = row.derivedState === 'superseded' || row.derivedState === 'contested' ? row.derivedState : null;
    return { memory, durableState: memory.state, derivedState, effectiveState: derivedState ?? memory.state, applicableAt: at };
  }
  private bounds(options: BoundedReadOptions): { limit: number; offset: number } {
    const limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;
    const offset = options.offset === undefined ? 0 : options.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('Invalid graph list limit.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid graph list offset.');
    return { limit, offset };
  }
}
