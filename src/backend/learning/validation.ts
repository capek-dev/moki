import { createHash } from 'node:crypto';
import type { LearningProposal } from '@backend/learning/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

export function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.trim();
}

export function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

export function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

export function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value as T;
}

export function exactProposalFields(value: Record<string, unknown>, fields: readonly string[]) {
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Learning proposal contained an unknown field.');
  }
}

export function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return bounded(value, 'description', 2000);
}

export function proposalSource(proposal: LearningProposal) {
  return {
    sourceMessageId: bounded(proposal.sourceMessageId, 'source message id', 100),
    sourceRevision: positive(proposal.sourceRevision, 'source revision'),
    sourceRole: proposal.sourceRole,
  };
}

export function operationId(proposal: LearningProposal): string {
  const digest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${digest.slice(18, 20)}-${digest.slice(20, 32)}`;
}

export function deterministicId(operation: string): string {
  return operation;
}
