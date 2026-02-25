import { EventEmitter } from 'events';
import { constants as fsConstants } from 'fs';
import { access, appendFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { TuringEngine, type IOracle, type IPhysicalManifold, type Pointer, type Slice, type State, type Transition } from './engine.js';
import { UnixPhysicalManifold } from './adapters/manifold.js';
import { StatelessOracle } from './adapters/oracle.js';
import { GitChronos } from './adapters/chronos.js';

export type RuntimeStatus = 'idle' | 'running' | 'error';

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  q: string;
  d: string;
  tape: string;
  error: string | null;
}

const DEFAULT_Q = 'q_0: SYSTEM_BOOTING';
const DEFAULT_D = './MAIN_TAPE.md';

function isTerminalState(q: string): boolean {
  const normalized = q.trim();
  return normalized === 'HALT' || normalized.includes('[HALT]');
}

function isShellPointer(pointer: string): boolean {
  return pointer.startsWith('$ ') || pointer.startsWith('tty://');
}

function isUrlPointer(pointer: string): boolean {
  return pointer.startsWith('http://') || pointer.startsWith('https://');
}

class RegisteringOracle implements IOracle {
  constructor(
    private readonly inner: IOracle,
    private readonly qPath: string,
    private readonly dPath: string,
    private readonly onState: (q: string, d: string) => Promise<void>,
  ) {}

  public async collapse(discipline: string, q: State, s: Slice): Promise<Transition> {
    const transition = await this.inner.collapse(discipline, q, s);
    const qNext = transition.q_next.trim() || DEFAULT_Q;
    const dNext = transition.d_next.trim() || DEFAULT_D;

    await writeFile(this.qPath, `${qNext}\n`, 'utf8');
    await writeFile(this.dPath, `${dNext}\n`, 'utf8');
    await this.onState(qNext, dNext);

    return {
      ...transition,
      q_next: qNext,
      d_next: dNext,
    };
  }
}

class BroadcastingManifold implements IPhysicalManifold {
  constructor(
    private readonly inner: IPhysicalManifold,
    private readonly onInterfere: (d: Pointer) => Promise<void>,
  ) {}

  public async observe(d: Pointer): Promise<Slice> {
    return this.inner.observe(d);
  }

  public async interfere(d: Pointer, s_prime: Slice): Promise<void> {
    await this.inner.interfere(d, s_prime);
    await this.onInterfere(d);
  }
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'ignore',
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

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(target: string, content: string): Promise<void> {
  if (!(await exists(target))) {
    await writeFile(target, content, 'utf8');
  }
}

export interface RuntimeOptions {
  workspaceDir?: string;
  promptFile?: string;
}

export class TuringRuntime extends EventEmitter {
  private readonly workspaceDir: string;
  private readonly promptFile: string;
  private readonly qRegister: string;
  private readonly dRegister: string;
  private readonly mainTape: string;
  private readonly lockFile: string;

  private initialized = false;
  private workspaceRootReal: string | null = null;
  private status: RuntimeStatus = 'idle';
  private lastError: string | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(options: RuntimeOptions = {}) {
    super();
    this.workspaceDir = path.resolve(process.cwd(), options.workspaceDir ?? process.env.TURING_WORKSPACE ?? '.turing_workspace');
    this.promptFile = path.resolve(process.cwd(), options.promptFile ?? 'turing_prompt.sh');
    this.qRegister = path.join(this.workspaceDir, '.reg_q');
    this.dRegister = path.join(this.workspaceDir, '.reg_d');
    this.mainTape = path.join(this.workspaceDir, 'MAIN_TAPE.md');
    this.lockFile = path.join(this.workspaceDir, '.runtime_lock');
  }

  public async init(): Promise<void> {
    if (this.initialized) return;

    await mkdir(this.workspaceDir, { recursive: true });

    if (!(await exists(path.join(this.workspaceDir, '.git')))) {
      await run('git', ['init'], this.workspaceDir);
    }

    await ensureFile(this.mainTape, '# MAIN_TAPE\n\n');
    await ensureFile(this.qRegister, `${DEFAULT_Q}\n`);
    await ensureFile(this.dRegister, `${DEFAULT_D}\n`);
    this.workspaceRootReal = await realpath(this.workspaceDir);

    this.initialized = true;
    await this.broadcastState();
    await this.broadcastTape();
  }

  public async appendUserMessage(message: string): Promise<void> {
    await this.init();

    const content = message.trim();
    if (!content) return;

    const block = [
      '',
      `## USER_INPUT ${new Date().toISOString()}`,
      content,
      '',
    ].join('\n');

    await appendFile(this.mainTape, block, 'utf8');

    const currentQ = await this.readRegister(this.qRegister, DEFAULT_Q);
    if (isTerminalState(currentQ)) {
      await writeFile(this.qRegister, `${DEFAULT_Q}\n`, 'utf8');
      await writeFile(this.dRegister, `${DEFAULT_D}\n`, 'utf8');
      void this.broadcastState();
    }

    void this.broadcastTape();
    this.startIfIdle();
  }

  public async getSnapshot(): Promise<RuntimeSnapshot> {
    await this.init();

    const [q, d, tape] = await Promise.all([
      this.readRegister(this.qRegister, DEFAULT_Q),
      this.readRegister(this.dRegister, DEFAULT_D),
      this.readTape(),
    ]);

    return {
      status: this.status,
      q,
      d,
      tape,
      error: this.lastError,
    };
  }

