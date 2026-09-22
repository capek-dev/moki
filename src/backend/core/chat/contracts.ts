import type { ModelMessage } from 'ai';
import type { ModelToolOutput, Toolbag } from '@backend/integrations/cua';
import type { SelectionEvidence } from '@backend/tools/scoring';
import type { ToolLoadingConfig } from '@shared/tool-loading';
import type { ContextTurn, ContextUpdate } from '@shared/context';
import type { Provider } from '@shared/protocol';
import type { Thinking } from '@shared/models';

export type Credentials =
  | { provider: 'deepseek'; key: string }
  | { provider: 'codex'; access: string; accountId: string };

export interface StartChatInput {
  conversationId: string;
  text: string;
  model: string;
  thinking?: Thinking | null;
  attachmentIds?: unknown[];
  editOf?: string;
  credentials: Credentials;
  toolLoading?: ToolLoadingConfig;
  memoryJevKey?: string;
}

export interface ValidatedStartChat {
  conversationId: string;
  text: string;
  model: string;
  thinking: Thinking | null;
  attachmentIds: string[];
  editOf?: string;
  credentials: Credentials;
  toolLoading?: ToolLoadingConfig;
  memoryJevKey?: string;
}

export interface TurnToolOutput {
  text: string;
  modelOutput: ModelToolOutput;
}

export interface TurnTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(args: unknown): Promise<string | TurnToolOutput>;
}

export interface Turn {
  conversationId: string;
  thinking?: Thinking | null;
  model: string;
  provider: Provider;
  instructions: string;
  messages: ModelMessage[];
  credentials: Credentials;
  tools?: TurnTool[];
  context?: {
    turn: ContextTurn;
    imageAccounting: import('@shared/context').ImageAccounting;
    onUpdate(update: ContextUpdate): void;
  };
}

export type Generate = (
  turn: Turn,
  signal: AbortSignal,
) => AsyncIterable<string | TurnToolOutput>;

export type BuiltInForegroundSource = {
  sourceMessageId: string;
  sourceRevision: number;
};

export type BuiltInToolSource = (
  conversationId: string,
  signal: AbortSignal,
  foregroundSource?: BuiltInForegroundSource,
) => Toolbag | Promise<Toolbag>;

export type ExternalToolSource = (
  signal: AbortSignal,
  evidence: SelectionEvidence,
  config?: ToolLoadingConfig,
) => Promise<Toolbag>;
