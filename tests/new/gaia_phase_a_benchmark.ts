import 'dotenv/config';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadDisciplineFromFile } from '../../server/discipline.js';
import { TuringEngine, type IChronos } from '../../server/engine.js';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';
import { StatelessOracle } from '../../server/adapters/oracle.js';
import { ProgressWatchdog, watchdogRecoveryState } from '../../server/control/progress_watchdog.js';

interface GaiaTask {
  taskId: string;
  level: 1 | 2 | 3;
  question: string;
  finalAnswer: string;
  fileName?: string;
  attachmentPath?: string;
}

interface GaiaManifest {
  meta?: Record<string, unknown>;
  tasks: GaiaTask[];
}

interface TaskRunResult {
  repeat: number;
  taskId: string;
  level: 1 | 2 | 3;
  halted: boolean;
  ticks: number;
  effectiveMaxTicks: number;
  maxTickHit: boolean;
  anomalies: number;
  trapHits: number;
  loopRecoveries: number;
  cycleRecoveries: number;
  pointerFallbackCount: number;
  haltRejectCount: number;
  preHaltReviewRejectCount: number;
  refusalRejectCount: number;
  emptyAnswerRecoveries: number;
  answerNonEmpty: boolean;
  controlOk: boolean;
  fallbackRate: number;
  missingAttachment: boolean;
  predictedAnswer: string;
  expectedAnswer: string;
  score: boolean;
  finalQ: string;
  finalD: string;
  workspace: string;
}

interface GateThresholds {
  minAccuracy: number;
  minHaltRate: number;
  minControlFidelity: number;
  maxAnomalyCount: number;
  maxPointerFallbackCount: number;
}

interface GateOutcome {
  enabled: boolean;
  passed: boolean;
  thresholds: GateThresholds;
  failures: string[];
}

interface GaiaReport {
  metadata: {
    executedAt: string;
    runStamp: string;
    manifestPath: string;
    repeats: number;
    maxTicks: number;
    model: string;
    provider: string;
    temporaryRoot: string;
  };
  summary: {
    score: string;
    accuracy: number;
    haltRate: number;
    anomalyCount: number;
    trapHits: number;
    loopRecoveries: number;
    cycleRecoveries: number;
    pointerFallbackCount: number;
    haltRejectCount: number;
    preHaltReviewRejectCount: number;
    refusalRejectCount: number;
    emptyAnswerRecoveries: number;
    answerNonEmptyRate: number;
    controlFidelity: number;
    averageFallbackRate: number;
    missingAttachmentCount: number;
    levelAccuracy: {
      l1: number;
      l2: number;
      l3: number;
    };
  };
  gate?: GateOutcome;
  runs: TaskRunResult[];
}

class NoopChronos implements IChronos {
  public async engrave(_message: string): Promise<void> {
    // no-op for benchmark mode
  }
}

const HALT_MIN_TICKS = 2;

const ROUND2_CONTROL_APPENDIX = [
  '# ROUND2_CONTROL_APPENDIX',
  'Control-fidelity is strictly prioritized over free-form text.',
  'Never HALT unless ./result/ANSWER.txt exists and is non-empty.',
  'To write answer safely:',
  '1) Navigate to ./result/ANSWER.txt with s_prime="👆🏻".',
  '2) On next tick (while d_t is that file), write the final answer as plain text.',
  '3) Then HALT using q_next="HALT" and d_next="HALT".',
  'If uncertain, still write your best concise final answer (not explanation).',
].join('\n');

function nowStamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function maxTicksForLevel(base: number, level: 1 | 2 | 3): number {
  if (level === 3) return base + 20;
  if (level === 2) return base + 10;
  return base;
}

