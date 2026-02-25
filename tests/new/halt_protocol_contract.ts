import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuringEngine, type IChronos, type IOracle, type Pointer, type Slice, type State, type Transition } from '../../server/engine.js';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';
import { applyTransitionGuard } from '../../server/control/transition_guard.js';
import { isHaltLikeState } from '../../server/control/halt_protocol.js';

class NoopChronos implements IChronos {
  public async engrave(_message: string): Promise<void> {
    // no-op in contract test
  }
}

class GuardedSingleStepOracle implements IOracle {
  private used = false;
  public observedTransitions: Transition[] = [];

  public async collapse(_discipline: string, q: State, _s: Slice, d: Pointer = './MAIN_TAPE.md'): Promise<Transition> {
    const raw: Transition = this.used
      ? { q_next: 'HALT', s_prime: '👆🏻', d_next: 'HALT' }
      : { q_next: 'HALT_COMPLETE', s_prime: '👆🏻', d_next: 'HALT' };
    this.used = true;
    const guarded = applyTransitionGuard(raw, { currentState: q, currentPointer: d }).transition;
    this.observedTransitions.push(guarded);
    return guarded;
  }
}

async function withWorkspace<T>(work: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'turingclaw-halt-contract-'));
  try {
    return await work(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assert.equal(isHaltLikeState('HALT'), true);
  assert.equal(isHaltLikeState('HALT_COMPLETE'), true);
  assert.equal(isHaltLikeState('[HALT] done'), true);
  assert.equal(isHaltLikeState('q_1: WORKING'), false);

  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, 'MAIN_TAPE.md'), '# test\n', 'utf8');
    const oracle = new GuardedSingleStepOracle();
    const engine = new TuringEngine(
      new UnixPhysicalManifold(workspace),
      oracle,
      new NoopChronos(),
      'halt protocol contract',
    );

    await engine.ignite('q_0: START', './MAIN_TAPE.md');
    assert.ok(oracle.observedTransitions.length >= 1, 'expected at least one transition');
    assert.equal(oracle.observedTransitions[0].q_next, 'HALT');
    assert.equal(oracle.observedTransitions[0].d_next, 'HALT');
  });

  console.log('[halt_protocol_contract] PASS');
}

main().catch((error) => {
  console.error('[halt_protocol_contract] FAIL', error);
  process.exitCode = 1;
});

