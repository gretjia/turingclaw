import 'dotenv/config';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDisciplineFromFile } from '../../server/discipline.js';
import { TuringEngine, type IChronos } from '../../server/engine.js';
import { UnixPhysicalManifold } from '../../server/adapters/manifold.js';
import { StatelessOracle } from '../../server/adapters/oracle.js';
import { ProgressWatchdog, watchdogRecoveryState } from '../../server/control/progress_watchdog.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, 'workspace', 'benchmarks', 'control_real_llm');
const PROMPT_FILE = path.join(ROOT, 'turing_prompt.sh');
const CONTRACT_DIR = path.join(ROOT, 'tests', 'new', 'contracts', 'control_real_llm');

type JsonPrimitive = string | number | boolean | null;

interface TextExpectation {
  kind: 'text';
  path: string;
  exact: string;
}

interface JsonExpectation {
  kind: 'json';
  path: string;
  expected: Record<string, JsonPrimitive>;
}

type Expectation = TextExpectation | JsonExpectation;

interface SetupFile {
  path: string;
  content: string;
  mode?: number;
}

interface CommandPostCheck {
  type: 'command';
  command: string;
  expectContains?: string;
  expectExitCode?: number;
}

interface CompletionPolicy {
  requireHalt: boolean;
  requireNoAnomalies: boolean;
  requireAllChecks: boolean;
  requirePostCheck: boolean;
}

interface ScenarioContractFile {
  id: string;
  maxTicks: number;
  initialQ: string;
  initialD: string;
  mainTape: string;
  setupFiles?: SetupFile[];
  checks: Expectation[];
  postCheck?: CommandPostCheck;
  completion?: Partial<CompletionPolicy>;
}

interface Scenario {
  id: string;
  contractPath: string;
  maxTicks: number;
  initialQ: string;
  initialD: string;
  mainTape: string;
  setupFiles: SetupFile[];
  checks: Expectation[];
  postCheck?: CommandPostCheck;
  completion: CompletionPolicy;
}

interface CheckResult {
  path: string;
  kind: 'text' | 'json';
  passed: boolean;
  reason?: string;
  expectedPreview?: string;
  actualPreview?: string;
}

interface PostCheckResult {
  passed: boolean;
  detail: string;
  command: string;
  exitCode: number | null;
}

interface ScenarioResult {
  repeat: number;
  id: string;
  contractPath: string;
  halted: boolean;
  ticks: number;
  maxTickHit: boolean;
  anomalies: number;
  trapHits: number;
  loopRecoveries: number;
  pointerFallbackCount: number;
  filePass: number;
  fileTotal: number;
  artifactAccuracy: number;
  checks: CheckResult[];
  postCheck?: PostCheckResult;
  completion: CompletionPolicy;
  finalQ: string;
  finalD: string;
  pass: boolean;
  workspace: string;
}

interface ScenarioScorecard {
  id: string;
  runs: number;
  runsPassed: number;
  halts: number;
  artifactPass: number;
  artifactTotal: number;
  artifactAccuracy: number;
  anomalies: number;
  trapHits: number;
  loopRecoveries: number;
  pointerFallbackCount: number;
}

interface GateThresholds {
  minScenarioPassRate: number;
  minHaltRate: number;
  minArtifactAccuracy: number;
  maxAnomalyCount: number;
  maxPointerFallbackCount: number;
}

interface GateOutcome {
  enabled: boolean;
  passed: boolean;
  thresholds: GateThresholds;
  failures: string[];
}

interface BenchmarkReport {
  metadata: {
    executedAt: string;
    runStamp: string;
    model: string;
    provider: string;
    repeats: number;
    intervention: 'none';
    disciplineFile: string;
    temporaryRoot: string;
    contractDir: string;
  };
  summary: {
    scenariosPassed: string;
    haltRate: number;
    artifactAccuracy: number;
    anomalyCount: number;
    trapHits: number;
    loopRecoveries: number;
    pointerFallbackCount: number;
  };
  gate?: GateOutcome;
  scorecards: ScenarioScorecard[];
  scenarios: ScenarioResult[];
}

