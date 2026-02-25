import { exec as execCb } from 'child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { promisify } from 'util';
import type { IPhysicalManifold, Pointer, Slice } from '../engine.js';

const exec = promisify(execCb);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function isUrlPointer(pointer: string): boolean {
  return pointer.startsWith('http://') || pointer.startsWith('https://');
}

function isShellPointer(pointer: string): boolean {
  return pointer.startsWith('$ ') || pointer.startsWith('tty://');
}

function isTrapPointer(pointer: string): boolean {
  return pointer.startsWith('sys://trap/');
}

function toCommand(pointer: string): string {
  if (pointer.startsWith('$ ')) return pointer.slice(2);
  if (pointer.startsWith('tty://')) return pointer.slice('tty://'.length);
  return pointer;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function htmlToPlainMarkdownLike(html: string): string {
  const noScripts = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  const withBreaks = noScripts
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ');

  const stripped = withBreaks
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return decodeHtmlEntities(stripped);
}

function toAbsolutePath(pointer: string, cwd: string): string {
  return isAbsolute(pointer) ? pointer : resolve(cwd, pointer);
}

function isMainTapePointer(pointer: string): boolean {
  const normalized = pointer.trim();
  return normalized === './MAIN_TAPE.md' || normalized === 'MAIN_TAPE.md';
}

export interface UnixPhysicalManifoldOptions {
  attachMainTapeContext?: boolean;
  mainTapeFile?: string;
}

export class UnixPhysicalManifold implements IPhysicalManifold {
  private readonly attachMainTapeContext: boolean;
  private readonly mainTapeFile: string;

  constructor(
    private readonly cwd: string = process.cwd(),
    options: UnixPhysicalManifoldOptions = {},
  ) {
    this.attachMainTapeContext =
      options.attachMainTapeContext ??
      process.env.TURING_ATTACH_MAIN_TAPE_CONTEXT === '1';
    this.mainTapeFile = options.mainTapeFile ?? 'MAIN_TAPE.md';
  }

  public async observe(d: Pointer): Promise<Slice> {
    if (d === 'sys://error_recovery') {
      return '';
    }
    if (isTrapPointer(d)) {
      return `[TRAP_POINTER] ${d}`;
    }

    let baseSlice: string;
    if (isUrlPointer(d)) {
      baseSlice = await this.observeUrl(d);
      return this.withMainTapeContext(d, baseSlice);
    }

    if (isShellPointer(d)) {
      baseSlice = await this.observeShell(d);
      return this.withMainTapeContext(d, baseSlice);
    }

    baseSlice = await this.observeFile(d);
    return this.withMainTapeContext(d, baseSlice);
  }

  public async interfere(d: Pointer, s_prime: Slice): Promise<void> {
    if (isUrlPointer(d) || isShellPointer(d) || d === 'sys://error_recovery' || isTrapPointer(d)) {
      return;
    }

    const filePath = toAbsolutePath(d, this.cwd);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, s_prime, 'utf8');
  }

  private async observeFile(pointer: string): Promise<string> {
    const filePath = toAbsolutePath(pointer, this.cwd);

    try {
      const fileStats = await stat(filePath);
      if (fileStats.isDirectory()) {
        const entries = await readdir(filePath);
        return entries.length === 0 ? '[EMPTY_DIRECTORY]' : entries.join('\n');
      }
      return await readFile(filePath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return '[FILE_NOT_FOUND]';
      }
      throw error;
    }
  }

  private async observeUrl(url: string): Promise<string> {
    const response = await fetch(url, { redirect: 'follow' });
    const raw = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('text/html') ? htmlToPlainMarkdownLike(raw) : raw;

    const statusLine = `[HTTP_STATUS] ${response.status} ${response.statusText}`;
    return `${statusLine}\n\n${body}`.trim();
  }

  private async observeShell(pointer: string): Promise<string> {
    const timeoutMs = Number.parseInt(process.env.TURING_COMMAND_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;
    const command = toCommand(pointer);

    try {
      const { stdout, stderr } = await exec(command, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
        shell: '/bin/bash',
      });
      return `${stdout ?? ''}${stderr ?? ''}`.trim() || '[NO_OUTPUT]';
    } catch (error: any) {
      const stdout = error?.stdout ?? '';
      const stderr = error?.stderr ?? '';
      const output = `${stdout}${stderr}`.trim();
      if (output) return output;
      return `[COMMAND_FAILED] ${error?.message ?? 'Unknown command execution failure'}`;
    }
  }

  private async withMainTapeContext(pointer: string, slice: string): Promise<string> {
    if (!this.attachMainTapeContext) return slice;
    if (isMainTapePointer(pointer)) return slice;
    if (isTrapPointer(pointer)) return slice;
    if (pointer === 'sys://error_recovery') return slice;

    const mainTapePath = toAbsolutePath(this.mainTapeFile, this.cwd);
    let mainTape = '';
    try {
      mainTape = await readFile(mainTapePath, 'utf8');
    } catch {
      return slice;
    }

    const normalizedTape = mainTape.trim();
    if (!normalizedTape) return slice;

    return [
      '[MAIN_TAPE_CONTEXT]',
      normalizedTape,
      '',
      '[CURRENT_POINTER_D]',
      pointer,
      '',
      '[CURRENT_OBSERVATION_S]',
      slice,
    ].join('\n');
  }
}
