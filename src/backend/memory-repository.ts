import type { Database } from 'bun:sqlite';

export type MemoryKind = 'fact' | 'preference' | 'note';
export type MemoryState = 'active' | 'superseded' | 'contested';
export type EvidenceStance = 'supporting' | 'contradicting';
export type EvidenceInvalidReason = 'source_deleted' | 'source_revised' | 'source_streaming' | 'conversation_excluded' | 'memory_revised' | 'memory_revision_unknown';

export interface MemoryRecord {
  id: string;
  text: string;
  kind: MemoryKind;
  state: MemoryState;
  pinned: boolean;
  core: boolean;
  recordedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  revision: number;
}

export interface CreateMemoryInput {
  id?: string;
  text: string;
  kind: MemoryKind;
  state?: MemoryState;
  pinned?: boolean;
  core?: boolean;
  recordedAt?: number;
  validFrom?: number | null;
  validUntil?: number | null;
}

export interface UpdateMemoryInput {
  text?: string;
  kind?: MemoryKind;
  state?: MemoryState;
  pinned?: boolean;
  core?: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
}

export interface SourceEvidence {
  id: string;
  memoryId: string;
  memoryRevision: number | null;
  sourceMessageId: string;
  sourceRevision: number;
  sourceCreatedAt: number | null;
  sourceRole: 'user' | 'assistant';
  stance: EvidenceStance;
  provenance: string;
  recordedAt: number;
  valid: boolean;
  invalidReason?: EvidenceInvalidReason;
}

export interface AddEvidenceInput {
  id?: string;
  memoryId: string;
  expectedMemoryRevision: number;
  sourceMessageId: string;
  sourceRevision: number;
  stance: EvidenceStance;
  provenance: string;
  recordedAt?: number;
}

export interface MemoryListOptions {
  limit?: number;
  offset?: number;
}

export interface MemorySearchOptions extends MemoryListOptions {}

/** A source captured by the host for the foreground user message. */
export interface ForegroundSource {
  sourceMessageId: string;
  sourceRevision: number;
}

export interface ForegroundMemoryWriteResult {
  memory: MemoryRecord;
  evidence: SourceEvidence;
  created: boolean;
}

export interface MemoryForgetResult {
  memoryId: string;
  expectedRevision: number;
  alreadyForgotten: boolean;
}

export interface MemoryRead {
  memory: MemoryRecord;
  evidence: SourceEvidence[];
  validSupportingEvidence: SourceEvidence[];
  validContradictingEvidence: SourceEvidence[];
}

export interface BasicRecallCandidate {
  memory: MemoryRecord;
  eligibility: 'core' | 'pinned' | 'supported';
  /** The source-message time of the latest supported user mention, not extraction time. */
  lastSupportedAt: number | null;
  sourceMessageId: string | null;
  sourceCreatedAt: number | null;
  /** Time the extractor recorded the evidence, retained as attribution only. */
  extractionRecordedAt: number | null;
  sourceProvenance: string | null;
}

type MemoryRow = Omit<MemoryRecord, 'pinned' | 'core'> & { pinned: number; core: number };
type EvidenceRow = Omit<SourceEvidence, 'valid' | 'invalidReason'> & {
  memoryExists: string | null;
  currentMemoryRevision: number | null;
  sourceExists: string | null;
  currentSourceRevision: number | null;
  sourceCreatedAt: number | null;
  sourceStatus: string | null;
  sourceConversationId: string | null;
  sourceExcluded: number;
};
type SourceRow = { revision: number; role: 'user' | 'assistant'; status: string };
type RecallRow = MemoryRow & {
  lastSupportedAt: number | null;
  sourceMessageId: string | null;
  sourceCreatedAt: number | null;
  sourceRowid: number | null;
  extractionRecordedAt: number | null;
  sourceProvenance: string | null;
  hasValidUserSupport: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'note'];
const STATES: readonly MemoryState[] = ['active', 'superseded', 'contested'];
const STANCES: readonly EvidenceStance[] = ['supporting', 'contradicting'];
const MAX_MEMORY_TEXT = 16000;
const MAX_PROVENANCE = 200;
const MAX_MEMORY_SEARCH_QUERY = 500;
const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 100;

/** Shared source-level suppression guard for all evidence-backed writers. */
export function assertSourceEvidenceAllowed(db: Database, sourceMessageId: string, sourceRevision: number) {
  if (db.query('SELECT 1 FROM memory_forget_sources WHERE sourceMessageId = ? AND sourceRevision = ?').get(sourceMessageId, sourceRevision)) {
    throw new Error('Memory source evidence was forgotten.');
  }
}

