import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';

async function run(): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'turingclaw-manifold-'));
  const manifold = new UnixPhysicalManifold(baseDir);

  try {
    const missing = await manifold.observe('./missing.txt');
    assert.equal(missing, '[FILE_NOT_FOUND]');

    await manifold.interfere('./notes/hello.txt', 'hello world');
    const stored = await manifold.observe('./notes/hello.txt');
    assert.equal(stored, 'hello world');

    const diskRead = await readFile(path.join(baseDir, 'notes/hello.txt'), 'utf8');
    assert.equal(diskRead, 'hello world');

    const shellOut = await manifold.observe('$ echo CONTRACT_OK');
    assert.match(shellOut, /CONTRACT_OK/);

    const recovery = await manifold.observe('sys://error_recovery');
    assert.equal(recovery, '');

    console.log('[manifold_contract] PASS');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('[manifold_contract] FAIL', error);
  process.exitCode = 1;
});
