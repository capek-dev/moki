import type { Thinking } from '@shared/models';
export type Provider = 'deepseek' | 'codex';
export interface Assistant { id: string; name: string; provider: Provider; instructions: string; appearance?: import('@shared/appearance').Appearance }
export interface Conversation { id: string; assistantId: string; title: string; model: string | null; thinking: Thinking | null }
export interface Message { id: string; conversationId: string; text: string; role: 'user' | 'assistant'; status: 'complete' | 'streaming' | 'interrupted' | 'failed'; model: string | null; assistantName: string | null; error: string | null; thinking: Thinking | null }
export interface Attachment { id: string; messageId: string; mime: 'image/png'; byteSize: number; width: number; height: number }
export type AttachmentDraft = Omit<Attachment, 'messageId'>;
export interface Snapshot { assistants: Assistant[]; conversations: Conversation[]; messages: Message[]; attachments: Attachment[] }
export type CaptureEvent =
  | { type: 'capture-started' | 'capture-cancelled' }
  | { type: 'capture-ready'; attachment: AttachmentDraft }
  | { type: 'capture-failed'; message: string };
export type Request =
  | { method: 'snapshot'; conversationId?: string }
  | { method: 'selectModel'; conversationId: string; model: string; thinking?: Thinking | null }
  | { method: 'cancelChat'; conversationId: string }
  | { method: 'saveAssistant'; assistant: Assistant }
  | { method: 'createConversation'; assistantId: string }
  | { method: 'saveMessage'; conversationId: string; text: string }
  | { method: 'revertMessage'; conversationId: string; messageId: string };
export interface Result { snapshot: Snapshot; conversationId?: string; revision?: number }
export type ProviderCommand =
  | { action: 'status' | 'startCodex' | 'cancelCodex' }
  | { action: 'saveDeepseek'; key: string }
  | { action: 'completeCodex'; url: string }
  | { action: 'disconnect'; provider: Provider };
export interface ProviderState { error?: string; revision: number; deepseek: { connected: boolean }; codex: { connected: boolean }; signingIn: boolean }
export interface ChatRequest { conversationId: string; text: string; model: string; thinking?: Thinking | null; attachmentIds?: string[]; editOf?: string }
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
  startCapture(): Promise<void>;
  removeCapture(id: string): Promise<void>;
  openScreenRecordingSettings(): Promise<void>;
  onCapture(listener: (event: CaptureEvent) => void): () => void;
  onState(listener: (result: Result) => void): () => void;
}

declare global { interface Window { moki: DesktopAPI } }