function parseArgs(argv: string[]): {
  manifest: string;
  outDir: string;
  repeats: number;
  maxTicks: number;
  attachmentsDir: string | null;
  gate: boolean;
  thresholds: GateThresholds;
} {
  const get = (flag: string, defaultValue?: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === flag);
    if (index < 0) return defaultValue;
    return argv[index + 1] ?? defaultValue;
  };

  const parseIntOption = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const parseFloatOption = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const manifest = get('--manifest', path.resolve(process.cwd(), 'tests/new/contracts/gaia_phase_a_tasks.json')) as string;
  const outDir = get('--out-dir', path.resolve(process.cwd(), 'workspace/benchmarks/gaia_phase_a')) as string;
  const repeats = Math.max(1, parseIntOption('--repeats', 1));
  const maxTicks = Math.max(1, parseIntOption('--max-ticks', 50));
  const attachmentsDir = get('--attachments-dir') ?? null;
  const gate = argv.includes('--gate');

  const thresholds: GateThresholds = {
    minAccuracy: parseFloatOption('--min-accuracy', Number.parseFloat(process.env.GAIA_PHASE_A_MIN_ACCURACY ?? '0.60')),
    minHaltRate: parseFloatOption('--min-halt-rate', Number.parseFloat(process.env.GAIA_PHASE_A_MIN_HALT_RATE ?? '0.90')),
    minControlFidelity: parseFloatOption(
      '--min-control-fidelity',
      Number.parseFloat(process.env.GAIA_PHASE_A_MIN_CONTROL_FIDELITY ?? '0.60'),
    ),
    maxAnomalyCount: parseFloatOption('--max-anomaly-count', Number.parseFloat(process.env.GAIA_PHASE_A_MAX_ANOMALY_COUNT ?? '0')),
    maxPointerFallbackCount: parseFloatOption(
      '--max-pointer-fallback-count',
      Number.parseFloat(process.env.GAIA_PHASE_A_MAX_POINTER_FALLBACK_COUNT ?? '0'),
    ),
  };

  return { manifest, outDir, repeats, maxTicks, attachmentsDir, gate, thresholds };
}

function normalizeNumberStr(input: string): number {
  const cleaned = input.replaceAll('$', '').replaceAll('%', '').replaceAll(',', '').trim();
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return parsed;
}

function isRefusalLikeAnswer(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;

  const markers = [
    "can't access",
    'cannot access',
    "don't have access",
    'do not have access',
    'unable to access',
    'not available in this environment',
    'without access',
    'cannot be completed',
    'cannot complete',
  ];

  return markers.some((marker) => normalized.includes(marker));
}

function detectPointerCycle(history: string[]): string | null {
  const isCycleCandidate = (pointer: string): boolean =>
    !pointer.startsWith('sys://') && pointer !== './MAIN_TAPE.md' && pointer !== './result/ANSWER.txt';

  const n = history.length;
  if (n >= 8) {
    const window = history.slice(n - 8);
    const [a, b] = window;
    const alternating = window.every((item, index) => item === (index % 2 === 0 ? a : b));
    if (alternating && a !== b && isCycleCandidate(a) && isCycleCandidate(b)) {
      return `${a} -> ${b}`;
    }
  }

  if (n >= 9) {
    const window = history.slice(n - 9);
    const [a, b, c] = window;
    const triplet = window.every((item, index) => item === [a, b, c][index % 3]);
    if (
      triplet &&
      (a !== b || b !== c) &&
      isCycleCandidate(a) &&
      isCycleCandidate(b) &&
      isCycleCandidate(c)
    ) {
      return `${a} -> ${b} -> ${c}`;
    }
  }

  return null;
}

function splitString(s: string): string[] {
  return s.split(/[;,]/g);
}

function normalizeStr(input: string, removePunct = true): string {
  const noSpaces = input.replace(/\s/g, '').toLowerCase();
  if (!removePunct) return noSpaces;
  return noSpaces.replace(/[\p{P}\p{S}]/gu, '');
}

function isFloatLike(value: string): boolean {
  if (!value.trim()) return false;
  return Number.isFinite(Number.parseFloat(value));
}

function questionScorer(modelAnswerRaw: string | null, groundTruthRaw: string): boolean {
  const modelAnswer = modelAnswerRaw ?? 'None';
  const groundTruth = groundTruthRaw ?? '';

  if (isFloatLike(groundTruth)) {
    return normalizeNumberStr(modelAnswer) === Number.parseFloat(groundTruth);
  }

  if (groundTruth.includes(',') || groundTruth.includes(';')) {
    const gtElems = splitString(groundTruth);
    const maElems = splitString(modelAnswer);
    if (gtElems.length !== maElems.length) return false;

    for (let i = 0; i < gtElems.length; i += 1) {
      const gt = gtElems[i] ?? '';
      const ma = maElems[i] ?? '';
      if (isFloatLike(gt)) {
        if (normalizeNumberStr(ma) !== Number.parseFloat(gt)) return false;
      } else if (normalizeStr(ma, false) !== normalizeStr(gt, false)) {
        return false;
      }
    }
    return true;
  }

  return normalizeStr(modelAnswer) === normalizeStr(groundTruth);
}