class NoopChronos implements IChronos {
  public async engrave(_message: string): Promise<void> {
    // no-op in benchmark mode
  }
}

function parseRepeats(args: string[]): number {
  const index = args.findIndex((arg) => arg === '--repeats');
  if (index < 0) return 1;
  const parsed = Number.parseInt(args[index + 1] ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseNumberOption(args: string[], flag: string, defaultValue: number): number {
  const index = args.findIndex((arg) => arg === flag);
  if (index < 0) return defaultValue;
  const raw = Number.parseFloat(args[index + 1] ?? '');
  return Number.isFinite(raw) ? raw : defaultValue;
}

function parseGateThresholds(args: string[]): GateThresholds {
  const env = process.env;
  return {
    minScenarioPassRate: parseNumberOption(
      args,
      '--min-scenario-pass-rate',
      Number.parseFloat(env.CONTROL_GATE_MIN_SCENARIO_PASS_RATE ?? '0.6667'),
    ),
    minHaltRate: parseNumberOption(
      args,
      '--min-halt-rate',
      Number.parseFloat(env.CONTROL_GATE_MIN_HALT_RATE ?? '0.95'),
    ),
    minArtifactAccuracy: parseNumberOption(
      args,
      '--min-artifact-accuracy',
      Number.parseFloat(env.CONTROL_GATE_MIN_ARTIFACT_ACCURACY ?? '0.9'),
    ),
    maxAnomalyCount: parseNumberOption(
      args,
      '--max-anomaly-count',
      Number.parseFloat(env.CONTROL_GATE_MAX_ANOMALY_COUNT ?? '0'),
    ),
    maxPointerFallbackCount: parseNumberOption(
      args,
      '--max-pointer-fallback-count',
      Number.parseFloat(env.CONTROL_GATE_MAX_POINTER_FALLBACK_COUNT ?? '0'),
    ),
  };
}

function evaluateGate(report: BenchmarkReport, thresholds: GateThresholds): GateOutcome {
  const [passedRunsRaw, totalRunsRaw] = report.summary.scenariosPassed.split('/');
  const passedRuns = Number.parseInt(passedRunsRaw ?? '0', 10);
  const totalRuns = Number.parseInt(totalRunsRaw ?? '1', 10);
  const scenarioPassRate = passedRuns / Math.max(1, totalRuns);
  const failures: string[] = [];

  if (scenarioPassRate < thresholds.minScenarioPassRate) {
    failures.push(
      `scenarioPassRate ${scenarioPassRate.toFixed(4)} < minScenarioPassRate ${thresholds.minScenarioPassRate}`,
    );
  }
  if (report.summary.haltRate < thresholds.minHaltRate) {
    failures.push(`haltRate ${report.summary.haltRate} < minHaltRate ${thresholds.minHaltRate}`);
  }
  if (report.summary.artifactAccuracy < thresholds.minArtifactAccuracy) {
    failures.push(
      `artifactAccuracy ${report.summary.artifactAccuracy} < minArtifactAccuracy ${thresholds.minArtifactAccuracy}`,
    );
  }
  if (report.summary.anomalyCount > thresholds.maxAnomalyCount) {
    failures.push(`anomalyCount ${report.summary.anomalyCount} > maxAnomalyCount ${thresholds.maxAnomalyCount}`);
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

function compact(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function preview(text: string | null): string {
  if (text === null) return '[NULL]';
  const compacted = compact(text);
  if (compacted.length <= 160) return compacted;
  return `${compacted.slice(0, 157)}...`;
}

function isHalting(q: string, d: string): boolean {
  const qq = q.trim();
  const dd = d.trim();
  return dd === 'HALT' || qq === 'HALT' || qq.includes('[HALT]') || /\bHALT(?:_[A-Z0-9]+)?\b/.test(qq.toUpperCase());
}

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

async function readMaybe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid string field: ${field}`);
  }
  return value;
}

function asInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid integer field: ${field}`);
  }
  return value;
}

function parseCompletionPolicy(value: unknown): CompletionPolicy {
  const defaults: CompletionPolicy = {
    requireHalt: true,
    requireNoAnomalies: true,
    requireAllChecks: true,
    requirePostCheck: false,
  };

  if (value === undefined) {
    return defaults;
  }

  const obj = asObject(value);
  return {
    requireHalt: typeof obj.requireHalt === 'boolean' ? obj.requireHalt : defaults.requireHalt,
    requireNoAnomalies: typeof obj.requireNoAnomalies === 'boolean' ? obj.requireNoAnomalies : defaults.requireNoAnomalies,
    requireAllChecks: typeof obj.requireAllChecks === 'boolean' ? obj.requireAllChecks : defaults.requireAllChecks,
    requirePostCheck: typeof obj.requirePostCheck === 'boolean' ? obj.requirePostCheck : defaults.requirePostCheck,
  };
}

function parseSetupFiles(value: unknown, source: string): SetupFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`setupFiles must be array in ${source}`);
  }

  return value.map((item, index) => {
    const obj = asObject(item);
    const mode = obj.mode;
    if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0)) {
      throw new Error(`invalid setupFiles[${index}].mode in ${source}`);
    }

    return {
      path: asString(obj.path, `setupFiles[${index}].path`),
      content: asString(obj.content, `setupFiles[${index}].content`),
      mode: mode as number | undefined,
    };
  });
}