  public async listWorkspaceFiles(): Promise<string[]> {
    await this.init();

    const files: string[] = [];
    const stack: string[] = [this.workspaceDir];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const relative = path.relative(this.workspaceDir, absolute);
        if (!relative) continue;
        if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) continue;

        if (entry.isDirectory()) {
          stack.push(absolute);
        } else {
          files.push(relative);
        }
      }
    }

    files.sort();
    return files;
  }

  public async readWorkspaceFile(relativePath: string): Promise<string> {
    await this.init();

    const target = path.resolve(this.workspaceDir, relativePath);
    if (!this.isInsideWorkspace(target)) {
      throw new Error('Path escapes workspace');
    }

    const resolvedTarget = await realpath(target);
    if (!this.isInsideWorkspace(resolvedTarget)) {
      throw new Error('Path escapes workspace');
    }

    const details = await stat(resolvedTarget);
    if (details.isDirectory()) {
      throw new Error('Requested path is a directory');
    }

    return readFile(resolvedTarget, 'utf8');
  }

  private startIfIdle(): void {
    if (this.status === 'running') return;
    if (this.runPromise) return;

    this.status = 'running';
    this.lastError = null;
    void this.broadcastStatus();

    this.runPromise = this.runLoop().finally(() => {
      this.runPromise = null;
    });
  }

  private async runLoop(): Promise<void> {
    const lock = await this.acquireLock();
    if (!lock) {
      this.status = 'idle';
      await this.broadcastStatus();
      return;
    }

    try {
      const disciplinePrompt = await this.loadPrompt();
      const [q, d] = await Promise.all([
        this.readRegister(this.qRegister, DEFAULT_Q),
        this.readRegister(this.dRegister, DEFAULT_D),
      ]);

      const manifold = new BroadcastingManifold(
        new UnixPhysicalManifold(this.workspaceDir),
        async (pointer: Pointer) => {
          if (this.isMainTapePointer(pointer)) {
            await this.broadcastTape();
          }
        },
      );

      const oracle = new RegisteringOracle(
        new StatelessOracle(),
        this.qRegister,
        this.dRegister,
        async () => {
          await this.broadcastState();
        },
      );

      const chronos = new GitChronos(this.workspaceDir);
      const engine = new TuringEngine(manifold, oracle, chronos, disciplinePrompt);

      await engine.ignite(q, d);
      this.status = 'idle';
      await this.broadcastState();
      await this.broadcastTape();
      await this.broadcastStatus();
    } catch (error: any) {
      this.status = 'error';
      this.lastError = error?.message ?? String(error);
      await this.broadcastStatus();
    } finally {
      await this.releaseLock();
    }
  }

  private async loadPrompt(): Promise<string> {
    if (await exists(this.promptFile)) {
      return readFile(this.promptFile, 'utf8');
    }

    return [
      '# TURING DISCIPLINE',
      'Operate as a stateless transition function.',
      'Output must match Transition {q_next, s_prime, d_next}.',
    ].join('\n');
  }

  private async readRegister(registerPath: string, fallback: string): Promise<string> {
    if (!(await exists(registerPath))) {
      return fallback;
    }

    const content = (await readFile(registerPath, 'utf8')).trim();
    return content || fallback;
  }

  private async readTape(): Promise<string> {
    if (!(await exists(this.mainTape))) return '';
    return readFile(this.mainTape, 'utf8');
  }

  private isMainTapePointer(pointer: string): boolean {
    if (isUrlPointer(pointer) || isShellPointer(pointer) || pointer === 'sys://error_recovery') {
      return false;
    }

    const absolute = path.isAbsolute(pointer)
      ? path.resolve(pointer)
      : path.resolve(this.workspaceDir, pointer);

    return absolute === this.mainTape;
  }

  private async acquireLock(): Promise<boolean> {
    try {
      await writeFile(this.lockFile, `${process.pid}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const recovered = await this.clearStaleLock();
      if (!recovered) return false;

      try {
        await writeFile(this.lockFile, `${process.pid}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        return true;
      } catch (retryError: any) {
        if (retryError?.code === 'EEXIST') {
          return false;
        }
        throw retryError;
      }
    }
  }

  private async releaseLock(): Promise<void> {
    await rm(this.lockFile, { force: true });
  }

  private async clearStaleLock(): Promise<boolean> {
    try {
      const raw = (await readFile(this.lockFile, 'utf8')).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && this.isProcessAlive(pid)) {
        return false;
      }
    } catch {
      // If lock cannot be read, treat as stale and try cleanup.
    }

    await rm(this.lockFile, { force: true });
    return true;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  private isInsideWorkspace(target: string): boolean {
    const base = this.workspaceRootReal ?? this.workspaceDir;
    const normalized = path.resolve(target);
    return normalized === base || normalized.startsWith(`${base}${path.sep}`);
  }

  private async broadcastStatus(): Promise<void> {
    this.emit('status', this.status);
  }

  private async broadcastState(): Promise<void> {
    const [q, d] = await Promise.all([
      this.readRegister(this.qRegister, DEFAULT_Q),
      this.readRegister(this.dRegister, DEFAULT_D),
    ]);

    this.emit('state', { q, d });
  }

  private async broadcastTape(): Promise<void> {
    const tape = await this.readTape();
    this.emit('tape', tape);
  }
}
