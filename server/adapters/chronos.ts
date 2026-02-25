import { spawn } from 'child_process';
import type { IChronos } from '../engine.js';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function isEmptyCommit(output: string): boolean {
  const content = output.toLowerCase();
  return content.includes('nothing to commit') || content.includes('no changes added to commit');
}

export class GitChronos implements IChronos {
  constructor(private readonly cwd: string = process.cwd()) {}

  public async engrave(message: string): Promise<void> {
    const safeMessage = message.replace(/\s+/g, ' ').trim() || '[Turing Tick]';

    const addResult = await run('git', ['add', '.'], this.cwd);
    if (addResult.code !== 0) {
      throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
    }

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'TuringEngine',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'turing@local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'TuringEngine',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'turing@local',
    };

    const commitResult = await run('git', ['commit', '-m', safeMessage], this.cwd, commitEnv);

    if (commitResult.code === 0) {
      return;
    }

    if (isEmptyCommit(`${commitResult.stdout}\n${commitResult.stderr}`)) {
      return;
    }

    throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
  }
}
