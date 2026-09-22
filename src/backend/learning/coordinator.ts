import {
  LEARNING_DISPATCH_TIMEOUT_MS,
  LEARNING_MAX_AUTOMATIC_ATTEMPTS,
  LEARNING_MAX_PENDING_MS,
  LEARNING_REVIEW_TIMEOUT_MS,
  type LearningClock,
  type LearningProposal,
  type LearningReviewer,
  type LearningReviewerOutcome,
  type LearningReviewContext,
  type LearningRunSummary,
  type LearningSettingsState,
  type LearningSource,
  type LearningTimer,
} from '@backend/learning/contracts';

export interface LearningRepository {
  recoverInterrupted(now: number): void;
  canSchedule(): boolean;
  noteActivity(now: number): void;
  settings(): LearningSettingsState;
  schedulableBatch(): {
    cursor: number;
    run: LearningRunSummary | null;
    sources: LearningSource[];
  } | null;
  scheduleTiming(now: number): {
    idleUntil: number;
    cooldownUntil: number;
    pendingSince: number;
  };
  beginRun(now: number): { run: LearningRunSummary; sources: LearningSource[] } | null;
  getRun(runId: string): LearningRunSummary | null;
  failRun(runId: string, error: unknown, cancelled: boolean, now: number, bumpAttempt?: boolean): void;
  claimRun(runId: string, now: number): LearningRunSummary;
  reviewSourcesForRun(runId: string): LearningSource[];
  reviewContext(): LearningReviewContext;
  saveProposals(
    runId: string,
    proposals: readonly LearningProposal[],
    rejections?: ReadonlyMap<number, string>,
  ): void;
  applyRun(runId: string, now: number, signal?: AbortSignal): LearningRunSummary;
  retryRun(runId: string, now: number): LearningRunSummary;
  cancelRun(runId?: string, now?: number): void;
}

export interface LearningSchedulerEvents {
  learningDue(run: LearningRunSummary, settings: LearningSettingsState): void;
  stateChanged?(): void;
}

const systemTimer: LearningTimer = {
  setTimeout,
  clearTimeout,
};

const systemClock: LearningClock = {
  now: Date.now,
  timer: systemTimer,
};

