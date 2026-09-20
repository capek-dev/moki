import { Store } from '@backend/store';
import { recallJev, type JevFetcher } from '@backend/memory-jev';
import type { BasicRecallConfig } from '@backend/memory-recall';
import type { MemoryRecord } from '@backend/memory-repository';
import type { MemoryRoutingDescriptor } from '@backend/memory-graph-repository';

export type MemoryJevEvalCase = {
  id: string;
  request: string;
  recent: string;
  selectedDescriptors: string[];
  expected: string[];
  forbidden: string[];
};

type CaseSetup = {
  selected: Set<string>;
  expected: Set<string>;
  forbidden: Set<string>;
  memoryLabels: Map<string, string>;
  memoryTexts: string[];
};

type EvalRow = {
  id: string;
  verification: 'mocked' | 'live';
  requests: number;
  selected: string[];
  expected: string[];
  forbidden: string[];
  missing: string[];
  unexpected: string[];
  outcome: string;
  passed: boolean;
};

const CASES = await Bun.file(new URL('./fixtures/memory-jev-eval.json', import.meta.url)).json() as MemoryJevEvalCase[];
const CONFIG: BasicRecallConfig = {
  enabled: true,
  recall: 'jev',
  jevConsent: true,
  jevModel: 'jev-latest',
  maxEntries: 8,
  maxCandidates: 30,
  maxTextChars: 12_000,
};
const IDS = {
  lisbonTrip: '11111111-1111-4111-8111-111111111111',
  tokyoTrip: '22222222-2222-4222-8222-222222222222',
  alex: '33333333-3333-4333-8333-333333333333',
  sam: '44444444-4444-4444-8444-444444444444',
  lisbonTopic: '55555555-5555-4555-8555-555555555555',
  tokyoTopic: '66666666-6666-4666-8666-666666666666',
};

function source(store: Store, text: string) {
  const conversationId = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  return store.handle({ method: 'saveMessage', conversationId, text }).snapshot.messages.at(-1)!;
}

function addMemory(store: Store, sourceMessage: { id: string; revision?: number }, label: string, text: string, entityId?: string): MemoryRecord {
  const memory = store.memoryRepository.create({ text, kind: 'fact' });
  store.memoryRepository.addEvidence({
    memoryId: memory.id,
    expectedMemoryRevision: memory.revision,
    sourceMessageId: sourceMessage.id,
    sourceRevision: sourceMessage.revision ?? 1,
    stance: 'supporting',
    provenance: 'synthetic evaluation source',
  });
  if (entityId) {
    const entity = store.memoryGraphRepository.getEntity(entityId)!;
    store.memoryGraphRepository.createRelationship({
      kind: 'about',
      subjectId: memory.id,
      objectId: entity.id,
      expectedSubjectRevision: memory.revision,
      expectedObjectRevision: entity.revision,
      provenance: 'synthetic evaluation source',
      explicit: true,
      sourceMessageId: sourceMessage.id,
      sourceRevision: sourceMessage.revision ?? 1,
    });
  }
  return memory;
}

