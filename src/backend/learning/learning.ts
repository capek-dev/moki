import type { Database } from 'bun:sqlite';
import { categorizeMemory } from '@backend/memory/categories';
import {
  MemoryGraphRepository,
  type EntityKind,
  type RelationshipKind,
} from '@backend/memory/graph-repository';
import { assertSourceEvidenceAllowed, type MemoryKind } from '@backend/memory/repository';
import { describeError } from '@backend/core/error-description';
import {
  LEARNING_COOLDOWN_MS,
  LEARNING_IDLE_MS,
  LEARNING_INSPECTOR_OFFSET_MAX,
  LEARNING_INSPECTOR_PAGE_MAX,
  LEARNING_MAX_AUTOMATIC_ATTEMPTS,
  LEARNING_MAX_MESSAGES,
  LEARNING_MAX_PROPOSALS,
  LEARNING_MAX_SOURCE_CHARS,
  LEARNING_RUN_DETAIL_MAX_BYTES,
  LEARNING_SOURCE_EXCERPT_MAX,
  type LearningHistoryRecord,
  type LearningHistoryResource,
  type LearningProposal,
  type LearningProposalStatus,
  type LearningProvider,
  type LearningReviewContext,
  type LearningRunDetail,
  type LearningRunPage,
  type LearningRunSource,
  type LearningRunStatus,
  type LearningRunSummary,
  type LearningSettingsState,
  type LearningSource,
} from '@backend/learning/contracts';
import { normalizeLearningProposal } from '@backend/learning/proposal-validation';
import {
  bounded,
  choice,
  deterministicId,
  nonnegative,
  operationId,
  positive,
  proposalSource,
  requireUuid,
} from '@backend/learning/validation';
import { defaultModel, requireModel } from '@shared/models';

export * from '@backend/learning/contracts';
export { LearningCoordinator, type LearningSchedulerEvents } from '@backend/learning/coordinator';
export {
  LEARNING_REVIEW_INSTRUCTIONS,
  parseLearningResponse,
  reviewWithModel,
  validateLearningProviderModel,
} from '@backend/learning/reviewer';
export { installLearningSchema } from '@backend/learning/schema';

type SettingsRow = {
  enabled: number;
  paused: number;
  provider: LearningProvider;
  model: string;
  revision: number;
};
type ProposalRow = {
  id: string;
  runId: string;
  operationId: string;
  kind: string;
  payload: string;
  sourceMessageId: string;
  sourceRevision: number;
  sourceRole: string;
  status: LearningProposalStatus;
  rejection: string | null;
};
type MemoryRow = {
  id: string;
  text: string;
  kind: MemoryKind;
  state: string;
  pinned: number;
  core: number;
  recordedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  revision: number;
};

const PROVIDERS: readonly LearningProvider[] = ['deepseek', 'codex'];
const MAX_PROVENANCE = 400;

function decodeSettings(row: SettingsRow): LearningSettingsState {
  return {
    enabled: row.enabled === 1,
    paused: row.paused === 1,
    provider: row.provider,
    model: row.model,
    revision: row.revision,
  };
}

function requireLearningModel(provider: LearningProvider, model: string): string {
  requireModel(provider, model);
  return model || defaultModel(provider);
}


function boundedRecord(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (typeof item === 'string') result[key] = item.slice(0, 600);
      else if (typeof item === 'number' || typeof item === 'boolean' || item === null) result[key] = item;
    }
    return result;
  } catch { return null; }
}

/** Bound the complete serialized inspector detail, not only each section. */
function boundRunDetail(detail: LearningRunDetail): LearningRunDetail {
  const result: LearningRunDetail = { ...detail, sources: [...detail.sources], proposals: [...detail.proposals], changes: [...detail.changes] };
  const lists = [result.sources, result.proposals, result.changes] as Array<Array<unknown>>;
  while (Buffer.byteLength(JSON.stringify(result)) > LEARNING_RUN_DETAIL_MAX_BYTES) {
    const largest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    largest.splice(Math.ceil(largest.length / 2));
    result.truncated = true;
    if (lists.every((list) => list.length === 0)) break;
  }
  return result;
}

export class MemoryLearningRepository {
  constructor(private readonly db: Database, private readonly onMemoryMutation: () => void = () => {}) {}

  settings(): LearningSettingsState {
    const row = this.db.query<SettingsRow, []>('SELECT enabled, paused, provider, model, revision FROM learning_settings WHERE id = 0').get();
    if (!row) throw new Error('Learning settings are unavailable.');
    return decodeSettings(row);
  }

