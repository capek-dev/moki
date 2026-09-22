import type { Thinking } from '@shared/models';
import type { ContextTurn, ContextUsage } from '@shared/context';
import type { MemoryConnectionsPage, MemoryDetail, MemoryMutationAttribution, MemoryPage, MemoryRecallHistoryPage, MemoryRecallInspection, MemorySettingsState } from '@shared/memory';
import type { LearningHistoryRecord, LearningRunDetail, LearningRunPage, LearningSettingsState, LearningRunSummary } from '@backend/learning/learning';
import type { BrowserExtensionState } from '@shared/browser-extension';
import type { UpdaterCommand, UpdaterState } from '@shared/updater';
export type { MemoryConnectionsPage, MemoryDetail, MemoryMutationAttribution, MemoryPage, MemoryRecallHistoryPage, MemoryRecallInspection, MemorySettingsState } from '@shared/memory';
export type { LearningHistoryRecord, LearningRunDetail, LearningRunPage, LearningRunSummary, LearningSettingsState } from '@backend/learning/learning';
export type Provider = 'deepseek' | 'codex';
export interface Assistant { id: string; name: string; provider: Provider; instructions: string; appearance?: import('@shared/appearance').Appearance }
export interface Conversation { id: string; assistantId: string; title: string; model: string | null; thinking: Thinking | null }
// createdAt is UTC milliseconds, or null/undefined when unknown (legacy rows).
// revision counts published content versions of a message; bump rules live in
// Store.updateReply (plan 28).
export interface Message { id: string; conversationId: string; text: string; role: 'user' | 'assistant'; status: 'complete' | 'streaming' | 'interrupted' | 'failed'; model: string | null; assistantName: string | null; error: string | null; thinking: Thinking | null; createdAt?: number | null; revision?: number; toolCalls?: ToolCallRecord[] }
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
  | { method: 'revertMessage'; conversationId: string; messageId: string }
  | { method: 'cuaTools' }
  | { method: 'cuaSetTool'; tool: string; disabled: boolean }
  | { method: 'cuaSetEnabled'; enabled: boolean }
  | { method: 'mcpTools' }
  | { method: 'mcpAddServer'; name: string; kind: 'stdio' | 'http'; command?: string; url?: string }
  | { method: 'mcpRemoveServer'; server: string }
  | { method: 'mcpSetServer'; server: string; enabled: boolean }
  | { method: 'mcpSetTool'; server: string; tool: string; disabled: boolean }
  | { method: 'memorySettings' }
  | { method: 'memorySetEnabled'; enabled: boolean; expectedRevision: number }
  | { method: 'memorySetPolicy'; recall: 'basic' | 'jev'; jevConsent: boolean; jevModel: string; expectedRevision: number }
  | { method: 'memoryRecallHistory'; limit?: number; offset?: number }
  | { method: 'memoryList'; query?: string; limit?: number; offset?: number }
  | { method: 'memoryRead'; memoryId: string; expectedRevision?: number; offset?: number; textLimit?: number }
  | { method: 'memoryConnections'; memoryId: string; limit?: number; offset?: number }
  | { method: 'memoryUpdate'; memoryId: string; expectedRevision: number; text?: string; pinned?: boolean }
  | { method: 'memoryForget'; memoryId: string; expectedRevision: number }
  | { method: 'learningSettings' }
  | { method: 'learningSetEnabled'; enabled: boolean; expectedRevision: number }
  | { method: 'learningSetPaused'; paused: boolean; expectedRevision: number }
  | { method: 'learningSetProviderModel'; provider: Provider; model: string; expectedRevision: number }
  | { method: 'learningExcludeConversation'; conversationId: string; excluded: boolean }
  | { method: 'learningHistory'; limit?: number; offset?: number }
  | { method: 'learningRuns'; limit?: number; offset?: number }
  | { method: 'learningRunDetail'; runId: string; limit?: number }
  | { method: 'learningRetry'; runId: string }
  | { method: 'learningCancel'; runId?: string }
  | { method: 'learningUndo'; historyId: string; expectedRevision: number };
