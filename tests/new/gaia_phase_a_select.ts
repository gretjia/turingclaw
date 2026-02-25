import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface RawRow {
  [key: string]: unknown;
}

interface GaiaTask {
  taskId: string;
  level: 1 | 2 | 3;
  question: string;
  finalAnswer: string;
  fileName: string;
  sourceLine: number;
}

interface GaiaPhaseAManifest {
  meta: {
    generatedAt: string;
    sourceJsonl: string;
    seed: number;
    targetPerLevel: {
      l1: number;
      l2: number;
      l3: number;
    };
    allowedExtensions: string[];
    requireAttachment: boolean;
    candidateCount: number;
  };
  tasks: GaiaTask[];
}

interface CliOptions {
  input: string;
  output: string;
  seed: number;
  l1: number;
  l2: number;
  l3: number;
  allowExtensions: Set<string>;
  requireAttachment: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string, defaultValue?: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === flag);
    if (index < 0) return defaultValue;
    return argv[index + 1] ?? defaultValue;
  };

  const input = get('--input', path.resolve(process.cwd(), 'workspace/benchmarks/gaia/input/validation.jsonl')) as string;
  const output = get('--output', path.resolve(process.cwd(), 'tests/new/contracts/gaia_phase_a_tasks.json')) as string;
  const seed = Number.parseInt(get('--seed', '20260225') as string, 10);
  const l1 = Number.parseInt(get('--l1', '8') as string, 10);
  const l2 = Number.parseInt(get('--l2', '8') as string, 10);
  const l3 = Number.parseInt(get('--l3', '8') as string, 10);
  const extRaw = (get('--ext', 'txt,csv,json,html,pdf') as string).trim();
  const requireAttachment = argv.includes('--allow-no-attachment') ? false : true;

  if (!Number.isFinite(seed)) {
    throw new Error(`Invalid --seed: ${String(seed)}`);
  }

  const allowExtensions = new Set(
    extRaw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );

  return { input, output, seed, l1, l2, l3, allowExtensions, requireAttachment };
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function readField(row: RawRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function parseLevel(raw: string): 1 | 2 | 3 | null {
  if (!raw) return null;
  const numeric = Number.parseInt(raw, 10);
  if (numeric === 1 || numeric === 2 || numeric === 3) return numeric;

  const match = raw.match(/[123]/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  if (parsed === 1 || parsed === 2 || parsed === 3) return parsed;
  return null;
}

function extensionOf(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized) return '';
  const base = normalized.split('/').pop() ?? normalized;
  const index = base.lastIndexOf('.');
  if (index < 0) return '';
  return base.slice(index + 1);
}

function parseRow(row: RawRow, line: number): GaiaTask | null {
  const taskId = readField(row, ['task_id', 'taskId', 'id', 'Task ID']);
  const question = readField(row, ['Question', 'question', 'prompt']);
  const finalAnswer = readField(row, ['Final answer', 'final_answer', 'answer']);
  const levelRaw = readField(row, ['Level', 'level']);
  const fileName = readField(row, ['file_name', 'fileName', 'File name']);

  const level = parseLevel(levelRaw);

  if (!taskId || !question || !finalAnswer || !level) {
    return null;
  }

  return {
    taskId,
    level,
    question,
    finalAnswer,
    fileName,
    sourceLine: line,
  };
}

function filterByAttachment(tasks: GaiaTask[], allowExtensions: Set<string>, requireAttachment: boolean): GaiaTask[] {
  return tasks.filter((task) => {
    const normalizedFile = task.fileName.trim();
    if (!normalizedFile) {
      return !requireAttachment;
    }

    const extension = extensionOf(normalizedFile);
    if (!extension) {
      return !requireAttachment && allowExtensions.size === 0;
    }
    if (allowExtensions.size === 0) {
      return true;
    }
    return allowExtensions.has(extension);
  });
}

function pickByLevel(tasks: GaiaTask[], level: 1 | 2 | 3, count: number, seed: number): GaiaTask[] {
  const subset = tasks.filter((task) => task.level === level);
  if (subset.length < count) {
    throw new Error(`Not enough candidates for level ${level}: required=${count}, found=${subset.length}`);
  }

  const sorted = subset.slice().sort((a, b) => a.taskId.localeCompare(b.taskId));
  const shuffled = seededShuffle(sorted, seed ^ hashString(`L${level}`));
  return shuffled.slice(0, count);
}

async function readJsonl(filePath: string): Promise<RawRow[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  const rows: RawRow[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line) as RawRow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse JSONL at line ${index + 1}: ${message}`);
    }
  }

  return rows;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await readJsonl(options.input);
  const parsed = rows.map((row, index) => parseRow(row, index + 1)).filter((row): row is GaiaTask => row !== null);
  const filtered = filterByAttachment(parsed, options.allowExtensions, options.requireAttachment);

  const selected = [
    ...pickByLevel(filtered, 1, options.l1, options.seed),
    ...pickByLevel(filtered, 2, options.l2, options.seed),
    ...pickByLevel(filtered, 3, options.l3, options.seed),
  ].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.taskId.localeCompare(b.taskId);
  });

  const manifest: GaiaPhaseAManifest = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceJsonl: options.input,
      seed: options.seed,
      targetPerLevel: {
        l1: options.l1,
        l2: options.l2,
        l3: options.l3,
      },
      allowedExtensions: [...options.allowExtensions].sort(),
      requireAttachment: options.requireAttachment,
      candidateCount: filtered.length,
    },
    tasks: selected,
  };

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const byLevel = {
    l1: selected.filter((task) => task.level === 1).length,
    l2: selected.filter((task) => task.level === 2).length,
    l3: selected.filter((task) => task.level === 3).length,
  };

  console.log(
    JSON.stringify(
      {
        output: options.output,
        selected: selected.length,
        byLevel,
        requireAttachment: options.requireAttachment,
        candidateCount: filtered.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('[gaia_phase_a_select] FAIL', error);
  process.exitCode = 1;
});
