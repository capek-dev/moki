import type { Generate } from '@backend/chat';

/** Observe only visible output, never reasoning, tools or credentials. */
export function observeLearningReview(generate: Generate, publish: (text: string) => void, now = Date.now): Generate {
  return async function* (turn, signal) {
    signal.throwIfAborted();
    let output = '';
    let lastPublished = -Infinity;
    publish('');
    try {
      for await (const delta of generate(turn, signal)) {
        signal.throwIfAborted();
        output = (output + delta).slice(0, 64000);
        if (now() - lastPublished >= 100) { publish(output); lastPublished = now(); }
        yield delta;
      }
    } finally { if (!signal.aborted) publish(output); }
  };
}
