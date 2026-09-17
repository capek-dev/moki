import type { Thinking } from './models';
export type Provider = 'deepseek' | 'codex';
export interface Assistant { id: string; name: string; provider: Provider; instructions: string; appearance?: import('./appearance').Appearance }
export interface Conversation { id: string; assistantId: string; title: string; model: string | null; thinking: Thinking | null }
export interface Message { id: string; conversationId: string; text: string; role: 'user' | 'assistant'; status: 'complete' | 'streaming' | 'interrupted' | 'failed'; model: string | null; assistantName: string | null; error: string | null; thinking: Thinking | null }
export interface Snapshot { assistants: Assistant[]; conversations: Conversation[]; messages: Message[] }
export type Request =
  | { method: 'snapshot'; conversationId?: string }
  | { method: 'selectModel'; conversationId: string; model: string; thinking?: Thinking | null }
  | { method: 'cancelChat'; conversationId: string }
  | { method: 'saveAssistant'; assistant: Assistant }
  | { method: 'createConversation'; assistantId: string }
  | { method: 'saveMessage'; conversationId: string; text: string };
export interface Result { snapshot: Snapshot; conversationId?: string; revision?: number }
export type ProviderCommand =
  | { action: 'status' | 'startCodex' | 'cancelCodex' }
  | { action: 'saveDeepseek'; key: string }
  | { action: 'completeCodex'; url: string }
  | { action: 'disconnect'; provider: Provider };
export interface ProviderState { error?: string; revision: number; deepseek: { connected: boolean }; codex: { connected: boolean }; signingIn: boolean }
export interface ChatRequest { conversationId: string; text: string; model: string; thinking?: Thinking | null }
export interface DesktopAPI {
  chat(request: ChatRequest): Promise<Result>;
  onRuntimeError(listener: (message: string) => void): () => void;
  providers(command: ProviderCommand): Promise<ProviderState>;
  onProviders(listener: (state: ProviderState) => void): () => void;
  request(request: Request): Promise<Result>;
  openSettings(): Promise<void>;
  openHistory(): Promise<void>;
  copyText(text: string): Promise<void>;
  openWebLink(url: string): Promise<void>;
  onState(listener: (result: Result) => void): () => void;
}

declare global { interface Window { moki: DesktopAPI } }