export function installMemorySchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'note')),
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'contested')),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      core INTEGER NOT NULL DEFAULT 0 CHECK (core IN (0, 1)),
      recordedAt INTEGER NOT NULL,
      validFrom INTEGER,
      validUntil INTEGER,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      CHECK (validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom)
    );
    CREATE INDEX IF NOT EXISTS memories_recorded_idx ON memories (recordedAt DESC, id);
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id TEXT PRIMARY KEY,
      memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      memoryRevision INTEGER NOT NULL CHECK (memoryRevision >= 1),
      sourceMessageId TEXT NOT NULL,
      sourceRevision INTEGER NOT NULL CHECK (sourceRevision >= 1),
      sourceRole TEXT NOT NULL CHECK (sourceRole IN ('user', 'assistant')),
      stance TEXT NOT NULL CHECK (stance IN ('supporting', 'contradicting')),
      provenance TEXT NOT NULL,
      recordedAt INTEGER NOT NULL,
      UNIQUE (memoryId, sourceMessageId, sourceRevision, stance, memoryRevision)
    );
    CREATE INDEX IF NOT EXISTS memory_evidence_memory_idx ON memory_evidence (memoryId, recordedAt, id);
    CREATE INDEX IF NOT EXISTS memory_evidence_source_idx ON memory_evidence (sourceMessageId, sourceRevision);
    -- Only stable IDs, revisions, and timestamps remain after forgetting. No text tombstone is stored.
    CREATE TABLE IF NOT EXISTS memory_forget_suppressions (
      memoryId TEXT PRIMARY KEY,
      forgottenRevision INTEGER NOT NULL CHECK (forgottenRevision >= 1),
      forgottenAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_forget_sources (
      sourceMessageId TEXT NOT NULL,
      sourceRevision INTEGER NOT NULL CHECK (sourceRevision >= 1),
      forgottenAt INTEGER NOT NULL,
      PRIMARY KEY (sourceMessageId, sourceRevision)
    );
    CREATE INDEX IF NOT EXISTS memory_forget_sources_source_idx ON memory_forget_sources (sourceMessageId, sourceRevision);
  `);
  // Upgrade the provisional phase-1 table if it was created before evidence
  // was bound to a memory revision. The binding is deliberately nullable for
  // old rows: their original revision is unknown and must not be reconstructed
  // from the current memory row.
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(memory_evidence)').all();
  if (!columns.some((column) => column.name === 'memoryRevision')) db.exec('ALTER TABLE memory_evidence ADD COLUMN memoryRevision INTEGER');
  ensureEvidenceRevisionUnique(db);
}

function ensureEvidenceRevisionUnique(db: Database) {
  const definition = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_evidence'",
  ).get()?.sql ?? '';
  if (definition.includes('UNIQUE (memoryId, sourceMessageId, sourceRevision, stance, memoryRevision)')) return;
  db.exec(`
    DROP INDEX IF EXISTS memory_evidence_memory_idx;
    DROP INDEX IF EXISTS memory_evidence_source_idx;
    CREATE TABLE memory_evidence_revision_upgrade (
      id TEXT PRIMARY KEY,
      memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      memoryRevision INTEGER,
      sourceMessageId TEXT NOT NULL,
      sourceRevision INTEGER NOT NULL CHECK (sourceRevision >= 1),
      sourceRole TEXT NOT NULL CHECK (sourceRole IN ('user', 'assistant')),
      stance TEXT NOT NULL CHECK (stance IN ('supporting', 'contradicting')),
      provenance TEXT NOT NULL,
      recordedAt INTEGER NOT NULL,
      UNIQUE (memoryId, sourceMessageId, sourceRevision, stance, memoryRevision)
    );
    INSERT INTO memory_evidence_revision_upgrade (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt)
      SELECT id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt FROM memory_evidence;
    DROP TABLE memory_evidence;
    ALTER TABLE memory_evidence_revision_upgrade RENAME TO memory_evidence;
    CREATE INDEX memory_evidence_memory_idx ON memory_evidence (memoryId, recordedAt, id);
    CREATE INDEX memory_evidence_source_idx ON memory_evidence (sourceMessageId, sourceRevision);
  `);
}

function stableId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Invalid ${name}.`);
  return value as T;
}

function timestamp(value: unknown, name: string, allowNull = false): number | null {
  if (value === null && allowNull) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}