export class LearningCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private dispatched?: { runId: string };
  private running?: { abort: AbortController; runId: string; generation: number };
  private generation = 0;
  private closed = false;

  constructor(
    private readonly repository: LearningRepository,
    private readonly events: LearningSchedulerEvents,
    private readonly clock: LearningClock = systemClock,
  ) {
    // An open run from a previous process cannot be resumed safely.
    this.repository.recoverInterrupted(this.clock.now());
    this.arm();
  }

  onActivity() {
    if (this.repository.canSchedule()) {
      this.repository.noteActivity(this.clock.now());
    }
    this.arm();
  }

  onSettingsChanged() {
    if (!this.repository.canSchedule()) {
      this.cancel();
      return;
    }
    this.arm();
  }

  private timerApi(): LearningTimer {
    return this.clock.timer ?? systemTimer;
  }

  /**
   * Schedule one bounded dispatch for the current cursor range. Blocked or
   * exhausted ranges do not re-arm, which prevents failed runs from spinning.
   */
  private arm() {
    if (this.closed) return;

    const settings = this.repository.settings();
    if (!settings.enabled || settings.paused || this.running) {
      this.clearTimer();
      return;
    }

    const range = this.repository.schedulableBatch();
    if (!range) {
      this.clearTimer();
      return;
    }

    const existing = range.run;
    if (existing) {
      const terminalOrRunning =
        existing.status === 'running' ||
        existing.status === 'complete' ||
        existing.status === 'cancelled';
      const alreadyDispatched =
        existing.status === 'pending' && this.dispatched?.runId === existing.id;
      const attemptsExhausted =
        existing.status === 'failed' &&
        existing.attempt >= LEARNING_MAX_AUTOMATIC_ATTEMPTS;

      if (terminalOrRunning || existing.cancelRequested || alreadyDispatched || attemptsExhausted) {
        this.clearTimer();
        return;
      }
    }

    const now = this.clock.now();
    const timing = this.repository.scheduleTiming(now);
    const dueAt = Math.max(
      timing.cooldownUntil,
      Math.min(timing.idleUntil, timing.pendingSince + LEARNING_MAX_PENDING_MS),
    );

    this.clearTimer();
    this.timer = this.timerApi().setTimeout(() => {
      this.timer = undefined;
      void this.fire();
    }, Math.max(0, dueAt - now));
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    this.timerApi().clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async fire() {
    if (this.running || this.closed) return;

    const range = this.repository.schedulableBatch();
    if (!range) {
      this.arm();
      return;
    }

    const existing = range.run;
    if (
      existing?.status === 'pending' &&
      !existing.cancelRequested &&
      this.dispatched?.runId !== existing.id
    ) {
      // An explicit retry is pending and only needs its host dispatch.
      this.startDispatchWatchdog(existing.id);
      this.events.learningDue(existing, this.repository.settings());
      return;
    }

    if (
      existing &&
      (existing.status !== 'failed' ||
        existing.cancelRequested ||
        existing.attempt >= LEARNING_MAX_AUTOMATIC_ATTEMPTS)
    ) {
      this.arm();
      return;
    }

    const started = this.repository.beginRun(this.clock.now());
    if (!started) {
      this.arm();
      return;
    }

    this.events.stateChanged?.();
    this.startDispatchWatchdog(started.run.id);
    this.events.learningDue(started.run, this.repository.settings());
  }

  /**
   * Bound the handoff to Electron. If the host never starts the review, the
   * pending run becomes a visible failure and waits for the normal cooldown.
   */
  private startDispatchWatchdog(runId: string) {
    this.clearDispatchWatchdog();
    this.dispatched = { runId };
    this.watchdog = this.timerApi().setTimeout(() => {
      this.watchdog = undefined;
      void this.dispatchTimeout(runId);
    }, LEARNING_DISPATCH_TIMEOUT_MS);
  }

  private clearDispatchWatchdog(runId?: string) {
    if (runId !== undefined && this.dispatched?.runId !== runId) return;

    this.dispatched = undefined;
    if (this.watchdog === undefined) return;

    this.timerApi().clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private async dispatchTimeout(runId: string) {
    if (this.closed || this.dispatched?.runId !== runId) return;

    this.dispatched = undefined;
    const run = this.repository.getRun(runId);
    if (run?.status === 'pending') {
      this.repository.failRun(
        runId,
        new Error('Learning review dispatch timed out. Learning will retry after the cooldown.'),
        false,
        this.clock.now(),
        true,
      );
      this.events.stateChanged?.();
    }
    this.arm();
  }

  async run(
    reviewer: LearningReviewer,
    signal?: AbortSignal,
    requestedRunId?: string,
  ): Promise<LearningRunSummary | null> {
    if (this.running) throw new Error('Learning review is already running.');

    const target = requestedRunId
      ? this.pendingRun(requestedRunId)
      : this.repository.beginRun(this.clock.now());
    if (!target) return null;

    const runId = target.run.id;
    const abort = new AbortController();
    const generation = ++this.generation;
    this.running = { abort, runId, generation };
    this.clearDispatchWatchdog(runId);

    const forwardAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let timedOut = false;
    try {
      if (abort.signal.aborted) {
        throw new Error('Learning review was cancelled.');
      }

      this.repository.claimRun(runId, this.clock.now());
      this.events.stateChanged?.();

      // Manifest and source checks stay inside the guarded run so stale input
      // becomes a visible failure instead of leaving a pending run behind.
      const sources = requestedRunId
        ? this.repository.reviewSourcesForRun(runId)
        : target.sources!;
      const context = this.repository.reviewContext();
      const review = reviewer(sources, abort.signal, context);
      const proposals = await this.waitForReview(review, abort, () => {
        timedOut = true;
      });

      if (generation !== this.running?.generation || abort.signal.aborted) {
        throw new Error('Learning review was cancelled.');
      }

      const outcome: LearningReviewerOutcome =
        'proposals' in proposals ? proposals : { proposals };
      this.repository.saveProposals(runId, outcome.proposals, outcome.rejections);
      const result = this.repository.applyRun(runId, this.clock.now(), abort.signal);
      this.events.stateChanged?.();
      return result;
    } catch (error) {
      this.repository.failRun(
        runId,
        error,
        abort.signal.aborted && !timedOut,
        this.clock.now(),
      );
      this.events.stateChanged?.();
      return null;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.running?.generation === generation) {
        this.running = undefined;
      }
      this.arm();
    }
  }

  private pendingRun(runId: string): {
    run: LearningRunSummary;
    sources: LearningSource[] | undefined;
  } | null {
    const run = this.repository.getRun(runId);
    if (!run || run.status !== 'pending' || run.cancelRequested) return null;
    return { run, sources: undefined };
  }

  private waitForReview(
    review: ReturnType<LearningReviewer>,
    abort: AbortController,
    onTimeout: () => void,
  ): Promise<readonly import('@backend/learning/contracts').LearningProposal[] | LearningReviewerOutcome> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timerApi = this.timerApi();
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        timerApi.clearTimeout(timer);
        abort.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        finish(() => reject(new Error('Learning review was cancelled.')));
      };
      const timer = timerApi.setTimeout(() => {
        onTimeout();
        finish(() => reject(new Error('Learning reviewer timed out.')));
        abort.abort();
      }, LEARNING_REVIEW_TIMEOUT_MS);

      abort.signal.addEventListener('abort', onAbort, { once: true });
      void review.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  retry(runId: string) {
    if (this.closed) throw new Error('Learning coordinator is closed.');
    if (
      (this.running && this.running.runId !== runId) ||
      (this.dispatched && this.dispatched.runId !== runId)
    ) {
      throw new Error('Another learning review is active.');
    }

    const run = this.repository.retryRun(runId, this.clock.now());
    this.events.stateChanged?.();

    // Historical retry is independent of the future-only cursor.
    if (
      run.status === 'pending' &&
      !run.cancelRequested &&
      this.dispatched?.runId !== run.id
    ) {
      this.clearTimer();
      this.startDispatchWatchdog(run.id);
      this.events.learningDue(run, this.repository.settings());
    }
    return run;
  }

  fail(runId: string, error: unknown) {
    this.clearDispatchWatchdog(runId);
    this.repository.failRun(runId, error, false, this.clock.now());
    if (this.running?.runId === runId) {
      this.running.abort.abort();
    }
    this.events.stateChanged?.();
    this.arm();
  }

  cancel(runId?: string) {
    this.repository.cancelRun(runId, this.clock.now());
    this.clearDispatchWatchdog(runId);
    if (runId === undefined || this.running?.runId === runId) {
      this.running?.abort.abort();
    }
    this.events.stateChanged?.();
    this.arm();
  }

  close() {
    this.closed = true;
    this.cancel();
  }
}
