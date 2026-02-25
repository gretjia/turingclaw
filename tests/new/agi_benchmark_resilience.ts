import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { TuringEngine, type IChronos, type IOracle, type Pointer, type Slice, type State, type Transition } from '../../server/engine.js';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';
import { GitChronos } from '../../server/adapters/chronos.js';

const execFileAsync = promisify(execFile);

interface BenchmarkResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

class NoopChronos implements IChronos {
  public async engrave(_message: string): Promise<void> {
    // no-op for controlled benchmark
  }
}

class SequenceOracle implements IOracle {
  private index = 0;

  constructor(private readonly steps: Transition[]) {}

  public async collapse(_discipline: string, _q: State, _s: Slice): Promise<Transition> {
    const next = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;
    return next;
  }
}

class RegisteringOracle implements IOracle {
  constructor(
    private readonly inner: IOracle,
    private readonly qPath: string,
    private readonly dPath: string,
  ) {}

  public async collapse(discipline: string, q: State, s: Slice): Promise<Transition> {
    const transition = await this.inner.collapse(discipline, q, s);
    await writeFile(this.qPath, `${transition.q_next.trim()}\n`, 'utf8');
    await writeFile(this.dPath, `${transition.d_next.trim()}\n`, 'utf8');
    return transition;
  }
}

class SisyphusOracle implements IOracle {
  public async collapse(_discipline: string, q: State, s: Slice): Promise<Transition> {
    const output = s.toUpperCase();

    if (q.startsWith('q_0')) {
      return { q_next: 'q_1: ANALYZE_BUILD', s_prime: '👆🏻', d_next: '$ bash ./build.sh' };
    }

    if (q.includes('ANALYZE_BUILD')) {
      if (output.includes('SUCCESS')) {
        return { q_next: 'HALT', s_prime: '👆🏻', d_next: 'HALT' };
      }
      return { q_next: 'q_2: APPLY_FIX', s_prime: '👆🏻', d_next: '$ bash ./fix.sh' };
    }

    if (q.includes('APPLY_FIX')) {
      return { q_next: 'q_1: ANALYZE_BUILD', s_prime: '👆🏻', d_next: '$ bash ./build.sh' };
    }

    return { q_next: 'HALT', s_prime: '👆🏻', d_next: 'HALT' };
  }
}

async function withWorkspace<T>(prefix: string, work: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await work(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runLazarusMini(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withWorkspace('turingclaw-lazarus-', async (workspace) => {
    try {
      const qReg = path.join(workspace, '.reg_q');
      const dReg = path.join(workspace, '.reg_d');
      const manifold = new UnixPhysicalManifold(workspace);

      await writeFile(path.join(workspace, 'MAIN_TAPE.md'), 'lazarus benchmark\n', 'utf8');

      const firstOracle = new RegisteringOracle(
        new SequenceOracle([
          { q_next: 'q_1: AFTER_CRASH', s_prime: 'boot-sequence-complete', d_next: './state.log' },
        ]),
        qReg,
        dReg,
      );

      const engineBeforeCrash = new TuringEngine(manifold, firstOracle, new NoopChronos(), 'lazarus-mini');
      await engineBeforeCrash.tick('q_0: START', './MAIN_TAPE.md');

      const resumedQ = (await readFile(qReg, 'utf8')).trim();
      const resumedD = (await readFile(dReg, 'utf8')).trim();

      const secondOracle = new RegisteringOracle(
        new SequenceOracle([
          { q_next: 'HALT', s_prime: 'resumed-and-finished', d_next: 'HALT' },
        ]),
        qReg,
        dReg,
      );

      const engineAfterCrash = new TuringEngine(manifold, secondOracle, new NoopChronos(), 'lazarus-mini');
      await engineAfterCrash.ignite(resumedQ, resumedD);

      const stateLog = (await readFile(path.join(workspace, 'state.log'), 'utf8')).trim();
      assert.equal(stateLog, 'resumed-and-finished');

      return {
        name: 'Lazarus-mini (register-based resume)',
        passed: true,
        detail: `resume_q=${resumedQ}, resume_d=${resumedD}`,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'Lazarus-mini (register-based resume)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    }
  });
}

async function runSisyphusMini(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withWorkspace('turingclaw-sisyphus-', async (workspace) => {
    try {
      await writeFile(path.join(workspace, 'progress.txt'), '0\n', 'utf8');
      await writeFile(
        path.join(workspace, 'build.sh'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'p=$(cat ./progress.txt)',
          'if [ "$p" -ge 2 ]; then',
          '  echo "SUCCESS"',
          'else',
          '  echo "FAIL stage=$p"',
          '  exit 1',
          'fi',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );
      await writeFile(
        path.join(workspace, 'fix.sh'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'p=$(cat ./progress.txt)',
          'echo $((p + 1)) > ./progress.txt',
          'echo "FIX_APPLIED"',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o755 },
      );

      const engine = new TuringEngine(
        new UnixPhysicalManifold(workspace),
        new SisyphusOracle(),
        new NoopChronos(),
        'sisyphus-mini',
      );

      await engine.ignite('q_0: START', '$ bash ./build.sh');
      const finalProgress = Number.parseInt((await readFile(path.join(workspace, 'progress.txt'), 'utf8')).trim(), 10);
      assert.ok(finalProgress >= 2);

      return {
        name: 'Sisyphus-mini (loop-until-success)',
        passed: true,
        detail: `progress=${finalProgress}`,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'Sisyphus-mini (loop-until-success)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    }
  });
}

async function runChronosMini(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withWorkspace('turingclaw-chronos-', async (workspace) => {
    try {
      await execFileAsync('git', ['init'], { cwd: workspace });

      const chronos = new GitChronos(workspace);
      await writeFile(path.join(workspace, 'notes.txt'), 'tick-1\n', 'utf8');
      await chronos.engrave('[bench] tick 1');

      await writeFile(path.join(workspace, 'notes.txt'), 'tick-2\n', 'utf8');
      await chronos.engrave('[bench] tick 2');

      await chronos.engrave('[bench] empty');

      const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace });
      const commits = Number.parseInt(stdout.trim(), 10);
      assert.equal(commits, 2);

      return {
        name: 'Chronos-mini (git DAG commit semantics)',
        passed: true,
        detail: `commits=${commits}`,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'Chronos-mini (git DAG commit semantics)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    }
  });
}

async function main(): Promise<void> {
  const results = await Promise.all([runLazarusMini(), runSisyphusMini(), runChronosMini()]);

  console.log('\n=== AGI RESILIENCE BENCHMARK RESULTS ===');
  for (const result of results) {
    const badge = result.passed ? 'PASS' : 'FAIL';
    console.log(`${badge} | ${result.name} | ${result.durationMs}ms | ${result.detail}`);
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\nScore: ${passed}/${results.length}`);

  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[agi_benchmark_resilience] FAIL', error);
  process.exitCode = 1;
});