function optionalTimestamp(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  return timestamp(value, name, true);
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name}.`);
  return value;
}

function decodeMemory(row: MemoryRow): MemoryRecord {
  return { ...row, pinned: row.pinned === 1, core: row.core === 1 };
}

function evidenceValidity(row: EvidenceRow): Pick<SourceEvidence, 'valid' | 'invalidReason'> {
  if (row.memoryRevision === null) return { valid: false, invalidReason: 'memory_revision_unknown' };
  if (row.memoryExists === null || row.currentMemoryRevision !== row.memoryRevision) return { valid: false, invalidReason: 'memory_revised' };
  if (row.sourceExists === null) return { valid: false, invalidReason: 'source_deleted' };
  if (row.sourceStatus === 'streaming') return { valid: false, invalidReason: 'source_streaming' };
  if (row.sourceExcluded === 1 && row.provenance === 'background learning') return { valid: false, invalidReason: 'conversation_excluded' };
  if (row.currentSourceRevision !== row.sourceRevision) return { valid: false, invalidReason: 'source_revised' };
  return { valid: true };
}

function decodeEvidence(row: EvidenceRow): SourceEvidence {
  return { id: row.id, memoryId: row.memoryId, memoryRevision: row.memoryRevision, sourceMessageId: row.sourceMessageId, sourceRevision: row.sourceRevision, sourceCreatedAt: row.sourceCreatedAt, sourceRole: row.sourceRole, stance: row.stance, provenance: row.provenance, recordedAt: row.recordedAt, ...evidenceValidity(row) };
}

export class MemoryRepository {
  constructor(
    private readonly db: Database,
    installSchema = true,
    private readonly onMutation: () => void = () => {},
    private readonly onForget: (memoryId: string) => void = () => {},
    private readonly onRevision: (memoryId: string) => void = () => {},
  ) {
    if (installSchema) this.db.transaction(() => installMemorySchema(this.db))();
  }

  create(input: CreateMemoryInput): MemoryRecord {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'memory id');
    const text = boundedText(input.text, 'memory text', MAX_MEMORY_TEXT);
    const kind = choice(input.kind, KINDS, 'memory kind');
    const state = input.state === undefined ? 'active' : choice(input.state, STATES, 'memory state');
    const pinned = input.pinned === undefined ? false : bool(input.pinned, 'pinned');
    const core = input.core === undefined ? false : bool(input.core, 'core');
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt')!;
    const validFrom = optionalTimestamp(input.validFrom, 'validFrom') ?? null;
    const validUntil = optionalTimestamp(input.validUntil, 'validUntil') ?? null;
    this.validateInterval(validFrom, validUntil);
    this.db.transaction(() => {
      this.assertMemoryNotForgotten(id);
      this.db.query('INSERT INTO memories (id, text, kind, state, pinned, core, recordedAt, validFrom, validUntil, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, text, kind, state, pinned ? 1 : 0, core ? 1 : 0, recordedAt, validFrom, validUntil);
    })();
    this.onMutation();
    return this.get(id)!;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(stableId(id, 'memory id'));
    return row ? decodeMemory(row) : null;
  }

  /**
   * Select a bounded basic-recall page in SQLite. The support subqueries repeat
   * the repository's live revision checks, so stale, deleted, streaming, or
   * source-less evidence cannot become current support. A core or pinned row
   * is eligible without support only when no evidence row has ever been attached,
   * because stale evidence must not silently become a manual fallback.
   */
  listBasicRecallCandidates(options: { applicableAt?: number; limit?: number; ids?: readonly string[] } = {}): BasicRecallCandidate[] {
    const at = options.applicableAt === undefined ? Date.now() : timestamp(options.applicableAt, 'applicableAt')!;
    const limit = options.limit === undefined ? 50 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recall candidate limit.');
    const ids = options.ids?.map((id) => stableId(id, 'recall memory id')).slice(0, 120) ?? [];
    const idFilter = ids.length ? `m.id IN (${ids.map(() => '?').join(',')})` : '1 = 1';
    const validSupport = `
      e.memoryId = m.id AND e.memoryRevision = m.revision AND e.stance = 'supporting'
      AND e.sourceRole = 'user'
      AND EXISTS (
        SELECT 1 FROM messages supportSource
        WHERE supportSource.id = e.sourceMessageId
          AND supportSource.role = 'user'
          AND supportSource.revision = e.sourceRevision
           AND supportSource.status <> 'streaming'
           AND NOT (e.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = supportSource.conversationId))
      )`;
    const validContradiction = `
      e.memoryId = m.id AND e.memoryRevision = m.revision AND e.stance = 'contradicting'
      AND e.sourceRole = 'user'
      AND EXISTS (
        SELECT 1 FROM messages contradictionSource
        WHERE contradictionSource.id = e.sourceMessageId
          AND contradictionSource.role = 'user'
          AND contradictionSource.revision = e.sourceRevision
          AND contradictionSource.status <> 'streaming'
          AND NOT (e.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = contradictionSource.conversationId))
      )`;
    const validRelationship = `
      r.sourceMessageId IS NOT NULL AND r.sourceRevision IS NOT NULL AND r.sourceRole = 'user'
      AND EXISTS (
        SELECT 1 FROM messages relationshipSource
        WHERE relationshipSource.id = r.sourceMessageId
          AND relationshipSource.role = 'user'
          AND relationshipSource.revision = r.sourceRevision
          AND relationshipSource.status <> 'streaming'
          AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = relationshipSource.conversationId))
      )
      AND EXISTS (SELECT 1 FROM memories relationshipSubject WHERE relationshipSubject.id = r.subjectId AND relationshipSubject.revision = r.subjectRevision)
      AND EXISTS (SELECT 1 FROM memories relationshipObject WHERE relationshipObject.id = r.objectId AND relationshipObject.revision = r.objectRevision)
      AND (r.validFrom IS NULL OR r.validFrom <= ?)
      AND (r.validUntil IS NULL OR ? < r.validUntil)`;
    const rows = this.db.query<RecallRow, (string | number)[]>(`
      SELECT m.*,
        (SELECT supportSource.createdAt
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS lastSupportedAt,
        (SELECT e.sourceMessageId
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS sourceMessageId,
        (SELECT supportSource.createdAt
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS sourceCreatedAt,
        (SELECT supportSource.rowid
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS sourceRowid,
        (SELECT e.recordedAt
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS extractionRecordedAt,
        (SELECT e.provenance
         FROM memory_evidence e JOIN messages supportSource ON supportSource.id = e.sourceMessageId
         WHERE ${validSupport}
         ORDER BY (supportSource.createdAt IS NULL) ASC, supportSource.createdAt DESC, supportSource.rowid DESC, e.recordedAt DESC, e.id ASC LIMIT 1) AS sourceProvenance,
        EXISTS (SELECT 1 FROM memory_evidence e WHERE ${validSupport}) AS hasValidUserSupport
      FROM memories m
       WHERE m.state = 'active'
         AND (${idFilter})
        AND (m.validFrom IS NULL OR m.validFrom <= ?)
        AND (m.validUntil IS NULL OR ? < m.validUntil)
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE ${validContradiction})
        AND NOT EXISTS (
          SELECT 1 FROM memory_relationships r
          WHERE r.kind = 'supersedes' AND r.explicit = 1 AND r.objectId = m.id AND ${validRelationship}
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_relationships r
          WHERE r.kind = 'contradicts' AND (r.subjectId = m.id OR r.objectId = m.id) AND ${validRelationship}
        )
        AND (
          EXISTS (SELECT 1 FROM memory_evidence e WHERE ${validSupport})
          OR ((m.core = 1 OR m.pinned = 1) AND NOT EXISTS (SELECT 1 FROM memory_evidence historicalEvidence WHERE historicalEvidence.memoryId = m.id))
        )
      ORDER BY m.core DESC, m.pinned DESC, (lastSupportedAt IS NULL) ASC, lastSupportedAt DESC, sourceRowid DESC, m.recordedAt DESC, m.id ASC
       LIMIT ?`).all(...ids, at, at, at, at, at, at, limit);
    return rows.map((row) => ({
      memory: decodeMemory(row),
      eligibility: row.hasValidUserSupport === 1 ? 'supported' : row.core === 1 ? 'core' : 'pinned',
      lastSupportedAt: row.lastSupportedAt,
      sourceMessageId: row.sourceMessageId,
      sourceCreatedAt: row.sourceCreatedAt,
      extractionRecordedAt: row.extractionRecordedAt,
      sourceProvenance: row.sourceProvenance,
    }));
  }

  /** Return bounded lexical/topic/entity seeds without reading memory text into the host first. */
  listJevSeedMemoryIds(options: { topicIds?: readonly string[]; entityIds?: readonly string[]; lexicalTerms?: readonly string[]; limit?: number }): string[] {
    const limit = options.limit === undefined ? 80 : options.limit;
    const branchLimit = Math.min(120, Math.max(limit, 1));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120) throw new Error('Invalid Jev seed limit.');
    const topicIds = options.topicIds?.map((id) => stableId(id, 'topic id')).slice(0, 64) ?? [];
    const entityIds = options.entityIds?.map((id) => stableId(id, 'entity id')).slice(0, 64) ?? [];
    const terms = options.lexicalTerms?.filter((term) => typeof term === 'string' && term.length > 1).slice(0, 16) ?? [];
    const unions: string[] = [];
    const params: (string | number)[] = [];
    if (topicIds.length) {
      const placeholders = topicIds.map(() => '?').join(',');
      unions.push(`SELECT id FROM (SELECT mt.memoryId AS id FROM memory_topics mt WHERE mt.topicId IN (${placeholders}) ORDER BY mt.memoryId LIMIT ?)`);
      params.push(...topicIds, branchLimit);
      unions.push(`SELECT id FROM (SELECT c.memoryId AS id FROM memory_routing_categories c JOIN memories m ON m.id = c.memoryId AND m.revision = c.memoryRevision WHERE c.topicId IN (${placeholders}) ORDER BY c.memoryId LIMIT ?)`);
      params.push(...topicIds, branchLimit);
    }
    if (entityIds.length) {
      const placeholders = entityIds.map(() => '?').join(',');
      unions.push(`SELECT id FROM (SELECT r.subjectId AS id FROM memory_relationships r WHERE r.kind = 'about' AND r.objectId IN (${placeholders})
        AND r.sourceMessageId IS NOT NULL AND r.sourceRole = 'user'
        AND EXISTS (SELECT 1 FROM messages s WHERE s.id = r.sourceMessageId AND s.role = 'user' AND s.revision = r.sourceRevision AND s.status <> 'streaming' AND NOT (r.provenance = 'background learning' AND EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = s.conversationId)))
        AND EXISTS (SELECT 1 FROM memories subjectMemory WHERE subjectMemory.id = r.subjectId AND subjectMemory.revision = r.subjectRevision)
        AND EXISTS (SELECT 1 FROM entities objectEntity WHERE objectEntity.id = r.objectId AND objectEntity.revision = r.objectRevision)
        ORDER BY r.subjectId LIMIT ?)`);
      params.push(...entityIds, branchLimit);
    }
    for (const term of terms) {
      unions.push('SELECT id FROM (SELECT m.id FROM memories m WHERE instr(lower(m.text), lower(?)) > 0 ORDER BY m.id LIMIT ?)');
      params.push(term, branchLimit);
    }
    if (!unions.length) return [];
    return this.db.query<{ id: string }, (string | number)[]>(`SELECT id FROM (${unions.join(' UNION ')}) WHERE id IN (SELECT id FROM memories) GROUP BY id ORDER BY id LIMIT ?`).all(...params, limit).map((row) => stableId(row.id, 'Jev seed memory id'));
  }

  list(options: MemoryListOptions = {}): MemoryRecord[] {
    const limit = this.listLimit(options.limit);
    const offset = this.listOffset(options.offset);
    return this.db.query<MemoryRow, [number, number]>('SELECT * FROM memories ORDER BY recordedAt DESC, id LIMIT ? OFFSET ?').all(limit, offset).map(decodeMemory);
  }

  /**
   * Search only stored memory text. The value is passed as a bound parameter to
   * instr(), so SQL and FTS operators remain literal data rather than syntax.
   */
  search(query: string, options: MemorySearchOptions = {}): MemoryRecord[] {
    const needle = boundedText(query, 'memory search query', MAX_MEMORY_SEARCH_QUERY);
    const limit = this.listLimit(options.limit);
    const offset = this.listOffset(options.offset);
    return this.db.query<MemoryRow, [string, number, number]>(
      'SELECT * FROM memories WHERE instr(lower(text), lower(?)) > 0 ORDER BY recordedAt DESC, id LIMIT ? OFFSET ?',
    ).all(needle, limit, offset).map(decodeMemory);
  }

  /**
   * Add a memory and its support from the host-captured foreground user message
   * in one transaction. The model never supplies the source identifier.
   */
  createWithForegroundEvidence(
    input: CreateMemoryInput,
    source: ForegroundSource,
    provenance = 'explicit foreground memory request',
  ): ForegroundMemoryWriteResult {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'memory id');
    const text = boundedText(input.text, 'memory text', MAX_MEMORY_TEXT);
    const kind = choice(input.kind, KINDS, 'memory kind');
    const state = input.state === undefined ? 'active' : choice(input.state, STATES, 'memory state');
    const pinned = input.pinned === undefined ? false : bool(input.pinned, 'pinned');
    const core = input.core === undefined ? false : bool(input.core, 'core');
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt')!;
    const validFrom = optionalTimestamp(input.validFrom, 'validFrom') ?? null;
    const validUntil = optionalTimestamp(input.validUntil, 'validUntil') ?? null;
    this.validateInterval(validFrom, validUntil);
    const sourceMessageId = boundedText(source.sourceMessageId, 'source message id', 100);
    const sourceRevision = this.requireRevision(source.sourceRevision, 'source revision');
    const evidenceProvenance = boundedText(provenance, 'evidence provenance', MAX_PROVENANCE);
    let result: ForegroundMemoryWriteResult | null = null;
    this.db.transaction(() => {
      const liveSource = this.foregroundSource(sourceMessageId, sourceRevision);
      this.assertMemoryNotForgotten(id);
      this.assertSourceNotSuppressed(sourceMessageId, sourceRevision);
      const duplicate = this.db.query<MemoryRow, [string, string, string, number]>(`
        SELECT m.* FROM memories m
        JOIN memory_evidence e ON e.memoryId = m.id
        WHERE m.text = ? AND m.kind = ? AND m.state = 'active'
          AND e.memoryId = m.id AND e.memoryRevision = m.revision
          AND e.sourceMessageId = ? AND e.sourceRevision = ? AND e.stance = 'supporting'
        LIMIT 1
      `).get(text, kind, sourceMessageId, sourceRevision);
      if (duplicate) {
        const evidence = this.getSupportEvidence(duplicate.id, sourceMessageId, sourceRevision);
        if (!evidence) throw new Error('Duplicate source evidence.');
        result = { memory: decodeMemory(duplicate), evidence, created: false };
        return;
      }
      this.db.query('INSERT INTO memories (id, text, kind, state, pinned, core, recordedAt, validFrom, validUntil, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(id, text, kind, state, pinned ? 1 : 0, core ? 1 : 0, recordedAt, validFrom, validUntil);
      const evidenceId = crypto.randomUUID();
      this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt) VALUES (?, ?, 1, ?, ?, ?, \'supporting\', ?, ?)')
        .run(evidenceId, id, sourceMessageId, sourceRevision, liveSource.role, evidenceProvenance, recordedAt);
      const evidence = this.getEvidence(evidenceId);
      if (!evidence) throw new Error('Foreground evidence was not stored.');
      result = { memory: this.get(id)!, evidence, created: true };
    })();
    const completed = result as unknown as ForegroundMemoryWriteResult;
    if (completed.created) this.onMutation();
    return completed;
  }

  /**
   * Replace a memory and attach the new revision to the same host-captured
   * foreground source atomically. A stale revision or invalid source rolls back
   * both the content update and evidence insert.
   */
  replaceWithForegroundEvidence(
    id: string,
    expectedRevision: number,
    patch: UpdateMemoryInput,
    source: ForegroundSource,
    provenance = 'explicit foreground memory correction',
  ): ForegroundMemoryWriteResult {
    const memoryId = stableId(id, 'memory id');
    const expected = this.requireRevision(expectedRevision);
    const sourceMessageId = boundedText(source.sourceMessageId, 'source message id', 100);
    const sourceRevision = this.requireRevision(source.sourceRevision, 'source revision');
    const evidenceProvenance = boundedText(provenance, 'evidence provenance', MAX_PROVENANCE);
    let result: ForegroundMemoryWriteResult | null = null;
    this.db.transaction(() => {
      const liveSource = this.foregroundSource(sourceMessageId, sourceRevision);
      this.assertSourceNotSuppressed(sourceMessageId, sourceRevision);
      const current = this.db.query<MemoryRow, [string]>( 'SELECT * FROM memories WHERE id = ?').get(memoryId);
      if (!current) throw new Error('Memory not found.');
      if (current.revision !== expected) throw new Error('Memory revision conflict.');
      const duplicate = this.db.query('SELECT 1 FROM memory_evidence WHERE memoryId = ? AND memoryRevision = ? AND sourceMessageId = ? AND sourceRevision = ? AND stance = \'supporting\' LIMIT 1').get(memoryId, expected + 1, sourceMessageId, sourceRevision);
      if (duplicate) throw new Error('Duplicate source evidence.');
      const text = patch.text === undefined ? current.text : boundedText(patch.text, 'memory text', MAX_MEMORY_TEXT);
      const kind = patch.kind === undefined ? current.kind : choice(patch.kind, KINDS, 'memory kind');
      const state = patch.state === undefined ? current.state : choice(patch.state, STATES, 'memory state');
      const pinned = patch.pinned === undefined ? current.pinned === 1 : bool(patch.pinned, 'pinned');
      const core = patch.core === undefined ? current.core === 1 : bool(patch.core, 'core');
      const validFrom = patch.validFrom === undefined ? current.validFrom : optionalTimestamp(patch.validFrom, 'validFrom')!;
      const validUntil = patch.validUntil === undefined ? current.validUntil : optionalTimestamp(patch.validUntil, 'validUntil')!;
      this.validateInterval(validFrom, validUntil);
      const updated = this.db.query('UPDATE memories SET text = ?, kind = ?, state = ?, pinned = ?, core = ?, validFrom = ?, validUntil = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .run(text, kind, state, pinned ? 1 : 0, core ? 1 : 0, validFrom, validUntil, memoryId, expected);
      if (updated.changes !== 1) throw new Error('Memory revision conflict.');
      this.onRevision(memoryId);
      const evidenceId = crypto.randomUUID();
      this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(evidenceId, memoryId, expected + 1, sourceMessageId, sourceRevision, liveSource.role, 'supporting', evidenceProvenance, Date.now());
      const evidence = this.getEvidence(evidenceId);
      if (!evidence) throw new Error('Foreground evidence was not stored.');
      result = { memory: this.get(memoryId)!, evidence, created: true };
    })();
    this.onMutation();
    return result!;
  }

  /**
   * Forget one live memory and all live graph/evidence links atomically.
   * Suppression retains only IDs, revisions, and time, never deleted text.
   * Source suppression is scoped to the exact source message ID and revision.
   * This is conservative across facts in one message, but does not block an
   * edited revision, another message, or a new explicit user request.
   */
  forget(id: string, expectedRevision: number, source: ForegroundSource): MemoryForgetResult {
    const memoryId = stableId(id, 'memory id');
    const expected = this.requireRevision(expectedRevision);
    const sourceMessageId = boundedText(source.sourceMessageId, 'source message id', 100);
    const sourceRevision = this.requireRevision(source.sourceRevision, 'source revision');
    let result: MemoryForgetResult | null = null;
    this.db.transaction(() => {
      this.foregroundSource(sourceMessageId, sourceRevision);
      const current = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(memoryId);
      const suppression = this.db.query<{ forgottenRevision: number }, [string]>('SELECT forgottenRevision FROM memory_forget_suppressions WHERE memoryId = ?').get(memoryId);
      if (!current) {
        if (suppression?.forgottenRevision === expected) {
          result = { memoryId, expectedRevision: expected, alreadyForgotten: true };
          return;
        }
        if (suppression) throw new Error('Memory revision conflict.');
        throw new Error('Memory not found.');
      }
      if (current.revision !== expected) throw new Error('Memory revision conflict.');
      if (suppression) throw new Error('Memory revision conflict.');
      const forgottenAt = Date.now();
      this.db.query('INSERT INTO memory_forget_suppressions (memoryId, forgottenRevision, forgottenAt) VALUES (?, ?, ?)').run(memoryId, expected, forgottenAt);
      this.db.query(`
        INSERT OR IGNORE INTO memory_forget_sources (sourceMessageId, sourceRevision, forgottenAt)
        SELECT sourceMessageId, sourceRevision, ? FROM memory_evidence WHERE memoryId = ?
        UNION
        SELECT sourceMessageId, sourceRevision, ? FROM memory_relationships
          WHERE (subjectId = ? OR objectId = ?)
            AND sourceMessageId IS NOT NULL AND sourceRevision IS NOT NULL
        UNION
        SELECT ?, ?, ?
      `).run(forgottenAt, memoryId, forgottenAt, memoryId, memoryId, sourceMessageId, sourceRevision, forgottenAt);
      this.db.query('DELETE FROM memory_relationships WHERE subjectId = ? OR objectId = ?').run(memoryId, memoryId);
      this.db.query('DELETE FROM memory_topics WHERE memoryId = ?').run(memoryId);
      const deleted = this.db.query('DELETE FROM memories WHERE id = ? AND revision = ?').run(memoryId, expected);
      // SQLite includes ON DELETE CASCADE rows in changes, so a successful
      // memory delete can report more than one affected row.
      if (deleted.changes < 1) throw new Error('Memory revision conflict.');
      result = { memoryId, expectedRevision: expected, alreadyForgotten: false };
    })();
    const completed = result!;
    if (!completed.alreadyForgotten) this.onForget(memoryId);
    return completed;
  }

  /** Settings deletion has no conversation source and therefore creates no evidence. */
  forgetFromSettings(id: string, expectedRevision: number): MemoryForgetResult {
    const memoryId = stableId(id, 'memory id');
    const expected = this.requireRevision(expectedRevision);
    let result: MemoryForgetResult | null = null;
    this.db.transaction(() => {
      const current = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(memoryId);
      const suppression = this.db.query<{ forgottenRevision: number }, [string]>('SELECT forgottenRevision FROM memory_forget_suppressions WHERE memoryId = ?').get(memoryId);
      if (!current) {
        if (suppression?.forgottenRevision === expected) { result = { memoryId, expectedRevision: expected, alreadyForgotten: true }; return; }
        if (suppression) throw new Error('Memory revision conflict.');
        throw new Error('Memory not found.');
      }
      if (current.revision !== expected || suppression) throw new Error('Memory revision conflict.');
      const forgottenAt = Date.now();
      this.db.query('INSERT INTO memory_forget_suppressions (memoryId, forgottenRevision, forgottenAt) VALUES (?, ?, ?)').run(memoryId, expected, forgottenAt);
      this.db.query(`
        INSERT OR IGNORE INTO memory_forget_sources (sourceMessageId, sourceRevision, forgottenAt)
        SELECT sourceMessageId, sourceRevision, ? FROM memory_evidence WHERE memoryId = ?
        UNION
        SELECT sourceMessageId, sourceRevision, ? FROM memory_relationships
          WHERE (subjectId = ? OR objectId = ?)
            AND sourceMessageId IS NOT NULL AND sourceRevision IS NOT NULL
      `).run(forgottenAt, memoryId, forgottenAt, memoryId, memoryId);
      this.db.query('DELETE FROM memory_relationships WHERE subjectId = ? OR objectId = ?').run(memoryId, memoryId);
      this.db.query('DELETE FROM memory_topics WHERE memoryId = ?').run(memoryId);
      const deleted = this.db.query('DELETE FROM memories WHERE id = ? AND revision = ?').run(memoryId, expected);
      if (deleted.changes < 1) throw new Error('Memory revision conflict.');
      result = { memoryId, expectedRevision: expected, alreadyForgotten: false };
    })();
    const completed = result as unknown as MemoryForgetResult;
    if (!completed.alreadyForgotten) { this.onForget(memoryId); this.onMutation(); }
    return completed;
  }

  update(id: string, expectedRevision: number, patch: UpdateMemoryInput): MemoryRecord {
    const memoryId = stableId(id, 'memory id');
    this.requireRevision(expectedRevision);
    this.db.transaction(() => {
      const current = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(memoryId);
      if (!current) throw new Error('Memory not found.');
      if (current.revision !== expectedRevision) throw new Error('Memory revision conflict.');
      const text = patch.text === undefined ? current.text : boundedText(patch.text, 'memory text', MAX_MEMORY_TEXT);
      const kind = patch.kind === undefined ? current.kind : choice(patch.kind, KINDS, 'memory kind');
      const state = patch.state === undefined ? current.state : choice(patch.state, STATES, 'memory state');
      const pinned = patch.pinned === undefined ? current.pinned === 1 : bool(patch.pinned, 'pinned');
      const core = patch.core === undefined ? current.core === 1 : bool(patch.core, 'core');
      const validFrom = patch.validFrom === undefined ? current.validFrom : optionalTimestamp(patch.validFrom, 'validFrom')!;
      const validUntil = patch.validUntil === undefined ? current.validUntil : optionalTimestamp(patch.validUntil, 'validUntil')!;
      this.validateInterval(validFrom, validUntil);
      const result = this.db.query('UPDATE memories SET text = ?, kind = ?, state = ?, pinned = ?, core = ?, validFrom = ?, validUntil = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(text, kind, state, pinned ? 1 : 0, core ? 1 : 0, validFrom, validUntil, memoryId, expectedRevision);
      if (result.changes !== 1) throw new Error('Memory revision conflict.');
      this.onRevision(memoryId);
    })();
    this.onMutation();
    return this.get(memoryId)!;
  }

  /** Future learners must check this before creating a source-backed proposal. */
  assertSourceEvidenceAllowed(sourceMessageId: string, sourceRevision: number) {
    const boundedSourceId = boundedText(sourceMessageId, 'source message id', 100);
    const revision = this.requireRevision(sourceRevision, 'source revision');
    assertSourceEvidenceAllowed(this.db, boundedSourceId, revision);
  }

  addEvidence(input: AddEvidenceInput): SourceEvidence {
    const id = input.id === undefined ? crypto.randomUUID() : stableId(input.id, 'evidence id');
    const memoryId = stableId(input.memoryId, 'memory id');
    // Message IDs predate this repository and legacy rows may use non-UUID IDs.
    // They are still validated as bounded non-empty identifiers and checked
    // against the live messages table below.
    const sourceMessageId = boundedText(input.sourceMessageId, 'source message id', 100);
    const expectedMemoryRevision = this.requireRevision(input.expectedMemoryRevision, 'memory revision');
    const sourceRevision = this.requireRevision(input.sourceRevision, 'source revision');
    const stance = choice(input.stance, STANCES, 'evidence stance');
    const provenance = boundedText(input.provenance, 'evidence provenance', MAX_PROVENANCE);
    const recordedAt = input.recordedAt === undefined ? Date.now() : timestamp(input.recordedAt, 'recordedAt')!;
    let evidence: SourceEvidence | null = null;
    this.db.transaction(() => {
      const memory = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(memoryId);
      if (!memory) throw new Error('Memory not found.');
      if (memory.revision !== expectedMemoryRevision) throw new Error('Memory revision conflict.');
      const source = this.db.query<SourceRow, [string]>('SELECT revision, role, status FROM messages WHERE id = ?').get(sourceMessageId);
      if (!source) throw new Error('Source message not found.');
      if (source.status === 'streaming') throw new Error('Streaming source cannot support evidence.');
      if (source.revision !== sourceRevision) throw new Error('Source revision conflict.');
      this.assertSourceNotSuppressed(sourceMessageId, sourceRevision);
      const duplicate = this.db.query('SELECT 1 FROM memory_evidence WHERE memoryId = ? AND memoryRevision = ? AND sourceMessageId = ? AND sourceRevision = ? AND stance = ? LIMIT 1').get(memoryId, expectedMemoryRevision, sourceMessageId, sourceRevision, stance);
      if (duplicate) throw new Error('Duplicate source evidence.');
      this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, memoryId, expectedMemoryRevision, sourceMessageId, sourceRevision, source.role, stance, provenance, recordedAt);
      evidence = this.getEvidence(id);
    })();
    this.onMutation();
    return evidence!;
  }

  getEvidence(id: string): SourceEvidence | null {
    const row = this.evidenceQuery('e.id = ?').get(stableId(id, 'evidence id'));
    return row ? decodeEvidence(row) : null;
  }

  evidenceFor(memoryId: string): SourceEvidence[] {
    const id = stableId(memoryId, 'memory id');
    return this.evidenceQuery('e.memoryId = ?').all(id).map(decodeEvidence);
  }

  read(id: string): MemoryRead {
    const memory = this.get(id);
    if (!memory) throw new Error('Memory not found.');
    const evidence = this.evidenceFor(id);
    return {
      memory,
      evidence,
      validSupportingEvidence: evidence.filter((item) => item.valid && item.stance === 'supporting'),
      validContradictingEvidence: evidence.filter((item) => item.valid && item.stance === 'contradicting'),
    };
  }

  private assertMemoryNotForgotten(memoryId: string) {
    if (this.db.query('SELECT 1 FROM memory_forget_suppressions WHERE memoryId = ?').get(memoryId)) throw new Error('Memory has been forgotten.');
  }
  private assertSourceNotSuppressed(sourceMessageId: string, sourceRevision: number) {
    assertSourceEvidenceAllowed(this.db, sourceMessageId, sourceRevision);
  }

  private getSupportEvidence(memoryId: string, sourceMessageId: string, sourceRevision: number): SourceEvidence | null {
    const row = this.evidenceQuery('e.memoryId = ? AND e.memoryRevision = (SELECT revision FROM memories WHERE id = e.memoryId) AND e.sourceMessageId = ? AND e.sourceRevision = ? AND e.stance = \'supporting\'').get(memoryId, sourceMessageId, sourceRevision);
    return row ? decodeEvidence(row) : null;
  }

  private foregroundSource(sourceMessageId: string, sourceRevision: number): SourceRow {
    const source = this.db.query<SourceRow, [string]>(
      'SELECT revision, role, status FROM messages WHERE id = ?',
    ).get(sourceMessageId);
    if (!source) throw new Error('Source message not found.');
    if (source.role !== 'user') throw new Error('Foreground evidence must cite the current user message.');
    if (source.status === 'streaming') throw new Error('Streaming source cannot support evidence.');
    if (source.revision !== sourceRevision) throw new Error('Source revision conflict.');
    return source;
  }

  private evidenceQuery(where: string) {
    return this.db.query<EvidenceRow, (string | number)[]>(`SELECT e.id, e.memoryId, e.memoryRevision, e.sourceMessageId, e.sourceRevision, m.createdAt AS sourceCreatedAt, e.sourceRole, e.stance, e.provenance, e.recordedAt, mem.id AS memoryExists, mem.revision AS currentMemoryRevision, m.id AS sourceExists, m.revision AS currentSourceRevision, m.status AS sourceStatus, m.conversationId AS sourceConversationId, CASE WHEN EXISTS (SELECT 1 FROM learning_exclusions le WHERE le.conversationId = m.conversationId) THEN 1 ELSE 0 END AS sourceExcluded FROM memory_evidence e LEFT JOIN memories mem ON mem.id = e.memoryId LEFT JOIN messages m ON m.id = e.sourceMessageId WHERE ${where} ORDER BY e.recordedAt, e.id`);
  }

  private listLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_MEMORY_LIST_LIMIT;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_MEMORY_LIST_LIMIT) throw new Error('Invalid memory list limit.');
    return value;
  }

  private listOffset(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid memory list offset.');
    return value;
  }

  private requireRevision(value: unknown, name = 'memory revision'): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
    return value;
  }

  private validateInterval(validFrom: number | null, validUntil: number | null) {
    if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw new Error('Invalid validity interval.');
  }
}
