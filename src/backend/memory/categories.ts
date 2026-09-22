import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/** Derived routing metadata, not factual evidence or user-authored topics. */
export function installMemoryCategorySchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_routing_categories (
    memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    memoryRevision INTEGER NOT NULL,
    topicId TEXT NOT NULL,
    label TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('reviewer', 'local-rule')),
    PRIMARY KEY (memoryId, topicId)
  );
  CREATE INDEX IF NOT EXISTS memory_routing_categories_topic ON memory_routing_categories(topicId, memoryId);
  DROP TRIGGER IF EXISTS memory_category_revision;`);
  // Revision-bound joins invalidate old labels. Avoid write triggers: Bun's
  // affected-row count includes their writes and would break memory CAS checks.
}

export function normalizeMemoryTopics(value: unknown): string[] | undefined {
  if (value === undefined) return undefined; // Older persisted proposals remain compatible.
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('Memory topics must contain one to four labels.');
  const labels = value.map(item => {
    if (typeof item !== 'string' || /[\u0000-\u001f\u007f<>]/.test(item)) throw new Error('Invalid memory topic.');
    const label = item.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!label || label.length > 80 || /[\u0000-\u001f<>]/.test(label)) throw new Error('Invalid memory topic.');
    return label;
  });
  return [...new Set(labels)];
}

function topicId(label: string) {
  const hash = createHash('sha256').update(`moki-routing-topic:${label}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Deliberately broad local fallback, never presented as semantic AI classification. */
function localLabels(text: string, kind: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['personal identity', /\b(name|named|occupation|profession|developer|engineer|designer|student|teacher)\b/i],
    ['marketing and distribution', /\b(marketing|distribution|audience|engagement|advertising|promotion|followers)\b/i],
    ['software development', /\b(developer|programming|code|software|typescript|rust|repository)\b/i],
    ['travel', /\b(travel|trip|hotel|flight|vacation)\b/i],
  ];
  const labels = rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return labels.length ? labels.slice(0, 4) : [kind === 'preference' ? 'personal preferences' : kind === 'note' ? 'ongoing context' : 'personal facts and ongoing work'];
}

export function categorizeMemory(db: Database, memoryId: string, topics?: readonly string[]) {
  const row = db.query<{ text: string; kind: string; revision: number }, [string]>('SELECT text, kind, revision FROM memories WHERE id = ?').get(memoryId);
  if (!row) throw new Error('Memory not found.');
  const labels = normalizeMemoryTopics(topics) ?? localLabels(row.text, row.kind);
  db.transaction(() => {
    db.query('DELETE FROM memory_routing_categories WHERE memoryId = ?').run(memoryId);
    for (const label of labels) db.query('INSERT INTO memory_routing_categories (memoryId, memoryRevision, topicId, label, origin) VALUES (?, ?, ?, ?, ?)').run(memoryId, row.revision, topicId(label), label, topics ? 'reviewer' : 'local-rule');
  })();
}

/** Bounded local repair, no provider calls, no source text copied into descriptors. */
export function backfillMemoryCategories(db: Database, limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid category repair limit.');
  return db.transaction(() => {
    const rows = db.query<{ id: string }, [number]>(`SELECT m.id FROM memories m
      WHERE m.state = 'active' AND NOT EXISTS (SELECT 1 FROM memory_routing_categories c WHERE c.memoryId = m.id AND c.memoryRevision = m.revision)
      AND NOT EXISTS (SELECT 1 FROM memory_topics mt WHERE mt.memoryId = m.id)
      AND NOT EXISTS (SELECT 1 FROM memory_relationships r WHERE r.kind = 'about' AND r.subjectId = m.id AND r.subjectRevision = m.revision)
      ORDER BY m.core DESC, m.pinned DESC, m.recordedAt DESC, m.id LIMIT ?`).all(limit);
    for (const row of rows) categorizeMemory(db, row.id);
    return rows.length;
  })();
}
