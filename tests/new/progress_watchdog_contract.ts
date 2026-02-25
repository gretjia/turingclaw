import assert from 'node:assert/strict';
import { ProgressWatchdog, watchdogRecoveryState } from '../../server/control/progress_watchdog.js';

function testConsecutiveTrigger(): void {
  const watchdog = new ProgressWatchdog({
    windowSize: 6,
    consecutiveThreshold: 3,
    repeatThreshold: 5,
  });

  const a1 = watchdog.inspect('q_1: WORK', './a.txt');
  const a2 = watchdog.inspect('q_1: WORK', './a.txt');
  const a3 = watchdog.inspect('q_1: WORK', './a.txt');

  assert.equal(a1.triggered, false);
  assert.equal(a2.triggered, false);
  assert.equal(a3.triggered, true);
  assert.equal(a3.reason, 'consecutive_repeat');
  assert.equal(a3.totalTriggers, 1);
}

function testWindowTrigger(): void {
  const watchdog = new ProgressWatchdog({
    windowSize: 5,
    consecutiveThreshold: 10,
    repeatThreshold: 3,
  });

  const samples: Array<[string, string]> = [
    ['q_1: A', './a.txt'],
    ['q_1: B', './b.txt'],
    ['q_1: A', './a.txt'],
    ['q_1: B', './b.txt'],
    ['q_1: A', './a.txt'],
  ];

  let last = watchdog.inspect(samples[0][0], samples[0][1]);
  for (let i = 1; i < samples.length; i += 1) {
    last = watchdog.inspect(samples[i][0], samples[i][1]);
  }

  assert.equal(last.triggered, true);
  assert.equal(last.reason, 'window_repeat');
  assert.equal(last.totalTriggers, 1);
}

function testRecoveryState(): void {
  const recovered = watchdogRecoveryState('window_repeat', './MAIN_TAPE.md|q_2: WAIT', 'q_2: WAIT\nextra');
  assert.match(recovered, /^\[WATCHDOG_RECOVERY:window_repeat\]/);
  assert.match(recovered, /\[PREV_Q\] q_2: WAIT/);
}

function main(): void {
  testConsecutiveTrigger();
  testWindowTrigger();
  testRecoveryState();
  console.log('[progress_watchdog_contract] PASS');
}

main();