function setupCase(store: Store, definition: MemoryJevEvalCase): CaseSetup {
  const memoryLabels = new Map<string, string>();
  const memoryTexts: string[] = [];
  const add = (sourceMessage: { id: string; revision?: number }, label: string, text: string, entityId?: string) => {
    const memory = addMemory(store, sourceMessage, label, text, entityId);
    memoryLabels.set(memory.id, label);
    memoryTexts.push(text);
    return memory;
  };

  switch (definition.id) {
    case 'positive-indirect-trip': {
      const sourceMessage = source(store, 'Alex is joining our Lisbon trip and needs step-free access.');
      store.memoryGraphRepository.createEntity({ id: IDS.lisbonTrip, kind: 'trip', label: 'Lisbon trip' });
      store.memoryGraphRepository.createEntity({ id: IDS.alex, kind: 'person', label: 'Alex' });
      const memory = add(sourceMessage, 'Alex accessibility', 'Alex requires step-free access.', IDS.alex);
      store.memoryGraphRepository.createRelationship({ kind: 'involves', subjectId: IDS.lisbonTrip, objectId: IDS.alex, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'synthetic evaluation source', explicit: true, sourceMessageId: sourceMessage.id, sourceRevision: sourceMessage.revision ?? 1 });
      if (!memory) throw new Error('Synthetic setup failed.');
      break;
    }
    case 'negative-alex-not-travelling': {
      const sourceMessage = source(store, 'Sam is joining our Lisbon trip. Alex is not travelling.');
      store.memoryGraphRepository.createEntity({ id: IDS.lisbonTrip, kind: 'trip', label: 'Lisbon trip' });
      store.memoryGraphRepository.createEntity({ id: IDS.alex, kind: 'person', label: 'Alex' });
      store.memoryGraphRepository.createEntity({ id: IDS.sam, kind: 'person', label: 'Sam' });
      add(sourceMessage, 'Alex accessibility', 'Alex requires step-free access.', IDS.alex);
      add(sourceMessage, 'Sam hotel preference', 'Sam prefers a quiet hotel near the station.', IDS.sam);
      store.memoryGraphRepository.createRelationship({ kind: 'involves', subjectId: IDS.lisbonTrip, objectId: IDS.sam, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'synthetic evaluation source', explicit: true, sourceMessageId: sourceMessage.id, sourceRevision: sourceMessage.revision ?? 1 });
      break;
    }
    case 'topic-switch': {
      const sourceMessage = source(store, 'We are switching from Lisbon to Tokyo for the next trip.');
      const lisbon = store.memoryGraphRepository.createTopic({ id: IDS.lisbonTopic, label: 'Lisbon trip' });
      const tokyo = store.memoryGraphRepository.createTopic({ id: IDS.tokyoTopic, label: 'Tokyo trip' });
      const lisbonMemory = add(sourceMessage, 'Lisbon packing', 'Lisbon requires a light rain jacket.');
      const tokyoMemory = add(sourceMessage, 'Tokyo packing', 'Tokyo requires a rail pass and comfortable shoes.');
      store.memoryGraphRepository.addMemoryTopic({ memoryId: lisbonMemory.id, topicId: lisbon.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
      store.memoryGraphRepository.addMemoryTopic({ memoryId: tokyoMemory.id, topicId: tokyo.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
      break;
    }
    case 'stale-fact': {
      const oldSource = source(store, 'Alex lives in Paris.');
      store.memoryGraphRepository.createEntity({ id: IDS.alex, kind: 'person', label: 'Alex' });
      const oldMemory = add(oldSource, 'Alex stale home', 'Alex lives in Paris.', IDS.alex);
      store.updateReply(oldSource.id, 'Alex moved from Paris.', 'complete');
      const currentSource = source(store, 'Alex lives in Berlin now.');
      add(currentSource, 'Alex current home', 'Alex lives in Berlin now.', IDS.alex);
      if (!oldMemory) throw new Error('Synthetic setup failed.');
      break;
    }
    case 'contradiction': {
      const sourceMessage = source(store, 'Alex gave contradictory seat preferences.');
      store.memoryGraphRepository.createEntity({ id: IDS.alex, kind: 'person', label: 'Alex' });
      const aisle = add(sourceMessage, 'Alex aisle preference', 'Alex prefers an aisle seat.', IDS.alex);
      const window = add(sourceMessage, 'Alex window preference', 'Alex prefers a window seat.', IDS.alex);
      store.memoryGraphRepository.createRelationship({ kind: 'contradicts', subjectId: aisle.id, objectId: window.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'synthetic contradiction', explicit: true, sourceMessageId: sourceMessage.id, sourceRevision: sourceMessage.revision ?? 1 });
      break;
    }
    case 'implicit-follow-up': {
      const sourceMessage = source(store, 'We are planning the Lisbon trip with Alex.');
      store.memoryGraphRepository.createEntity({ id: IDS.lisbonTrip, kind: 'trip', label: 'Lisbon trip' });
      store.memoryGraphRepository.createEntity({ id: IDS.alex, kind: 'person', label: 'Alex' });
      const memory = add(sourceMessage, 'Alex accessibility', 'Alex requires step-free access.', IDS.alex);
      store.memoryGraphRepository.createRelationship({ kind: 'involves', subjectId: IDS.lisbonTrip, objectId: IDS.alex, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'synthetic evaluation source', explicit: true, sourceMessageId: sourceMessage.id, sourceRevision: sourceMessage.revision ?? 1 });
      if (!memory) throw new Error('Synthetic setup failed.');
      break;
    }
    default: throw new Error(`Unknown Jev evaluation case: ${definition.id}`);
  }

  return {
    selected: new Set(definition.selectedDescriptors),
    expected: new Set(definition.expected),
    forbidden: new Set(definition.forbidden),
    memoryLabels,
    memoryTexts,
  };
}

function mockFetcher(setup: CaseSetup): { fetcher: JevFetcher; requests: () => number } {
  let count = 0;
  return {
    fetcher: async (_url, init) => {
      count++;
      const body = JSON.parse(String(init?.body)) as { state: { descriptors: MemoryRoutingDescriptor[] } };
      const serializedState = JSON.stringify(body.state);
      if (setup.memoryTexts.some((text) => serializedState.includes(text))) throw new Error('Memory text crossed the Jev routing boundary.');
      return Response.json({ answers: Object.fromEntries(body.state.descriptors.map((descriptor, index) => {
        const selected = setup.selected.has(descriptor.label);
        return [`item_${index}`, { type: 'score', score: selected ? 3 : 0, probabilities: selected ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0 } }];
      })) });
    },
    requests: () => count,
  };
}

async function evaluateDefinition(definition: MemoryJevEvalCase, verification: 'mocked' | 'live', key: string, liveFetcher?: JevFetcher): Promise<EvalRow> {
  const store = new Store(':memory:');
  try {
    const setup = setupCase(store, definition);
    const mock = mockFetcher(setup);
    const fetcher = liveFetcher ?? mock.fetcher;
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: definition.request, recent: definition.recent }, CONFIG, new AbortController().signal, { key }, fetcher);
    const requests = liveFetcher ? 1 : mock.requests();
    const selected = result.entries.map((entry) => setup.memoryLabels.get(entry.memory.id)).filter((label): label is string => label !== undefined);
    const expected = [...setup.expected];
    const forbidden = [...setup.forbidden];
    const missing = expected.filter((label) => !selected.includes(label));
    const unexpected = selected.filter((label) => !setup.expected.has(label));
    const passed = result.inspection.outcome === 'jev_selected' || expected.length === 0
      ? missing.length === 0 && unexpected.length === 0 && forbidden.every((label) => !selected.includes(label)) && requests === 1
      : false;
    return { id: definition.id, verification, requests, selected, expected, forbidden, missing, unexpected, outcome: result.inspection.outcome, passed };
  } finally {
    store.close();
  }
}

export async function runOfflineEvaluation(): Promise<{ verification: 'offline-mock'; cases: EvalRow[]; passed: boolean; note: string }> {
  const cases = await Promise.all(CASES.map((definition) => evaluateDefinition(definition, 'mocked', 'offline-fixture')));
  return {
    verification: 'offline-mock',
    cases,
    passed: cases.every((item) => item.passed),
    note: 'Synthetic transport selects the fixture labels. This verifies retrieval wiring, filtering, bounds, privacy, and diagnostics, not model quality or provider precision.',
  };
}

export async function runLiveEvaluation(key: string): Promise<{ verification: 'live'; cases: EvalRow[]; passed: boolean; note: string }> {
  if (!key || key.length > 1000 || /\s/.test(key)) throw new Error('Saved TypeSafe key unavailable.');
  let requests = 0;
  const fetcher: JevFetcher = async (url, init) => {
    if (requests >= CASES.length || url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Live request budget stopped.');
    requests++;
    const response = await fetch(url, { ...init, redirect: 'error' });
    const body = await response.text();
    if (Buffer.byteLength(body) > 128_000) throw new Error('Live response exceeded the evaluation bound.');
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const cases = [] as EvalRow[];
  for (const definition of CASES) cases.push(await evaluateDefinition(definition, 'live', key, fetcher));
  return {
    verification: 'live',
    cases,
    passed: cases.every((item) => item.passed),
    note: 'Live results are provider-dependent and require review against the synthetic labels. No tool execution is part of this evaluator.',
  };
}

if (import.meta.main) {
  const mode = Bun.argv[2];
  if (mode === '--mock') {
    const report = await runOfflineEvaluation();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } else if (mode === '--approved-live') {
    const key = (await Bun.stdin.text()).trim();
    try {
      const report = await runLiveEvaluation(key);
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } catch {
      console.error('Live Jev evaluation stopped. Key and upstream error details were withheld.');
      process.exitCode = 1;
    }
  } else {
    throw new Error('Use --mock, or --approved-live with a key on stdin after explicit live approval.');
  }
}
