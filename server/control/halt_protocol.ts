import type { Transition } from '../engine.js';

export function isHaltLikeState(state: string): boolean {
  const normalized = state.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized === 'HALT') return true;
  if (normalized.includes('[HALT]')) return true;
  return /\bHALT(?:_[A-Z0-9]+)?\b/.test(normalized);
}

export function canonicalHaltState(): string {
  return 'HALT';
}

export function canonicalizeHaltTransition(transition: Transition): Transition {
  return {
    ...transition,
    q_next: canonicalHaltState(),
    d_next: 'HALT',
  };
}

