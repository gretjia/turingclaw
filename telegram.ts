#!/usr/bin/env node
import "dotenv/config";
import { exec } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
};

type AgentProcess = {
  name: string;
  workspace: string;
  proc: ChildProcessWithoutNullStreams;
  lastOutput: string[];
};

type TmuxWatcher = {
  target: string;
  timer: NodeJS.Timeout;
  lastTailLines: string[];
  pendingLines: string[];
  pendingSinceAt: number;
  lastDigestChangeAt: number;
  seenLineSigs: string[];
  seenLineSigSet: Set<string>;
  recentPayloadSigs: string[];
  busy: boolean;
  errorCount: number;
  lastSentAt: number;
};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT || 45);
const STATE_DIR = path.join(process.cwd(), process.env.TELEGRAM_STATE_DIR || ".telegram");
const OFFSET_FILE = path.join(STATE_DIR, "offset.json");
const SESSION_FILE = path.join(STATE_DIR, "sessions.json");
const BASE_WORKSPACE = path.join(process.cwd(), process.env.TELEGRAM_BASE_WORKSPACE || "workspace/telegram");
const ENABLE_BASH = (process.env.TELEGRAM_ENABLE_BASH || "false").toLowerCase() === "true";
const BASH_TIMEOUT_MS = Number(process.env.TELEGRAM_BASH_TIMEOUT_MS || 25000);
const OUTPUT_LIMIT = Number(process.env.TELEGRAM_OUTPUT_LIMIT || 3000);
const TMUX_POLL_SECONDS = Number(process.env.TELEGRAM_TMUX_POLL_SECONDS || 5);
const TMUX_TAIL_LINES = Number(process.env.TELEGRAM_TMUX_TAIL_LINES || 80);
const TMUX_MIN_PUSH_SECONDS = Number(process.env.TELEGRAM_TMUX_MIN_PUSH_SECONDS || 5);
const TMUX_QUIET_SECONDS = Number(process.env.TELEGRAM_TMUX_QUIET_SECONDS || 3);
const TMUX_MAX_BATCH_SECONDS = Number(process.env.TELEGRAM_TMUX_MAX_BATCH_SECONDS || 15);
const TMUX_MIN_BATCH_LINES = Number(process.env.TELEGRAM_TMUX_MIN_BATCH_LINES || 2);
const TMUX_TYPING_QUIET_SECONDS = Number(process.env.TELEGRAM_TMUX_TYPING_QUIET_SECONDS || 8);
const TMUX_SUBMIT_MODE = (process.env.TELEGRAM_TMUX_SUBMIT_MODE || "lf").toLowerCase();
const AGENT_COLLECT_SECONDS = Number(process.env.TELEGRAM_AGENT_COLLECT_SECONDS || 4);
const CONFIRM_TTL_SECONDS = Number(process.env.TELEGRAM_CONFIRM_TTL_SECONDS || 180);
const STALL_SECONDS = Number(process.env.TELEGRAM_STALL_SECONDS || 120);
const HEARTBEAT_SECONDS = Number(process.env.TELEGRAM_HEARTBEAT_SECONDS || 45);
const MAX_RECOVERY_ATTEMPTS = Number(process.env.TELEGRAM_MAX_RECOVERY_ATTEMPTS || 3);
const TASK_HARD_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_TASK_HARD_TIMEOUT_SECONDS || 900);
const ALLOWED_CHAT_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

type SessionState = {
  activeAgent: string;
  agents: string[];
  activeProject?: string;
};

type AgentTracker = {
  lastQ: string;
  awaitingResult: boolean;
  seenWorkingState: boolean;
  lastQChangeAt: number;
  lastNotifyAt: number;
  recoveryAttempts: number;
  currentTaskId?: string;
  currentTaskStartedAt?: number;
  queue: TaskItem[];
  history: TaskItem[];
};

type TaskState = "queued" | "running" | "recovering" | "halt" | "timeout" | "fatal" | "cancelled";

type TaskItem = {
  id: string;
  state: TaskState;
  project: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

type PendingRiskConfirm =
  | {
      lane: "tmux";
      createdAt: number;
      expiresAt: number;
      riskTags: string[];
      target: string;
      payload: string;
      pressEnter: boolean;
    }
  | {
      lane: "agent";
      createdAt: number;
      expiresAt: number;
      riskTags: string[];
      agentName: string;
      project: string;
      text: string;
    };

type PendingAgentCollect = {
  key: string;
  chatId: string;
  chatNumericId: number;
  agentName: string;
  project: string;
  lines: string[];
  startedAt: number;
  updatedAt: number;
  timer: NodeJS.Timeout;
};

const sessions = new Map<string, SessionState>();
const agents = new Map<string, AgentProcess>();
const trackers = new Map<string, AgentTracker>();
const tmuxWatchers = new Map<string, TmuxWatcher>();
const pendingRiskConfirms = new Map<string, PendingRiskConfirm>();
const pendingAgentCollects = new Map<string, PendingAgentCollect>();

function loadJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function saveJsonFile(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function normalizeAgentName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "alpha";
}

function workspaceFor(chatId: string, agentName: string): string {
  return path.join(BASE_WORKSPACE, chatId, agentName);
}

function keyFor(chatId: string, agentName: string): string {
  return `${chatId}:${agentName}`;
}

function parseKey(key: string): { chatId: string; agentName: string } {
  const idx = key.indexOf(":");
  if (idx < 0) return { chatId: key, agentName: "alpha" };
  return { chatId: key.slice(0, idx), agentName: key.slice(idx + 1) };
}

function tmuxWatcherKey(chatId: number | string): string {
  return String(chatId);
}

function sanitizeTmuxTarget(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate.startsWith("-%")) {
    candidate = candidate.slice(1);
  }
  candidate = candidate.replace(/[）)]$/, "");
  candidate = candidate.replace(/^[（(]/, "");
  if (!candidate) return null;
  if (!/^[A-Za-z0-9:_.%+-]{1,64}$/.test(candidate)) return null;
  return candidate;
}

function extractTmuxTarget(text: string): string | null {
  const patterns = [
    /tmux\s+attach(?:-session)?\s+-t\s+([A-Za-z0-9:_.%+-]+)/i,
    /tmux\s+capture-pane\s+-pt\s+([A-Za-z0-9:_.%+-]+)/i,
    /attach\s+-t\s+([A-Za-z0-9:_.%+-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return sanitizeTmuxTarget(match[1]);
    }
  }

  return null;
}

function hasTmuxInputVerb(text: string): boolean {
  return /(输入|回复|发送|键入|type)/i.test(text);
}

function extractTmuxInputPayload(text: string): { payload: string; pressEnter: boolean } | null {
  const quoted = text.match(/[“"]([^”"]+)[”"]\s*$/);
  const quotedPayload = quoted?.[1]?.trim();

  const withColon = text.match(/(?:输入|回复|发送|键入|type)(?:给我|为我|一下)?\s*[:：]\s*(.+)$/i);
  const plain = text.match(/(?:输入|回复|发送|键入|type)(?:给我|为我|一下)?\s*([^\n]+)$/i);

  let payload = quotedPayload ?? withColon?.[1]?.trim() ?? plain?.[1]?.trim() ?? '';
  if (!payload) return null;

  payload = payload.replace(/^(内容|文本)\s*[:：]\s*/i, '').trim();
  if (!payload) return null;

  const noEnter = /不回车|不要回车|no enter|without enter/i.test(text);
  return { payload, pressEnter: !noEnter };
}

function extractImplicitReplyPayload(text: string): { payload: string; pressEnter: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;

  const replyPrefixed = trimmed.match(/^(?:请)?(?:帮我|替我)?回复\s*[:：]\s*(.+)$/i);
  if (replyPrefixed?.[1]) {
    const payload = replyPrefixed[1].trim();
    if (payload) return { payload, pressEnter: true };
  }

  const sendPrefixed = trimmed.match(/^(?:请)?(?:帮我|替我)?发送\s*[:：]\s*(.+)$/i);
  if (sendPrefixed?.[1]) {
    const payload = sendPrefixed[1].trim();
    if (payload) return { payload, pressEnter: true };
  }

  const shortIntent = /^(同意|不同意|拒绝|可以|不可以|好的|收到|明白|继续|暂停|完成|ok|yes|no|done)$/i;
  if (trimmed.length <= 24 && shortIntent.test(trimmed)) {
    return { payload: trimmed, pressEnter: true };
  }

  return null;
}

function isTmuxInputRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("tmux")) return false;
  if (!hasTmuxInputVerb(text)) return false;
  return extractTmuxInputPayload(text) !== null;
}

function isImplicitTmuxInputRequest(text: string): boolean {
  if (hasTmuxInputVerb(text)) return true;
  return extractImplicitReplyPayload(text) !== null;
}

function parseAgentOverrideText(text: string): string | null {
  const m = text.match(/^\s*agent\s*[:：]\s*(.+)$/i);
  if (!m?.[1]) return null;
  const payload = m[1].trim();
  return payload || null;
}