function summarizeMarkdown(report: GaiaReport): string {
  const lines: string[] = [];
  lines.push('# GAIA Phase A Benchmark');
  lines.push('');
  lines.push(`- executedAt: ${report.metadata.executedAt}`);
  lines.push(`- manifest: ${report.metadata.manifestPath}`);
  lines.push(`- repeats: ${report.metadata.repeats}`);
  lines.push(`- maxTicks: ${report.metadata.maxTicks}`);
  lines.push(`- model: ${report.metadata.model}`);
  lines.push(`- provider: ${report.metadata.provider}`);
  lines.push(`- score: ${report.summary.score}`);
  lines.push(`- accuracy: ${report.summary.accuracy}`);
  lines.push(`- haltRate: ${report.summary.haltRate}`);
  lines.push(`- anomalyCount: ${report.summary.anomalyCount}`);
  lines.push(`- trapHits: ${report.summary.trapHits}`);
  lines.push(`- loopRecoveries: ${report.summary.loopRecoveries}`);
  lines.push(`- cycleRecoveries: ${report.summary.cycleRecoveries}`);
  lines.push(`- pointerFallbackCount: ${report.summary.pointerFallbackCount}`);
  lines.push(`- haltRejectCount: ${report.summary.haltRejectCount}`);
  lines.push(`- preHaltReviewRejectCount: ${report.summary.preHaltReviewRejectCount}`);
  lines.push(`- refusalRejectCount: ${report.summary.refusalRejectCount}`);
  lines.push(`- emptyAnswerRecoveries: ${report.summary.emptyAnswerRecoveries}`);
  lines.push(`- answerNonEmptyRate: ${report.summary.answerNonEmptyRate}`);
  lines.push(`- controlFidelity: ${report.summary.controlFidelity}`);
  lines.push(`- averageFallbackRate: ${report.summary.averageFallbackRate}`);
  lines.push(`- missingAttachmentCount: ${report.summary.missingAttachmentCount}`);
  lines.push(`- levelAccuracy.l1: ${report.summary.levelAccuracy.l1}`);
  lines.push(`- levelAccuracy.l2: ${report.summary.levelAccuracy.l2}`);
  lines.push(`- levelAccuracy.l3: ${report.summary.levelAccuracy.l3}`);
  lines.push('');

  if (report.gate) {
    lines.push('## Gate');
    lines.push('');
    lines.push(`- enabled: ${report.gate.enabled}`);
    lines.push(`- passed: ${report.gate.passed}`);
    lines.push(`- minAccuracy: ${report.gate.thresholds.minAccuracy}`);
    lines.push(`- minHaltRate: ${report.gate.thresholds.minHaltRate}`);
    lines.push(`- minControlFidelity: ${report.gate.thresholds.minControlFidelity}`);
    lines.push(`- maxAnomalyCount: ${report.gate.thresholds.maxAnomalyCount}`);
    lines.push(`- maxPointerFallbackCount: ${report.gate.thresholds.maxPointerFallbackCount}`);
    for (const failure of report.gate.failures) {
      lines.push(`- failure: ${failure}`);
    }
    lines.push('');
  }

  lines.push('## Runs');
  lines.push('');
  for (const run of report.runs) {
    lines.push(`### ${run.taskId} (L${run.level}, repeat=${run.repeat})`);
    lines.push(`- score: ${run.score}`);
    lines.push(`- halted: ${run.halted}`);
    lines.push(`- ticks: ${run.ticks}/${run.effectiveMaxTicks}${run.maxTickHit ? ' (max-hit)' : ''}`);
    lines.push(`- anomalies: ${run.anomalies}`);
    lines.push(`- trapHits: ${run.trapHits}`);
    lines.push(`- loopRecoveries: ${run.loopRecoveries}`);
    lines.push(`- cycleRecoveries: ${run.cycleRecoveries}`);
    lines.push(`- pointerFallbackCount: ${run.pointerFallbackCount}`);
    lines.push(`- haltRejectCount: ${run.haltRejectCount}`);
    lines.push(`- preHaltReviewRejectCount: ${run.preHaltReviewRejectCount}`);
    lines.push(`- refusalRejectCount: ${run.refusalRejectCount}`);
    lines.push(`- emptyAnswerRecoveries: ${run.emptyAnswerRecoveries}`);
    lines.push(`- answerNonEmpty: ${run.answerNonEmpty}`);
    lines.push(`- controlOk: ${run.controlOk}`);
    lines.push(`- fallbackRate: ${run.fallbackRate}`);
    lines.push(`- missingAttachment: ${run.missingAttachment}`);
    lines.push(`- expected: ${run.expectedAnswer}`);
    lines.push(`- predicted: ${run.predictedAnswer || '[MISSING]'}`);
    lines.push(`- finalD: ${run.finalD}`);
    lines.push(`- finalQ: ${run.finalQ.split('\n')[0]}`);
    lines.push('');
  }

  return lines.join('\n');
}

