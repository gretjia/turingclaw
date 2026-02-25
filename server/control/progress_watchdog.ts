import type { Pointer, State } from '../engine.js';

export interface ProgressWatchdogOptions {
  windowSize?: number;
  consecutiveThreshold?: number;
  repeatThreshold?: number;
}

export type WatchdogReason = 'consecutive_repeat' | 'window_repeat';

export interface WatchdogDecision {
  triggered: boolean;
  reason?: WatchdogReason;
  fingerprint: string;
  occurrences: number;
  totalTriggers: number;
}

function stateHead(state: string): string {
  return state
    .split('\n')[0]
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

function makeFingerprint(state: State, pointer: Pointer): string {
  return `${pointer.trim()}|${stateHead(state)}`;
}

export class ProgressWatchdog {
  private readonly windowSize: number;
  private readonly consecutiveThreshold: number;
  private readonly repeatThreshold: number;

  private lastFingerprint = '';
  private consecutiveCount = 0;
  private triggerCount = 0;
  private recent: string[] = [];

  constructor(options: ProgressWatchdogOptions = {}) {
    this.windowSize = options.windowSize ?? 12;
    this.consecutiveThreshold = options.consecutiveThreshold ?? 4;
    this.repeatThreshold = options.repeatThreshold ?? 6;
  }

  public inspect(state: State, pointer: Pointer): WatchdogDecision {
    const fingerprint = makeFingerprint(state, pointer);

    if (fingerprint === this.lastFingerprint) {
      this.consecutiveCount += 1;
    } else {
      this.lastFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }

    this.recent.push(fingerprint);
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }

    const occurrences = this.recent.filter((item) => item === fingerprint).length;
    const consecutiveTrigger = this.consecutiveCount >= this.consecutiveThreshold;
    const windowTrigger = occurrences >= this.repeatThreshold;

    if (consecutiveTrigger || windowTrigger) {
      this.triggerCount += 1;
      this.recent = [];
      this.lastFingerprint = '';
      this.consecutiveCount = 0;

      return {
        triggered: true,
        reason: consecutiveTrigger ? 'consecutive_repeat' : 'window_repeat',
        fingerprint,
        occurrences,
        totalTriggers: this.triggerCount,
      };
    }

    return {
      triggered: false,
      fingerprint,
      occurrences,
      totalTriggers: this.triggerCount,
    };
  }
}

export function watchdogRecoveryState(reason: WatchdogReason, fingerprint: string, previous: State): State {
  const previousHead = stateHead(previous);
  return [
    `[WATCHDOG_RECOVERY:${reason}] ${fingerprint}`,
    'You are stuck in repeated behavior.',
    'Next action must differ from recent repeated pointer/state pattern.',
    'Prioritize unfinished required artifacts before HALT.',
    `[PREV_Q] ${previousHead}`,
  ].join('\n');
}