function parseTmuxOverrideText(text: string): string | null {
  const m = text.match(/^\s*tmux\s*[:：]\s*(.+)$/i);
  if (!m?.[1]) return null;
  const payload = m[1].trim();
  return payload || null;
}

function parseTmuxOverridePayload(
  overrideText: string,
  fallbackTarget: string | null
): { target: string | null; payload: string; pressEnter: boolean } | null {
  let text = overrideText.trim();
  if (!text) return null;

  let pressEnter = true;
  if (/\s+noenter$/i.test(text)) {
    text = text.replace(/\s+noenter$/i, "").trim();
    pressEnter = false;
  }

  let target = fallbackTarget;
  const explicit = text.match(/^([A-Za-z0-9:_.%+-]{1,64})\s*\|\s*(.+)$/);
  if (explicit?.[1] && explicit?.[2]) {
    target = sanitizeTmuxTarget(explicit[1]);
    text = explicit[2].trim();
  }

  if (!text) return null;
  return { target, payload: text, pressEnter };
}

type RiskRule = {
  re: RegExp;
  tag: string;
};

const HIGH_RISK_RULES: RiskRule[] = [
  { re: /\bgit\s+push\b/i, tag: "git push" },
  { re: /\bgit\s+reset\s+--hard\b/i, tag: "git reset --hard" },
  { re: /\brm\s+-rf\b/i, tag: "rm -rf" },
  { re: /\bmkfs\b/i, tag: "mkfs" },
  { re: /\bdd\s+if=/i, tag: "dd if=" },
  { re: /\bshutdown\b/i, tag: "shutdown" },
  { re: /\breboot\b/i, tag: "reboot" },
];

function detectHighRiskTags(text: string): string[] {
  const tags: string[] = [];
  for (const rule of HIGH_RISK_RULES) {
    if (rule.re.test(text)) tags.push(rule.tag);
  }
  return Array.from(new Set(tags));
}

function confirmKey(chatId: number | string): string {
  return String(chatId);
}

function isNaturalConfirmText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "确认执行";
}

function isNaturalCancelConfirmText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "取消确认";
}

function getPendingRiskConfirm(chatId: number | string): PendingRiskConfirm | null {
  const key = confirmKey(chatId);
  const pending = pendingRiskConfirms.get(key);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    pendingRiskConfirms.delete(key);
    return null;
  }
  return pending;
}

function clearPendingRiskConfirm(chatId: number | string): PendingRiskConfirm | null {
  const key = confirmKey(chatId);
  const pending = pendingRiskConfirms.get(key) || null;
  pendingRiskConfirms.delete(key);
  return pending;
}

function setPendingRiskConfirm(chatId: number | string, pending: PendingRiskConfirm): void {
  pendingRiskConfirms.set(confirmKey(chatId), pending);
}

function previewText(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 3))}...`;
}

function formatPendingRiskConfirm(pending: PendingRiskConfirm): string {
  const ttlSeconds = Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 1000));
  const base = [
    "high-risk action requires confirmation",
    `lane=${pending.lane}`,
    `risks=${pending.riskTags.join(", ")}`,
    `expires_in=${ttlSeconds}s`,
    "reply /confirm to execute, /cancelconfirm to abort.",
  ];
  if (pending.lane === "tmux") {
    base.push(`target=${pending.target}`, `payload=${previewText(pending.payload)}`);
  } else {
    base.push(`agent=${pending.agentName}`, `project=${pending.project}`, `task=${previewText(pending.text)}`);
  }
  return base.join("\n");
}

function isTmuxMonitorRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("tmux")) return false;

  if (/\btmux\s+attach(?:-session)?\s+-t\b/i.test(text)) return true;
  if (/\btmux\s+capture-pane\s+-pt\b/i.test(text)) return true;

  return (
    lower.includes("monitor") ||
    lower.includes("watch") ||
    lower.includes("stream") ||
    text.includes("实时监测") ||
    text.includes("实时监控") ||
    text.includes("持续监控") ||
    text.includes("有任何新的信息") ||
    text.includes("推送")
  );
}

function isTmuxStopRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("stop tmux") ||
    lower.includes("停止tmux") ||
    lower.includes("停止监控") ||
    lower.includes("停止监测") ||
    lower.includes("结束监控")
  );
}

function tailText(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isTransientTmuxLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line) return false;

  return (
    /^[›❯>]\s/.test(line) ||
    /esc to interrupt\)$/i.test(line) ||
    /^◦\s/.test(line) ||
    /^↳\sInteracted with background terminal/i.test(line) ||
    /^•\sWaiting for /i.test(line) ||
    /^Planning .* \(\d+s .*interrupt\)$/i.test(line) ||
    line === "› Use /skills to list available skills" ||
    line === "? for shortcuts" ||
    /context left$/i.test(line) ||
    /^─\s*Worked for .*─$/u.test(line)
  );
}

function isLikelyInteractivePromptLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line || line.length > 220) return false;

  if (/^[\w.-]+@[\w.-]+[:~\/\w.-]*\s*[#$]\s+.*$/.test(line)) return true;
  if (/^PS\s+[A-Za-z]:\\.*>\s+.*$/.test(line)) return true;
  if (/^[A-Za-z0-9._/-]+[#$>]\s+.*$/.test(line)) return true;
  return false;
}

function canonicalizeLineForDedupe(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<iso_ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, "<clock>")
    .replace(/\b\d+(?:\.\d+)?s\b/gi, "<secs>")
    .replace(/\b\d+%\b/g, "<pct>")
    .replace(/\s+/g, " ")
    .trim();
}

function lineSignature(line: string): string {
  const normalized = canonicalizeLineForDedupe(line);
  if (!normalized) return "";
  return createHash("sha1").update(normalized).digest("hex");
}

function payloadSignature(lines: string[]): string {
  const canonical = lines
    .map((line) => canonicalizeLineForDedupe(line))
    .filter((line) => line.length > 0)
    .join("\n");
  if (!canonical) return "";
  return createHash("sha1").update(canonical).digest("hex");
}

function tmuxDigest(snapshot: string): string {
  const normalized = stripAnsi(snapshot)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !isTransientTmuxLine(line))
    .join("\n")
    .trim();

  const tail = tailText(normalized, Math.max(20, TMUX_TAIL_LINES));
  const deduped: string[] = [];
  for (const line of tail.split("\n")) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }
  return deduped.join("\n").trim();
}

function tmuxTailLines(snapshot: string): string[] {
  const digest = tmuxDigest(snapshot);
  if (!digest) return [];
  return digest
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function appendPendingLines(pending: string[], lines: string[]): string[] {
  const next = [...pending];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (next.length === 0 || next[next.length - 1] !== line) {
      next.push(line);
    }
  }

  if (next.length > 400) {
    return next.slice(next.length - 400);
  }

  return next;
}

function markSeenLines(watcher: TmuxWatcher, lines: string[]): void {
  for (const line of lines) {
    const sig = lineSignature(line);
    if (!sig) continue;
    if (watcher.seenLineSigSet.has(sig)) continue;
    watcher.seenLineSigSet.add(sig);
    watcher.seenLineSigs.push(sig);
  }

  const maxSeen = 4000;
  if (watcher.seenLineSigs.length > maxSeen) {
    const removeCount = watcher.seenLineSigs.length - maxSeen;
    const removed = watcher.seenLineSigs.splice(0, removeCount);
    for (const sig of removed) {
      watcher.seenLineSigSet.delete(sig);
    }
  }
}

function collectNovelLines(watcher: TmuxWatcher, lines: string[]): string[] {
  const novel: string[] = [];
  for (const line of lines) {
    const sig = lineSignature(line);
    if (!sig) continue;
    if (watcher.seenLineSigSet.has(sig)) continue;
    novel.push(line);
  }
  return novel;
}

function clipPreserveTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "...[older lines truncated]\n";
  const budget = Math.max(1, maxChars - marker.length);
  return `${marker}${text.slice(-budget)}`;
}

function buildTmuxPush(kind: "started" | "update", target: string, digest: string): string {
  const headerLines =
    kind === "started"
      ? [`tmux watcher started`, `target=${target}`, `poll=${TMUX_POLL_SECONDS}s`, `mode=new-lines-only`]
      : [`tmux update`, `target=${target}`, `at=${new Date().toISOString()}`];
  const header = `${headerLines.join("\n")}\n\n`;
  const maxChars = Math.min(3900, Math.max(1200, OUTPUT_LIMIT));
  const body = clipPreserveTail(digest, Math.max(200, maxChars - header.length));
  return `${header}${body}`;
}

function appendRecentPayloadSig(watcher: TmuxWatcher, sig: string): void {
  if (!sig) return;
  if (watcher.recentPayloadSigs.includes(sig)) return;
  watcher.recentPayloadSigs.push(sig);
  const maxRecent = 40;
  if (watcher.recentPayloadSigs.length > maxRecent) {
    watcher.recentPayloadSigs.splice(0, watcher.recentPayloadSigs.length - maxRecent);
  }
}

function newTaskId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `t_${ts}_${rand}`;
}

function ensureWorkspace(workspace: string) {
  fs.mkdirSync(workspace, { recursive: true });
  const qFile = path.join(workspace, ".reg_q");
  const dFile = path.join(workspace, ".reg_d");
  const tapeFile = path.join(workspace, "MAIN_TAPE.md");
  if (!fs.existsSync(qFile)) fs.writeFileSync(qFile, "q_0: SYSTEM_BOOTING\n", "utf-8");
  if (!fs.existsSync(dFile)) fs.writeFileSync(dFile, "MAIN_TAPE.md\n", "utf-8");
  if (!fs.existsSync(tapeFile)) fs.writeFileSync(tapeFile, "# Telegram Agent Tape\n", "utf-8");
}

function notebooksDir(workspace: string): string {
  return path.join(workspace, ".project_notebooks");
}

function sanitizeProjectName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || "general";
}

function inferProjectFromText(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("omega")) return "omega";
  if (t.includes("turingclaw")) return "turingclaw";
  return "general";
}

function projectPathHints(project: string): string[] {
  const p = sanitizeProjectName(project);
  if (p === "omega") {
    return [
      "/home/zephryj/projects/omega/handover",
      "/home/zephryj/projects/turingclaw/omega",
    ];
  }
  if (p === "turingclaw") {
    return ["/home/zephryj/projects/turingclaw"];
  }
  return [process.cwd()];
}

function projectNotebookPath(workspace: string, project: string): string {
  return path.join(notebooksDir(workspace), `${sanitizeProjectName(project)}.md`);
}

function ensureProjectNotebook(workspace: string, project: string) {
  const file = projectNotebookPath(workspace, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# Project Notebook: ${sanitizeProjectName(project)}\n\n` +
        "Tracks context, constraints, failed attempts, and validated outcomes.\n",
      "utf-8"
    );
  }
}

