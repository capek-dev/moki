import type { Database } from 'bun:sqlite';

export type SessionSearchRole = 'user' | 'assistant';
export type SessionSearchScope =
  | { kind: 'archive' }
  | { kind: 'conversation'; conversationId: string };

export interface SessionSearchMessage {
  id: string;
  conversationId: string;
  role: SessionSearchRole;
  createdAt: number | null;
  revision: number;
  snippet: string;
}

export interface SessionSearchConversation {
  id: string;
  assistantId: string;
  title: string;
  messageCount: number;
  latestMessageAt: number | null;
}

export interface SessionSearchPage<T> {
  results: T[];
  nextCursor: number | null;
}

export interface SessionSearchOptions {
  query: string;
  scope?: SessionSearchScope;
  roles?: readonly SessionSearchRole[];
  limit?: number;
  cursor?: number | null;
}

export interface SessionConversationListOptions {
  scope?: SessionSearchScope;
  limit?: number;
  cursor?: number | null;
}

export interface SessionReadAroundOptions {
  anchorMessageId: string;
  conversationId?: string;
  roles?: readonly SessionSearchRole[];
  before?: number;
  after?: number;
}

export interface SessionReadAround {
  anchor: SessionSearchMessage;
  results: SessionSearchMessage[];
}

export interface SessionMessageTextPage {
  id: string;
  conversationId: string;
  role: SessionSearchRole;
  createdAt: number | null;
  revision: number;
  text: string;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
}

export const SESSION_SEARCH_SCHEMA_VERSION = 1;
export const DEFAULT_SESSION_SEARCH_LIMIT = 20;
export const MAX_SESSION_SEARCH_LIMIT = 50;
export const MAX_SESSION_SEARCH_OUTPUT_BYTES = 24_000;
export const MAX_SESSION_SEARCH_SNIPPET_LENGTH = 320;
const MAX_QUERY_LENGTH = 500;
const MAX_ID_LENGTH = 100;
const MAX_READ_AROUND_SIDE = 25;
const DEFAULT_MESSAGE_TEXT_LENGTH = 4_000;
const MAX_MESSAGE_TEXT_LENGTH = 8_000;

const ROLES: readonly SessionSearchRole[] = ['user', 'assistant'];

type SearchIndexRow = {
  rowid: number;
  messageId: string;
  conversationId: string;
  role: SessionSearchRole;
  createdAt: number | null;
  revision: number;
  text: string;
};

type MessageRow = SearchIndexRow & { status: string };

type SqlValue = string | number;

export function installSessionSearchSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_message_fts USING fts5(
      messageId UNINDEXED,
      conversationId UNINDEXED,
      role UNINDEXED,
      createdAt UNINDEXED,
      revision UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
  `);
}

function eligibleMessageWhere(): string {
  return "status <> 'streaming' AND role IN ('user', 'assistant')";
}

export function rebuildSessionSearchIndex(db: Database) {
  db.exec('DELETE FROM session_message_fts;');
  db.exec(`
    INSERT INTO session_message_fts (rowid, messageId, conversationId, role, createdAt, revision, text)
    SELECT rowid, id, conversationId, role, createdAt, revision, text
    FROM messages
    WHERE ${eligibleMessageWhere()};
  `);
  db.query(`
    INSERT INTO session_search_meta (key, value) VALUES ('schemaVersion', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SESSION_SEARCH_SCHEMA_VERSION));
}

