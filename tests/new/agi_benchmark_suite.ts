import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuringEngine, type IChronos, type IOracle, type State, type Slice, type Transition } from '../../server/engine.js';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';
import { TuringRuntime } from '../../server/runtime.js';

interface BenchmarkResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

class NoopChronos implements IChronos {
  public async engrave(_message: string): Promise<void> {
    // no-op in benchmark mode
  }
}

class GaiaMiniOracle implements IOracle {
  private answer = 'UNKNOWN';

  public async collapse(_discipline: string, q: State, s: Slice): Promise<Transition> {
    if (q.startsWith('q_0')) {
      return { q_next: 'q_1: READ_WEB', s_prime: '👆🏻', d_next: 'http://127.0.0.1:43199/info' };
    }

    if (q.startsWith('q_1')) {
      const match = s.match(/France\s*[:|-]\s*Paris/i);
      this.answer = match ? 'Paris' : 'UNKNOWN';
      return { q_next: 'q_2: WRITE_ANSWER', s_prime: '👆🏻', d_next: './answer_gaia.txt' };
    }

    return { q_next: 'HALT', s_prime: this.answer, d_next: 'HALT' };
  }
}

class SweMiniOracle implements IOracle {
  public async collapse(_discipline: string, q: State, s: Slice): Promise<Transition> {
    if (q.startsWith('q_0')) {
      return { q_next: 'q_1: PATCH_FILE', s_prime: '👆🏻', d_next: './calculator.js' };
    }

    if (q.startsWith('q_1')) {
      const fixed = s.replace('return a + b; // BUG', 'return a * b;');
      return { q_next: 'q_2: RUN_TEST', s_prime: fixed, d_next: '$ node ./test_calculator.js' };
    }

    if (s.includes('PASS')) {
      return { q_next: 'HALT', s_prime: '👆🏻', d_next: 'HALT' };
    }

    return { q_next: 'q_1: PATCH_RETRY', s_prime: '👆🏻', d_next: './calculator.js' };
  }
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withTempWorkspace<T>(prefix: string, work: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await work(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runGaiaMini(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withTempWorkspace('turingclaw-gaia-', async (workspace) => {
    const server = createServer((req, res) => {
      if (req.url === '/info') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Country Capitals</h1><p>France: Paris</p><p>Japan: Tokyo</p></body></html>');
        return;
      }
      res.writeHead(404).end('not found');
    });

    await new Promise<void>((resolve) => server.listen(43199, '127.0.0.1', () => resolve()));

    try {
      await writeFile(path.join(workspace, 'MAIN_TAPE.md'), 'Find the capital of France.\n', 'utf8');

      const engine = new TuringEngine(
        new UnixPhysicalManifold(workspace),
        new GaiaMiniOracle(),
        new NoopChronos(),
        'GAIA mini discipline',
      );

      await runWithTimeout(engine.ignite('q_0: START', './MAIN_TAPE.md'), 10_000);

      const answer = (await readFile(path.join(workspace, 'answer_gaia.txt'), 'utf8')).trim();
      assert.equal(answer, 'Paris');

      return {
        name: 'GAIA-mini (tool use + web read)',
        passed: true,
        detail: `answer=${answer}`,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'GAIA-mini (tool use + web read)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
}

async function runSweMini(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withTempWorkspace('turingclaw-swe-', async (workspace) => {
    try {
      await writeFile(path.join(workspace, 'MAIN_TAPE.md'), 'Fix multiply bug and run tests.\n', 'utf8');
      await writeFile(
        path.join(workspace, 'calculator.js'),
        [
          'export function add(a, b) { return a + b; }',
          'export function multiply(a, b) { return a + b; // BUG }',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(workspace, 'test_calculator.js'),
        [
          "import { multiply } from './calculator.js';",
          "if (multiply(3, 4) !== 12) {",
          "  console.error('FAIL');",
          '  process.exit(1);',
          '}',
          "console.log('PASS');",
        ].join('\n'),
        'utf8',
      );

      const engine = new TuringEngine(
        new UnixPhysicalManifold(workspace),
        new SweMiniOracle(),
        new NoopChronos(),
        'SWE mini discipline',
      );

      await runWithTimeout(engine.ignite('q_0: START', './MAIN_TAPE.md'), 10_000);

      const testOutput = await new UnixPhysicalManifold(workspace).observe('$ node ./test_calculator.js');
      assert.match(testOutput, /PASS/);

      return {
        name: 'SWE-mini (bugfix + test pass)',
        passed: true,
        detail: testOutput.trim(),
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'SWE-mini (bugfix + test pass)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    }
  });
}

async function runArcMiniReset(): Promise<BenchmarkResult> {
  const started = Date.now();

  return withTempWorkspace('turingclaw-arc-reset-', async (workspace) => {
    try {
      const promptFile = path.join(workspace, 'prompt.sh');
      await writeFile(promptFile, '# prompt\n', 'utf8');

      const runtime = new TuringRuntime({ workspaceDir: workspace, promptFile });
      await runtime.init();

      // Simulate a previous run that halted with rich marker text.
      await writeFile(path.join(workspace, '.reg_q'), '[HALT] completed-episode', 'utf8');
      await writeFile(path.join(workspace, '.reg_d'), './MAIN_TAPE.md', 'utf8');

      await runtime.appendUserMessage('start next episode');
      await new Promise((resolve) => setTimeout(resolve, 200));

      const qAfter = (await readFile(path.join(workspace, '.reg_q'), 'utf8')).trim();
      assert.equal(qAfter, 'q_0: SYSTEM_BOOTING');

      return {
        name: 'ARC-mini (episode reset after HALT marker)',
        passed: true,
        detail: `q_after=${qAfter}`,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        name: 'ARC-mini (episode reset after HALT marker)',
        passed: false,
        detail: error?.message ?? String(error),
        durationMs: Date.now() - started,
      };
    }
  });
}

async function main(): Promise<void> {
  const results = await Promise.all([runGaiaMini(), runSweMini(), runArcMiniReset()]);

  console.log('\n=== AGI MINI BENCHMARK RESULTS ===');
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
  console.error('[agi_benchmark_suite] FAIL', error);
  process.exitCode = 1;
});
