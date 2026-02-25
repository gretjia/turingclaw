import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TuringRuntime } from '../../server/runtime.js';

async function run(): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'turingclaw-runtime-'));
  const promptFile = path.join(workspace, 'prompt.sh');
  await writeFile(promptFile, '# prompt\n', 'utf8');

  const runtime = new TuringRuntime({ workspaceDir: workspace, promptFile });

  try {
    await runtime.init();

    const initial = await runtime.getSnapshot();
    assert.equal(initial.q, 'q_0: SYSTEM_BOOTING');
    assert.equal(initial.d, './MAIN_TAPE.md');

    const started = Date.now();
    await runtime.appendUserMessage('contract-check message');
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 500, `appendUserMessage should be fast, got ${elapsedMs}ms`);

    const tape = await runtime.readWorkspaceFile('MAIN_TAPE.md');
    assert.match(tape, /contract-check message/);

    await assert.rejects(runtime.readWorkspaceFile('../../etc/passwd'));

    await symlink('/etc/passwd', path.join(workspace, 'escape-link'));
    await assert.rejects(runtime.readWorkspaceFile('escape-link'));

    const regQ = (await readFile(path.join(workspace, '.reg_q'), 'utf8')).trim();
    assert.ok(regQ.length > 0);

    console.log('[runtime_contract] PASS');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('[runtime_contract] FAIL', error);
  process.exitCode = 1;
});
