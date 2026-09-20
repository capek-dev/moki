import { expect, test } from 'bun:test';
import { Store } from '@backend/store';
import { LearningCoordinator, LEARNING_REVIEW_INSTRUCTIONS, reviewWithModel, type LearningProposal } from '@backend/memory-learning';

// Contract/application regression, not a claim that a live model extracts these facts.
test('personal introduction reaches reviewer and multiple identity facts from one source persist', async () => {
  const store = new Store(':memory:');
  let coordinator: LearningCoordinator | undefined;
  try {
    store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
    store.learningRepository.setEnabled(true, 1);
    const conversationId = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const texts = [
      "hello, my name is Daniel, I'm developer and I often struggle with marketing",
      "issue is definitely distribution and consistency, I dont like engaging with people through half facts or engagement bait",
      "just quick question, lets say, I'm consistent and I'm talking about new things and concepts based on actual work. No virality etc, what is time I can expect to actually grow any meaningful following that helps me distributing products?",
    ];
    const ids = texts.map(text => store.handle({ method: 'saveMessage', conversationId, text }).snapshot.messages.at(-1)!.id);
    const expected: LearningProposal[] = [
      { kind: 'memory', action: 'add', sourceMessageId: ids[0], sourceRevision: 1, sourceRole: 'user', text: 'The user is named Daniel.', memoryKind: 'fact' },
      { kind: 'memory', action: 'add', sourceMessageId: ids[0], sourceRevision: 1, sourceRole: 'user', text: 'The user is a developer.', memoryKind: 'fact' },
      { kind: 'memory', action: 'add', sourceMessageId: ids[0], sourceRevision: 1, sourceRole: 'user', text: 'The user reports recurring difficulty with marketing.', memoryKind: 'fact' },
      { kind: 'memory', action: 'add', sourceMessageId: ids[1], sourceRevision: 1, sourceRole: 'user', text: 'The user identifies distribution and consistency as marketing difficulties.', memoryKind: 'fact' },
      { kind: 'memory', action: 'add', sourceMessageId: ids[1], sourceRevision: 1, sourceRole: 'user', text: 'The user dislikes marketing using half-facts or engagement bait.', memoryKind: 'preference' },
    ];
    coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} });
    const result = await coordinator.run((sources, signal, context) => reviewWithModel(async function* (turn) {
      expect(turn.instructions).toContain('Who the user is');
      expect(turn.instructions).toContain('Do not skip identity to return only preferences');
      expect(turn.instructions).toContain('hypothetical');
      expect(turn.instructions).toContain('Assistant advice, predictions');
      expect(turn.instructions).toContain('confirm a matching fact');
      expect(turn.instructions.indexOf('LEARNING PRIORITIES')).toBeLessThan(turn.instructions.indexOf('OUTPUT CONTRACT'));
      const payload = JSON.parse(turn.messages[0].content as string);
      expect(payload.sources.map((source: { text: string }) => source.text)).toEqual(texts);
      expect(turn.tools).toBeUndefined();
      yield JSON.stringify({ proposals: expected });
    }, 'deepseek', 'deepseek-flash', { provider: 'deepseek', key: 'synthetic-not-used' }, 'synthetic-review', sources, signal, context));
    expect(result?.appliedCount).toBe(5);
    const memories = store.memoryRepository.list();
    expect(memories).toHaveLength(5);
    for (const proposal of expected) {
      if (proposal.kind !== 'memory' || proposal.action !== 'add') continue;
      const memory = memories.find(item => item.text === proposal.text)!;
      expect(store.memoryRepository.read(memory.id).validSupportingEvidence[0].sourceMessageId).toBe(proposal.sourceMessageId);
    }
    expect(store.memoryRepository.listBasicRecallCandidates().length).toBe(5);
  } finally { coordinator?.close(); store.close(); }
});

test('example identity is explicitly separated from actual evidence and kinds are explained', () => {
  expect(LEARNING_REVIEW_INSTRUCTIONS).toContain('illustration only, never evidence for the current user');
  expect(LEARNING_REVIEW_INSTRUCTIONS).toContain('must never be copied');
  expect(LEARNING_REVIEW_INSTRUCTIONS).toContain('Use memoryKind "fact" for identity');
  expect(LEARNING_REVIEW_INSTRUCTIONS).toContain('Copy actual source and record revisions');
  expect(LEARNING_REVIEW_INSTRUCTIONS).not.toContain('Daniel');
});
