import type { Pointer, State, Transition } from '../engine.js';
import { canonicalizeHaltTransition, isHaltLikeState } from './halt_protocol.js';

export interface GuardIssue {
  code: string;
  message: string;
}

export interface GuardContext {
  currentState: State;
  currentPointer: Pointer;
}

export interface GuardResult {
  transition: Transition;
  trapped: boolean;
  issues: GuardIssue[];
}

function isMainTapePointer(pointer: string): boolean {
  const normalized = pointer.trim();
  return normalized === './MAIN_TAPE.md' || normalized === 'MAIN_TAPE.md';
}

function isAllowedPointer(pointer: string): boolean {
  const normalized = pointer.trim();
  if (!normalized) return false;
  if (normalized === 'HALT') return true;
  if (normalized === 'sys://error_recovery') return true;
  if (normalized.startsWith('sys://trap/')) return true;
  if (normalized.startsWith('./') || normalized.startsWith('/')) return true;
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return true;
  if (normalized.startsWith('$ ') || normalized.startsWith('tty://')) return true;

  return (
    /^[A-Za-z0-9._/-]{1,240}$/.test(normalized) &&
    !normalized.includes('..') &&
    (normalized.includes('/') || normalized.includes('.'))
  );
}

function pointerClass(pointer: string): 'halt' | 'trap' | 'system' | 'shell' | 'url' | 'file' | 'invalid' {
  const normalized = pointer.trim();
  if (!normalized) return 'invalid';
  if (normalized === 'HALT') return 'halt';
  if (normalized.startsWith('sys://trap/')) return 'trap';
  if (normalized === 'sys://error_recovery') return 'system';
  if (normalized.startsWith('$ ') || normalized.startsWith('tty://')) return 'shell';
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return 'url';
  if (normalized.startsWith('./') || normalized.startsWith('/')) return 'file';
  if (
    /^[A-Za-z0-9._/-]{1,240}$/.test(normalized) &&
    !normalized.includes('..') &&
    (normalized.includes('/') || normalized.includes('.'))
  ) {
    return 'file';
  }
  return 'invalid';
}

function trapTransition(code: string, message: string, context: GuardContext): Transition {
  const trapState = `[TRAP:${code}] ${message}\n[PREV_Q] ${context.currentState}`;
  return {
    q_next: trapState,
    s_prime: '👆🏻',
    d_next: `sys://trap/${code.toLowerCase()}`,
  };
}

function allowsMainTapeWrite(nextState: string): boolean {
  return nextState.includes('[ALLOW_MAIN_TAPE_WRITE]');
}

export function applyTransitionGuard(transition: Transition, context: GuardContext): GuardResult {
  const issues: GuardIssue[] = [];
  const nextPointer = transition.d_next.trim();
  const currentPointer = context.currentPointer.trim();
  const nextState = transition.q_next;
  const writing = transition.s_prime.trim() !== '👆🏻';

  if (!isAllowedPointer(nextPointer)) {
    const message = `Invalid pointer emitted: "${nextPointer}"`;
    issues.push({ code: 'INVALID_POINTER', message });
    return {
      transition: trapTransition('INVALID_POINTER', message, context),
      trapped: true,
      issues,
    };
  }

  const nextIsHalt = nextPointer === 'HALT';
  const stateIsHalt = isHaltLikeState(nextState);
  if (nextIsHalt || stateIsHalt) {
    if (nextIsHalt !== stateIsHalt) {
      const message = `HALT normalized from q_next="${nextState}" d_next="${nextPointer}"`;
      issues.push({ code: 'HALT_NORMALIZED', message });
    }
    return {
      transition: canonicalizeHaltTransition(transition),
      trapped: false,
      issues,
    };
  }

  if (writing && isMainTapePointer(currentPointer) && !allowsMainTapeWrite(nextState)) {
    const message = 'Write to MAIN_TAPE.md blocked by guard policy';
    issues.push({ code: 'MAIN_TAPE_WRITE_BLOCKED', message });
    return {
      transition: {
        q_next: `[GUARD_BLOCKED:MAIN_TAPE_WRITE] ${nextState}`.trim(),
        s_prime: '👆🏻',
        d_next: nextPointer || context.currentPointer,
      },
      trapped: false,
      issues,
    };
  }

  const currentClass = pointerClass(currentPointer);
  const nextClass = pointerClass(nextPointer);
  if (currentClass === 'halt' && nextClass !== 'halt') {
    const message = `Transition from HALT pointer to ${nextPointer} is not allowed`;
    issues.push({ code: 'INVALID_POINTER_CLASS', message });
    return {
      transition: trapTransition('INVALID_POINTER_CLASS', message, context),
      trapped: true,
      issues,
    };
  }

  return {
    transition,
    trapped: false,
    issues,
  };
}