function parseExpectation(value: unknown, source: string, index: number): Expectation {
  const obj = asObject(value);
  const kind = asString(obj.kind, `checks[${index}].kind`);
  const targetPath = asString(obj.path, `checks[${index}].path`);

  if (kind === 'text') {
    return {
      kind,
      path: targetPath,
      exact: asString(obj.exact, `checks[${index}].exact`),
    };
  }

  if (kind === 'json') {
    const expectedObj = asObject(obj.expected);
    const expected: Record<string, JsonPrimitive> = {};
    for (const [key, raw] of Object.entries(expectedObj)) {
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
        expected[key] = raw as JsonPrimitive;
      } else {
        throw new Error(`checks[${index}].expected.${key} must be primitive in ${source}`);
      }
    }
    return {
      kind,
      path: targetPath,
      expected,
    };
  }

  throw new Error(`unsupported checks[${index}].kind in ${source}: ${kind}`);
}

function parsePostCheck(value: unknown, source: string): CommandPostCheck | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value);
  const type = asString(obj.type, 'postCheck.type');
  if (type !== 'command') {
    throw new Error(`unsupported postCheck.type in ${source}: ${type}`);
  }

  const expectExitCode = obj.expectExitCode;
  if (
    expectExitCode !== undefined &&
    (typeof expectExitCode !== 'number' || !Number.isInteger(expectExitCode))
  ) {
    throw new Error(`postCheck.expectExitCode must be integer in ${source}`);
  }

  if (obj.expectContains !== undefined && typeof obj.expectContains !== 'string') {
    throw new Error(`postCheck.expectContains must be string in ${source}`);
  }

  return {
    type: 'command',
    command: asString(obj.command, 'postCheck.command'),
    expectContains: obj.expectContains as string | undefined,
    expectExitCode: expectExitCode as number | undefined,
  };
}

function parseScenarioContract(sourcePath: string, raw: string): Scenario {
  const payload = JSON.parse(raw) as unknown;
  const obj = asObject(payload);

  const checksRaw = obj.checks;
  if (!Array.isArray(checksRaw) || checksRaw.length === 0) {
    throw new Error(`checks must be a non-empty array in ${sourcePath}`);
  }

  const checks = checksRaw.map((item, index) => parseExpectation(item, sourcePath, index));

  return {
    id: asString(obj.id, 'id'),
    contractPath: sourcePath,
    maxTicks: asInteger(obj.maxTicks, 'maxTicks'),
    initialQ: asString(obj.initialQ, 'initialQ'),
    initialD: asString(obj.initialD, 'initialD'),
    mainTape: asString(obj.mainTape, 'mainTape'),
    setupFiles: parseSetupFiles(obj.setupFiles, sourcePath),
    checks,
    postCheck: parsePostCheck(obj.postCheck, sourcePath),
    completion: parseCompletionPolicy(obj.completion),
  };
}

