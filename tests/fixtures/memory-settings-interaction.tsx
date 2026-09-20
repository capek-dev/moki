import { Window } from 'happy-dom';
import { strict as assert } from 'node:assert';
const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemorySettings } = await import('@renderer/components/settings/memory-settings');
const snapshot = { assistants: [], conversations: [], messages: [], attachments: [] };
let memory = { enabled: false, recall: 'basic', jevConsent: false, jevModel: 'jev-latest', revision: 1 };
const learning = { enabled: true, paused: false, provider: 'deepseek', model: 'deepseek-flash', revision: 1 };
let listener: (r: any) => void = () => {};
let count = 0;
const run = { id: 'run', status: 'failed', outcome: 'failed', provider: 'deepseek', model: 'deepseek-flash', attempt: 3, createdAt: 1, appliedCount: 0, rejectedCount: 0, error: 'Timed out', sourceManifest: 'captured' };
let resolveDetail: ((r: any) => void) | undefined;
const saved = { id: 'memory', revision: 1, text: 'Saved fact', kind: 'fact', state: 'active', pinned: false, core: false, recordedAt: 1, validFrom: null, validUntil: null };
let partial = false;
let openedRun = '';
(dom as any).moki = {
  openLearningReview: async (id: string) => { openedRun = id; },
  onState: (fn: any) => { listener = fn; return () => { listener = () => {}; }; },
  request: async (r: any) => {
    assert.ok(++count < 100, 'request loop');
    const base = { snapshot };
    switch (r.method) {
      case 'memorySettings': return { ...base, memory };
      case 'learningSettings': return { ...base, learning };
      case 'learningHistory': return { ...base, learning, learningHistory: [] };
      case 'learningRuns': return { ...base, learning, learningRuns: { runs: [run], offset: 0, nextOffset: null } };
      case 'learningRunDetail': return new Promise(resolve => { resolveDetail = resolve; });
      case 'memoryList': return { ...base, memory, memoryPage: { memories: [saved], query: null, offset: 0, nextOffset: null } };
      case 'memoryRead': return { ...base, memoryDetail: { ...saved, textPage: saved.text, textNextOffset: partial ? 10 : null, evidence: [], evidenceTruncated: false } };
      case 'memoryConnections': return { ...base, memoryConnections: { connections: [], nextOffset: null } };
      case 'memoryRecallHistory': return { ...base, memoryRecallHistory: { records: [], offset: 0, nextOffset: null } };
      case 'memorySetEnabled': memory = { ...memory, enabled: r.enabled, revision: memory.revision + 1 }; listener({ ...base, memory }); return { ...base, memory };
      default: return base;
    }
  },
};
const root = createRoot(dom.document.body as unknown as HTMLElement);
await act(async () => { root.render(<MemorySettings />); });
assert.ok(dom.document.body.textContent.includes('Memory: Off'));
assert.ok(dom.document.body.textContent.includes('Learning: Blocked: enable memory'));
const initial = count;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
assert.equal(count, initial, 'mount must settle');
const checkbox = dom.document.querySelector('[aria-label="Enable basic memory recall"]') as any;
await act(async () => checkbox.click());
assert.ok(dom.document.body.textContent.includes('Memory: On'));
assert.ok(dom.document.body.textContent.includes('Learning: Enabled'));
const inspect = [...dom.document.querySelectorAll('button')].find(b => b.textContent.includes('Inspect run'))!;
await act(async () => inspect.click());
await act(async () => listener({ snapshot, learning }));
await act(async () => resolveDetail!({ snapshot, learningRunDetail: { run, sources: [], proposals: [], changes: [], truncated: false } }));
assert.ok(dom.document.body.textContent.includes('Run details'), 'run list refresh must not cancel detail');
const settled = count;
await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
assert.equal(count, settled);
const button = (text: string) => [...dom.document.querySelectorAll('button')].find(b => b.textContent.includes(text))!;
await act(async () => button('Open review').click());
assert.equal(openedRun, run.id);
await act(async () => button('Saved fact').click());
const textarea = dom.document.querySelector('#memory-text') as any;
await act(async () => {
  Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Unsaved personal edit');
  textarea.dispatchEvent(new dom.Event('input', { bubbles: true }));
});
await act(async () => listener({ snapshot, memory: { ...memory, revision: memory.revision + 1 } }));
assert.equal((dom.document.querySelector('#memory-text') as any).value, 'Unsaved personal edit');
assert.ok(dom.document.body.textContent.includes('Your draft is preserved'));
assert.equal((button('Save text') as any).disabled, true);
await act(async () => button('Back to list').click());
partial = true;
await act(async () => button('Saved fact').click());
assert.equal((dom.document.querySelector('#memory-text') as any).disabled, true);
assert.equal((button('Save text') as any).disabled, true);
await act(async () => root.unmount());
const { LearningReviewWindow } = await import('@renderer/windows/learning-review-window');
let reviewListener: (value: any) => void = () => {};
let reviewReads = 0;
let reviewText: string | undefined = 'initial output';
(dom as any).moki = {
  onLearningReview: (fn: any) => { reviewListener = fn; return () => { reviewListener = () => {}; }; },
  onRuntimeError: () => () => {},
  readLearningReview: async () => { reviewReads++; return { detail: { run: { ...run, status: 'running' }, sources: [{ messageId: 'source', role: 'user', state: 'current', currentText: '<script>not executable</script>' }], proposals: [] }, output: reviewText === undefined ? undefined : { runId: run.id, text: reviewText } }; },
};
const reviewRoot = createRoot(dom.document.body as unknown as HTMLElement);
await act(async () => reviewRoot.render(<LearningReviewWindow />));
assert.ok(dom.document.body.textContent.includes('initial output'));
assert.equal(dom.document.querySelector('textarea'), null);
assert.equal(dom.document.querySelector('script'), null);
await act(async () => reviewListener({ output: { runId: run.id, text: 'live output' } }));
assert.ok(dom.document.body.textContent.includes('live output'));
assert.equal(reviewReads, 1, 'streaming must not trigger reads');
reviewText = undefined;
await act(async () => reviewListener({ refresh: true }));
assert.ok(!dom.document.body.textContent.includes('live output'));
await act(async () => reviewRoot.unmount());
await dom.happyDOM.close();
console.log('Memory settings mounted interactions passed');
