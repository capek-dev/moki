import type { ToolCallRecord } from '@shared/protocol';
import type { Toolbag } from '@backend/integrations/cua';
import type {
  BuiltInForegroundSource,
  BuiltInToolSource,
  ExternalToolSource,
  TurnTool,
  TurnToolOutput,
} from '@backend/core/chat/contracts';
import type { SelectionEvidence } from '@backend/tools/scoring';
import type { ToolLoadingConfig } from '@shared/tool-loading';
import { describeError } from '@backend/core/error-description';
import { ToolBudgetError, describeMcpCall, mcpToolLabel } from '@shared/mcp';
import { cuaToolLabel, describeCuaCall } from '@shared/cua';

export interface LoadedChatTools {
  external?: Toolbag;
  builtIn?: Toolbag;
  tools: TurnTool[];
}

interface LoadChatToolsOptions {
  conversationId: string;
  signal: AbortSignal;
  evidence: SelectionEvidence;
  toolLoading?: ToolLoadingConfig;
  foregroundSource: BuiltInForegroundSource;
  toolCalls: ToolCallRecord[];
  externalSource?: ExternalToolSource;
  builtInSource?: BuiltInToolSource;
  scheduleFlush(): void;
}

function summarizeToolText(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 160) : '';
}

async function executeTool(
  owner: Toolbag,
  name: string,
  args: unknown,
  signal: AbortSignal,
  toolCalls: ToolCallRecord[],
  scheduleFlush: () => void,
): Promise<string | TurnToolOutput> {
  signal.throwIfAborted();
  const appTool = name.includes('__');
  const entry: ToolCallRecord = {
    name,
    label: appTool ? mcpToolLabel(name) : cuaToolLabel(name),
    detail: appTool ? describeMcpCall(name, args) : describeCuaCall(name, args),
    summary: null,
    status: 'running',
    at: Date.now(),
  };
  toolCalls.push(entry);
  scheduleFlush();

  try {
    const result = await owner.execute(name, args);
    entry.status = result.isError ? 'failed' : 'ok';
    entry.summary = summarizeToolText(result.text);
    if (result.isError) return `Tool error: ${result.text.slice(0, 2_000)}`;
    return result.modelOutput
      ? { text: result.text, modelOutput: result.modelOutput }
      : result.text;
  } catch (error) {
    if (signal.aborted) throw error;
    entry.status = 'failed';
    entry.summary = (error instanceof Error ? error.message : 'Tool failed.').slice(0, 160);
    return `Tool failed: ${entry.summary}`;
  } finally {
    scheduleFlush();
  }
}

/** Load toolbags, preserve built-in precedence, and sort model-facing tools. */
export async function loadChatTools(
  options: LoadChatToolsOptions,
): Promise<LoadedChatTools> {
  let external: Toolbag | undefined;
  let builtIn: Toolbag | undefined;

  if (options.externalSource) {
    try {
      external = await options.externalSource(
        options.signal,
        options.evidence,
        options.toolLoading,
      );
    } catch (error) {
      if (error instanceof ToolBudgetError) throw error;
      console.error(
        `[moki] tool source unavailable, continuing without tools: ${describeError(error)}`,
      );
    }
  }
  if (options.signal.aborted) {
    external?.close();
    options.signal.throwIfAborted();
  }

  try {
    if (options.builtInSource) {
      builtIn = await options.builtInSource(
        options.conversationId,
        options.signal,
        options.foregroundSource,
      );
    }
    options.signal.throwIfAborted();
  } catch (error) {
    builtIn?.close();
    external?.close();
    throw error;
  }

  const owners = new Map<string, Toolbag>();
  const definitions: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }> = [];
  for (const source of [builtIn, external]) {
    if (!source) continue;
    for (const definition of source.tools) {
      if (owners.has(definition.name)) {
        console.error(`[moki] built-in tool kept duplicate name ${definition.name}`);
        continue;
      }
      owners.set(definition.name, source);
      definitions.push(definition);
    }
  }

  const tools = definitions
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition): TurnTool => ({
      ...definition,
      execute: (args) => executeTool(
        owners.get(definition.name)!,
        definition.name,
        args,
        options.signal,
        options.toolCalls,
        options.scheduleFlush,
      ),
    }));

  return { external, builtIn, tools };
}