async function loadScenarioContracts(): Promise<Scenario[]> {
  const entries = await readdir(CONTRACT_DIR);
  const files = entries.filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`no scenario contracts found in ${CONTRACT_DIR}`);
  }

  const scenarios: Scenario[] = [];
  const ids = new Set<string>();

  for (const file of files) {
    const sourcePath = path.join(CONTRACT_DIR, file);
    const raw = await readFile(sourcePath, 'utf8');
    const parsed = parseScenarioContract(sourcePath, raw);
    if (ids.has(parsed.id)) {
      throw new Error(`duplicate scenario id: ${parsed.id}`);
    }
    ids.add(parsed.id);
    scenarios.push(parsed);
  }

  return scenarios;
}

async function runChecks(workspace: string, checks: Expectation[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const absolute = path.join(workspace, check.path);
    const raw = await readMaybe(absolute);
    if (raw === null) {
      results.push({
        path: check.path,
        kind: check.kind,
        passed: false,
        reason: 'missing file',
        expectedPreview: check.kind === 'text' ? preview(check.exact) : preview(JSON.stringify(check.expected)),
        actualPreview: '[MISSING]',
      });
      continue;
    }

    if (check.kind === 'text') {
      const actual = compact(raw);
      const expected = compact(check.exact);
      const passed = actual === expected;
      results.push({
        path: check.path,
        kind: check.kind,
        passed,
        reason: passed ? undefined : 'text mismatch',
        expectedPreview: preview(expected),
        actualPreview: preview(actual),
      });
      continue;
    }

    try {
      const actual = JSON.parse(raw) as Record<string, unknown>;
      const mismatch = Object.entries(check.expected).find(([key, expectedValue]) => actual[key] !== expectedValue);
      if (mismatch) {
        results.push({
          path: check.path,
          kind: check.kind,
          passed: false,
          reason: `json mismatch at ${mismatch[0]}`,
          expectedPreview: preview(JSON.stringify(check.expected)),
          actualPreview: preview(JSON.stringify(actual)),
        });
      } else {
        results.push({
          path: check.path,
          kind: check.kind,
          passed: true,
          expectedPreview: preview(JSON.stringify(check.expected)),
          actualPreview: preview(JSON.stringify(actual)),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        path: check.path,
        kind: check.kind,
        passed: false,
        reason: `invalid json: ${message}`,
        expectedPreview: preview(JSON.stringify(check.expected)),
        actualPreview: preview(raw),
      });
    }
  }

  return results;
}

async function runSetupFiles(workspace: string, files: SetupFile[]): Promise<void> {
  for (const file of files) {
    const absolute = path.join(workspace, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, {
      encoding: 'utf8',
      mode: file.mode,
    });
  }
}

async function runPostCheck(workspace: string, spec?: CommandPostCheck): Promise<PostCheckResult | undefined> {
  if (!spec) return undefined;

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', spec.command], { cwd: workspace });
    const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
    const containsOk = spec.expectContains ? output.includes(spec.expectContains) : true;
    const exitOk = spec.expectExitCode !== undefined ? spec.expectExitCode === 0 : true;
    return {
      passed: containsOk && exitOk,
      detail: output || '[NO_OUTPUT]',
      command: spec.command,
      exitCode: 0,
    };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | null; message?: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'post-check failed';
    const code = typeof e.code === 'number' ? e.code : null;
    const expectedCode = spec.expectExitCode;
    const containsOk = spec.expectContains ? output.includes(spec.expectContains) : true;
    const exitOk = expectedCode !== undefined ? code === expectedCode : false;
    return {
      passed: containsOk && exitOk,
      detail: output,
      command: spec.command,
      exitCode: code,
    };
  }
}

