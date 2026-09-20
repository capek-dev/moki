import { useEffect, useRef, useState } from 'react';
import type { Result } from '@shared/protocol';
import type { LearningSettingsState } from '@shared/protocol';
import type { MemorySettingsState } from '@shared/memory';
import { Panel } from '@renderer/components/ui/panel';
import { acceptMemoryRevision } from '@renderer/lib/memory-settings-state';
import { errorMessage } from './format';

/** Compact status strip for the whole Memory tab. Each panel reports its own busy and error state. */
export function MemoryStatusSummary() {
  const [settings, setSettings] = useState<MemorySettingsState>();
  const [learning, setLearning] = useState<LearningSettingsState>();
  const [error, setError] = useState('');
  const memoryRevision = useRef(0);
  const learningRevision = useRef(0);

  useEffect(() => {
    let active = true;
    function acceptMemory(next: MemorySettingsState) {
      const decision = acceptMemoryRevision(memoryRevision.current, next.revision);
      if (!decision.accepted) return;
      memoryRevision.current = decision.revision;
      setSettings(next);
    }
    function acceptLearning(next: LearningSettingsState) {
      if (next.revision < learningRevision.current) return;
      learningRevision.current = next.revision;
      setLearning(next);
    }
    const unsubscribe = window.moki.onState((result: Result) => {
      if (!active) return;
      if (result.memory) acceptMemory(result.memory);
      if (result.learning) acceptLearning(result.learning);
    });
    void window.moki.request({ method: 'memorySettings' }).then(
      (result) => { if (active && result.memory) acceptMemory(result.memory); },
      (failure) => { if (active) setError(errorMessage(failure)); },
    );
    void window.moki.request({ method: 'learningSettings' }).then(
      (result) => { if (active && result.learning) acceptLearning(result.learning); },
      (failure) => { if (active) setError(errorMessage(failure)); },
    );
    return () => { active = false; unsubscribe(); };
  }, []);

  const memoryOn = settings?.enabled === true;
  const learningLabel = !learning || !settings ? 'Loading…'
    : !learning.enabled ? 'Off'
    : !memoryOn ? 'Blocked: enable memory'
    : learning.paused ? 'Paused'
    : 'Enabled';
  return <Panel aria-label="Memory status" className="grid gap-1">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
      <strong className="text-[13px]">Memory: {!settings ? 'Loading…' : memoryOn ? 'On' : 'Off'}</strong>
      <strong className="text-[13px]">Learning: {learningLabel}</strong>
    </div>
    <p className="text-[12px] text-ink-3">Status reflects saved settings. Provider availability is checked when a review starts.</p>
    {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
  </Panel>;
}
