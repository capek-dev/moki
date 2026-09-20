import { noul, TypeSafeClient } from '@typesafe-ai/sdk';
import type { LearningProposal, LearningSource } from './memory-learning';

/**
 * Jev source-support gate for learning reviews. The TypeSafe API answers
 * bounded questions (noul/choice/score); it cannot author reviews. What it can
 * do is verify: one systemOne request asks, per text-bearing proposal, whether
 * the user-authored message it cites directly supports the claim. Proposals
 * below the support threshold come back as rejection messages keyed by index
 * into the original proposals array; anything else stays pending.
 *
 * Transport, shape, and size failures throw; the caller fails open so learning
 * keeps working without the gate. Abort signals always propagate.
 */

export const LEARNING_VERIFY_TIMEOUT_MS = 15_000;
const SUPPORT_THRESHOLD = 0.5;
const SOURCE_EXCERPT_CHARS = 4_000;
const PROPOSAL_EXCERPT_CHARS = 2_000;
const MAX_REQUEST_CHARS = 60_000;
const MAX_RESPONSE_CHARS = 128_000;

export type VerifyFetcher = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export interface LearningVerification {
  rejections: Map<number, string>;
  checked: number;
}

type NoulAnswer = { type?: unknown; noul?: unknown };

function parseNoul(value: unknown): number {
  const answer = value as NoulAnswer;
  if (!answer || typeof answer !== 'object' || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error('Invalid Jev verification answer.');
  return answer.noul;
}

async function boundedResponse(response: Response): Promise<Response> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('Jev verification response too large.');
  return new Response(text, { status: response.status, headers: response.headers });
}

export async function verifyLearningSupport(
  key: string,
  proposals: readonly LearningProposal[],
  sources: readonly LearningSource[],
  signal: AbortSignal,
  fetcher: VerifyFetcher = fetch,
  timeoutMs = LEARNING_VERIFY_TIMEOUT_MS,
): Promise<LearningVerification> {
  signal.throwIfAborted();
  if (!key.trim()) throw new Error('Jev verification requires a key.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid Jev verification timeout.');
  // Only proposals that assert factual text are checkable; confirms and
  // structural proposals (topics, entities, relationships) carry no claim.
  const targets: Array<{ index: number; sourceMessageId: string; text: string }> = [];
  proposals.forEach((proposal, index) => {
    if (proposal.kind === 'memory' && (proposal.action === 'add' || proposal.action === 'correct') && proposal.text) {
      targets.push({ index, sourceMessageId: proposal.sourceMessageId, text: proposal.text });
    }
  });
  const rejections = new Map<number, string>();
  if (targets.length === 0) return { rejections, checked: 0 };

  const state = {
    task: 'Check whether each proposed memory is directly supported by the user-authored message it cites.',
    sources: sources.map((source) => ({ messageId: source.id, revision: source.revision, role: source.role, text: source.text.slice(0, SOURCE_EXCERPT_CHARS) })),
    proposals: targets.map((target, i) => ({ key: `p${i}`, sourceMessageId: target.sourceMessageId, text: target.text.slice(0, PROPOSAL_EXCERPT_CHARS) })),
  };
  const questions: Record<string, ReturnType<typeof noul>> = {};
  targets.forEach((_target, i) => {
    questions[`p${i}`] = noul('Does the cited user-authored source message directly and explicitly support this proposed fact? Judge only from the user\'s own words in that message; assistant text, hypotheticals, and inferences beyond the message do not count.');
  });
  const payload = { state, questions };
  if (JSON.stringify(payload).length > MAX_REQUEST_CHARS) throw new Error('Jev verification request too large.');

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = new TypeSafeClient({
      apiKey: key,
      baseURL: 'https://api.typesafe.ai',
      defaultModel: 'jev-latest',
      logLevel: 'off',
      retry: { maxRetries: 0 },
      fetch: async (url, init) => {
        controller.signal.throwIfAborted();
        if (typeof init?.body !== 'string' || init.body.length > MAX_REQUEST_CHARS) throw new Error('Jev verification request too large.');
        const response = await fetcher(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`Jev verification failed (${response.status}).`);
        return boundedResponse(response);
      },
    });
    const data = await client.systemOne(payload, { signal: controller.signal });
    const answers = (data as { answers?: unknown })?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Invalid Jev verification answers.');
    const record = answers as Record<string, unknown>;
    targets.forEach((target, i) => {
      const answer = record[`p${i}`];
      // A missing answer leaves the proposal pending: one unverifiable claim
      // must not block the rest of the run.
      if (answer === undefined) return;
      const probability = parseNoul(answer);
      if (probability < SUPPORT_THRESHOLD) rejections.set(target.index, `Jev source check: claim not supported by the cited user message (confidence ${probability.toFixed(2)}).`);
    });
    return { rejections, checked: targets.length };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
