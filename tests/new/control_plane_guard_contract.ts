import assert from 'node:assert/strict';
import { applyTransitionGuard, type GuardContext } from '../../server/control/transition_guard.js';
import type { Transition } from '../../server/engine.js';

function mustTrap(input: Transition, ctx: GuardContext, expectedCode: string): void {
  const result = applyTransitionGuard(input, ctx);
  assert.equal(result.trapped, true, `expected trap for ${expectedCode}`);
  assert.ok(result.transition.d_next.startsWith('sys://trap/'), 'trap pointer should use sys://trap/*');
  assert.ok(
    result.transition.q_next.includes(`[TRAP:${expectedCode}]`),
    `trap state should include code ${expectedCode}`,
  );
}

function main(): void {
  mustTrap(
    { q_next: 'q_1: RUN', s_prime: '👆🏻', d_next: 'not a pointer ???' },
    { currentState: 'q_0: START', currentPointer: './MAIN_TAPE.md' },
    'INVALID_POINTER',
  );

  const normalizedFromStateOnly = applyTransitionGuard(
    { q_next: 'HALT_COMPLETE', s_prime: '👆🏻', d_next: './MAIN_TAPE.md' },
    { currentState: 'q_1: WRAPUP', currentPointer: './state.txt' },
  );
  assert.equal(normalizedFromStateOnly.trapped, false);
  assert.equal(normalizedFromStateOnly.transition.q_next, 'HALT');
  assert.equal(normalizedFromStateOnly.transition.d_next, 'HALT');

  const normalizedFromPointerOnly = applyTransitionGuard(
    { q_next: 'q_3: WRITE_RESULT', s_prime: '{"status":"done"}', d_next: 'HALT' },
    { currentState: 'q_2: FINALIZE', currentPointer: './result/RESULT.json' },
  );
  assert.equal(normalizedFromPointerOnly.trapped, false);
  assert.equal(normalizedFromPointerOnly.transition.q_next, 'HALT');
  assert.equal(normalizedFromPointerOnly.transition.d_next, 'HALT');

  const blockedMainTape = applyTransitionGuard(
    { q_next: 'q_2: WRITE', s_prime: 'overwrite', d_next: './result.txt' },
    { currentState: 'q_1: PLAN', currentPointer: './MAIN_TAPE.md' },
  );
  assert.equal(blockedMainTape.trapped, false);
  assert.equal(blockedMainTape.transition.s_prime, '👆🏻');
  assert.equal(blockedMainTape.transition.d_next, './result.txt');
  assert.match(blockedMainTape.transition.q_next, /^\[GUARD_BLOCKED:MAIN_TAPE_WRITE\]/);

  const allowed = applyTransitionGuard(
    {
      q_next: 'q_2: WRITE [ALLOW_MAIN_TAPE_WRITE]',
      s_prime: 'rewrite tape intentionally',
      d_next: './MAIN_TAPE.md',
    },
    { currentState: 'q_1: PLAN', currentPointer: './MAIN_TAPE.md' },
  );
  assert.equal(allowed.trapped, false);
  assert.equal(allowed.transition.d_next, './MAIN_TAPE.md');

  const valid = applyTransitionGuard(
    { q_next: 'HALT', s_prime: '👆🏻', d_next: 'HALT' },
    { currentState: 'q_9: DONE', currentPointer: './result/RESULT.json' },
  );
  assert.equal(valid.trapped, false);

  const normalizedHalt = applyTransitionGuard(
    { q_next: 'HALT_COMPLETE', s_prime: '👆🏻', d_next: 'HALT' },
    { currentState: 'q_9: DONE', currentPointer: './result/RESULT.json' },
  );
  assert.equal(normalizedHalt.trapped, false);
  assert.equal(normalizedHalt.transition.q_next, 'HALT');
  assert.equal(normalizedHalt.transition.d_next, 'HALT');

  const bracketHalt = applyTransitionGuard(
    { q_next: '[HALT] mission completed', s_prime: '👆🏻', d_next: 'HALT' },
    { currentState: 'q_9: DONE', currentPointer: './result/RESULT.json' },
  );
  assert.equal(bracketHalt.trapped, false);
  assert.equal(bracketHalt.transition.q_next, 'HALT');
  assert.equal(bracketHalt.transition.d_next, 'HALT');

  console.log('[control_plane_guard_contract] PASS');
}

main();
