#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { TuringEngine, type IOracle, type State, type Slice, type Transition } from './server/engine.js';
import { UnixPhysicalManifold } from './server/adapters/manifold.js';
import { StatelessOracle } from './server/adapters/oracle.js';
import { GitChronos } from './server/adapters/chronos.js';

const WORKSPACE_DIR = path.resolve(process.cwd(), process.env.TURING_WORKSPACE ?? '.turing_workspace');
const Q_REGISTER = path.join(WORKSPACE_DIR, '.reg_q');
const D_REGISTER = path.join(WORKSPACE_DIR, '.reg_d');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const PROMPT_FILE = path.resolve(process.cwd(), 'turing_prompt.sh');
const DEFAULT_Q = 'q_0: SYSTEM_BOOTING';
const DEFAULT_D = './MAIN_TAPE.md';

function isTerminalState(q: string): boolean {
  const normalized = q.trim();
  return normalized === 'HALT' || normalized.includes('[HALT]');
}

class RegisteringOracle implements IOracle {
  constructor(
    private readonly inner: IOracle,
    private readonly qPath: string,
    private readonly dPath: string,
  ) {}

  public async collapse(discipline: string, q: State, s: Slice): Promise<Transition> {
    const next = await this.inner.collapse(discipline, q, s);
    await writeFile(this.qPath, `${next.q_next.trim()}\n`, 'utf8');
    await writeFile(this.dPath, `${next.d_next.trim()}\n`, 'utf8');
    return next;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code ?? 1}`));
    });
  });
}

async function ensureWorkspace(): Promise<void> {
  await mkdir(WORKSPACE_DIR, { recursive: true });

  if (!(await exists(path.join(WORKSPACE_DIR, '.git')))) {
    await run('git', ['init'], WORKSPACE_DIR);
  }

  if (!(await exists(MAIN_TAPE))) {
    await writeFile(MAIN_TAPE, '# MAIN_TAPE\n\n', 'utf8');
  }
}

async function loadDisciplinePrompt(): Promise<string> {
  if (await exists(PROMPT_FILE)) {
    return readFile(PROMPT_FILE, 'utf8');
  }

  return [
    '# TURING DISCIPLINE',
    'Operate as a stateless transition function.',
    'Return strict JSON for Transition {q_next, s_prime, d_next}.',
  ].join('\n');
}

async function resolveInitialState(userTask: string | null): Promise<[State, string]> {
  if (userTask && userTask.trim()) {
    await writeFile(MAIN_TAPE, `${userTask.trim()}\n`, 'utf8');
    await writeFile(Q_REGISTER, `${DEFAULT_Q}\n`, 'utf8');
    await writeFile(D_REGISTER, `${DEFAULT_D}\n`, 'utf8');
    return [DEFAULT_Q, DEFAULT_D];
  }

  const hasQ = await exists(Q_REGISTER);
  const hasD = await exists(D_REGISTER);

  if (hasQ && hasD) {
    const q = (await readFile(Q_REGISTER, 'utf8')).trim() || DEFAULT_Q;
    const d = (await readFile(D_REGISTER, 'utf8')).trim() || DEFAULT_D;

    if (isTerminalState(q)) {
      await writeFile(Q_REGISTER, `${DEFAULT_Q}\n`, 'utf8');
      await writeFile(D_REGISTER, `${DEFAULT_D}\n`, 'utf8');
      return [DEFAULT_Q, DEFAULT_D];
    }

    return [q, d];
  }

  await writeFile(Q_REGISTER, `${DEFAULT_Q}\n`, 'utf8');
  await writeFile(D_REGISTER, `${DEFAULT_D}\n`, 'utf8');
  return [DEFAULT_Q, DEFAULT_D];
}

async function main(): Promise<void> {
  await ensureWorkspace();

  const disciplinePrompt = await loadDisciplinePrompt();
  const userTask = process.argv.slice(2).join(' ').trim();
  const [qInit, dInit] = await resolveInitialState(userTask || null);

  const manifold = new UnixPhysicalManifold(WORKSPACE_DIR);
  const oracle = new RegisteringOracle(new StatelessOracle(), Q_REGISTER, D_REGISTER);
  const chronos = new GitChronos(WORKSPACE_DIR);
  const engine = new TuringEngine(manifold, oracle, chronos, disciplinePrompt);

  await engine.ignite(qInit, dInit);
}

main().catch((error) => {
  console.error('[CLI FATAL]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
