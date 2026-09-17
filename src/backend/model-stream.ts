import { streamText } from 'ai';
import { createOpenAiResponsesModel } from '@capekai/core/providers';
import { getModelWithMetadata } from '@capekai/core/execution';
import { createSingleModelConfiguration, withRuntimeConfiguration } from '@capekai/core/configuration';
import type { Generate } from '@backend/chat';
import { requireThinking } from '@shared/models';

export function codexFetch(access: string, accountId: string, fetcher: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses') throw new Error('Unexpected Codex endpoint.');
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${access}`);
    headers.set('ChatGPT-Account-Id', accountId);
    headers.set('originator', 'moki');
    return fetcher('https://chatgpt.com/backend-api/codex/responses', {
      method: request.method, headers, body: await request.text(), signal: request.signal, redirect: 'error',
    });
  }) as typeof fetch;
}
export function createGenerate(fetcher: typeof fetch = fetch): Generate {
  return async function* (turn, signal) {
  const credentials = turn.credentials;
  const metadata = credentials.provider === 'codex'
    ? createOpenAiResponsesModel({ modelId: turn.model, apiKey: 'codex-oauth', fetch: codexFetch(credentials.access, credentials.accountId, fetcher), systemPrompt: turn.instructions, sessionId: turn.conversationId })
    : await withRuntimeConfiguration({
      ...createSingleModelConfiguration({ providerId: 'deepseek', modelId: turn.model }),
      getApiKey: (provider) => provider === 'deepseek' ? credentials.key : undefined,
    }, () => getModelWithMetadata({ modelId: turn.model, providerId: 'deepseek' }));
  const thinking = requireThinking(turn.provider, turn.model, turn.thinking);
  const providerOptions = { ...metadata.providerOptions };
  if (thinking) {
    const key = turn.provider === 'codex' ? 'openai' : 'deepseek';
    providerOptions[key] = { ...providerOptions[key], reasoningEffort: thinking,
      ...(turn.provider === 'deepseek' ? { thinking: { type: 'adaptive' } } : {}),
    };
  }
  signal.throwIfAborted();
  const stream = streamText({
    model: metadata.model,
    ...(metadata.useProviderInstructions ? {} : { system: turn.instructions || 'Be helpful, clear, and kind.' }),
    messages: turn.messages,
    providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
    abortSignal: signal,
    maxRetries: 0,
    // No temperature/max-output keys: Codex rejects some shared parameters.
    // No tools are supplied. Reasoning is consumed but not displayed or stored.
    onError: () => {},
  });
  for await (const event of stream.fullStream) {
    if (event.type === 'error') throw event.error;
    if (event.type === 'finish' && event.finishReason !== 'stop') throw new Error('Model did not complete its reply.');
    if (event.type === 'text-delta') yield event.text;
  }
  };
}
export const generate = createGenerate();