function evaluateGate(report: GaiaReport, thresholds: GateThresholds): GateOutcome {
  const failures: string[] = [];
  if (report.summary.accuracy < thresholds.minAccuracy) {
    failures.push(`accuracy ${report.summary.accuracy} < minAccuracy ${thresholds.minAccuracy}`);
  }
  if (report.summary.haltRate < thresholds.minHaltRate) {
    failures.push(`haltRate ${report.summary.haltRate} < minHaltRate ${thresholds.minHaltRate}`);
  }
  if (report.summary.controlFidelity < thresholds.minControlFidelity) {
    failures.push(
      `controlFidelity ${report.summary.controlFidelity} < minControlFidelity ${thresholds.minControlFidelity}`,
    );
  }
  if (report.summary.anomalyCount > thresholds.maxAnomalyCount) {
    failures.push(
      `anomalyCount ${report.summary.anomalyCount} > maxAnomalyCount ${thresholds.maxAnomalyCount}`,
    );
  }
  if (report.summary.pointerFallbackCount > thresholds.maxPointerFallbackCount) {
    failures.push(
      `pointerFallbackCount ${report.summary.pointerFallbackCount} > maxPointerFallbackCount ${thresholds.maxPointerFallbackCount}`,
    );
  }

  return {
    enabled: true,
    passed: failures.length === 0,
    thresholds,
    failures,
  };
}

function requireTasks(manifest: GaiaManifest): GaiaTask[] {
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error('Manifest has no tasks. Run gaia_phase_a_select.ts first.');
  }
  return manifest.tasks;
}

async function readManifest(filePath: string): Promise<GaiaManifest> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as GaiaManifest;
  return parsed;
}

async function readMaybe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function augmentDiscipline(base: string): string {
  const trimmed = base.trimEnd();
  return `${trimmed}\n\n${ROUND2_CONTROL_APPENDIX}\n`;
}

function isHaltedState(q: string, d: string): boolean {
  return d.trim() === 'HALT' || q.trim() === 'HALT' || q.includes('[HALT]');
}

function stateHead(state: string): string {
  return state.split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 240);
}

async function resolveAttachment(task: GaiaTask, attachmentsDir: string | null): Promise<{ source: string | null; missing: boolean }> {
  const explicit = task.attachmentPath?.trim();
  if (explicit) {
    if (existsSync(explicit)) return { source: explicit, missing: false };
    return { source: null, missing: true };
  }

  const fileName = task.fileName?.trim() ?? '';
  if (!fileName) return { source: null, missing: false };
  if (!attachmentsDir) return { source: null, missing: true };

  const candidate = path.join(attachmentsDir, fileName);
  if (existsSync(candidate)) return { source: candidate, missing: false };
  return { source: null, missing: true };
}