export function sessionSearchIndexNeedsRebuild(db: Database): boolean {
  const marker = db.query<{ value: string }, [string]>(
    "SELECT value FROM session_search_meta WHERE key = 'schemaVersion'",
  ).get('schemaVersion')?.value;
  if (marker !== String(SESSION_SEARCH_SCHEMA_VERSION)) return true;
  const indexed = db.query<{ count: number }, []>('SELECT count(*) AS count FROM session_message_fts').get()!.count;
  const eligible = db.query<{ count: number }, []>(`SELECT count(*) AS count FROM messages WHERE ${eligibleMessageWhere()}`).get()!.count;
  return indexed !== eligible;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function limit(value: unknown, name: string, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function nonNegativeLimit(value: unknown, name: string, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function cursor(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
  return value;
}

function roles(value: readonly SessionSearchRole[] | undefined): SessionSearchRole[] {
  if (value === undefined) return [...ROLES];
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid roles.');
  const selected = new Set<SessionSearchRole>();
  for (const role of value) {
    if (!ROLES.includes(role)) throw new Error('Invalid roles.');
    selected.add(role);
  }
  return [...selected];
}

function roleClause(selected: readonly SessionSearchRole[], parameters: SqlValue[]): string {
  parameters.push(...selected);
  return `role IN (${selected.map(() => '?').join(', ')})`;
}

function safePhrase(value: string): string {
  const phrase = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  // SQLite treats NUL as a truncated SQL string. Replace it before quoting so
  // even malformed control-character input stays a valid FTS expression.
  const normalized = phrase.replaceAll('\u0000', ' ');
  if (!normalized.trim()) return '"__moki_empty_search__"';
  // Always pass a single quoted phrase to MATCH. Operators, column selectors,
  // unmatched quotes, and punctuation are treated as user text, not SQL/FTS.
  return `"${normalized.replaceAll('"', '""')}"`;
}

function snippet(text: string): string {
  const value = text.trim();
  if (value.length <= MAX_SESSION_SEARCH_SNIPPET_LENGTH) return value;
  return `${value.slice(0, MAX_SESSION_SEARCH_SNIPPET_LENGTH - 1)}…`;
}

function outputFits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_SESSION_SEARCH_OUTPUT_BYTES;
}


function decodeSearchRow(row: SearchIndexRow, boundedText = row.text): SessionSearchMessage {
  return {
    id: row.messageId,
    conversationId: row.conversationId,
    role: row.role,
    createdAt: row.createdAt ?? null,
    revision: row.revision,
    snippet: snippet(boundedText),
  };
}

function conversationScope(db: Database, scope: SessionSearchScope | undefined): string | null {
  if (scope === undefined || scope.kind === 'archive') return null;
  if (scope.kind !== 'conversation') throw new Error('Invalid search scope.');
  const id = boundedString(scope.conversationId, 'conversationId', MAX_ID_LENGTH);
  if (!db.query('SELECT 1 FROM conversations WHERE id = ?').get(id)) throw new Error('Conversation not found.');
  return id;
}

function addResultsWithinBudget<T>(rows: readonly T[], limitValue: number, cursorValue: number | null, rowid?: (row: T) => number): SessionSearchPage<T> {
  const results: T[] = [];
  for (const row of rows) {
    if (results.length >= limitValue) break;
    const candidate = [...results, row];
    if (!outputFits({ results: candidate, nextCursor: null })) {
      if (results.length === 0) throw new Error('Search output exceeds its bound.');
      break;
    }
    results.push(row);
  }
  const consumed = results.length;
  const hasMore = consumed < rows.length;
  const nextCursor = hasMore && consumed > 0
    ? rowid?.(rows[consumed - 1]) ?? cursorValue
    : null;
  const page = { results, nextCursor };
  if (!outputFits(page)) throw new Error('Search output exceeds its bound.');
  return page;
}

export class SessionSearchRepository {
  constructor(private readonly db: Database) {}

  rebuild() {
    this.db.transaction(() => rebuildSessionSearchIndex(this.db))();
  }

  syncMessage(messageId: string) {
    const id = boundedString(messageId, 'messageId', MAX_ID_LENGTH);
    this.db.query('DELETE FROM session_message_fts WHERE messageId = ?').run(id);
    const row = this.db.query<MessageRow, [string]>(`
      SELECT rowid, id AS messageId, conversationId, role, createdAt, revision, text, status
      FROM messages WHERE id = ?
    `).get(id);
    if (!row || row.status === 'streaming' || !ROLES.includes(row.role)) return;
    this.db.query(`
      INSERT INTO session_message_fts (rowid, messageId, conversationId, role, createdAt, revision, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.rowid, row.messageId, row.conversationId, row.role, row.createdAt, row.revision, row.text);
  }

  removeMessage(messageId: string) {
    this.db.query('DELETE FROM session_message_fts WHERE messageId = ?').run(boundedString(messageId, 'messageId', MAX_ID_LENGTH));
  }

  listConversations(options: SessionConversationListOptions = {}): SessionSearchPage<SessionSearchConversation> {
    const limitValue = limit(options.limit, 'limit', DEFAULT_SESSION_SEARCH_LIMIT, MAX_SESSION_SEARCH_LIMIT);
    const cursorValue = cursor(options.cursor, 'cursor');
    const scopeConversationId = conversationScope(this.db, options.scope);
    const parameters: SqlValue[] = [];
    const predicates: string[] = [];
    if (scopeConversationId !== null) { predicates.push('c.id = ?'); parameters.push(scopeConversationId); }
    if (cursorValue !== null) { predicates.push('c.rowid < ?'); parameters.push(cursorValue); }
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    parameters.push(limitValue + 1);
    const rows = this.db.query<SessionSearchConversation & { rowid: number }, SqlValue[]>(`
      SELECT c.rowid, c.id, c.assistantId, c.title,
        sum(CASE WHEN m.status <> 'streaming' THEN 1 ELSE 0 END) AS messageCount,
        max(CASE WHEN m.status <> 'streaming' THEN m.createdAt ELSE NULL END) AS latestMessageAt
      FROM conversations c
      LEFT JOIN messages m ON m.conversationId = c.id
      ${where}
      GROUP BY c.rowid, c.id, c.assistantId, c.title
      ORDER BY c.rowid DESC
      LIMIT ?
    `).all(...parameters);
    const pageRows = rows.map(({ rowid: _rowid, ...row }) => row);
    return addResultsWithinBudget(pageRows, limitValue, cursorValue, (row) => rows[pageRows.indexOf(row)].rowid);
  }

  search(options: SessionSearchOptions): SessionSearchPage<SessionSearchMessage> {
    const query = boundedString(options.query, 'query', MAX_QUERY_LENGTH);
    const scopeConversationId = conversationScope(this.db, options.scope);
    const selectedRoles = roles(options.roles);
    const limitValue = limit(options.limit, 'limit', DEFAULT_SESSION_SEARCH_LIMIT, MAX_SESSION_SEARCH_LIMIT);
    const cursorValue = cursor(options.cursor, 'cursor');
    const parameters: SqlValue[] = [safePhrase(query)];
    const predicates = ['session_message_fts MATCH ?'];
    if (scopeConversationId !== null) { predicates.push('conversationId = ?'); parameters.push(scopeConversationId); }
    predicates.push(roleClause(selectedRoles, parameters));
    if (cursorValue !== null) { predicates.push('session_message_fts.rowid < ?'); parameters.push(cursorValue); }
    parameters.push(limitValue + 1);
    const rows = this.db.query<SearchIndexRow & { matchedSnippet: string }, SqlValue[]>(`
      SELECT rowid, messageId, conversationId, role, createdAt, revision, text,
        snippet(session_message_fts, 5, '', '', '…', 24) AS matchedSnippet
      FROM session_message_fts
      WHERE ${predicates.join(' AND ')}
      ORDER BY session_message_fts.rowid DESC
      LIMIT ?
    `).all(...parameters);
    const decoded = rows.map((row) => decodeSearchRow(row, row.matchedSnippet));
    return addResultsWithinBudget(decoded, limitValue, cursorValue, (row) => rows[decoded.indexOf(row)].rowid);
  }

  latestMessageId(conversationId: string): string | null {
    const id = conversationScope(this.db, { kind: 'conversation', conversationId });
    const row = this.db.query<{ id: string }, [string]>(`
      SELECT id FROM messages
      WHERE conversationId = ? AND status <> 'streaming' AND role IN ('user', 'assistant')
      ORDER BY rowid DESC LIMIT 1
    `).get(id!);
    return row?.id ?? null;
  }

  readAround(options: SessionReadAroundOptions): SessionReadAround {
    const anchorId = boundedString(options.anchorMessageId, 'anchorMessageId', MAX_ID_LENGTH);
    const scopeId = options.conversationId === undefined ? null : boundedString(options.conversationId, 'conversationId', MAX_ID_LENGTH);
    const selectedRoles = roles(options.roles);
    const before = nonNegativeLimit(options.before, 'before', 10, MAX_READ_AROUND_SIDE);
    const after = nonNegativeLimit(options.after, 'after', 10, MAX_READ_AROUND_SIDE);
    const anchor = this.db.query<MessageRow, [string]>(`
      SELECT rowid, id AS messageId, conversationId, role, createdAt, revision, text, status
      FROM messages WHERE id = ? AND status <> 'streaming'
    `).get(anchorId);
    if (!anchor || (scopeId !== null && anchor.conversationId !== scopeId)) throw new Error('Anchor message not found.');
    if (!ROLES.includes(anchor.role)) throw new Error('Anchor message is not searchable.');

    const roleParametersBefore: SqlValue[] = [anchor.conversationId, anchor.rowid];
    const roleBefore = roleClause(selectedRoles, roleParametersBefore);
    roleParametersBefore.push(before);
    const prior = this.db.query<MessageRow, SqlValue[]>(`
      SELECT rowid, id AS messageId, conversationId, role, createdAt, revision, text, status
      FROM messages
      WHERE conversationId = ? AND rowid < ? AND status <> 'streaming' AND ${roleBefore}
      ORDER BY rowid DESC LIMIT ?
    `).all(...roleParametersBefore).reverse();

    const roleParametersAfter: SqlValue[] = [anchor.conversationId, anchor.rowid];
    const roleAfter = roleClause(selectedRoles, roleParametersAfter);
    roleParametersAfter.push(after);
    const following = this.db.query<MessageRow, SqlValue[]>(`
      SELECT rowid, id AS messageId, conversationId, role, createdAt, revision, text, status
      FROM messages
      WHERE conversationId = ? AND rowid > ? AND status <> 'streaming' AND ${roleAfter}
      ORDER BY rowid ASC LIMIT ?
    `).all(...roleParametersAfter);
    const decodedAnchor = decodeSearchRow(anchor);
    const decoded = [...prior.map((row) => decodeSearchRow(row)), decodedAnchor, ...following.map((row) => decodeSearchRow(row))];
    const response = { anchor: decodedAnchor, results: decoded };
    if (!outputFits(response)) {
      throw new Error('Read-around output exceeds its bound.');
    }
    return response;
  }

  readMessageText(messageId: string, options: { offset?: number; limit?: number; conversationId?: string } = {}): SessionMessageTextPage {
    const id = boundedString(messageId, 'messageId', MAX_ID_LENGTH);
    const offset = options.offset === undefined ? 0 : options.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset.');
    const length = limit(options.limit, 'limit', DEFAULT_MESSAGE_TEXT_LENGTH, MAX_MESSAGE_TEXT_LENGTH);
    const conversationId = options.conversationId === undefined ? undefined : boundedString(options.conversationId, 'conversationId', MAX_ID_LENGTH);
    const row = this.db.query<MessageRow, [string]>(`
      SELECT id AS messageId, conversationId, role, createdAt, revision, text, status
      FROM messages WHERE id = ? AND status <> 'streaming'
    `).get(id);
    if (!row || !ROLES.includes(row.role) || (conversationId !== undefined && row.conversationId !== conversationId)) {
      throw new Error('Message not found.');
    }
    const codePoints = Array.from(row.text);
    const requested = codePoints.slice(offset, offset + length);
    let pageText = requested.join('');
    while (pageText && !outputFits({
      id: row.messageId,
      conversationId: row.conversationId,
      role: row.role,
      createdAt: row.createdAt ?? null,
      revision: row.revision,
      text: pageText,
      offset,
      nextOffset: offset + Array.from(pageText).length < codePoints.length ? offset + Array.from(pageText).length : null,
      truncated: true,
    })) {
      requested.pop();
      pageText = requested.join('');
    }
    const consumed = Array.from(pageText).length;
    const nextOffset = offset + consumed < codePoints.length ? offset + consumed : null;
    const page = {
      id: row.messageId,
      conversationId: row.conversationId,
      role: row.role,
      createdAt: row.createdAt ?? null,
      revision: row.revision,
      text: pageText,
      offset,
      nextOffset,
      truncated: nextOffset !== null,
    } satisfies SessionMessageTextPage;
    if (!outputFits(page)) throw new Error('Message text output exceeds its bound.');
    return page;
  }
}
