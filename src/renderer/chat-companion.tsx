import { useEffect, useState } from 'react';
import type { Message } from '../shared/protocol';
import { Companion, type Appearance, type Mood } from './companion';

interface Activity {
  /** Already scoped to the selected conversation, in transcript order. */
  messages: readonly Message[];
  starting: boolean;
  failed: boolean;
}

export function chatMood({ messages, starting, failed }: Activity): Mood {
  if (failed) return 'attention';
  const streaming = messages.find((message) => message.role === 'assistant' && message.status === 'streaming');
  if (streaming) return streaming.text ? 'working' : 'thinking';
  if (starting) return 'thinking';
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') return 'idle';
  if (latest.status === 'failed') return 'attention';
  if (latest.status === 'complete') return 'done';
  return 'idle';
}

export function scheduleDoneReset(reset: () => void): () => void {
  const timer = setTimeout(reset, 3000);
  return () => clearTimeout(timer);
}

export function ChatCompanion({ appearance, ...activity }: Activity & { appearance: Appearance }) {
  const mood = chatMood(activity);
  const replyId = activity.messages.at(-1)?.id;
  const [settledReply, setSettledReply] = useState<string>();
  useEffect(() => {
    if (mood !== 'done' || !replyId) return;
    return scheduleDoneReset(() => setSettledReply(replyId));
  }, [mood, replyId]);
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const update = () => setPaused(document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return <Companion appearance={appearance} mood={mood === 'done' && settledReply === replyId ? 'idle' : mood} paused={paused} />;
}