function appendProjectNotebook(workspace: string, project: string, section: string, content: string) {
  ensureProjectNotebook(workspace, project);
  const file = projectNotebookPath(workspace, project);
  const ts = new Date().toISOString();
  fs.appendFileSync(file, `\n## ${section} @ ${ts}\n${content.trim()}\n`, "utf-8");
}

function projectNotebookTail(workspace: string, project: string, lines = 80): string {
  const file = projectNotebookPath(workspace, project);
  if (!fs.existsSync(file)) return "(empty)";
  const all = fs.readFileSync(file, "utf-8").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

type ProjectPolicy = {
  stallSeconds: number;
  heartbeatSeconds: number;
  maxRecoveryAttempts: number;
  hardTimeoutSeconds: number;
  pathHints: string[];
};

function projectPolicyPath(workspace: string, project: string): string {
  return path.join(notebooksDir(workspace), `${sanitizeProjectName(project)}.policy.json`);
}

function loadProjectPolicy(workspace: string, project: string): ProjectPolicy {
  const defaults: ProjectPolicy = {
    stallSeconds: STALL_SECONDS,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    hardTimeoutSeconds: TASK_HARD_TIMEOUT_SECONDS,
    pathHints: projectPathHints(project),
  };
  const file = projectPolicyPath(workspace, project);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2), "utf-8");
    return defaults;
  }
  const loaded = loadJsonFile<Partial<ProjectPolicy>>(file, {});
  return {
    stallSeconds: loaded.stallSeconds ?? defaults.stallSeconds,
    heartbeatSeconds: loaded.heartbeatSeconds ?? defaults.heartbeatSeconds,
    maxRecoveryAttempts: loaded.maxRecoveryAttempts ?? defaults.maxRecoveryAttempts,
    hardTimeoutSeconds: loaded.hardTimeoutSeconds ?? defaults.hardTimeoutSeconds,
    pathHints: loaded.pathHints?.length ? loaded.pathHints : defaults.pathHints,
  };
}

function readD(workspace: string): string {
  const dFile = path.join(workspace, ".reg_d");
  return fs.existsSync(dFile) ? fs.readFileSync(dFile, "utf-8").trim() || "MAIN_TAPE.md" : "MAIN_TAPE.md";
}

function writeQ(workspace: string, q: string) {
  fs.writeFileSync(path.join(workspace, ".reg_q"), `${q.trim()}\n`, "utf-8");
}

function enqueueUserRequest(workspace: string, message: string) {
  ensureWorkspace(workspace);
  const d = readD(workspace);
  const tapePath = path.join(workspace, d);
  fs.mkdirSync(path.dirname(tapePath), { recursive: true });
  fs.appendFileSync(tapePath, `\n[USER REQUEST]: ${message}\n`, "utf-8");

  // New user tasks must restart from a deterministic processing state.
  writeQ(workspace, "q_1: PROCESSING_USER_REQUEST");
}