function decidePass(
  scenario: Scenario,
  halted: boolean,
  anomalies: number,
  filePass: number,
  fileTotal: number,
  postCheck?: PostCheckResult,
): boolean {
  const policy = scenario.completion;
  const haltOk = !policy.requireHalt || halted;
  const anomalyOk = !policy.requireNoAnomalies || anomalies === 0;
  const checksOk = !policy.requireAllChecks || filePass === fileTotal;
  const postOk = !policy.requirePostCheck || Boolean(postCheck?.passed);
  return haltOk && anomalyOk && checksOk && postOk;
}

async function runScenario(
  workspaceRoot: string,
  discipline: string,
  scenario: Scenario,
  repeat: number,
): Promise<ScenarioResult> {
  const workspace = path.join(workspaceRoot, `${scenario.id}-r${repeat}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'MAIN_TAPE.md'), `${scenario.mainTape.trim()}\n`, 'utf8');
  await runSetupFiles(workspace, scenario.setupFiles);

  const engine = new TuringEngine(
    new UnixPhysicalManifold(workspace, { attachMainTapeContext: true }),
    new StatelessOracle(),
    new NoopChronos(),
    discipline,
  );

  let q = scenario.initialQ;
  let d = scenario.initialD;
  let ticks = 0;
  let anomalies = 0;
  let trapHits = 0;
  let loopRecoveries = 0;
  let pointerFallbackCount = 0;
  const watchdog = new ProgressWatchdog({
    windowSize: 20,
    consecutiveThreshold: 10,
    repeatThreshold: 12,
  });

  for (; ticks < scenario.maxTicks; ticks += 1) {
    if (isHalting(q, d)) break;

    try {
      [q, d] = await engine.tick(q, d);
      if (d.startsWith('sys://trap/')) {
        trapHits += 1;
        if (d === 'sys://trap/invalid_pointer') {
          pointerFallbackCount += 1;
        }
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

  const halted = isHalting(q, d);
  const checkResults = await runChecks(workspace, scenario.checks);
  const filePass = checkResults.filter((c) => c.passed).length;
  const fileTotal = checkResults.length;
  const artifactAccuracy = Number((filePass / Math.max(1, fileTotal)).toFixed(4));
  const maxTickHit = !halted && ticks >= scenario.maxTicks;
  const postCheck = await runPostCheck(workspace, scenario.postCheck);
  const pass = decidePass(scenario, halted, anomalies, filePass, fileTotal, postCheck);

  return {
    repeat,
    id: scenario.id,
    contractPath: scenario.contractPath,
    halted,
    ticks,
    maxTickHit,
    anomalies,
    trapHits,
    loopRecoveries,
    pointerFallbackCount,
    filePass,
    fileTotal,
    artifactAccuracy,
    checks: checkResults,
    postCheck,
    completion: scenario.completion,
    finalQ: q,
    finalD: d,
    pass,
    workspace,
  };
}

function buildScorecards(runs: ScenarioResult[]): ScenarioScorecard[] {
  const grouped = new Map<string, ScenarioResult[]>();
  for (const run of runs) {
    const existing = grouped.get(run.id);
    if (existing) {
      existing.push(run);
    } else {
      grouped.set(run.id, [run]);
    }
  }

  const scorecards: ScenarioScorecard[] = [];
  for (const [id, group] of grouped.entries()) {
    const runsCount = group.length;
    const runsPassed = group.filter((r) => r.pass).length;
    const halts = group.filter((r) => r.halted).length;
    const artifactPass = group.reduce((sum, r) => sum + r.filePass, 0);
    const artifactTotal = group.reduce((sum, r) => sum + r.fileTotal, 0);
    const anomalies = group.reduce((sum, r) => sum + r.anomalies, 0);
    const trapHits = group.reduce((sum, r) => sum + r.trapHits, 0);
    const loopRecoveries = group.reduce((sum, r) => sum + r.loopRecoveries, 0);
    const pointerFallbackCount = group.reduce((sum, r) => sum + r.pointerFallbackCount, 0);
    scorecards.push({
      id,
      runs: runsCount,
      runsPassed,
      halts,
      artifactPass,
      artifactTotal,
      artifactAccuracy: Number((artifactPass / Math.max(1, artifactTotal)).toFixed(4)),
      anomalies,
      trapHits,
      loopRecoveries,
      pointerFallbackCount,
    });
  }

  return scorecards.sort((a, b) => a.id.localeCompare(b.id));
}

function summarize(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# Control Real-LLM Benchmark');
  lines.push('');
  lines.push(`- executedAt: ${report.metadata.executedAt}`);
  lines.push(`- model: ${report.metadata.model}`);
  lines.push(`- provider: ${report.metadata.provider}`);
  lines.push(`- repeats: ${report.metadata.repeats}`);
  lines.push(`- scenariosPassed: ${report.summary.scenariosPassed}`);
  lines.push(`- haltRate: ${report.summary.haltRate}`);
  lines.push(`- artifactAccuracy: ${report.summary.artifactAccuracy}`);
  lines.push(`- anomalyCount: ${report.summary.anomalyCount}`);
  lines.push(`- trapHits: ${report.summary.trapHits}`);
  lines.push(`- loopRecoveries: ${report.summary.loopRecoveries}`);
  lines.push(`- pointerFallbackCount: ${report.summary.pointerFallbackCount}`);
  lines.push('');

  if (report.gate) {
    lines.push('## Gate');
    lines.push('');
    lines.push(`- enabled: ${report.gate.enabled}`);
    lines.push(`- passed: ${report.gate.passed}`);
    lines.push(`- minScenarioPassRate: ${report.gate.thresholds.minScenarioPassRate}`);
    lines.push(`- minHaltRate: ${report.gate.thresholds.minHaltRate}`);
    lines.push(`- minArtifactAccuracy: ${report.gate.thresholds.minArtifactAccuracy}`);
    lines.push(`- maxAnomalyCount: ${report.gate.thresholds.maxAnomalyCount}`);
    lines.push(`- maxPointerFallbackCount: ${report.gate.thresholds.maxPointerFallbackCount}`);
    if (report.gate.failures.length > 0) {
      for (const failure of report.gate.failures) {
        lines.push(`- failure: ${failure}`);
      }
    }
    lines.push('');
  }
  lines.push('## Scenario Scorecards');
  lines.push('');

  for (const card of report.scorecards) {
    lines.push(`### ${card.id}`);
    lines.push(`- runsPassed: ${card.runsPassed}/${card.runs}`);
    lines.push(`- halts: ${card.halts}/${card.runs}`);
    lines.push(`- artifactAccuracy: ${card.artifactAccuracy} (${card.artifactPass}/${card.artifactTotal})`);
    lines.push(`- anomalies: ${card.anomalies}`);
    lines.push(`- trapHits: ${card.trapHits}`);
    lines.push(`- loopRecoveries: ${card.loopRecoveries}`);
    lines.push(`- pointerFallbackCount: ${card.pointerFallbackCount}`);
    lines.push('');
  }

  lines.push('## Scenario Runs');
  lines.push('');

  for (const run of report.scenarios) {
    lines.push(`### ${run.id} (repeat=${run.repeat})`);
    lines.push(`- contract: ${run.contractPath}`);
    lines.push(`- pass: ${run.pass}`);
    lines.push(`- halted: ${run.halted}`);
    lines.push(`- ticks: ${run.ticks}/${run.maxTickHit ? 'max-hit' : 'within-limit'}`);
    lines.push(`- anomalies: ${run.anomalies}`);
    lines.push(`- trapHits: ${run.trapHits}`);
    lines.push(`- loopRecoveries: ${run.loopRecoveries}`);
    lines.push(`- pointerFallbackCount: ${run.pointerFallbackCount}`);
    lines.push(`- artifactAccuracy: ${run.artifactAccuracy} (${run.filePass}/${run.fileTotal})`);
    lines.push(`- finalD: ${run.finalD}`);
    lines.push(`- finalQ: ${run.finalQ.split('\n')[0]}`);
    if (run.postCheck) {
      lines.push(
        `- postCheck: ${run.postCheck.passed} (exit=${run.postCheck.exitCode}, command=${run.postCheck.command})`,
      );
      lines.push(`- postCheckDetail: ${run.postCheck.detail.split('\n')[0]}`);
    }

    const failedChecks = run.checks.filter((item) => !item.passed);
    if (failedChecks.length > 0) {
      for (const item of failedChecks) {
        lines.push(
          `- failedArtifact: ${item.path} | reason=${item.reason ?? 'failed'} | expected=${item.expectedPreview ?? '[N/A]'} | actual=${item.actualPreview ?? '[N/A]'}`,
        );
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repeats = parseRepeats(args);
  const freezeBaseline = hasFlag(args, '--freeze-baseline');
  const gateEnabled = hasFlag(args, '--gate');
  const runStamp = nowStamp();

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'turingclaw-control-real-'));
  await mkdir(OUT_DIR, { recursive: true });

  const discipline = await loadDisciplineFromFile(PROMPT_FILE);
  const scenarios = await loadScenarioContracts();

  const runs: ScenarioResult[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const scenario of scenarios) {
      const result = await runScenario(temporaryRoot, discipline, scenario, repeat);
      runs.push(result);
    }
  }

  const passed = runs.filter((r) => r.pass).length;
  const halts = runs.filter((r) => r.halted).length;
  const anomalyCount = runs.reduce((sum, r) => sum + r.anomalies, 0);
  const trapHits = runs.reduce((sum, r) => sum + r.trapHits, 0);
  const loopRecoveries = runs.reduce((sum, r) => sum + r.loopRecoveries, 0);
  const pointerFallbackCount = runs.reduce((sum, r) => sum + r.pointerFallbackCount, 0);
  const filePass = runs.reduce((sum, r) => sum + r.filePass, 0);
  const fileTotal = runs.reduce((sum, r) => sum + r.fileTotal, 0);

  const report: BenchmarkReport = {
    metadata: {
      executedAt: new Date().toISOString(),
      runStamp,
      model: process.env.ORACLE_MODEL || process.env.OPENAI_MODEL || 'default',
      provider: process.env.OPENAI_API_KEY ? 'openai-compatible' : process.env.KIMI_API_KEY ? 'kimi' : 'unknown',
      repeats,
      intervention: 'none',
      disciplineFile: PROMPT_FILE,
      temporaryRoot,
      contractDir: CONTRACT_DIR,
    },
    summary: {
      scenariosPassed: `${passed}/${runs.length}`,
      haltRate: Number((halts / Math.max(1, runs.length)).toFixed(4)),
      artifactAccuracy: Number((filePass / Math.max(1, fileTotal)).toFixed(4)),
      anomalyCount,
      trapHits,
      loopRecoveries,
      pointerFallbackCount,
    },
    scorecards: buildScorecards(runs),
    scenarios: runs,
  };

  if (gateEnabled) {
    const thresholds = parseGateThresholds(args);
    report.gate = evaluateGate(report, thresholds);
  }

  const jsonPath = path.join(OUT_DIR, `control-real-${runStamp}.json`);
  const mdPath = path.join(OUT_DIR, `control-real-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, `${summarize(report)}\n`, 'utf8');

  if (freezeBaseline) {
    const frozenJsonPath = path.join(OUT_DIR, 'day3_baseline_frozen.json');
    const frozenMdPath = path.join(OUT_DIR, 'day3_baseline_frozen.md');
    const frozenPayload = {
      frozenAt: new Date().toISOString(),
      sourceJson: jsonPath,
      sourceMarkdown: mdPath,
      summary: report.summary,
    };
    await writeFile(frozenJsonPath, `${JSON.stringify(frozenPayload, null, 2)}\n`, 'utf8');
    await writeFile(frozenMdPath, `${summarize(report)}\n`, 'utf8');
  }

  console.log(
    JSON.stringify(
      { jsonPath, mdPath, summary: report.summary, scorecards: report.scorecards, gate: report.gate ?? null },
      null,
      2,
    ),
  );

  if (report.gate) {
    if (!report.gate.passed) {
      process.exitCode = 1;
    }
  } else if (passed !== runs.length) {
    process.exitCode = 1;
  }

  await rm(temporaryRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('[control_benchmark_real_llm] FAIL', error);
  process.exitCode = 1;
});