  setEnabled(enabled: boolean, expectedRevision: number, now = Date.now()): LearningSettingsState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid learning enabled setting.');
    const expected = positive(expectedRevision, 'learning settings revision');
    this.db.transaction(() => {
      const current = this.settings();
      if (current.revision !== expected) throw new Error('Learning settings revision conflict.');
      if (enabled && !current.enabled) {
        const max = this.db.query<{ max: number | null }, []>('SELECT COALESCE(MAX(rowid), 0) AS max FROM messages').get()!.max ?? 0;
        this.db.query('UPDATE learning_cursor SET nextRowid = ?, activatedAt = ? WHERE id = 0').run(max, now);
      }
      this.db.query('UPDATE learning_settings SET enabled = ?, paused = CASE WHEN ? = 0 THEN 0 ELSE paused END, revision = revision + 1 WHERE id = 0 AND revision = ?').run(enabled ? 1 : 0, enabled ? 1 : 0, expected);
      if (!enabled) this.cancelOpenRuns(now);
    })();
    return this.settings();
  }

  setPaused(paused: boolean, expectedRevision: number): LearningSettingsState {
    if (typeof paused !== 'boolean') throw new Error('Invalid learning pause setting.');
    const expected = positive(expectedRevision, 'learning settings revision');
    const result = this.db.query('UPDATE learning_settings SET paused = ?, revision = revision + 1 WHERE id = 0 AND revision = ?').run(paused ? 1 : 0, expected);
    if (result.changes !== 1) throw new Error('Learning settings revision conflict.');
    if (paused) this.cancelAll();
    return this.settings();
  }

  setProviderModel(provider: LearningProvider, model: string, expectedRevision: number): LearningSettingsState {
    const selectedProvider = choice(provider, PROVIDERS, 'learning provider');
    const selectedModel = requireLearningModel(selectedProvider, bounded(model, 'learning model', 120));
    const expected = positive(expectedRevision, 'learning settings revision');
    const result = this.db.query('UPDATE learning_settings SET provider = ?, model = ?, revision = revision + 1 WHERE id = 0 AND revision = ?').run(selectedProvider, selectedModel, expected);
    if (result.changes !== 1) throw new Error('Learning settings revision conflict.');
    this.cancelAll();
    return this.settings();
  }

  exclusions(): string[] { return this.db.query<{ conversationId: string }, []>('SELECT conversationId FROM learning_exclusions ORDER BY conversationId').all().map((row) => row.conversationId); }

  canSchedule(): boolean {
    const row = this.db.query<{ learning: number; paused: number; memory: number }, []>("SELECT l.enabled AS learning, l.paused, m.enabled AS memory FROM learning_settings l JOIN memory_settings m ON m.id = 0 WHERE l.id = 0").get();
    return !!row && row.learning === 1 && row.paused === 0 && row.memory === 1;
  }

  /**
   * Cancel open runs. Pending runs were never claimed, so they become
   * terminal cancelled rows. A running review is flagged and aborted by the
   * coordinator; its commit checks then fail.
   */
  private cancelOpenRuns(now: number) {
    this.db.query("UPDATE learning_runs SET status = 'cancelled', cancelRequested = 1, completedAt = COALESCE(completedAt, ?) WHERE status = 'pending'").run(now);
    this.db.query("UPDATE learning_runs SET cancelRequested = 1 WHERE status = 'running'").run();
  }
  cancelAll(now = Date.now()) { this.db.transaction(() => this.cancelOpenRuns(now))(); }

  setExcluded(conversationId: string, excluded: boolean, now = Date.now()): { conversationId: string; excluded: boolean; revision: number } {
    const id = bounded(conversationId, 'conversation id', 100);
    let revision = 1;
    this.db.transaction(() => {
      const current = this.db.query<{ revision: number }, [string]>('SELECT revision FROM learning_exclusions WHERE conversationId = ?').get(id);
      if (excluded) {
        revision = (current?.revision ?? 0) + 1;
        this.db.query('INSERT INTO learning_exclusions (conversationId, revision, excludedAt) VALUES (?, ?, ?) ON CONFLICT(conversationId) DO UPDATE SET revision = excluded.revision, excludedAt = excluded.excludedAt').run(id, revision, now);
        this.db.query("UPDATE learning_proposals SET status = 'suppressed', rejection = 'conversation excluded' WHERE status = 'pending' AND sourceMessageId IN (SELECT id FROM messages WHERE conversationId = ?)").run(id);
      } else if (current) {
        revision = current.revision + 1;
        this.db.query('DELETE FROM learning_exclusions WHERE conversationId = ?').run(id);
      } else revision = 1;
    })();
    return { conversationId: id, excluded, revision };
  }

  isExcluded(conversationId: string): boolean { return !!this.db.query('SELECT 1 FROM learning_exclusions WHERE conversationId = ?').get(conversationId); }

  noteActivity(now = Date.now()) {
    this.db.query('UPDATE learning_settings SET pendingSince = COALESCE(pendingSince, ?), idleUntil = ? WHERE id = 0').run(now, now + LEARNING_IDLE_MS);
  }

  scheduleTiming(now = Date.now()): { idleUntil: number; cooldownUntil: number; pendingSince: number } {
    const row = this.db.query<{
      idleUntil: number | null;
      cooldownUntil: number | null;
      pendingSince: number | null;
    }, []>('SELECT idleUntil, cooldownUntil, pendingSince FROM learning_settings WHERE id = 0').get()!;
    const pendingSince = row.pendingSince ?? now;
    const idleUntil = row.idleUntil ?? now + LEARNING_IDLE_MS;
    const cooldownUntil = row.cooldownUntil ?? 0;
    if (row.pendingSince === null || row.idleUntil === null) {
      this.db.query('UPDATE learning_settings SET pendingSince = ?, idleUntil = ? WHERE id = 0').run(pendingSince, idleUntil);
    }
    return { idleUntil, cooldownUntil, pendingSince };
  }

  sourceBatch(afterRowid: number, limit = LEARNING_MAX_MESSAGES, maxChars = LEARNING_MAX_SOURCE_CHARS): LearningSource[] {
    const start = nonnegative(afterRowid, 'source cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEARNING_MAX_MESSAGES) throw new Error('Invalid learning batch limit.');
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > LEARNING_MAX_SOURCE_CHARS) throw new Error('Invalid learning batch size.');
    type SourceBatchRow = LearningSource & { status: string; toolCalls: string | null };
    // Include streaming rows as barriers. If a later completed row is selected
    // before the barrier, advancing past it would permanently lose the delayed
    // publication when the cursor is committed.
    const rows = this.db.query<SourceBatchRow, [number, number]>(`
      SELECT m.rowid, m.id, m.conversationId, m.role, m.text, m.revision, m.createdAt, m.status, m.toolCalls
      FROM messages m
      LEFT JOIN learning_exclusions e ON e.conversationId = m.conversationId
      WHERE m.rowid > ? AND m.role IN ('user', 'assistant') AND e.conversationId IS NULL
        AND (m.status = 'streaming' OR (m.status = 'complete' AND m.text <> '' AND (m.toolCalls IS NULL OR m.toolCalls = '[]')))
      ORDER BY m.rowid LIMIT ?`).all(start, limit + 1);
    const result: LearningSource[] = [];
    let chars = 0;
    for (const row of rows) {
      if (row.status === 'streaming') break;
      if (result.length >= limit) break;
      const remaining = maxChars - chars;
      if (remaining <= 0) break;
      const text = row.text.slice(0, remaining);
      if (!text) break;
      result.push({ ...row, text, role: row.role === 'user' ? 'user' : 'assistant' });
      chars += text.length;
      if (text.length < row.text.length) break;
    }
    return result;
  }

  /**
   * The bounded chronological batch for the current cursor plus the run that
   * owns that cursor start. A pending or running run wins so an explicit
   * retry whose captured range grew is still the run that dispatches.
   */
  schedulableBatch(): { cursor: number; run: LearningRunSummary | null; sources: LearningSource[] } | null {
    const cursor = this.db.query<{ nextRowid: number }, []>('SELECT nextRowid FROM learning_cursor WHERE id = 0').get()!.nextRowid;
    const sources = this.sourceBatch(cursor);
    if (!sources.length) return null;
    const existing = this.db.query<{ id: string }, [number]>(`SELECT id FROM learning_runs WHERE cursorStart = ? ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END, createdAt DESC, id DESC LIMIT 1`).get(cursor);
    return { cursor, run: existing ? this.getRun(existing.id) : null, sources };
  }

  beginRun(now = Date.now()): { run: LearningRunSummary; sources: LearningSource[] } | null {
    if (!this.canSchedule()) return null;
    const range = this.schedulableBatch();
    if (!range) return null;
    const settings = this.settings();
    const { cursor, sources } = range;
    const end = sources[sources.length - 1].rowid;
    const key = `${cursor}:${end}`;
    let id: string;
    const existing = range.run;
    if (existing) {
      // Only the bounded automatic retry resets a failed range. A pending
      // dispatch, running review, cancelled range, or exhausted range waits
      // for an explicit retry instead of spinning.
      if (existing.status !== 'failed' || existing.attempt >= LEARNING_MAX_AUTOMATIC_ATTEMPTS) return null;
      id = existing.id;
      // Refresh the content-free manifest so retry input matches the exact
      // revisions this attempt reviews.
      this.db.transaction(() => {
        this.db.query('DELETE FROM learning_run_sources WHERE runId = ?').run(id);
        for (const source of sources) this.db.query('INSERT INTO learning_run_sources (runId, messageId, capturedRevision, role, capturedAt, excerptLength) VALUES (?, ?, ?, ?, ?, ?)').run(id, source.id, source.revision, source.role, now, source.text.length);
        this.db.query("UPDATE learning_runs SET status = 'pending', cancelRequested = 0, attempt = attempt + 1, completedAt = NULL, cursorEnd = ?, provider = ?, model = ?, manifestOrigin = 'captured' WHERE id = ?").run(end, settings.provider, settings.model, id);
      })();
    } else {
      id = crypto.randomUUID();
      this.db.transaction(() => {
        this.db.query('INSERT INTO learning_runs (id, operationKey, status, cursorStart, cursorEnd, attempt, provider, model, createdAt, manifestOrigin) VALUES (?, ?, \'pending\', ?, ?, 1, ?, ?, ?, \'captured\')').run(id, key, cursor, end, settings.provider, settings.model, now);
        for (const source of sources) this.db.query('INSERT INTO learning_run_sources (runId, messageId, capturedRevision, role, capturedAt, excerptLength) VALUES (?, ?, ?, ?, ?, ?)').run(id, source.id, source.revision, source.role, now, source.text.length);
      })();
    }
    const run = this.getRun(id);
    if (!run || run.status !== 'pending') return null;
    return { run, sources };
  }

  /** Current records are context, not a historical snapshot. Keep this bounded. */
  reviewContext(): LearningReviewContext {
    return {
      routingLabels: new MemoryGraphRepository(this.db, false).listRoutingDescriptors({ limit: 40 }).map(item => item.label),
      memories: this.db.query<{ id: string; revision: number; kind: MemoryKind; text: string }, []>('SELECT id, revision, kind, text FROM memories ORDER BY recordedAt DESC, id LIMIT 40').all().map((row) => ({ ...row, text: row.text.slice(0, 600) })),
      topics: this.db.query<{ id: string; revision: number; label: string }, []>('SELECT id, revision, label FROM topics ORDER BY recordedAt DESC, id LIMIT 40').all(),
      entities: this.db.query<{ id: string; revision: number; kind: EntityKind; label: string }, []>('SELECT id, revision, kind, label FROM entities ORDER BY recordedAt DESC, id LIMIT 40').all(),
    };
  }

  /**
   * Retry input is the captured manifest only: chronological by source row,
   * bounded to the recorded per-source excerpt and the total batch budget.
   * A changed or deleted source fails clearly instead of being silently
   * skipped or replaced with modified text.
   */
  reviewSourcesForRun(runId: string): LearningSource[] {
    const id = requireUuid(runId, 'learning run id');
    const manifest = this.db.query<{ messageId: string; capturedRevision: number; role: 'user' | 'assistant'; excerptLength: number }, [string, number]>(`
      SELECT s.messageId, s.capturedRevision, s.role, s.excerptLength
      FROM learning_run_sources s JOIN messages m ON m.id = s.messageId
      WHERE s.runId = ? ORDER BY m.rowid LIMIT ?`).all(id, LEARNING_MAX_MESSAGES);
    if (!manifest.length) throw new Error('Learning source manifest is unavailable. Retry to capture the current sources again.');
    const sources: LearningSource[] = [];
    let remaining = LEARNING_MAX_SOURCE_CHARS;
    for (const item of manifest) {
      const source = this.db.query<LearningSource & { status: string; toolCalls: string | null }, [string]>('SELECT rowid, id, conversationId, role, text, revision, createdAt, status, toolCalls FROM messages WHERE id = ?').get(item.messageId);
      if (!source || source.status !== 'complete' || source.role !== item.role || source.revision !== item.capturedRevision) throw new Error('Learning source changed or was deleted. Retry to capture the current sources again.');
      const limit = Math.min(item.excerptLength, remaining);
      if (limit <= 0) break;
      const text = source.text.slice(0, limit);
      if (!text) break;
      sources.push({ rowid: source.rowid, id: source.id, conversationId: source.conversationId, role: source.role, text, revision: source.revision, createdAt: source.createdAt });
      remaining -= text.length;
    }
    if (!sources.length) throw new Error('Learning source excerpts are empty. Retry to capture the current sources again.');
    return sources;
  }

  /** Inspector text is always current text, never a stored historical snapshot. */
  sourcesForRun(runId: string): LearningRunSource[] {
    const id = requireUuid(runId, 'learning run id');
    const manifest = this.db.query<{ messageId: string; capturedRevision: number; role: 'user' | 'assistant'; currentRevision: number | null; currentText: string | null }, [string, number]>(`
      SELECT s.messageId, s.capturedRevision, s.role, m.revision AS currentRevision, m.text AS currentText
      FROM learning_run_sources s LEFT JOIN messages m ON m.id = s.messageId
      WHERE s.runId = ? ORDER BY m.rowid IS NULL, m.rowid, s.messageId LIMIT ?`).all(id, LEARNING_MAX_MESSAGES);
    if (manifest.length) return manifest.map((row) => ({ messageId: row.messageId, capturedRevision: row.capturedRevision, role: row.role, state: row.currentRevision === null ? 'deleted' : row.currentRevision === row.capturedRevision ? 'current' : 'changed', currentRevision: row.currentRevision, currentText: row.currentText === null ? null : row.currentText.slice(0, LEARNING_SOURCE_EXCERPT_MAX), currentTextIsHistoricalSnapshot: false }));
    const run = this.db.query<{ cursorStart: number; cursorEnd: number }, [string]>('SELECT cursorStart, cursorEnd FROM learning_runs WHERE id = ?').get(id);
    if (!run) throw new Error('Learning run not found.');
    return this.db.query<{ id: string; revision: number; role: 'user' | 'assistant'; text: string }, [number, number, number]>(`SELECT id, revision, role, text FROM messages WHERE rowid > ? AND rowid <= ? AND role IN ('user', 'assistant') ORDER BY rowid LIMIT ?`).all(run.cursorStart, run.cursorEnd, LEARNING_MAX_MESSAGES).map((current) => ({ messageId: current.id, capturedRevision: null, role: current.role, state: 'legacy_unknown', currentRevision: current.revision, currentText: current.text.slice(0, LEARNING_SOURCE_EXCERPT_MAX), currentTextIsHistoricalSnapshot: false }));
  }

  /**
   * Explicit user retry, idempotent while a retry is already open. A valid
   * captured manifest is reused (its historical input is unchanged).
   * Otherwise the manifest is recaptured from the current completed sources
   * at this request and marked recaptured, so stale text is never reviewed
   * as if it were the original input.
   */
  retryRun(runId: string, now = Date.now()): LearningRunSummary {
    const id = requireUuid(runId, 'learning run id');
    const current = this.getRun(id);
    if (!current) throw new Error('Learning run not found.');
    if (current.status === 'pending' || current.status === 'running') return current;
    if (current.status !== 'failed' && current.status !== 'cancelled') throw new Error('Only a failed or cancelled learning run can be retried.');
    if (!this.canSchedule()) throw new Error('Learning is disabled or paused.');
    const settings = this.settings();
    let cursorEnd = current.cursorEnd;
    let manifestOrigin: 'captured' | 'recaptured' = current.sourceManifest === 'recaptured' ? 'recaptured' : 'captured';
    if (!this.manifestMatchesLiveSources(id)) {
      const row = this.db.query<{ cursorStart: number }, [string]>('SELECT cursorStart FROM learning_runs WHERE id = ?').get(id)!;
      const sources = this.sourceBatch(row.cursorStart);
      if (!sources.length) throw new Error('No completed sources are available to review. Learning will wait for new activity.');
      cursorEnd = sources[sources.length - 1].rowid;
      manifestOrigin = 'recaptured';
      this.db.transaction(() => {
        this.db.query('DELETE FROM learning_run_sources WHERE runId = ?').run(id);
        for (const source of sources) this.db.query('INSERT INTO learning_run_sources (runId, messageId, capturedRevision, role, capturedAt, excerptLength) VALUES (?, ?, ?, ?, ?, ?)').run(id, source.id, source.revision, source.role, now, source.text.length);
      })();
    }
    this.db.transaction(() => {
      this.db.query("UPDATE learning_runs SET status = 'pending', cancelRequested = 0, attempt = attempt + 1, completedAt = NULL, cursorEnd = ?, provider = ?, model = ?, manifestOrigin = ? WHERE id = ?").run(cursorEnd, settings.provider, settings.model, manifestOrigin, id);
      this.db.query('UPDATE learning_settings SET pendingSince = ?, idleUntil = ?, cooldownUntil = MIN(COALESCE(cooldownUntil, 0), ?) WHERE id = 0').run(now, now, now);
    })();
    return this.getRun(id)!;
  }

  private manifestMatchesLiveSources(runId: string): boolean {
    const rows = this.db.query<{ recordedRole: string; capturedRevision: number; liveRole: string | null; revision: number | null; status: string | null }, [string]>(`
      SELECT s.role AS recordedRole, s.capturedRevision, m.role AS liveRole, m.revision, m.status
      FROM learning_run_sources s LEFT JOIN messages m ON m.id = s.messageId WHERE s.runId = ?`).all(runId);
    return rows.length > 0 && rows.every((row) => row.liveRole === row.recordedRole && row.revision === row.capturedRevision && row.status === 'complete');
  }

  claimRun(runId: string, now = Date.now()): LearningRunSummary {
    const id = requireUuid(runId, 'learning run id');
    const result = this.db.query("UPDATE learning_runs SET status = 'running', startedAt = COALESCE(startedAt, ?) WHERE id = ? AND status = 'pending' AND cancelRequested = 0").run(now, id);
    if (result.changes !== 1) throw new Error('Learning run is no longer available.');
    return this.getRun(id)!;
  }

  cancelRun(runId?: string, now = Date.now()) {
    if (runId === undefined) { this.cancelAll(now); return; }
    const id = requireUuid(runId, 'learning run id');
    this.db.transaction(() => {
      this.db.query("UPDATE learning_runs SET status = 'cancelled', cancelRequested = 1, completedAt = COALESCE(completedAt, ?) WHERE id = ? AND status = 'pending'").run(now, id);
      this.db.query("UPDATE learning_runs SET cancelRequested = 1 WHERE id = ? AND status = 'running'").run(id);
    })();
  }

  /**
   * Startup recovery. A run left open by a previous process can never be
   * resumed, so it becomes a visible terminal failure. The previous error
   * text is preserved, the cursor is not advanced, and no source row is
   * skipped. The cooldown prevents an immediate restart retry loop.
   */
  recoverInterrupted(now = Date.now()) {
    this.db.transaction(() => {
      const recovered = this.db.query(`UPDATE learning_runs SET status = 'failed', cancelRequested = 0, completedAt = COALESCE(completedAt, ?),
        error = COALESCE(error, 'Learning review was interrupted by an app restart. Use Retry to review the current sources again.')
        WHERE status IN ('pending', 'running')`).run(now);
      if (recovered.changes > 0) this.db.query('UPDATE learning_settings SET cooldownUntil = MAX(COALESCE(cooldownUntil, 0), ?) WHERE id = 0').run(now + LEARNING_COOLDOWN_MS);
    })();
  }

  runConfiguration(runId: string): { provider: LearningProvider; model: string } {
    const id = requireUuid(runId, 'learning run id');
    const row = this.db.query<{ provider: LearningProvider; model: string }, [string]>('SELECT provider, model FROM learning_runs WHERE id = ?').get(id);
    if (!row) throw new Error('Learning run not found.');
    requireLearningModel(row.provider, row.model);
    return row;
  }

  runCanCommit(runId: string): boolean {
    const row = this.db.query<{ enabled: number; paused: number; memoryEnabled: number; cancelRequested: number; status: string; provider: LearningProvider; model: string }, [string]>(`SELECT s.enabled, s.paused, m.enabled AS memoryEnabled, r.cancelRequested, r.status, r.provider, r.model FROM learning_settings s JOIN learning_runs r ON r.id = ? JOIN memory_settings m ON m.id = 0 WHERE s.id = 0`).get(runId);
    const settings = this.settings();
    return !!row && row.enabled === 1 && row.paused === 0 && row.memoryEnabled === 1 && row.cancelRequested === 0 && row.status === 'running' && row.provider === settings.provider && row.model === settings.model;
  }

  saveProposals(runId: string, proposals: readonly LearningProposal[], rejections?: ReadonlyMap<number, string>) {
    const id = requireUuid(runId, 'learning run id');
    if (proposals.length > LEARNING_MAX_PROPOSALS) throw new Error('Learning proposal limit exceeded.');
    if (!this.runCanCommit(id)) throw new Error('Learning run was cancelled or disabled.');
    this.db.transaction(() => {
      if (!this.runCanCommit(id)) throw new Error('Learning run was cancelled or disabled.');
      for (const [index, proposal] of proposals.entries()) {
        const normalized = normalizeLearningProposal(proposal);
        const source = proposalSource(normalized);
        const op = operationId(normalized);
        const proposalId = normalized.kind === 'memory' && normalized.action === 'add' ? deterministicId(op) : crypto.randomUUID();
        // A Jev source-support verdict arrives as a terminal rejection before apply.
        const rejection = rejections?.get(index);
        this.db.query('INSERT OR IGNORE INTO learning_proposals (id, runId, operationId, kind, payload, sourceMessageId, sourceRevision, sourceRole, status, rejection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(proposalId, id, op, normalized.kind, JSON.stringify(normalized), source.sourceMessageId, source.sourceRevision, source.sourceRole, rejection === undefined ? 'pending' : 'rejected', rejection === undefined ? null : rejection.slice(0, 240));
      }
    })();
  }

  proposalsForRun(runId: string): Array<LearningProposal & { proposalId: string; operationId: string; status: LearningProposalStatus; rejection: string | null }> {
    const rows = this.db.query<ProposalRow, [string]>('SELECT * FROM learning_proposals WHERE runId = ? ORDER BY id').all(requireUuid(runId, 'learning run id'));
    return rows.map((row) => ({ ...(JSON.parse(row.payload) as LearningProposal), proposalId: row.id, operationId: row.operationId, status: row.status, rejection: row.rejection }));
  }

  applyRun(runId: string, now = Date.now(), signal?: AbortSignal): LearningRunSummary {
    const id = requireUuid(runId, 'learning run id');
    if (signal?.aborted || !this.runCanCommit(id)) throw new Error('Learning run was cancelled or disabled.');
    let touchedMemory = false;
    this.db.transaction(() => {
      if (!this.runCanCommit(id)) throw new Error('Learning run was cancelled or disabled.');
      const run = this.db.query<{ cursorEnd: number }, [string]>('SELECT cursorEnd FROM learning_runs WHERE id = ?').get(id);
      if (!run) throw new Error('Learning run not found.');
      const proposals = this.proposalsForRun(id);
      for (const proposal of proposals) {
        // Pre-rejected proposals (Jev source check) are final for this run.
        if (proposal.status !== 'pending') continue;
        if (signal?.aborted || !this.runCanCommit(id)) throw new Error('Learning run was cancelled or disabled.');
        this.db.exec('SAVEPOINT learning_proposal');
        try {
          this.applyProposal(id, proposal, now);
          this.db.query("UPDATE learning_proposals SET status = 'applied', rejection = NULL WHERE id = ?").run(proposal.proposalId);
          this.db.exec('RELEASE SAVEPOINT learning_proposal');
          touchedMemory = true;
        } catch (error) {
          this.db.exec('ROLLBACK TO SAVEPOINT learning_proposal');
          this.db.exec('RELEASE SAVEPOINT learning_proposal');
          if (signal?.aborted || !this.runCanCommit(id)) throw error;
          const message = error instanceof Error ? error.message : 'Proposal rejected.';
          const status: LearningProposalStatus = message.includes('forgotten') || message.includes('excluded') ? 'suppressed' : message.includes('revision') || message.includes('source') ? 'stale' : 'rejected';
          this.db.query('UPDATE learning_proposals SET status = ?, rejection = ? WHERE id = ?').run(status, message.slice(0, 240), proposal.proposalId);
        }
      }
      this.db.query("UPDATE learning_runs SET status = 'complete', completedAt = ?, error = NULL WHERE id = ?").run(now, id);
      this.db.query('UPDATE learning_cursor SET nextRowid = MAX(nextRowid, (SELECT cursorEnd FROM learning_runs WHERE id = ?)) WHERE id = 0').run(id);
      this.db.query('UPDATE learning_settings SET idleUntil = NULL, pendingSince = NULL, cooldownUntil = ? WHERE id = 0').run(now + LEARNING_COOLDOWN_MS);
    })();
    if (touchedMemory) this.onMemoryMutation();
    return this.getRun(id)!;
  }

  failRun(runId: string, error: unknown, cancelled = false, now = Date.now(), bumpAttempt = false) {
    const id = requireUuid(runId, 'learning run id');
    const raw = error instanceof Error ? error.message : describeError(error);
    const message = /secret|token|api.?key|authorization|credential/i.test(raw) ? 'Learning provider request failed.' : raw.replace(/[\r\n]+/g, ' ').slice(0, 500) || 'Learning review failed.';
    this.db.transaction(() => {
      this.db.query('UPDATE learning_runs SET status = ?, error = ?, completedAt = ?, attempt = attempt + ? WHERE id = ? AND status IN (\'pending\', \'running\')').run(cancelled ? 'cancelled' : 'failed', message, now, bumpAttempt ? 1 : 0, id);
      this.db.query('UPDATE learning_settings SET cooldownUntil = ? WHERE id = 0').run(now + LEARNING_COOLDOWN_MS);
    })();
  }

  getRun(runId: string): LearningRunSummary | null {
    const id = requireUuid(runId, 'learning run id');
    const row = this.db.query<{ id: string; status: LearningRunStatus; cursorStart: number; cursorEnd: number; attempt: number; cancelRequested: number; provider: LearningProvider; model: string; manifestOrigin: 'unavailable' | 'captured' | 'recaptured'; error: string | null; createdAt: number; startedAt: number | null; completedAt: number | null; proposalCount: number; appliedCount: number; rejectedCount: number }, [string]>(`SELECT r.id, r.status, r.cursorStart, r.cursorEnd, r.attempt, r.cancelRequested, r.provider, r.model, r.manifestOrigin, r.error, r.createdAt, r.startedAt, r.completedAt, COUNT(p.id) AS proposalCount, COALESCE(SUM(p.status = 'applied'), 0) AS appliedCount, COALESCE(SUM(p.status IN ('rejected', 'suppressed', 'stale')), 0) AS rejectedCount FROM learning_runs r LEFT JOIN learning_proposals p ON p.runId = r.id WHERE r.id = ? GROUP BY r.id`).get(id);
    if (!row) return null;
    const { cancelRequested, manifestOrigin, ...rest } = row;
    return { ...rest, cancelRequested: cancelRequested === 1, sourceManifest: manifestOrigin, outcome: row.status === 'failed' ? 'failed' : row.status === 'cancelled' ? 'cancelled' : row.status === 'pending' || row.status === 'running' ? 'pending' : row.appliedCount > 0 ? 'changes' : 'no_changes' };
  }

  listRuns(limit = 25, offset = 0): LearningRunPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEARNING_INSPECTOR_PAGE_MAX || !Number.isSafeInteger(offset) || offset < 0 || offset > LEARNING_INSPECTOR_OFFSET_MAX) throw new Error('Invalid learning run page.');
    const ids = this.db.query<{ id: string }, [number, number]>('SELECT id FROM learning_runs ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?').all(limit + 1, offset);
    const runs = ids.slice(0, limit).map((row) => this.getRun(row.id)!).filter(Boolean);
    return { runs, offset, nextOffset: ids.length > limit ? offset + limit : null };
  }

  runDetail(runId: string, limit = 20): LearningRunDetail {
    const id = requireUuid(runId, 'learning run id');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEARNING_INSPECTOR_PAGE_MAX) throw new Error('Invalid learning run detail limit.');
    const run = this.getRun(id);
    if (!run) throw new Error('Learning run not found.');
    const rows = this.db.query<ProposalRow, [string, number]>('SELECT * FROM learning_proposals WHERE runId = ? ORDER BY id LIMIT ?').all(id, limit);
    const proposals = rows.map((row) => {
      const proposal = JSON.parse(row.payload) as Record<string, unknown>;
      const summary = Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'text' && key !== 'description' && key !== 'provenance'));
      if (typeof proposal.text === 'string') summary.text = proposal.text.slice(0, 600);
      return { proposalId: row.id, operationId: row.operationId, kind: row.kind as LearningProposal['kind'], status: row.status, rejection: row.rejection, sourceMessageId: row.sourceMessageId, sourceRevision: row.sourceRevision, summary };
    });
    return boundRunDetail({ run, sources: this.sourcesForRun(id), proposals, changes: this.historyForRun(id, limit), truncated: false });
  }

  private historyForRun(runId: string, limit: number): LearningRunDetail['changes'] {
    return this.db.query<{ id: string; resourceType: LearningHistoryResource; resourceId: string | null; action: 'add' | 'correct'; memoryId: string; beforeJson: string | null; afterJson: string; afterRevision: number; createdAt: number; undoneAt: number | null }, [string, number]>('SELECT id, resourceType, resourceId, action, memoryId, beforeJson, afterJson, afterRevision, createdAt, undoneAt FROM learning_history WHERE runId = ? ORDER BY createdAt, id LIMIT ?').all(runId, limit).map((row) => ({ id: row.id, resourceType: row.resourceType, resourceId: row.resourceId ?? row.memoryId, action: row.action, before: boundedRecord(row.beforeJson), after: boundedRecord(row.afterJson) ?? {}, afterRevision: row.afterRevision, createdAt: row.createdAt, undoneAt: row.undoneAt }));
  }

  history(limit = 50, offset = 0): LearningHistoryRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid learning history bounds.');
    type HistoryRow = { id: string; runId: string; operationId: string; resourceType: LearningHistoryResource; resourceId: string | null; action: 'add' | 'correct'; memoryId: string; beforeJson: string | null; afterJson: string; afterRevision: number; createdAt: number; undoneAt: number | null };
    return this.db.query<HistoryRow, [number, number]>('SELECT id, runId, operationId, resourceType, resourceId, action, memoryId, beforeJson, afterJson, afterRevision, createdAt, undoneAt FROM learning_history ORDER BY createdAt DESC, id LIMIT ? OFFSET ?').all(limit, offset).map((row) => ({ id: row.id, runId: row.runId, operationId: row.operationId, resourceType: row.resourceType, resourceId: row.resourceId ?? row.memoryId, action: row.action, memoryId: row.memoryId, before: row.beforeJson ? JSON.parse(row.beforeJson) as Record<string, unknown> : null, after: JSON.parse(row.afterJson) as Record<string, unknown>, afterRevision: row.afterRevision, createdAt: row.createdAt, undoneAt: row.undoneAt }));
  }

  undoHistory(historyId: string, expectedRevision: number, now = Date.now()): { id: string; memoryId: string; undone: boolean; revision: number } {
    const id = requireUuid(historyId, 'learning history id');
    const expected = positive(expectedRevision, 'resource revision');
    let result: { id: string; memoryId: string; undone: boolean; revision: number } | null = null;
    this.db.transaction(() => {
      const history = this.db.query<{ id: string; memoryId: string; resourceType: LearningHistoryResource; resourceId: string | null; action: 'add' | 'correct'; beforeJson: string | null; afterJson: string; afterRevision: number; undoneAt: number | null }, [string]>('SELECT id, memoryId, resourceType, resourceId, action, beforeJson, afterJson, afterRevision, undoneAt FROM learning_history WHERE id = ?').get(id);
      if (!history) throw new Error('Learning history entry not found.');
      if (history.undoneAt !== null) { result = { id, memoryId: history.memoryId, undone: true, revision: expected }; return; }
      const resourceId = history.resourceId ?? history.memoryId;
      if (history.resourceType === 'memory') {
        const current = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(resourceId);
        if (!current || current.revision !== expected || current.revision !== history.afterRevision) throw new Error('Learning history revision conflict.');
        if (history.action === 'add') {
          const evidenceCount = this.db.query<{ count: number }, [string, number]>("SELECT count(*) AS count FROM memory_evidence WHERE memoryId = ? AND memoryRevision = ?").get(current.id, current.revision)!.count;
          const dependencyCount = this.db.query<{ count: number }, [string, string]>("SELECT count(*) AS count FROM memory_relationships WHERE subjectId = ? OR objectId = ?").get(current.id, current.id)!.count;
          if (evidenceCount > 1 || dependencyCount > 0) throw new Error('Learning history revision conflict.');
          this.db.query('DELETE FROM memories WHERE id = ? AND revision = ?').run(current.id, current.revision);
          result = { id, memoryId: current.id, undone: false, revision: 0 };
        } else {
          const before = JSON.parse(history.beforeJson ?? '{}') as MemoryRow;
          const laterEvidence = this.db.query<{ count: number }, [string, number]>(
            'SELECT count(*) AS count FROM memory_evidence WHERE memoryId = ? AND memoryRevision = ?',
          ).get(current.id, current.revision)!.count;
          if (laterEvidence > 0) throw new Error('Learning history revision conflict.');
          const changed = this.db.query('UPDATE memories SET text = ?, kind = ?, state = ?, pinned = ?, core = ?, validFrom = ?, validUntil = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(before.text, before.kind, before.state, before.pinned, before.core, before.validFrom, before.validUntil, current.id, current.revision);
          if (changed.changes !== 1) throw new Error('Learning history revision conflict.');
          result = { id, memoryId: current.id, undone: false, revision: current.revision + 1 };
        }
      } else if (history.resourceType === 'topic') {
        const current = this.db.query<{ revision: number }, [string]>('SELECT revision FROM topics WHERE id = ?').get(resourceId);
        const after = JSON.parse(history.afterJson) as { membership?: Array<{ memoryId: string; topicId: string }> };
        const membership = after.membership ?? [];
        const dependencyCount = this.db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM memory_topics WHERE topicId = ?').get(resourceId)!.count;
        if (!current || current.revision !== expected || current.revision !== history.afterRevision || dependencyCount !== membership.length) throw new Error('Learning history revision conflict.');
        for (const item of membership) if (!this.db.query('SELECT 1 FROM memory_topics WHERE memoryId = ? AND topicId = ?').get(item.memoryId, item.topicId)) throw new Error('Learning history revision conflict.');
        this.db.query('DELETE FROM memory_topics WHERE topicId = ?').run(resourceId);
        this.db.query('DELETE FROM topics WHERE id = ? AND revision = ?').run(resourceId, expected);
        result = { id, memoryId: resourceId, undone: false, revision: 0 };
      } else if (history.resourceType === 'entity') {
        const current = this.db.query<{ revision: number }, [string]>('SELECT revision FROM entities WHERE id = ?').get(resourceId);
        const dependencyCount = this.db.query<{ count: number }, [string, string]>('SELECT count(*) AS count FROM memory_relationships WHERE subjectId = ? OR objectId = ?').get(resourceId, resourceId)!.count;
        if (!current || current.revision !== expected || current.revision !== history.afterRevision || dependencyCount > 0) throw new Error('Learning history revision conflict.');
        this.db.query('DELETE FROM entities WHERE id = ? AND revision = ?').run(resourceId, expected);
        result = { id, memoryId: resourceId, undone: false, revision: 0 };
      } else {
        const current = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memory_relationships WHERE id = ?').get(resourceId);
        if (!current || current.revision !== expected || current.revision !== history.afterRevision) throw new Error('Learning history revision conflict.');
        this.db.query('DELETE FROM memory_relationships WHERE id = ? AND revision = ?').run(resourceId, expected);
        result = { id, memoryId: resourceId, undone: false, revision: 0 };
      }
      this.db.query('UPDATE learning_history SET undoneAt = ? WHERE id = ?').run(now, id);
    })();
    this.onMemoryMutation();
    return result!;
  }

  private applyProposal(runId: string, proposal: LearningProposal & { proposalId: string; operationId: string }, now: number) {
    const source = this.db.query<{ conversationId: string; revision: number; role: string; status: string }, [string]>('SELECT conversationId, revision, role, status FROM messages WHERE id = ?').get(proposal.sourceMessageId);
    if (!source || source.status !== 'complete' || source.role !== 'user' || source.revision !== proposal.sourceRevision) throw new Error('Source revision is stale.');
    if (this.isExcluded(source.conversationId)) throw new Error('Conversation is excluded.');
    assertSourceEvidenceAllowed(this.db, proposal.sourceMessageId, proposal.sourceRevision);
    if (proposal.kind === 'memory') return this.applyMemoryProposal(runId, proposal, now);
    if (proposal.kind === 'topic') return this.applyTopicProposal(runId, proposal, now);
    if (proposal.kind === 'entity') return this.applyEntityProposal(runId, proposal, now);
    return this.applyRelationshipProposal(runId, proposal, now);
  }

  private applyMemoryProposal(runId: string, proposal: Extract<LearningProposal, { kind: 'memory' }> & { proposalId: string; operationId: string }, now: number) {
    if (proposal.action === 'add') {
      const id = deterministicId(proposal.operationId);
      const existing = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(id);
      if (existing) return;
      this.db.query('INSERT INTO memories (id, text, kind, state, pinned, core, recordedAt, revision) VALUES (?, ?, ?, \'active\', 0, 0, ?, 1)').run(id, proposal.text, proposal.memoryKind, now);
      this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, modality, provenance, recordedAt) VALUES (?, ?, 1, ?, ?, \'user\', \'supporting\', ?, ?, ?)').run(crypto.randomUUID(), id, proposal.sourceMessageId, proposal.sourceRevision, proposal.modality ?? 'assertion', 'background learning', now);
      categorizeMemory(this.db, id, proposal.topics);
      const after = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(id)!;
      this.recordHistory(runId, proposal.operationId, 'memory', id, 'add', null, after, now);
      return;
    }
    const id = requireUuid(proposal.memoryId, 'memory id');
    const current = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(id);
    if (!current) throw new Error('Memory not found.');
    if (current.revision !== proposal.expectedMemoryRevision) throw new Error('Memory revision conflict.');
    if (proposal.action === 'confirm') {
      const duplicate = this.db.query('SELECT 1 FROM memory_evidence WHERE memoryId = ? AND memoryRevision = ? AND sourceMessageId = ? AND sourceRevision = ? AND stance = \'supporting\'').get(id, current.revision, proposal.sourceMessageId, proposal.sourceRevision);
      if (!duplicate) this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, modality, provenance, recordedAt) VALUES (?, ?, ?, ?, ?, \'user\', \'supporting\', ?, \'background learning\', ?)').run(crypto.randomUUID(), id, current.revision, proposal.sourceMessageId, proposal.sourceRevision, proposal.modality ?? 'assertion', now);
      return;
    }
    const before = { ...current };
    this.db.query('UPDATE memories SET text = ?, kind = ?, revision = revision + 1 WHERE id = ? AND revision = ?').run(proposal.text, proposal.memoryKind ?? current.kind, id, current.revision);
    this.db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, modality, provenance, recordedAt) VALUES (?, ?, ?, ?, ?, \'user\', \'supporting\', ?, \'background learning\', ?)').run(crypto.randomUUID(), id, current.revision + 1, proposal.sourceMessageId, proposal.sourceRevision, proposal.modality ?? 'assertion', now);
    categorizeMemory(this.db, id, proposal.topics);
    const after = this.db.query<MemoryRow, [string]>('SELECT * FROM memories WHERE id = ?').get(id)!;
    this.recordHistory(runId, proposal.operationId, 'memory', id, 'correct', before, after, now);
  }

  private applyTopicProposal(runId: string, proposal: Extract<LearningProposal, { kind: 'topic' }>, now: number) {
    const id = deterministicId(operationId(proposal));
    const inserted = this.db.query('INSERT OR IGNORE INTO topics (id, label, description, aliases, recordedAt, revision) VALUES (?, ?, ?, \'[]\', ?, 1)').run(id, proposal.label, proposal.description ?? null, now);
    if (inserted.changes !== 1) return;
    const membership: Array<{ memoryId: string; topicId: string }> = [];
    if (proposal.memoryId !== undefined) {
      const memory = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(proposal.memoryId);
      if (!memory || memory.revision !== proposal.expectedMemoryRevision) throw new Error('Memory revision conflict.');
      this.db.query('INSERT INTO memory_topics (memoryId, topicId) VALUES (?, ?)').run(proposal.memoryId, id);
      membership.push({ memoryId: proposal.memoryId, topicId: id });
    }
    const topic = this.db.query<Record<string, unknown>, [string]>('SELECT * FROM topics WHERE id = ?').get(id)!;
    this.recordHistory(runId, operationId(proposal), 'topic', id, 'add', null, { topic, membership, revision: 1 }, now);
  }

  private applyEntityProposal(runId: string, proposal: Extract<LearningProposal, { kind: 'entity' }>, now: number) {
    const id = deterministicId(operationId(proposal));
    const inserted = this.db.query('INSERT OR IGNORE INTO entities (id, kind, label, description, aliases, recordedAt, revision) VALUES (?, ?, ?, ?, \'[]\', ?, 1)').run(id, proposal.entityKind, proposal.label, proposal.description ?? null, now);
    if (inserted.changes !== 1) return;
    const entity = this.db.query<Record<string, unknown>, [string]>('SELECT * FROM entities WHERE id = ?').get(id)!;
    this.recordHistory(runId, operationId(proposal), 'entity', id, 'add', null, { entity, revision: 1 }, now);
    if (proposal.memoryId !== undefined) {
      const memory = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(proposal.memoryId);
      if (!memory || memory.revision !== proposal.expectedMemoryRevision) throw new Error('Memory revision conflict.');
      const relationshipId = crypto.randomUUID();
      this.insertRelationship(relationshipId, 'about', proposal.memoryId, id, proposal.expectedMemoryRevision!, 1, 'background learning', false, proposal.sourceMessageId, proposal.sourceRevision, now);
      const relationship = this.db.query<Record<string, unknown>, [string]>('SELECT * FROM memory_relationships WHERE id = ?').get(relationshipId)!;
      this.recordHistory(runId, `${operationId(proposal)}:about`, 'relationship', relationshipId, 'add', null, relationship, now);
    }
  }

  private applyRelationshipProposal(runId: string, proposal: Extract<LearningProposal, { kind: 'relationship' }>, now: number) {
    const kind = proposal.relationshipKind;
    if (kind === 'about' || kind === 'involves') throw new Error('Relationship endpoints require an entity proposal.');
    if (proposal.subjectId === proposal.objectId) throw new Error('Relationship cannot link an endpoint to itself.');
    const existing = this.db.query('SELECT 1 FROM memory_relationships WHERE kind = ? AND subjectId = ? AND objectId = ?').get(kind, proposal.subjectId, proposal.objectId);
    if (existing) return;
    const subject = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(proposal.subjectId);
    const object = this.db.query<{ revision: number }, [string]>('SELECT revision FROM memories WHERE id = ?').get(proposal.objectId);
    if (!subject || !object || subject.revision !== proposal.expectedSubjectRevision || object.revision !== proposal.expectedObjectRevision) throw new Error('Memory revision conflict.');
    if (kind === 'supersedes') {
      const cycle = this.db.query('WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT objectId FROM memory_relationships JOIN chain ON subjectId = chain.id WHERE kind = \'supersedes\') SELECT 1 FROM chain WHERE id = ? LIMIT 1').get(proposal.objectId, proposal.subjectId);
      if (cycle) throw new Error('Supersession cycle.');
    }
    const relationshipId = crypto.randomUUID();
    this.insertRelationship(relationshipId, kind, proposal.subjectId, proposal.objectId, subject.revision, object.revision, proposal.provenance ?? 'background learning', false, proposal.sourceMessageId, proposal.sourceRevision, now);
    const relationship = this.db.query<Record<string, unknown>, [string]>('SELECT * FROM memory_relationships WHERE id = ?').get(relationshipId)!;
    this.recordHistory(runId, operationId(proposal), 'relationship', relationshipId, 'add', null, relationship, now);
  }

  private insertRelationship(id: string, kind: RelationshipKind, subjectId: string, objectId: string, subjectRevision: number, objectRevision: number, provenance: string, explicit: boolean, sourceMessageId: string, sourceRevision: number, recordedAt: number) {
    this.db.query('INSERT INTO memory_relationships (id, kind, subjectId, objectId, subjectRevision, objectRevision, provenance, explicit, recordedAt, sourceMessageId, sourceRevision, sourceRole, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'user\', 1)').run(id, kind, subjectId, objectId, subjectRevision, objectRevision, bounded(provenance, 'relationship provenance', MAX_PROVENANCE), explicit ? 1 : 0, recordedAt, sourceMessageId, sourceRevision);
  }

  private recordHistory(runId: string, operationIdValue: string, resourceType: LearningHistoryResource, resourceId: string, action: 'add' | 'correct', before: Record<string, unknown> | null, after: Record<string, unknown>, createdAt: number) {
    this.db.query('INSERT OR IGNORE INTO learning_history (id, runId, operationId, action, memoryId, resourceType, resourceId, beforeJson, afterJson, afterRevision, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), runId, operationIdValue, action, resourceId, resourceType, resourceId, before ? JSON.stringify(before) : null, JSON.stringify(after), Number(after.revision), createdAt);
  }
}