function spawnAgent(chatId: string, agentName: string): AgentProcess {
  const ws = workspaceFor(chatId, agentName);
  ensureWorkspace(ws);
  const child = spawn("npx", ["tsx", "cli.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, TURINGCLAW_WORKSPACE: ws, TURING_WORKSPACE: ws },
    stdio: "pipe",
  });

  const recordOutput = (chunk: Buffer) => {
    const key = keyFor(chatId, agentName);
    const ap = agents.get(key);
    if (!ap) return;
    const text = chunk.toString("utf-8").trim();
    if (!text) return;
    ap.lastOutput.push(text);
    if (ap.lastOutput.length > 30) ap.lastOutput.shift();
    const logPath = path.join(ap.workspace, ".agent_runtime.log");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`, "utf-8");
  };

  child.stdout.on("data", recordOutput);
  child.stderr.on("data", recordOutput);

  child.on("exit", () => {
    const key = keyFor(chatId, agentName);
    agents.delete(key);
  });

  return {
    name: agentName,
    workspace: ws,
    proc: child,
    lastOutput: [],
  };
}

function getOrStartAgent(chatId: string, agentName: string): AgentProcess {
  const key = keyFor(chatId, agentName);
  const existing = agents.get(key);
  if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) return existing;
  const ap = spawnAgent(chatId, agentName);
  agents.set(key, ap);
  if (!trackers.has(key)) {
    trackers.set(key, {
      lastQ: readQ(ap.workspace),
      awaitingResult: false,
      seenWorkingState: false,
      lastQChangeAt: Date.now(),
      lastNotifyAt: 0,
      recoveryAttempts: 0,
      queue: [],
      history: [],
    });
  }
  return ap;
}

function getSession(chatId: string): SessionState {
  const existing = sessions.get(chatId);
  if (existing) return existing;
  const created: SessionState = { activeAgent: "alpha", agents: ["alpha"], activeProject: "general" };
  sessions.set(chatId, created);
  return created;
}

function saveSessions() {
  const obj: Record<string, SessionState> = {};
  for (const [k, v] of sessions.entries()) obj[k] = v;
  saveJsonFile(SESSION_FILE, obj);
}

function loadSessions() {
  const data = loadJsonFile<Record<string, SessionState>>(SESSION_FILE, {});
  for (const [chatId, state] of Object.entries(data)) sessions.set(chatId, state);
}

function bootstrapTrackersFromSessions() {
  for (const [chatId, session] of sessions.entries()) {
    const names = [session.activeAgent || "alpha"];
    for (const rawName of names) {
      const agentName = normalizeAgentName(rawName || "alpha");
      const workspace = workspaceFor(chatId, agentName);
      ensureWorkspace(workspace);
      const key = keyFor(chatId, agentName);
      const tracker =
        trackers.get(key) ||
        ({
          lastQ: readQ(workspace),
          awaitingResult: false,
          seenWorkingState: false,
          lastQChangeAt: Date.now(),
          lastNotifyAt: 0,
          recoveryAttempts: 0,
          queue: [],
          history: [],
        } satisfies AgentTracker);

      const q = readQ(workspace);
      tracker.lastQ = q;
      tracker.lastQChangeAt = Date.now();
      tracker.awaitingResult = false;
      tracker.seenWorkingState = false;
      tracker.currentTaskId = undefined;
      tracker.currentTaskStartedAt = undefined;

      trackers.set(key, tracker);
    }
  }
}

async function tgApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result as T;
}

async function sendMessage(chatId: number, text: string) {
  const safe = text.length > 4000 ? `${text.slice(0, 3900)}\n...[truncated]` : text;
  await tgApi("sendMessage", {
    chat_id: chatId,
    text: safe,
    disable_web_page_preview: true,
  });
  console.log(`[telegram] sent reply to chat=${chatId} bytes=${safe.length}`);
}

function tailFile(file: string, linesCount: number): string {
  if (!fs.existsSync(file)) return "(file not found)";
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  return lines.slice(Math.max(0, lines.length - linesCount)).join("\n");
}

function readStatus(workspace: string): string {
  const q = fs.existsSync(path.join(workspace, ".reg_q"))
    ? fs.readFileSync(path.join(workspace, ".reg_q"), "utf-8").trim()
    : "missing";
  const d = fs.existsSync(path.join(workspace, ".reg_d"))
    ? fs.readFileSync(path.join(workspace, ".reg_d"), "utf-8").trim()
    : "missing";
  return `q=${q}\nd=${d}\nworkspace=${workspace}`;
}

function readQ(workspace: string): string {
  const qFile = path.join(workspace, ".reg_q");
  return fs.existsSync(qFile) ? fs.readFileSync(qFile, "utf-8").trim() : "";
}

function isTerminalQ(q: string): boolean {
  return q === "HALT" || q === "FATAL_DEBUG" || q.includes("[HALT]");
}

function isInvalidHeadPointer(workspace: string): boolean {
  const d = readD(workspace);
  if (!d || d.startsWith("/") || d.includes("..")) return true;
  const fullPath = path.join(workspace, d);
  try {
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  } catch {
    return true;
  }
}

function writeD(workspace: string, d: string) {
  fs.writeFileSync(path.join(workspace, ".reg_d"), `${d.trim()}\n`, "utf-8");
}

function appendSystemRecoveryNote(workspace: string, note: string) {
  const tapePath = path.join(workspace, "MAIN_TAPE.md");
  fs.appendFileSync(
    tapePath,
    `\n[SYSTEM RECOVERY]: ${note}\n` +
      `If blocked, use <EXEC> to verify real-world state, then try a different tool/path. Avoid repeating identical failed transitions.\n`,
    "utf-8"
  );
}

function buildCompletionSummary(agent: AgentProcess, q: string): string {
  const tapeTail = tailFile(path.join(agent.workspace, "MAIN_TAPE.md"), 35);
  return [
    `agent=${agent.name}`,
    `q=${q}`,
    `workspace=${agent.workspace}`,
    "",
    "result summary (MAIN_TAPE tail):",
    tapeTail || "(empty tape)",
  ].join("\n");
}

function hasExecutionEvidence(agent: AgentProcess): boolean {
  const tail = tailFile(path.join(agent.workspace, "MAIN_TAPE.md"), 120);
  return (
    tail.includes("[EXEC RESULT") ||
    tail.includes("[EXEC ERROR") ||
    tail.includes("[DISCIPLINE ERROR]") ||
    tail.includes("Verification") ||
    tail.includes("REPORT")
  );
}

function buildFailureTemplate(agent: AgentProcess, taskId: string, state: TaskState, reason: string): string {
  const tail = tailFile(path.join(agent.workspace, "MAIN_TAPE.md"), 35);
  return [
    `task ${state}`,
    `task_id=${taskId}`,
    `reason=${reason}`,
    "facts:",
    "- task execution reached non-terminal stall or invalid result gate",
    "- see evidence tail below",
    "next_actions:",
    "1. run /status",
    "2. run /tape 120",
    "3. send follow-up task with explicit verification command",
    "",
    tail,
  ].join("\n");
}

function updateTaskState(tracker: AgentTracker, id: string, state: TaskState) {
  const all = [...tracker.queue, ...tracker.history];
  for (const t of all) {
    if (t.id === id) {
      t.state = state;
      t.updatedAt = Date.now();
    }
  }
}

function cancelRunningTask(chatId: string, agentName: string, reason: string): string | null {
  const key = keyFor(chatId, agentName);
  const tracker = trackers.get(key);
  if (!tracker || !tracker.currentTaskId) return null;

  const taskId = tracker.currentTaskId;
  writeQ(workspaceFor(chatId, agentName), "FATAL_DEBUG");
  tracker.awaitingResult = false;
  tracker.seenWorkingState = false;
  tracker.queue = [];
  tracker.history.push({
    id: taskId,
    state: "cancelled",
    project: "general",
    text: `(auto-cancelled: ${reason})`,
    createdAt: tracker.currentTaskStartedAt || Date.now(),
    updatedAt: Date.now(),
  });
  tracker.currentTaskId = undefined;
  tracker.currentTaskStartedAt = undefined;
  trackers.set(key, tracker);
  return taskId;
}

async function monitorAgentCompletion() {
  for (const [key, tracker] of trackers.entries()) {
    const { chatId, agentName } = parseKey(key);
    const session = getSession(chatId);
    const activeProject = sanitizeProjectName(session.activeProject || "general");
    const workspace = workspaceFor(chatId, agentName);
    ensureWorkspace(workspace);
    const policy = loadProjectPolicy(workspace, activeProject);
    const currentQ = readQ(workspace);
    const now = Date.now();
    let cachedAgent: AgentProcess | null = null;
    const agent = (): AgentProcess => {
      if (!cachedAgent) cachedAgent = getOrStartAgent(chatId, agentName);
      return cachedAgent;
    };

    // Start next queued task if idle.
    if (!tracker.awaitingResult && tracker.queue.length > 0) {
      const activeAgent = agent();
      const next = tracker.queue.shift()!;
      tracker.currentTaskId = next.id;
      tracker.currentTaskStartedAt = now;
      tracker.awaitingResult = true;
      tracker.seenWorkingState = false;
      tracker.recoveryAttempts = 0;
      tracker.lastNotifyAt = 0;
      tracker.lastQ = readQ(activeAgent.workspace);
      tracker.lastQChangeAt = now;
      next.state = "running";
      next.updatedAt = now;
      enqueueUserRequest(activeAgent.workspace, next.text);
      appendProjectNotebook(
        activeAgent.workspace,
        next.project,
        "Task Start",
        `task_id=${next.id}\nstate=running\nagent=${agentName}`
      );
      await sendMessage(Number(chatId), `task running\ntask_id=${next.id}\nagent=${agentName}\nproject=${next.project}`);
      trackers.set(key, tracker);
      continue;
    }

    if (currentQ && currentQ !== tracker.lastQ) {
      tracker.lastQ = currentQ;
      tracker.lastQChangeAt = now;
      tracker.recoveryAttempts = 0;
    }

    if (!tracker.awaitingResult) continue;
    if (!tracker.seenWorkingState && currentQ && !isTerminalQ(currentQ)) {
      tracker.seenWorkingState = true;
      trackers.set(key, tracker);
    }
    if (!tracker.seenWorkingState) continue;

    const activeAgent = agent();

    if (isTerminalQ(currentQ)) {
      const taskId = tracker.currentTaskId || "unknown";
      const terminalState: TaskState = currentQ === "HALT" ? "halt" : "fatal";
      const summary = buildCompletionSummary(activeAgent, currentQ);
      if (currentQ === "HALT" && !hasExecutionEvidence(activeAgent)) {
        // Evidence gate: do not accept empty HALT.
        tracker.recoveryAttempts += 1;
        updateTaskState(tracker, taskId, "recovering");
        appendSystemRecoveryNote(
          activeAgent.workspace,
          `halt reached without evidence; require explicit verification output (attempt ${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}).`
        );
        writeQ(activeAgent.workspace, "q_1: PROCESSING_USER_REQUEST");
        await sendMessage(
          Number(chatId),
          `task recovering\ntask_id=${taskId}\nreason=evidence gate failed\nattempt=${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}`
        );
        if (tracker.recoveryAttempts > policy.maxRecoveryAttempts) {
          const msg = buildFailureTemplate(activeAgent, taskId, "timeout", "evidence gate exceeded");
          updateTaskState(tracker, taskId, "timeout");
          tracker.history.push({
            id: taskId,
            state: "timeout",
            project: activeProject,
            text: "(from current task)",
            createdAt: tracker.currentTaskStartedAt || now,
            updatedAt: now,
          });
          tracker.awaitingResult = false;
          tracker.seenWorkingState = false;
          tracker.currentTaskId = undefined;
          await sendMessage(Number(chatId), msg);
        }
        trackers.set(key, tracker);
        continue;
      }
      appendProjectNotebook(
        activeAgent.workspace,
        activeProject,
        "Outcome",
        `task_id=${taskId}\nagent=${agentName}\nq=${currentQ}\n\n${summary}`
      );
      updateTaskState(tracker, taskId, terminalState);
      tracker.history.push({
        id: taskId,
        state: terminalState,
        project: activeProject,
        text: "(from current task)",
        createdAt: tracker.currentTaskStartedAt || now,
        updatedAt: now,
      });
      await sendMessage(Number(chatId), `task ${terminalState}\ntask_id=${taskId}\n${summary}`);
      tracker.awaitingResult = false;
      tracker.seenWorkingState = false;
      tracker.recoveryAttempts = 0;
      tracker.currentTaskId = undefined;
      tracker.currentTaskStartedAt = undefined;
      trackers.set(key, tracker);
      continue;
    }

    const hardTimeoutMs = policy.hardTimeoutSeconds * 1000;
    if (tracker.currentTaskStartedAt && now - tracker.currentTaskStartedAt > hardTimeoutMs) {
      const taskId = tracker.currentTaskId || "unknown";
      updateTaskState(tracker, taskId, "timeout");
      const msg = buildFailureTemplate(activeAgent, taskId, "timeout", "hard timeout reached");
      appendProjectNotebook(activeAgent.workspace, activeProject, "Timeout", `task_id=${taskId}\nq=${currentQ}`);
      await sendMessage(Number(chatId), msg);
      tracker.awaitingResult = false;
      tracker.seenWorkingState = false;
      tracker.currentTaskId = undefined;
      tracker.currentTaskStartedAt = undefined;
      trackers.set(key, tracker);
      continue;
    }

    const stallMs = now - tracker.lastQChangeAt;
    const heartbeatMs = now - tracker.lastNotifyAt;
    if (heartbeatMs >= policy.heartbeatSeconds * 1000) {
      const taskId = tracker.currentTaskId || "unknown";
      await sendMessage(
        Number(chatId),
        `task running\ntask_id=${taskId}\nagent=${agentName}\nq=${currentQ}\nworkspace=${activeAgent.workspace}\n(no need to check tape manually)`
      );
      tracker.lastNotifyAt = now;
    }

    if (stallMs < policy.stallSeconds * 1000) {
      trackers.set(key, tracker);
      continue;
    }

    if (tracker.recoveryAttempts >= policy.maxRecoveryAttempts) {
      const taskId = tracker.currentTaskId || "unknown";
      updateTaskState(tracker, taskId, "timeout");
      const msg = buildFailureTemplate(activeAgent, taskId, "timeout", "recovery attempts exceeded");
      await sendMessage(Number(chatId), msg);
      tracker.awaitingResult = false;
      tracker.seenWorkingState = false;
      tracker.recoveryAttempts = 0;
      tracker.currentTaskId = undefined;
      tracker.currentTaskStartedAt = undefined;
      trackers.set(key, tracker);
      continue;
    }

    tracker.recoveryAttempts += 1;
    tracker.lastQChangeAt = now;
    tracker.lastNotifyAt = now;
    const taskId = tracker.currentTaskId || "unknown";
    updateTaskState(tracker, taskId, "recovering");

    if (isInvalidHeadPointer(activeAgent.workspace)) {
      writeD(activeAgent.workspace, "MAIN_TAPE.md");
      writeQ(activeAgent.workspace, "q_1: PROCESSING_USER_REQUEST");
      appendSystemRecoveryNote(
        activeAgent.workspace,
        `head pointer was invalid; reset d to MAIN_TAPE.md (attempt ${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}).`
      );
    } else {
      appendSystemRecoveryNote(
        activeAgent.workspace,
        `state stagnation detected; enforce alternate strategy and tool retries (attempt ${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}).`
      );
    }

    await sendMessage(
      Number(chatId),
      `task recovering\ntask_id=${taskId}\nagent=${agentName}\nq=${readQ(activeAgent.workspace)}\nattempt=${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}`
    );
    appendProjectNotebook(
      activeAgent.workspace,
      activeProject,
      "Recovery",
      `task_id=${taskId}\nauto-recovery attempt ${tracker.recoveryAttempts}/${policy.maxRecoveryAttempts}\nq=${readQ(activeAgent.workspace)}`
    );
    trackers.set(key, tracker);
  }
}

async function runBash(raw: string): Promise<string> {
  if (!ENABLE_BASH) return "bash is disabled. Set TELEGRAM_ENABLE_BASH=true.";
  try {
    const { stdout, stderr } = await execAsync(raw, {
      cwd: process.cwd(),
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = `${stdout}${stderr}`.trim() || "Silent Success";
    return out.slice(0, OUTPUT_LIMIT);
  } catch (e: any) {
    const out = (e.stderr || e.stdout || e.message || "bash failed").toString();
    return out.slice(0, OUTPUT_LIMIT);
  }
}

async function captureTmuxPane(target: string): Promise<string> {
  const cmd = `tmux capture-pane -pt ${target} -S -200`;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: process.cwd(),
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const content = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
    return content || "[NO_OUTPUT]";
  } catch (error: any) {
    const details = (error?.stderr || error?.stdout || error?.message || "tmux capture failed").toString().trim();
    throw new Error(details || "tmux capture failed");
  }
}

async function listTmuxTargets(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} pane_id=#{pane_id} active=#{pane_active} cmd=#{pane_current_command} title=#{pane_title}'",
      {
        cwd: process.cwd(),
        timeout: 8000,
        maxBuffer: 512 * 1024,
      }
    );
    const out = stdout.trim();
    return out || "(no tmux panes)";
  } catch (error: any) {
    return `tmux list failed: ${error?.message || "unknown error"}`;
  }
}

function activeTmuxTarget(chatId: number | string): string | null {
  const watcher = tmuxWatchers.get(tmuxWatcherKey(chatId));
  return watcher?.target ?? null;
}

async function sendTmuxInput(target: string, payload: string, pressEnter: boolean): Promise<void> {
  const runSendKeys = (args: string[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("tmux", args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "ignore",
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`tmux ${args.join(" ")} failed with code ${code ?? 1}`));
      });
    });

  if (payload.length > 0) {
    // Use literal mode so payload text is not interpreted as tmux key names.
    await runSendKeys(["send-keys", "-t", target, "-l", payload]);
  }

  if (pressEnter) {
    // Some terminal apps consume CR but submit on LF; default to LF for robustness.
    if (TMUX_SUBMIT_MODE === "cr") {
      await runSendKeys(["send-keys", "-t", target, "C-m"]);
    } else if (TMUX_SUBMIT_MODE === "both") {
      await runSendKeys(["send-keys", "-t", target, "C-m"]);
      await runSendKeys(["send-keys", "-t", target, "C-j"]);
    } else if (TMUX_SUBMIT_MODE === "enter") {
      await runSendKeys(["send-keys", "-t", target, "Enter"]);
    } else if (TMUX_SUBMIT_MODE === "literal-lf") {
      await runSendKeys(["send-keys", "-t", target, "-l", "\n"]);
    } else {
      await runSendKeys(["send-keys", "-t", target, "C-j"]);
    }
  }
}

function stopTmuxWatcher(chatId: number | string): boolean {
  const key = tmuxWatcherKey(chatId);
  const watcher = tmuxWatchers.get(key);
  if (!watcher) return false;
  clearInterval(watcher.timer);
  tmuxWatchers.delete(key);
  return true;
}

async function startTmuxWatcher(chatId: number, target: string): Promise<void> {
  stopTmuxWatcher(chatId);

  const initialSnapshot = await captureTmuxPane(target);
  const initialTailLines = tmuxTailLines(initialSnapshot);
  await sendMessage(chatId, buildTmuxPush("started", target, "baseline captured; waiting for new output..."));

  const key = tmuxWatcherKey(chatId);
  const watcher: TmuxWatcher = {
    target,
    timer: setInterval(() => {
      void (async () => {
        const live = tmuxWatchers.get(key);
        if (!live) return;
        if (live.busy) return;
        live.busy = true;

        try {
          const snapshot = await captureTmuxPane(live.target);
          const nextTailLines = tmuxTailLines(snapshot);
          const now = Date.now();
          const minGapMs = Math.max(1, TMUX_MIN_PUSH_SECONDS) * 1000;
          const quietMs = Math.max(1, TMUX_QUIET_SECONDS) * 1000;
          const typingQuietMs = Math.max(2, TMUX_TYPING_QUIET_SECONDS) * 1000;
          const maxBatchMs = Math.max(2, TMUX_MAX_BATCH_SECONDS) * 1000;
          const minBatchLines = Math.max(1, TMUX_MIN_BATCH_LINES);

          if (!sameLines(nextTailLines, live.lastTailLines)) {
            live.lastDigestChangeAt = now;
            const novel = collectNovelLines(live, nextTailLines);
            if (novel.length > 0) {
              live.pendingLines = appendPendingLines(live.pendingLines, novel);
              markSeenLines(live, novel);
              if (live.pendingSinceAt === 0) {
                live.pendingSinceAt = now;
              }
            }
            live.lastTailLines = nextTailLines;
          }

          const pendingAge = live.pendingSinceAt > 0 ? now - live.pendingSinceAt : 0;
          const promptOnlyPending =
            live.pendingLines.length > 0 &&
            live.pendingLines.every((line) => isLikelyInteractivePromptLine(line));
          const effectiveQuietMs = promptOnlyPending ? Math.max(quietMs, typingQuietMs) : quietMs;
          const shouldFlush =
            live.pendingLines.length > 0 &&
            now - live.lastSentAt >= minGapMs &&
            (
              (live.pendingLines.length >= minBatchLines && now - live.lastDigestChangeAt >= effectiveQuietMs) ||
              pendingAge >= maxBatchMs
            );

          if (shouldFlush) {
            const payloadLines =
              live.lastTailLines.length > 0
                ? live.lastTailLines.slice(-Math.max(20, TMUX_TAIL_LINES))
                : live.pendingLines.slice(-Math.max(20, TMUX_TAIL_LINES));
            const sig = payloadSignature(payloadLines);
            if (!sig || live.recentPayloadSigs.includes(sig)) {
              live.pendingLines = [];
              live.pendingSinceAt = 0;
            } else {
              live.lastSentAt = now;
              live.errorCount = 0;
              const payload = payloadLines.join("\n");
              await sendMessage(chatId, buildTmuxPush("update", live.target, payload));
              appendRecentPayloadSig(live, sig);
              live.pendingLines = [];
              live.pendingSinceAt = 0;
            }
          }
        } catch (error: any) {
          live.errorCount += 1;
          if (live.errorCount >= 3) {
            stopTmuxWatcher(chatId);
            await sendMessage(chatId, `tmux watcher stopped: ${error?.message || "capture failed"}`);
          }
        } finally {
          live.busy = false;
        }
      })().catch(() => {
        // no-op; loop is best-effort and self-healing.
      });
    }, Math.max(2, TMUX_POLL_SECONDS) * 1000),
    lastTailLines: initialTailLines,
    pendingLines: [],
    pendingSinceAt: 0,
    lastDigestChangeAt: Date.now(),
    seenLineSigs: initialTailLines.map((line) => lineSignature(line)).filter(Boolean),
    seenLineSigSet: new Set(initialTailLines.map((line) => lineSignature(line)).filter(Boolean)),
    recentPayloadSigs: [],
    busy: false,
    errorCount: 0,
    lastSentAt: Date.now(),
  };

  tmuxWatchers.set(key, watcher);
}

async function describeHostDirectory(): Promise<string> {
  const cwd = process.cwd();
  try {
    const { stdout } = await execAsync("ls -la", {
      cwd,
      timeout: 8000,
      maxBuffer: 512 * 1024,
    });
    const preview = stdout
      .split("\n")
      .slice(0, 30)
      .join("\n");
    return [`cwd=${cwd}`, "", "ls -la (top 30 lines):", preview].join("\n");
  } catch (e: any) {
    return `cwd=${cwd}\n(directory listing failed: ${e.message})`;
  }
}

function isHostDirectoryQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("当前目录") ||
    t.includes("本机目录") ||
    t.includes("工作目录") ||
    t.includes("where are you") ||
    t.includes("current directory") ||
    t.includes("pwd")
  );
}

async function handleCommand(msg: TelegramMessage, rawText: string) {
  const chatId = String(msg.chat.id);
  const session = getSession(chatId);
  const [cmd, ...rest] = rawText.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  if (cmd === "/start" || cmd === "/help") {
    await sendMessage(
      msg.chat.id,
      [
        "TuringClaw Telegram Arm ready.",
        "/agent <name> - switch/create agent",
        "/agents - list agents in this chat",
        "/project <name> - switch/create active project notebook",
        "/notebook [name] - show notebook tail",
        "/session - show queue/current/history",
        "/cancel <task_id> - cancel queued/running task",
        "/interrupt - cancel current running task",
        "/resume <task_id> - clone a history task back to queue",
        "/flush - flush collected agent inputs immediately",
        "/confirm - execute pending high-risk action",
        "/cancelconfirm - cancel pending high-risk action",
        "/status - read .reg_q/.reg_d",
        "/where - show host current directory and listing preview",
        "/tape [n] - tail MAIN_TAPE.md (default 40 lines)",
        "/tmuxlist - list available tmux pane targets",
        "/tmuxsend <target> <text> - send text to tmux target and press Enter",
        "/tmuxtype <text> - send text to currently watched tmux target",
        "/tmuxstop - stop active tmux live watcher",
        "/bash <cmd> - run shell command (optional, disabled by default)",
        "Explicit routes: 'agent: <task>' and 'tmux: <text>' (or 'tmux: <target>|<text>').",
        "Natural-language tmux monitor: send 'tmux attach -t <pane>, 实时监测并推送变化'.",
        "Natural-language tmux input: send '在tmux %1中输入：同意。'",
        "When tmux watcher is active, plain text goes to tmux by default. Use 'agent: ...' to force agent task mode.",
        "Any non-command text is sent to the active agent as task input.",
      ].join("\n")
    );
    return;
  }

  if (cmd === "/agent") {
    const name = normalizeAgentName(arg || "alpha");
    if (!session.agents.includes(name)) session.agents.push(name);
    session.activeAgent = name;
    saveSessions();
    const agent = getOrStartAgent(chatId, name);
    await sendMessage(msg.chat.id, `active agent=${name}\nworkspace=${agent.workspace}`);
    return;
  }

  if (cmd === "/agents") {
    await sendMessage(msg.chat.id, `active=${session.activeAgent}\nagents=${session.agents.join(", ")}`);
    return;
  }

  if (cmd === "/project") {
    const project = sanitizeProjectName(arg || "general");
    session.activeProject = project;
    saveSessions();
    const agent = getOrStartAgent(chatId, session.activeAgent);
    ensureProjectNotebook(agent.workspace, project);
    await sendMessage(
      msg.chat.id,
      `active project=${project}\nnotebook=${projectNotebookPath(agent.workspace, project)}`
    );
    return;
  }

  if (cmd === "/notebook") {
    const project = sanitizeProjectName(arg || session.activeProject || "general");
    const agent = getOrStartAgent(chatId, session.activeAgent);
    const tail = projectNotebookTail(agent.workspace, project, 80);
    await sendMessage(
      msg.chat.id,
      `project=${project}\nnotebook=${projectNotebookPath(agent.workspace, project)}\n\n${tail}`
    );
    return;
  }

  if (cmd === "/session") {
    const key = keyFor(chatId, session.activeAgent);
    const tracker = trackers.get(key);
    if (!tracker) {
      await sendMessage(msg.chat.id, "no session tracker for this agent yet.");
      return;
    }
    const queued = tracker.queue.map((t) => `${t.id}:${t.state}`).join(", ") || "(empty)";
    const history = tracker.history.slice(-5).map((t) => `${t.id}:${t.state}`).join(", ") || "(empty)";
    await sendMessage(
      msg.chat.id,
      `session\nagent=${session.activeAgent}\nproject=${session.activeProject || "general"}\ncurrent_task=${
        tracker.currentTaskId || "(none)"
      }\nawaiting=${tracker.awaitingResult}\nq=${tracker.lastQ}\nqueued=${queued}\nhistory(last5)=${history}`
    );
    return;
  }

  if (cmd === "/cancel") {
    const key = keyFor(chatId, session.activeAgent);
    const tracker = trackers.get(key);
    const target = arg.trim();
    if (!tracker) {
      await sendMessage(msg.chat.id, "no active session.");
      return;
    }
    if (!target) {
      await sendMessage(msg.chat.id, "usage: /cancel <task_id>");
      return;
    }
    const qidx = tracker.queue.findIndex((t) => t.id === target);
    if (qidx >= 0) {
      tracker.queue[qidx].state = "cancelled";
      tracker.queue[qidx].updatedAt = Date.now();
      tracker.history.push(tracker.queue[qidx]);
      tracker.queue.splice(qidx, 1);
      trackers.set(key, tracker);
      await sendMessage(msg.chat.id, `task cancelled from queue: ${target}`);
      return;
    }
    if (tracker.currentTaskId === target) {
      writeQ(workspaceFor(chatId, session.activeAgent), "FATAL_DEBUG");
      tracker.awaitingResult = false;
      tracker.seenWorkingState = false;
      tracker.history.push({
        id: target,
        state: "cancelled",
        project: sanitizeProjectName(session.activeProject || "general"),
        text: "(cancelled running task)",
        createdAt: tracker.currentTaskStartedAt || Date.now(),
        updatedAt: Date.now(),
      });
      tracker.currentTaskId = undefined;
      tracker.currentTaskStartedAt = undefined;
      trackers.set(key, tracker);
      await sendMessage(msg.chat.id, `running task cancelled: ${target}`);
      return;
    }
    await sendMessage(msg.chat.id, `task not found: ${target}`);
    return;
  }

  if (cmd === "/interrupt") {
    const key = keyFor(chatId, session.activeAgent);
    const tracker = trackers.get(key);
    if (!tracker || !tracker.currentTaskId) {
      await sendMessage(msg.chat.id, "no running task to interrupt.");
      return;
    }
    const target = tracker.currentTaskId;
    writeQ(workspaceFor(chatId, session.activeAgent), "FATAL_DEBUG");
    tracker.awaitingResult = false;
    tracker.seenWorkingState = false;
    tracker.history.push({
      id: target,
      state: "cancelled",
      project: sanitizeProjectName(session.activeProject || "general"),
      text: "(interrupted)",
      createdAt: tracker.currentTaskStartedAt || Date.now(),
      updatedAt: Date.now(),
    });
    tracker.currentTaskId = undefined;
    tracker.currentTaskStartedAt = undefined;
    trackers.set(key, tracker);
    await sendMessage(msg.chat.id, `interrupted task: ${target}`);
    return;
  }

  if (cmd === "/resume") {
    const key = keyFor(chatId, session.activeAgent);
    const tracker = trackers.get(key);
    const target = arg.trim();
    if (!tracker) {
      await sendMessage(msg.chat.id, "no active session.");
      return;
    }
    if (!target) {
      await sendMessage(msg.chat.id, "usage: /resume <task_id>");
      return;
    }
    const from = tracker.history.find((t) => t.id === target);
    if (!from) {
      await sendMessage(msg.chat.id, `task not found in history: ${target}`);
      return;
    }
    const resumed: TaskItem = {
      ...from,
      id: newTaskId(),
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tracker.queue.push(resumed);
    trackers.set(key, tracker);
    await sendMessage(msg.chat.id, `task resumed: old=${target}, new=${resumed.id}`);
    return;
  }

  if (cmd === "/flush") {
    const key = collectKey(chatId, session.activeAgent);
    const pending = pendingAgentCollects.get(key);
    if (!pending) {
      await sendMessage(msg.chat.id, "no pending collected inputs for active agent.");
      return;
    }
    const count = await flushAgentCollect(key, "manual");
    await sendMessage(msg.chat.id, `collect flushed\nagent=${session.activeAgent}\nitems=${count}`);
    return;
  }

  if (cmd === "/confirm") {
    const executed = await runPendingRiskConfirm(msg.chat.id, chatId);
    if (!executed) {
      await sendMessage(msg.chat.id, "no pending confirmation.");
    }
    return;
  }

  if (cmd === "/cancelconfirm") {
    const cancelled = clearPendingRiskConfirm(msg.chat.id);
    await sendMessage(msg.chat.id, cancelled ? "pending confirmation cancelled." : "no pending confirmation.");
    return;
  }

  if (cmd === "/status") {
    const agent = getOrStartAgent(chatId, session.activeAgent);
    await sendMessage(msg.chat.id, readStatus(agent.workspace));
    return;
  }

  if (cmd === "/where") {
    const info = await describeHostDirectory();
    await sendMessage(msg.chat.id, info);
    return;
  }

  if (cmd === "/tape") {
    const n = Math.min(300, Math.max(10, Number(arg || "40")));
    const agent = getOrStartAgent(chatId, session.activeAgent);
    const tape = tailFile(path.join(agent.workspace, "MAIN_TAPE.md"), n);
    await sendMessage(msg.chat.id, tape || "(empty tape)");
    return;
  }

  if (cmd === "/bash") {
    const output = await runBash(arg);
    await sendMessage(msg.chat.id, output);
    return;
  }

  if (cmd === "/tmuxstop") {
    const stopped = stopTmuxWatcher(msg.chat.id);
    await sendMessage(msg.chat.id, stopped ? "tmux watcher stopped." : "no active tmux watcher.");
    return;
  }

  if (cmd === "/tmuxlist") {
    const targets = await listTmuxTargets();
    await sendMessage(msg.chat.id, targets);
    return;
  }

  if (cmd === "/tmuxsend") {
    const [targetRaw, ...contentParts] = arg.split(/\s+/);
    const target = sanitizeTmuxTarget(targetRaw || "");
    const payload = contentParts.join(" ").trim();
    if (!target || !payload) {
      await sendMessage(msg.chat.id, "usage: /tmuxsend <target> <text>");
      return;
    }
    await sendTmuxInputWithRiskGate(msg.chat.id, target, payload, true);
    return;
  }

  if (cmd === "/tmuxtype") {
    const target = activeTmuxTarget(msg.chat.id);
    const payload = arg.trim();
    if (!target) {
      await sendMessage(msg.chat.id, "no active tmux watcher target. start with: tmux attach -t %1");
      return;
    }
    if (!payload) {
      await sendMessage(msg.chat.id, "usage: /tmuxtype <text>");
      return;
    }
    await sendTmuxInputWithRiskGate(msg.chat.id, target, payload, true);
    return;
  }

  await sendMessage(msg.chat.id, "unknown command. use /help");
}

function buildEnrichedTaskText(agent: AgentProcess, project: string, rawText: string): string {
  appendProjectNotebook(agent.workspace, project, "User Request", rawText);
  const snapshot = projectNotebookTail(agent.workspace, project, 60);
  const hints = loadProjectPolicy(agent.workspace, project).pathHints.join("\n");
  return [
    `[PROJECT]: ${project}`,
    `[PROJECT NOTEBOOK]: ${projectNotebookPath(agent.workspace, project)}`,
    "[PROJECT PATH HINTS]",
    hints,
    "[PROJECT NOTEBOOK SNAPSHOT]",
    snapshot,
    "",
    rawText.trim(),
  ].join("\n");
}

function ensureAgentTracker(key: string, workspace: string): AgentTracker {
  const existing = trackers.get(key);
  if (existing) return existing;

  const created: AgentTracker = {
    lastQ: readQ(workspace),
    awaitingResult: false,
    seenWorkingState: false,
    lastQChangeAt: Date.now(),
    lastNotifyAt: 0,
    recoveryAttempts: 0,
    queue: [],
    history: [],
  };
  trackers.set(key, created);
  return created;
}

async function enqueueAgentTask(
  chatNumericId: number,
  chatId: string,
  agentName: string,
  project: string,
  rawText: string
): Promise<void> {
  const agent = getOrStartAgent(chatId, agentName);
  const key = keyFor(chatId, agentName);
  const tracker = ensureAgentTracker(key, agent.workspace);

  const task: TaskItem = {
    id: newTaskId(),
    state: "queued",
    project,
    text: buildEnrichedTaskText(agent, project, rawText),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tracker.queue.push(task);

  if (!tracker.awaitingResult && !tracker.currentTaskId) {
    const first = tracker.queue.shift()!;
    first.state = "running";
    first.updatedAt = Date.now();
    tracker.currentTaskId = first.id;
    tracker.currentTaskStartedAt = Date.now();
    tracker.awaitingResult = true;
    tracker.lastQ = readQ(agent.workspace);
    tracker.seenWorkingState = false;
    tracker.lastQChangeAt = Date.now();
    tracker.lastNotifyAt = 0;
    tracker.recoveryAttempts = 0;
    enqueueUserRequest(agent.workspace, first.text);
    appendProjectNotebook(agent.workspace, project, "Task Start", `task_id=${first.id}\nstate=running`);
    await sendMessage(
      chatNumericId,
      `task running\ntask_id=${first.id}\nagent=${agent.name}\nproject=${project}\n${readStatus(agent.workspace)}`
    );
    trackers.set(key, tracker);
    return;
  }

  trackers.set(key, tracker);
  await sendMessage(
    chatNumericId,
    `task queued\ntask_id=${task.id}\nagent=${agent.name}\nproject=${project}\nqueue_len=${tracker.queue.length}\ncurrent_task=${
      tracker.currentTaskId || "(none)"
    }`
  );
}

function collectKey(chatId: string, agentName: string): string {
  return keyFor(chatId, agentName);
}

function combineCollectedLines(lines: string[]): string {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean);
  if (cleaned.length <= 1) return cleaned[0] || "";
  return [`[COLLECTED_USER_REQUESTS count=${cleaned.length}]`, ...cleaned.map((line, idx) => `[${idx + 1}] ${line}`)].join(
    "\n\n"
  );
}

function scheduleCollectFlush(key: string): NodeJS.Timeout {
  return setTimeout(() => {
    void flushAgentCollect(key, "timer").catch((error: any) => {
      console.error("[telegram] collect flush failed:", error?.message || "unknown");
    });
  }, Math.max(1, AGENT_COLLECT_SECONDS) * 1000);
}

async function flushAgentCollect(key: string, _reason: "timer" | "manual" | "project-switch"): Promise<number> {
  const pending = pendingAgentCollects.get(key);
  if (!pending) return 0;
  clearTimeout(pending.timer);
  pendingAgentCollects.delete(key);

  const count = pending.lines.length;
  const combined = combineCollectedLines(pending.lines);
  if (!combined) return 0;

  await enqueueAgentTask(
    pending.chatNumericId,
    pending.chatId,
    pending.agentName,
    sanitizeProjectName(pending.project),
    combined
  );
  return count;
}

async function enqueueAgentTaskWithCollect(
  chatNumericId: number,
  chatId: string,
  agentName: string,
  project: string,
  rawText: string
): Promise<void> {
  if (AGENT_COLLECT_SECONDS <= 0) {
    await enqueueAgentTask(chatNumericId, chatId, agentName, project, rawText);
    return;
  }

  const key = collectKey(chatId, agentName);
  let pending = pendingAgentCollects.get(key);
  if (pending && sanitizeProjectName(pending.project) !== sanitizeProjectName(project)) {
    await flushAgentCollect(key, "project-switch");
    pending = undefined;
  }

  if (!pending) {
    pending = {
      key,
      chatId,
      chatNumericId,
      agentName,
      project,
      lines: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timer: scheduleCollectFlush(key),
    };
    pendingAgentCollects.set(key, pending);
    await sendMessage(
      chatNumericId,
      `agent collect started\nagent=${agentName}\nproject=${project}\nwindow=${AGENT_COLLECT_SECONDS}s\nuse /flush to dispatch now`
    );
  } else {
    clearTimeout(pending.timer);
    pending.timer = scheduleCollectFlush(key);
  }

  pending.lines.push(rawText);
  pending.updatedAt = Date.now();
  pending.project = project;
  pendingAgentCollects.set(key, pending);
}

async function executeTmuxInput(
  chatNumericId: number,
  target: string,
  payload: string,
  pressEnter: boolean
): Promise<void> {
  try {
    await sendTmuxInput(target, payload, pressEnter);
    const submitMode = pressEnter ? TMUX_SUBMIT_MODE : "none";
    await sendMessage(
      chatNumericId,
      `tmux input sent\ntarget=${target}\npayload=${payload}\nenter=${pressEnter}\nsubmit_mode=${submitMode}`
    );
  } catch (error: any) {
    await sendMessage(chatNumericId, `tmux input failed\ntarget=${target}\nerror=${error?.message || "unknown error"}`);
  }
}

async function requestRiskConfirm(chatNumericId: number, pending: PendingRiskConfirm): Promise<void> {
  const replaced = getPendingRiskConfirm(chatNumericId);
  setPendingRiskConfirm(chatNumericId, pending);
  const prefix = replaced ? "previous pending confirmation replaced.\n" : "";
  await sendMessage(chatNumericId, `${prefix}${formatPendingRiskConfirm(pending)}`);
}

async function runPendingRiskConfirm(chatNumericId: number, chatId: string): Promise<boolean> {
  const pending = getPendingRiskConfirm(chatNumericId);
  if (!pending) return false;
  clearPendingRiskConfirm(chatNumericId);

  if (pending.lane === "tmux") {
    await executeTmuxInput(chatNumericId, pending.target, pending.payload, pending.pressEnter);
    return true;
  }

  const key = collectKey(chatId, pending.agentName);
  await flushAgentCollect(key, "manual");
  await enqueueAgentTask(
    chatNumericId,
    chatId,
    pending.agentName,
    sanitizeProjectName(pending.project),
    pending.text
  );
  return true;
}

async function sendTmuxInputWithRiskGate(
  chatNumericId: number,
  target: string,
  payload: string,
  pressEnter: boolean
): Promise<void> {
  const riskTags = detectHighRiskTags(payload);
  if (riskTags.length > 0) {
    const now = Date.now();
    await requestRiskConfirm(chatNumericId, {
      lane: "tmux",
      createdAt: now,
      expiresAt: now + Math.max(10, CONFIRM_TTL_SECONDS) * 1000,
      riskTags,
      target,
      payload,
      pressEnter,
    });
    return;
  }
  await executeTmuxInput(chatNumericId, target, payload, pressEnter);
}

async function enqueueAgentTaskWithRiskGate(
  chatNumericId: number,
  chatId: string,
  agentName: string,
  project: string,
  rawText: string
): Promise<void> {
  const riskTags = detectHighRiskTags(rawText);
  if (riskTags.length > 0) {
    const now = Date.now();
    await requestRiskConfirm(chatNumericId, {
      lane: "agent",
      createdAt: now,
      expiresAt: now + Math.max(10, CONFIRM_TTL_SECONDS) * 1000,
      riskTags,
      agentName,
      project,
      text: rawText,
    });
    return;
  }
  await enqueueAgentTaskWithCollect(chatNumericId, chatId, agentName, project, rawText);
}

async function handleTextMessage(msg: TelegramMessage, text: string) {
  // Ops-style natural language questions should get an immediate host answer.
  if (isHostDirectoryQuestion(text)) {
    const info = await describeHostDirectory();
    await sendMessage(msg.chat.id, info);
    return;
  }

  if (isTmuxStopRequest(text)) {
    const stopped = stopTmuxWatcher(msg.chat.id);
    await sendMessage(msg.chat.id, stopped ? "tmux watcher stopped." : "no active tmux watcher.");
    return;
  }

  if (isNaturalCancelConfirmText(text)) {
    const cancelled = clearPendingRiskConfirm(msg.chat.id);
    await sendMessage(msg.chat.id, cancelled ? "pending confirmation cancelled." : "no pending confirmation.");
    return;
  }

  if (isNaturalConfirmText(text)) {
    const executed = await runPendingRiskConfirm(msg.chat.id, String(msg.chat.id));
    if (!executed) {
      await sendMessage(msg.chat.id, "no pending confirmation.");
    }
    return;
  }

  const chatId = String(msg.chat.id);
  const session = getSession(chatId);
  const watchedTarget = activeTmuxTarget(msg.chat.id);
  const tmuxOverrideText = parseTmuxOverrideText(text);
  const agentOverrideText = parseAgentOverrideText(text);

  // Route precedence: explicit command (handled upstream) > explicit lane directive > heuristics/default.
  if (tmuxOverrideText) {
    const parsed = parseTmuxOverridePayload(tmuxOverrideText, watchedTarget);
    if (!parsed?.target || !parsed.payload) {
      await sendMessage(
        msg.chat.id,
        "tmux override parse failed. use: tmux: <text> (with active watcher) or tmux: <target>|<text>"
      );
      return;
    }
    await sendTmuxInputWithRiskGate(msg.chat.id, parsed.target, parsed.payload, parsed.pressEnter);
    return;
  }

  if (agentOverrideText) {
    const project = sanitizeProjectName(session.activeProject || inferProjectFromText(agentOverrideText));
    session.activeProject = project;
    saveSessions();
    await enqueueAgentTaskWithRiskGate(msg.chat.id, chatId, session.activeAgent, project, agentOverrideText);
    return;
  }

  const monitorTarget = extractTmuxTarget(text);
  if (monitorTarget && isTmuxMonitorRequest(text)) {
    const cancelledTaskId = cancelRunningTask(chatId, session.activeAgent, "superseded by tmux live monitor");
    await startTmuxWatcher(msg.chat.id, monitorTarget);
    if (cancelledTaskId) {
      await sendMessage(msg.chat.id, `cancelled previous agent task: ${cancelledTaskId}`);
    }
    return;
  }

  const explicitTarget = extractTmuxTarget(text);
  const explicitParsed = extractTmuxInputPayload(text);
  const implicitParsed = extractImplicitReplyPayload(text);
  const shouldRouteTmuxInput =
    isTmuxInputRequest(text) ||
    (Boolean(watchedTarget) && isImplicitTmuxInputRequest(text));

  if (shouldRouteTmuxInput) {
    const target = explicitTarget ?? watchedTarget;
    const parsed = explicitParsed ?? implicitParsed;
    if (!target || !parsed) {
      await sendMessage(
        msg.chat.id,
        "tmux input parse failed. use: 在tmux attach -t %1中输入：同意。 或 /tmuxsend %1 同意。"
      );
      return;
    }
    await sendTmuxInputWithRiskGate(msg.chat.id, target, parsed.payload, parsed.pressEnter);
    return;
  }

  // Focus mode: while watching a tmux pane, plain text defaults to tmux input.
  if (watchedTarget) {
    const payload = text.trim();
    if (!payload) return;
    await sendTmuxInputWithRiskGate(msg.chat.id, watchedTarget, payload, true);
    return;
  }

  const project = sanitizeProjectName(session.activeProject || inferProjectFromText(text));
  session.activeProject = project;
  saveSessions();
  await enqueueAgentTaskWithRiskGate(msg.chat.id, chatId, session.activeAgent, project, text);
}

async function handleUpdate(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  console.log(
    `[telegram] update chat=${msg.chat.id} message_id=${msg.message_id} text="${msg.text.slice(0, 80)}"`
  );

  if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(String(msg.chat.id))) {
    console.log(`[telegram] rejected unauthorized chat=${msg.chat.id}`);
    await sendMessage(msg.chat.id, "unauthorized chat");
    return;
  }

  if (msg.text.startsWith("/")) {
    await handleCommand(msg, msg.text);
    return;
  }

  await handleTextMessage(msg, msg.text);
}

function loadOffset(): number {
  const state = loadJsonFile<{ offset: number }>(OFFSET_FILE, { offset: 0 });
  return Number(state.offset || 0);
}

function saveOffset(offset: number) {
  saveJsonFile(OFFSET_FILE, { offset });
}

async function pollLoop() {
  let offset = loadOffset();
  loadSessions();
  bootstrapTrackersFromSessions();

  console.log("[telegram] arm online, polling updates...");
  while (true) {
    try {
      const updates = await tgApi<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (e: any) {
          console.error("[telegram] update handling error:", e.message);
        } finally {
          offset = update.update_id + 1;
          saveOffset(offset);
        }
      }
    } catch (e: any) {
      console.error("[telegram] polling error:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function validateEnv() {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
}

async function main() {
  validateEnv();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(BASE_WORKSPACE, { recursive: true });
  setInterval(() => {
    void monitorAgentCompletion().catch((e) => {
      console.error("[telegram] completion monitor error:", e.message);
    });
  }, 3000);
  await pollLoop();
}

main().catch((err) => {
  console.error("[telegram] fatal:", err.message);
  process.exit(1);
});
