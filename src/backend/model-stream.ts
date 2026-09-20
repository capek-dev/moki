import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createOpenAiResponsesModel } from '@capekai/core/providers';
import { getModelWithMetadata } from '@capekai/core/execution';
import { createSingleModelConfiguration, withRuntimeConfiguration } from '@capekai/core/configuration';
import { describeError, type Generate, type TurnToolOutput } from '@backend/chat';
import { requireModel, requireThinking } from '@shared/models';
import { estimateModelContext, ContextBudgetError, type ContextUpdate } from '@shared/context';
import { formatClockContext, systemClock, withClockContext, type Clock } from '@shared/clock';

// Multi-step tool loop budget. The AI SDK has no unlimited mode (omitting
// stopWhen defaults to a single step), so the maximum expressible cap is used;
// the reply deadline is what actually terminates runaway loops.
const TOOL_STEP_BUDGET = Number.MAX_SAFE_INTEGER;

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
export function createGenerate(fetcher: typeof fetch = fetch, clock: Clock = systemClock): Generate {
  return async function* (turn, signal) {
  const catalogModel = requireModel(turn.provider, turn.model);
  const inputLimitTokens = catalogModel.contextWindow - catalogModel.maxOutputTokens;
  if (inputLimitTokens <= 0) throw new Error('The selected model has no verified input budget. Select another model.');
  const notifyContext = (update: ContextUpdate) => turn.context?.onUpdate(update);
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
  // Enabled agent tools (Cua Driver plus connected apps) run inline with the reply; the step bound keeps a
  // tool-looping model from running away past the reply deadline.
  const modelTools = turn.tools && turn.tools.length
    ? Object.fromEntries(turn.tools.map((entry) => [entry.name, tool({
        description: entry.description || entry.name,
        inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: (args: unknown) => entry.execute(args),
        toModelOutput: ({ output }: { output: string | TurnToolOutput }) => typeof output === 'string' ? { type: 'text', value: output } : output.modelOutput,
      })]))
    : undefined;
  const stream = streamText({
    model: metadata.model,
    ...(metadata.useProviderInstructions ? {} : { system: turn.instructions || 'Be helpful, clear, and kind.' }),
    messages: turn.messages,
    tools: modelTools,
    stopWhen: modelTools ? stepCountIs(TOOL_STEP_BUDGET) : undefined,
    providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
    prepareStep: ({ messages, stepNumber }) => {
      // prepareStep runs immediately before every provider request, including
      // the request after a tool result. Read the clock here rather than at
      // Chat.start so long-running tool loops do not reuse stale context.
      signal.throwIfAborted();
      const instructions = withClockContext(turn.instructions || 'Be helpful, clear, and kind.', formatClockContext(clock));
      const estimate = estimateModelContext(messages, instructions, turn.tools ?? [], turn.context?.imageAccounting);
      const requestNumber = stepNumber + 1;
      notifyContext({ type: 'estimate', requestNumber, estimate, contextWindowTokens: catalogModel.contextWindow, outputReserveTokens: catalogModel.maxOutputTokens });
      if (estimate.totalTokens > inputLimitTokens) throw new ContextBudgetError(estimate.totalTokens, inputLimitTokens, catalogModel.contextWindow, catalogModel.maxOutputTokens, requestNumber);
      if (metadata.useProviderInstructions) {
        return {
          providerOptions: {
            ...providerOptions,
            openai: { ...providerOptions.openai, instructions },
          } as Parameters<typeof streamText>[0]['providerOptions'],
        };
      }
      return { system: instructions };
    },
    onStepFinish: ({ stepNumber, usage }) => {
      notifyContext({ type: 'provider', requestNumber: stepNumber + 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens });
    },
    abortSignal: signal,
    maxRetries: 0,
    // No temperature/max-output keys: Codex rejects some shared parameters.
    // Reasoning is consumed but not displayed or stored.
    onError: () => {},
  });
  for await (const event of stream.fullStream) {
    // Terminal diagnostics only; the renderer keeps its generic messages.
    if (event.type === 'error') {
      console.error(`[moki] model stream error provider=${turn.provider} model=${turn.model}: ${describeError(event.error)}`);
      throw event.error;
    }
    if (event.type === 'finish' && event.finishReason !== 'stop') {
      // 'tool-calls' means the step budget ended the turn while the model
      // still wanted more tools; partial text stands. Log other reasons.
      console.error(`[moki] model stream ended early reason=${event.finishReason}${event.finishReason === 'tool-calls' ? ` (step budget ${TOOL_STEP_BUDGET} reached)` : ''} provider=${turn.provider} model=${turn.model}`);
      if (event.finishReason !== 'tool-calls') throw new Error('Model did not complete its reply.');
    }
    if (event.type === 'text-delta') yield event.text;
  }
  };
}
export const generate = createGenerate();