export interface LearningLiveOutput { runId: string; text: string }
export interface Result {
  learningLiveOutput?: LearningLiveOutput;
  learningLiveCleared?: boolean;
  snapshot: Snapshot;
  conversationId?: string;
  revision?: number;
  contextTurn?: ContextTurn;
  contextUsage?: ContextUsage;
  cua?: CuaState;
  mcp?: McpState;
  memory?: MemorySettingsState;
  memoryRecall?: MemoryRecallInspection;
  memoryRecallHistory?: MemoryRecallHistoryPage;
  memoryAttribution?: MemoryMutationAttribution;
  memoryPage?: MemoryPage;
  memoryDetail?: MemoryDetail;
  memoryConnections?: MemoryConnectionsPage;
  learning?: LearningSettingsState;
  learningExclusions?: string[];
  learningHistory?: LearningHistoryRecord[];
  learningRuns?: LearningRunPage;
  learningRunDetail?: LearningRunDetail;
  learningRun?: LearningRunSummary;
}
export type ProviderCommand =
  | { action: 'status' | 'startCodex' | 'cancelCodex' | 'resetUnreadable' }
  | { action: 'saveDeepseek'; key: string }
  | { action: 'completeCodex'; url: string }
  | { action: 'disconnect'; provider: Provider };
export interface ProviderState { error?: string; revision: number; deepseek: { connected: boolean }; codex: { connected: boolean }; signingIn: boolean }
export interface CuaTool { name: string; description: string }
export interface CuaState { enabled: boolean; connected: boolean; version: string | null; tools: CuaTool[]; disabled: string[]; error: string | null; weight: number }
// User-added MCP connections (config file is the source of truth). Tool names
// are the prefixed, model-facing ones (`server__tool`).
export interface McpTool { name: string; description: string }
export interface McpServerState { name: string; transport: 'stdio' | 'http'; enabled: boolean; connected: boolean; tools: McpTool[]; disabledTools: string[]; error: string | null; needsAuth: boolean; signedIn: boolean; stale: boolean; weight: number }
export interface McpState { servers: McpServerState[]; diagnostics: string[] }
// Spoken replies (plan 17 A): main synthesizes and pushes the speaking state;
// the renderer only submits text and reacts to events. No polling.
export interface SpeechState { speaking: boolean }
// Push-to-talk (plan 17 B): events from the native dictation helper, pushed
// from main to the window that started the session. `final` with an empty
// transcript means the session ended cleanly without more text.
export interface DictationIpcEvent { transcript?: string; final?: boolean; error?: string }
// Sign-in for web connections runs entirely in Electron main (browser OAuth,
// encrypted vault); the renderer only starts it and observes the outcome.
export type McpAuthCommand = { action: 'signIn'; server: string } | { action: 'signOut'; server: string };
export interface McpAuthResult { signedIn: boolean; note?: string }
// One agent tool invocation attached to an assistant reply. `label` is the
// friendly phrase, `detail` the argument digest, `summary` the result digest.
export interface ToolCallRecord { name: string; label: string; detail: string; summary: string | null; status: 'running' | 'ok' | 'failed'; at: number }
export interface ChatRequest { conversationId: string; text: string; model: string; thinking?: Thinking | null; attachmentIds?: string[]; editOf?: string }
export interface DesktopAPI {
  toolLoading(command: import('./tool-loading').ToolLoadingCommand): Promise<import('./tool-loading').ToolLoadingState>;
  onToolLoading(listener: (state: import('./tool-loading').ToolLoadingState) => void): () => void;
  chat(request: ChatRequest): Promise<Result>;
  onRuntimeError(listener: (message: string) => void): () => void;
  providers(command: ProviderCommand): Promise<ProviderState>;
  browserExtensionState(): Promise<BrowserExtensionState>;
  onBrowserExtension(listener: (state: BrowserExtensionState) => void): () => void;
  updater(command: UpdaterCommand): Promise<UpdaterState>;
  onUpdater(listener: (state: UpdaterState) => void): () => void;
  mcpAuth(command: McpAuthCommand): Promise<McpAuthResult>;
  speak(text: string): Promise<void>;
  stopSpeaking(): Promise<void>;
  onSpeech(listener: (state: SpeechState) => void): () => void;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  onDictation(listener: (event: DictationIpcEvent) => void): () => void;
  openSpeechRecognitionSettings(): Promise<void>;
  onProviders(listener: (state: ProviderState) => void): () => void;
  request(request: Request): Promise<Result>;
  openSettings(): Promise<void>;
  openHistory(): Promise<void>;
  openLearningReview(runId: string): Promise<void>;
  readLearningReview(): Promise<{ detail?: LearningRunDetail; output?: LearningLiveOutput }>;
  onLearningReview(listener: (value: { output?: LearningLiveOutput; refresh?: boolean }) => void): () => void;
  copyText(text: string): Promise<void>;
  openWebLink(url: string): Promise<void>;
  startCapture(): Promise<void>;
  removeCapture(id: string): Promise<void>;
  openScreenRecordingSettings(): Promise<void>;
  openMicrophoneSettings(): Promise<void>;
  onCapture(listener: (event: CaptureEvent) => void): () => void;
  onState(listener: (result: Result) => void): () => void;
}

declare global { interface Window { moki: DesktopAPI } }