async function runTask(
  task: GaiaTask,
  repeat: number,
  workspaceRoot: string,
  discipline: string,
  maxTicks: number,
  attachmentsDir: string | null,
): Promise<TaskRunResult> {
  const workspace = path.join(workspaceRoot, `${task.taskId}-r${repeat}`);
  await mkdir(workspace, { recursive: true });

  const attachment = await resolveAttachment(task, attachmentsDir);
  const hasAttachment = Boolean(task.fileName && task.fileName.trim());
  let attachmentInstruction = 'No attachment for this task.';

  if (attachment.source && task.fileName) {
    const target = path.join(workspace, 'inputs', task.fileName);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(attachment.source, target);
    attachmentInstruction = `Attachment available at ./inputs/${task.fileName}`;
  } else if (hasAttachment) {
    attachmentInstruction = `Attachment expected but missing: ${task.fileName}`;
  }

  const tape = [
    '# Mission: GAIA Phase A',
    `Task ID: ${task.taskId}`,
    `Level: ${task.level}`,
    attachmentInstruction,
    '',
    'Question:',
    task.question,
    '',
    'Required output protocol:',
    task.level >= 2
      ? '1) First write a short plan (<=8 lines) to ./result/PLAN_TAPE.md before final answer.'
      : '1) Solve the question using only available context/tools.',
    task.level >= 2
      ? '2) Then solve the question using available context/tools.'
      : '2) Write ONLY final answer text to ./result/ANSWER.txt',
    task.level >= 2
      ? '3) Write ONLY final answer text to ./result/ANSWER.txt'
      : '3) No explanation, no prefix, no suffix.',
    task.level >= 2
      ? '4) No explanation, no prefix, no suffix.'
      : '4) After writing, HALT with q_next=HALT and d_next=HALT.',
    task.level >= 2 ? '5) After writing, HALT with q_next=HALT and d_next=HALT.' : '',
  ].join('\n');

  await writeFile(path.join(workspace, 'MAIN_TAPE.md'), `${tape}\n`, 'utf8');

  const engine = new TuringEngine(
    new UnixPhysicalManifold(workspace, { attachMainTapeContext: true }),
    new StatelessOracle(),
    new NoopChronos(),
    discipline,
  );

  let q = 'q_0: SYSTEM_BOOTING';
  let d = './MAIN_TAPE.md';
  let ticks = 0;
  const effectiveMaxTicks = maxTicksForLevel(maxTicks, task.level);
  let anomalies = 0;
  let trapHits = 0;
  let loopRecoveries = 0;
  let cycleRecoveries = 0;
  let pointerFallbackCount = 0;
  let haltRejectCount = 0;
  let preHaltReviewRejectCount = 0;
  let refusalRejectCount = 0;
  let emptyAnswerRecoveries = 0;
  const answerPath = path.join(workspace, 'result', 'ANSWER.txt');
  const planPath = path.join(workspace, 'result', 'PLAN_TAPE.md');
  let preHaltReviewInjected = false;
  const pointerHistory: string[] = [d];
  const watchdog = new ProgressWatchdog({
    windowSize: 20,
    consecutiveThreshold: 10,
    repeatThreshold: 12,
  });

  for (; ticks < effectiveMaxTicks; ticks += 1) {
    if (isHaltedState(q, d)) break;

    try {
      const previousPointer = d;
      [q, d] = await engine.tick(q, d);
      pointerHistory.push(d);
      if (pointerHistory.length > 16) {
        pointerHistory.shift();
      }

      if (d.startsWith('sys://trap/')) {
        trapHits += 1;
        if (d === 'sys://trap/invalid_pointer') {
          pointerFallbackCount += 1;
          q = [
            '[POINTER_RECOVERY] Invalid pointer trapped.',
            'Use one of: HALT, sys://error_recovery, ./..., /..., http(s)://..., $ ..., tty://...',
            `[PREV_Q] ${stateHead(q)}`,
          ].join('\n');
          d = 'sys://error_recovery';
          continue;
        }
      }

      const detectedCycle = detectPointerCycle(pointerHistory);
      if (detectedCycle) {
        cycleRecoveries += 1;
        q = [
          '[CYCLE_RECOVERY]',
          `Detected pointer cycle: ${detectedCycle}`,
          `Previous pointer: ${previousPointer}`,
          'Break the cycle: choose a new pointer that advances work (read inputs, compute, or write required artifacts).',
          `[PREV_Q] ${stateHead(q)}`,
        ].join('\n');
        d = 'sys://error_recovery';
        continue;
      }

      if (isHaltedState(q, d)) {
        const candidateAnswer = (await readMaybe(answerPath))?.trim() ?? '';
        const candidatePlan = (await readMaybe(planPath))?.trim() ?? '';
        const reasons: string[] = [];
        if (ticks + 1 < HALT_MIN_TICKS) {
          reasons.push(`ticks=${ticks + 1} below minimum ${HALT_MIN_TICKS}`);
        }
        if (!candidateAnswer) {
          reasons.push('ANSWER.txt missing or empty');
          emptyAnswerRecoveries += 1;
        }
        if (candidateAnswer && isRefusalLikeAnswer(candidateAnswer)) {
          reasons.push('ANSWER.txt appears to be a refusal/non-answer');
          refusalRejectCount += 1;
        }
        if (task.level >= 2 && !candidatePlan) {
          reasons.push('PLAN_TAPE.md missing or empty for L2/L3 task');
        }

        if (reasons.length === 0 && task.level === 3 && !preHaltReviewInjected) {
          preHaltReviewInjected = true;
          preHaltReviewRejectCount += 1;
          haltRejectCount += 1;
          q = [
            '[PRE_HALT_REVIEW_REQUIRED]',
            'Before HALT on L3, verify every numbered requirement in MAIN_TAPE.md is complete.',
            'Re-read MAIN_TAPE + PLAN_TAPE + ANSWER.txt and then HALT again.',
            `[PREV_Q] ${stateHead(q)}`,
          ].join('\n');
          d = './MAIN_TAPE.md';
          continue;
        }

        if (reasons.length > 0) {
          haltRejectCount += 1;
          q = [
            '[HALT_REJECTED]',
            ...reasons.map((reason, index) => `${index + 1}. ${reason}`),
            'Recover by fulfilling missing requirements, then HALT.',
            'Required artifacts: ./result/ANSWER.txt (all levels), ./result/PLAN_TAPE.md (L2/L3).',
            `Question snippet: ${task.question.slice(0, 220).replace(/\s+/g, ' ')}`,
            `[PREV_Q] ${stateHead(q)}`,
          ].join('\n');
          d = 'sys://error_recovery';
        }
        continue;
      }

      const watch = watchdog.inspect(q, d);
      if (watch.triggered) {
        loopRecoveries += 1;
        q = watchdogRecoveryState(watch.reason ?? 'window_repeat', watch.fingerprint, q);
        d = 'sys://error_recovery';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      anomalies += 1;
      q = `[SYSTEM ERROR INTERRUPT] ${message}\n${q}`;
      d = 'sys://error_recovery';
    }
  }

  const halted = isHaltedState(q, d);
  const predicted = (await readMaybe(answerPath))?.trim() ?? '';
  const answerNonEmpty = predicted.length > 0;
  const controlOk =
    halted &&
    answerNonEmpty &&
    anomalies === 0 &&
    pointerFallbackCount === 0 &&
    haltRejectCount === 0 &&
    !(hasAttachment && !attachment.source);
  const fallbackRate = Number((pointerFallbackCount / Math.max(1, ticks)).toFixed(4));
  const score = questionScorer(predicted || null, task.finalAnswer);

  return {
    repeat,
    taskId: task.taskId,
    level: task.level,
    halted,
    ticks,
    effectiveMaxTicks,
    maxTickHit: !halted && ticks >= effectiveMaxTicks,
    anomalies,
    trapHits,
    loopRecoveries,
    cycleRecoveries,
    pointerFallbackCount,
    haltRejectCount,
    preHaltReviewRejectCount,
    refusalRejectCount,
    emptyAnswerRecoveries,
    answerNonEmpty,
    controlOk,
    fallbackRate,
    missingAttachment: hasAttachment && !attachment.source,
    predictedAnswer: predicted,
    expectedAnswer: task.finalAnswer,
    score,
    finalQ: q,
    finalD: d,
    workspace,
  };
}

function levelAccuracy(runs: TaskRunResult[], level: 1 | 2 | 3): number {
  const filtered = runs.filter((run) => run.level === level);
  if (filtered.length === 0) return 0;
  const passed = filtered.filter((run) => run.score).length;
  return Number((passed / filtered.length).toFixed(4));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifest);
  const manifest = await readManifest(manifestPath);
  const tasks = requireTasks(manifest);

  const outDir = path.resolve(args.outDir);
  const runStamp = nowStamp();
  await mkdir(outDir, { recursive: true });

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'turingclaw-gaia-phase-a-'));
  const baseDiscipline = await loadDisciplineFromFile(path.resolve(process.cwd(), 'turing_prompt.sh'));
  const discipline = augmentDiscipline(baseDiscipline);

  const runs: TaskRunResult[] = [];

  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    for (const task of tasks) {
      const run = await runTask(task, repeat, workspaceRoot, discipline, args.maxTicks, args.attachmentsDir);
      runs.push(run);
    }
  }

  const scored = runs.filter((run) => run.score).length;
  const halted = runs.filter((run) => run.halted).length;
  const anomalies = runs.reduce((sum, run) => sum + run.anomalies, 0);
  const trapHits = runs.reduce((sum, run) => sum + run.trapHits, 0);
  const loopRecoveries = runs.reduce((sum, run) => sum + run.loopRecoveries, 0);
  const cycleRecoveries = runs.reduce((sum, run) => sum + run.cycleRecoveries, 0);
  const pointerFallbackCount = runs.reduce((sum, run) => sum + run.pointerFallbackCount, 0);
  const haltRejectCount = runs.reduce((sum, run) => sum + run.haltRejectCount, 0);
  const preHaltReviewRejectCount = runs.reduce((sum, run) => sum + run.preHaltReviewRejectCount, 0);
  const refusalRejectCount = runs.reduce((sum, run) => sum + run.refusalRejectCount, 0);
  const emptyAnswerRecoveries = runs.reduce((sum, run) => sum + run.emptyAnswerRecoveries, 0);
  const answerNonEmptyCount = runs.filter((run) => run.answerNonEmpty).length;
  const controlOkCount = runs.filter((run) => run.controlOk).length;
  const averageFallbackRate = Number(
    (runs.reduce((sum, run) => sum + run.fallbackRate, 0) / Math.max(1, runs.length)).toFixed(4),
  );
  const missingAttachmentCount = runs.filter((run) => run.missingAttachment).length;

  const report: GaiaReport = {
    metadata: {
      executedAt: new Date().toISOString(),
      runStamp,
      manifestPath,
      repeats: args.repeats,
      maxTicks: args.maxTicks,
      model: process.env.ORACLE_MODEL || process.env.OPENAI_MODEL || 'default',
      provider: process.env.OPENAI_API_KEY ? 'openai-compatible' : process.env.KIMI_API_KEY ? 'kimi' : 'unknown',
      temporaryRoot: workspaceRoot,
    },
    summary: {
      score: `${scored}/${runs.length}`,
      accuracy: Number((scored / Math.max(1, runs.length)).toFixed(4)),
      haltRate: Number((halted / Math.max(1, runs.length)).toFixed(4)),
      anomalyCount: anomalies,
      trapHits,
      loopRecoveries,
      cycleRecoveries,
      pointerFallbackCount,
      haltRejectCount,
      preHaltReviewRejectCount,
      refusalRejectCount,
      emptyAnswerRecoveries,
      answerNonEmptyRate: Number((answerNonEmptyCount / Math.max(1, runs.length)).toFixed(4)),
      controlFidelity: Number((controlOkCount / Math.max(1, runs.length)).toFixed(4)),
      averageFallbackRate,
      missingAttachmentCount,
      levelAccuracy: {
        l1: levelAccuracy(runs, 1),
        l2: levelAccuracy(runs, 2),
        l3: levelAccuracy(runs, 3),
      },
    },
    runs,
  };

  if (args.gate) {
    report.gate = evaluateGate(report, args.thresholds);
  }

  const jsonPath = path.join(outDir, `gaia-phase-a-${runStamp}.json`);
  const mdPath = path.join(outDir, `gaia-phase-a-${runStamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, `${summarizeMarkdown(report)}\n`, 'utf8');

  console.log(
    JSON.stringify(
      {
        jsonPath,
        mdPath,
        summary: report.summary,
        gate: report.gate ?? null,
      },
      null,
      2,
    ),
  );

  if (report.gate && !report.gate.passed) {
    process.exitCode = 1;
  }

  await rm(workspaceRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('[gaia_phase_a_benchmark] FAIL', error);
  process.exitCode = 1;
});
