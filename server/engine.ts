import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exec, spawn, spawnSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';

type LLMProvider = 'gemini_api' | 'gemini_cli' | 'codex_cli' | 'kimi_api';
type ExecSecurityMode = 'full' | 'allowlist' | 'deny';
type ExecAskMode = 'off' | 'on-miss' | 'always';

const MAX_STDOUT = 2000;
const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GEMINI_API_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_KIMI_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_KIMI_MODEL = 'kimi-for-coding';
const DEFAULT_KIMI_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ROM_LINES = 15;
const DEFAULT_STAGNATION_WINDOW_CHARS = 2000;
const DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS = 6000;
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const kimiApiKey = process.env.KIMI_API_KEY;
const APPROVE_EXEC_TOKEN = '[APPROVE_EXEC]';
const APPROVE_DANGEROUS_TOKEN = '[APPROVE_DANGEROUS]';
const ALLOW_MOCK_SSH_TOKEN = '[ALLOW_MOCK_SSH]';
const ALLOW_UNLISTED_HOST_TOKEN = '[ALLOW_UNLISTED_HOST]';
const APPROVE_HOST_SWITCH_TOKEN = '[APPROVE_HOST_SWITCH]';
const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\bkill\s+-9\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bsystemctl\s+(stop|restart|reboot|poweroff)\b/i,
  /\bStop-Process\b/i,
  /\btaskkill\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
];

const DEFAULT_EXEC_ALLOWLIST = [
  'ls',
  'pwd',
  'cat',
  'echo',
  'head',
  'tail',
  'sed',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
  'wc',
  'find',
  'rg',
  'grep',
  'stat',
  'du',
  'df',
  'ps',
  'pgrep',
  'top',
  'date',
  'whoami',
  'hostname',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'python',
  'python3',
  'node',
  'npm',
  'ssh',
  'scp',
  'curl',
  'git',
  'unzip',
];

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type HostSourceSnapshot = {
  path: string;
  hosts: string[];
};

function normalizeProvider(value?: string): LLMProvider | null {
  const raw = (value || '').trim().toLowerCase();
  switch (raw) {
    case '':
      return null;
    case 'gemini_api':
    case 'gemini-api':
    case 'google_api':
    case 'google-api':
      return 'gemini_api';
    case 'gemini_cli':
    case 'gemini-cli':
    case 'gemini':
      return 'gemini_cli';
    case 'codex_cli':
    case 'codex-cli':
    case 'openai-codex':
    case 'openai_codex':
    case 'codex':
      return 'codex_cli';
    case 'kimi_api':
    case 'kimi-api':
    case 'kimi':
    case 'moonshot':
      return 'kimi_api';
    default:
      console.warn(`[CONFIG] Unknown LLM_PROVIDER="${value}", falling back to auto-detect.`);
      return null;
  }
}

function normalizeExecSecurity(value?: string): ExecSecurityMode {
  const raw = (value || '').trim().toLowerCase();
  if (raw === 'allowlist') return 'allowlist';
  if (raw === 'deny') return 'deny';
  return 'full';
}

function normalizeExecAsk(value?: string): ExecAskMode {
  const raw = (value || '').trim().toLowerCase();
  if (raw === 'always') return 'always';
  if (raw === 'on-miss' || raw === 'on_miss') return 'on-miss';
  return 'off';
}

function parseCsvList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sanitizeWorkspaceSegment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.slice(0, 64);
}

function resolveWorkspaceDir(): string {
  const explicitDir = (process.env.TURING_WORKSPACE_DIR || '').trim();
  if (explicitDir) {
    return path.isAbsolute(explicitDir) ? explicitDir : path.join(process.cwd(), explicitDir);
  }

  const rootRaw = (process.env.TURING_WORKSPACE_ROOT || path.join(process.cwd(), 'workspace-runs')).trim();
  const rootDir = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
  const taskId = sanitizeWorkspaceSegment(process.env.TURING_TASK_ID || '');
  if (taskId) {
    return path.join(rootDir, taskId);
  }

  const isolate = parseBool(process.env.TURING_WORKSPACE_ISOLATE, false);
  if (isolate) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(rootDir, `run_${stamp}_${process.pid}`);
  }

  return path.join(process.cwd(), 'workspace');
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function extractIpv4(text: string): string[] {
  const matches = text.match(IPV4_REGEX) || [];
  const unique = new Set<string>();
  for (const match of matches) {
    if (isValidIpv4(match)) unique.add(match);
  }
  return Array.from(unique);
}

function loadHostSourceSnapshots(paths: string[]): HostSourceSnapshot[] {
  const snapshots: HostSourceSnapshot[] = [];
  for (const sourcePath of paths) {
    try {
      if (!fs.existsSync(sourcePath)) continue;
      const content = fs.readFileSync(sourcePath, 'utf-8');
      const hosts = extractIpv4(content);
      snapshots.push({ path: sourcePath, hosts });
    } catch {
      // Ignore unreadable host source files and continue with remaining files.
    }
  }
  return snapshots;
}

function resolveAuthorizedHosts(snapshots: HostSourceSnapshot[]): { hosts: Set<string>; source: string } {
  const prioritized = snapshots.find((snapshot) => snapshot.hosts.length > 0);
  if (prioritized) {
    return { hosts: new Set(prioritized.hosts), source: prioritized.path };
  }

  const merged = new Set<string>();
  for (const snapshot of snapshots) {
    for (const host of snapshot.hosts) merged.add(host);
  }
  return { hosts: merged, source: merged.size > 0 ? 'merged-host-sources' : 'none' };
}

function sanitizeCliPath(pathValue?: string): string {
  if (!pathValue) return '';
  const segments = pathValue
    .split(path.delimiter)
    .filter((entry) => entry && !entry.includes(`${path.sep}node_modules${path.sep}.bin`));
  return segments.join(path.delimiter);
}

const CLI_PATH = sanitizeCliPath(process.env.PATH) || (process.env.PATH || '');
const WORKSPACE_DIR = resolveWorkspaceDir();
const TAPE_FILE = path.join(WORKSPACE_DIR, 'TAPE.md');
const execSecurityMode = normalizeExecSecurity(process.env.TURING_EXEC_SECURITY);
const execAskMode = normalizeExecAsk(process.env.TURING_EXEC_ASK);
const requireDangerousApproval = (process.env.TURING_REQUIRE_DANGEROUS_APPROVAL || 'true').trim().toLowerCase() !== 'false';
const allowMockSshByDefault = (process.env.TURING_ALLOW_MOCK_SSH || 'false').trim().toLowerCase() === 'true';
const validateIpTargets = (process.env.TURING_VALIDATE_IP_TARGETS || 'true').trim().toLowerCase() !== 'false';
const execAllowlist = (() => {
  const fromEnv = parseCsvList(process.env.TURING_EXEC_ALLOWLIST);
  return fromEnv.length > 0 ? fromEnv.map((item) => item.toLowerCase()) : DEFAULT_EXEC_ALLOWLIST;
})();
const maxTurnsPerRun = parsePositiveInt(process.env.TURING_MAX_TURNS_PER_RUN, 40);
const turingEntryHint = (process.env.TURING_ENTRY_HINT || '').trim();
const handoverSourcePaths = parseCsvList(process.env.TURING_HANDOVER_PATHS);
const hostSourcePaths = (() => {
  const fromEnv = parseCsvList(process.env.TURING_HOST_SOT_PATHS);
  if (fromEnv.length > 0) return fromEnv;
  return [path.join(WORKSPACE_DIR, 'memory', 'host_config.md')];
})();
const hostSourceSnapshots = loadHostSourceSnapshots(hostSourcePaths);
const authorizedHostResolution = resolveAuthorizedHosts(hostSourceSnapshots);
const authorizedHosts = authorizedHostResolution.hosts;
const rawScopeHosts = parseCsvList(process.env.TURING_SCOPE_HOSTS);
const validScopeHosts = rawScopeHosts.filter((host) => isValidIpv4(host));
const invalidScopeHosts = rawScopeHosts.filter((host) => !isValidIpv4(host));
const scopeHosts = new Set(validScopeHosts);
const romLines = parsePositiveInt(process.env.TURING_ROM_LINES, DEFAULT_ROM_LINES);
const stagnationWindowChars = parsePositiveInt(
  process.env.TURING_STAGNATION_WINDOW_CHARS,
  DEFAULT_STAGNATION_WINDOW_CHARS
);
const workspaceContextMaxChars = parsePositiveInt(
  process.env.TURING_CONTEXT_MAX_CHARS,
  DEFAULT_WORKSPACE_CONTEXT_MAX_CHARS
);

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    env: { ...process.env, PATH: CLI_PATH },
  });
  return !result.error && result.status === 0;
}

function resolveProvider(): LLMProvider {
  const configured = normalizeProvider(process.env.LLM_PROVIDER);
  if (configured) return configured;
  if (commandAvailable('gemini')) return 'gemini_cli';
  if (commandAvailable('codex')) return 'codex_cli';
  if (kimiApiKey && kimiApiKey.trim().length > 0) return 'kimi_api';
  return 'gemini_api';
}

const llmProvider = resolveProvider();
let geminiApiClient: GoogleGenAI | null = null;

if (llmProvider === 'gemini_api') {
  if (!geminiApiKey || geminiApiKey === 'MY_GEMINI_API_KEY') {
    console.warn('[CONFIG] GEMINI_API_KEY/GOOGLE_API_KEY is missing or placeholder. Gemini API calls will fail.');
  } else {
    geminiApiClient = new GoogleGenAI({ apiKey: geminiApiKey });
  }
}
if (llmProvider === 'kimi_api') {
  if (!kimiApiKey || kimiApiKey.trim().length === 0) {
    console.warn('[CONFIG] KIMI_API_KEY is missing. Kimi API calls will fail.');
  }
}

console.log(`[LLM] Provider selected: ${llmProvider}`);
console.log(`[GUARDRAIL] exec_security=${execSecurityMode}, exec_ask=${execAskMode}, dangerous_approval=${requireDangerousApproval}`);
console.log(`[GUARDRAIL] mock_ssh_default=${allowMockSshByDefault}, validate_ip_targets=${validateIpTargets}`);
console.log(`[GUARDRAIL] max_turns_per_run=${maxTurnsPerRun}`);
console.log(`[GUARDRAIL] rom_lines=${romLines}, stagnation_window_chars=${stagnationWindowChars}`);
if (turingEntryHint) {
  console.log(`[GUARDRAIL] entry_hint=${turingEntryHint}`);
}
if (handoverSourcePaths.length > 0) {
  console.log(`[GUARDRAIL] handover_sources=${handoverSourcePaths.join(',')}`);
}
console.log(`[RUNTIME] workspace_dir=${WORKSPACE_DIR}`);
console.log(`[RUNTIME] tape_file=${TAPE_FILE}`);
if (authorizedHosts.size > 0) {
  console.log(`[GUARDRAIL] authorized_hosts_source=${authorizedHostResolution.source} hosts=${Array.from(authorizedHosts).join(',')}`);
} else {
  console.log('[GUARDRAIL] No authorized hosts discovered from host source files.');
}
if (scopeHosts.size > 0) {
  console.log(`[GUARDRAIL] scope_hosts=${Array.from(scopeHosts).join(',')}`);
}
if (invalidScopeHosts.length > 0) {
  console.warn(`[CONFIG] Ignoring invalid TURING_SCOPE_HOSTS entries: ${invalidScopeHosts.join(', ')}`);
}

export class TuringClawEngine {
  private isRunning: boolean = false;
  private strikes: number = 0;
  private turnCount: number = 0;
  private lastHandoverDigest: string = '';
  private workspaceContextPath: string = '';
  private workspaceContextContent: string = '';
  private workspaceContextDigest: string = '';

  constructor() {
    this.initPaper();
    this.bootstrapHandoverContext();
    this.refreshWorkspaceContext();
  }

  // ==========================================
  // The Paper (纸带：绝对的单一真实物理状态源)
  // ==========================================
  private initPaper() {
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    if (!fs.existsSync(TAPE_FILE)) {
      fs.writeFileSync(TAPE_FILE, '# TURING CLAW TAPE\n[SYSTEM]: Machine booted. The tape is clean.\n', 'utf-8');
    }

    // Initialize operational directories used by external tooling.
    const memoryPath = path.join(WORKSPACE_DIR, 'memory');
    const skillsPath = path.join(WORKSPACE_DIR, 'skills');

    if (!fs.existsSync(memoryPath)) fs.mkdirSync(memoryPath, { recursive: true });
    if (!fs.existsSync(skillsPath)) fs.mkdirSync(skillsPath, { recursive: true });

    const ensureSkillScript = (filename: string, content: string) => {
      const scriptPath = path.join(skillsPath, filename);
      if (fs.existsSync(scriptPath)) return;
      fs.writeFileSync(scriptPath, content.trim() + '\n', 'utf-8');
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch {
        // Ignore chmod failures on non-POSIX environments.
      }
    };

    ensureSkillScript('github_fetcher.py', `
#!/usr/bin/env python3
import sys
import urllib.request

if len(sys.argv) < 2:
    print("Usage: python3 github_fetcher.py <raw_github_url_or_search_term>")
    sys.exit(1)

query = sys.argv[1]
if query.startswith("http"):
    url = query if "raw.githubusercontent" in query else query.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'TuringClaw/1.0'})
        with urllib.request.urlopen(req) as response:
            print(response.read().decode('utf-8')[:4000] + "\\n...[truncated if too long]...")
    except Exception as e:
        print(f"Error fetching URL: {e}")
else:
    print(f"I am a simple fetcher. Please find the raw GitHub URL for '{query}' and pass it to me.")
    `);

    ensureSkillScript('remote_mgr.py', `
#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys

def load_runtime_env():
    env = {}
    candidates = []
    explicit = os.getenv("TURING_SSH_ENV_FILE")
    if explicit:
        candidates.append(explicit)
    candidates.append(os.path.join(os.getcwd(), "memory", "ssh_runtime.env"))
    for candidate in candidates:
        path = candidate if os.path.isabs(candidate) else os.path.join(os.getcwd(), candidate)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    raw = line.strip()
                    if not raw or raw.startswith("#") or "=" not in raw:
                        continue
                    key, value = raw.split("=", 1)
                    env[key.strip()] = value.strip()
        except Exception:
            continue
    return env

RUNTIME_ENV = load_runtime_env()

def env_get(name, fallback=""):
    val = os.getenv(name)
    if val is not None and val != "":
        return val
    return RUNTIME_ENV.get(name, fallback)

def env_int(name, fallback):
    raw = env_get(name, "")
    try:
        return int(raw)
    except Exception:
        return fallback

def parse_args():
    parser = argparse.ArgumentParser(description="Execute remote commands over SSH.")
    parser.add_argument("--host", required=True, help="Target host/IP.")
    parser.add_argument("--cmd", required=True, help="Remote command string.")
    parser.add_argument("--type", choices=["linux", "windows"], default="linux", help="Remote host type.")
    parser.add_argument("--user", default=env_get("TURING_SSH_USER", "") or env_get("SSH_USER", "") or env_get("USER", ""), help="SSH username.")
    parser.add_argument("--port", type=int, default=env_int("TURING_SSH_PORT", 22), help="SSH port.")
    parser.add_argument("--key", default=env_get("TURING_SSH_KEY", ""), help="SSH private key path.")
    parser.add_argument("--timeout", type=int, default=env_int("TURING_SSH_TIMEOUT", 30), help="Connect timeout seconds.")
    parser.add_argument(
        "--strict-host-key-checking",
        dest="strict_host_key_checking",
        choices=["yes", "no"],
        default=env_get("TURING_SSH_STRICT", "no"),
        help="StrictHostKeyChecking option."
    )
    return parser.parse_args()

def build_remote_cmd(host_type, cmd):
    cmd_lower = cmd.lower()
    if host_type == "windows" and "powershell" not in cmd_lower and "cmd.exe" not in cmd_lower:
        return f'powershell.exe -NoProfile -NonInteractive -Command "{cmd}"'
    return cmd

def main():
    args = parse_args()
    target = f"{args.user}@{args.host}" if args.user else args.host
    ssh_cmd = [
        "ssh",
        "-p", str(args.port),
        "-o", f"ConnectTimeout={args.timeout}",
        "-o", "BatchMode=yes",
        "-o", f"StrictHostKeyChecking={args.strict_host_key_checking}",
    ]
    if args.key:
        ssh_cmd.extend(["-i", args.key])
    ssh_cmd.append(target)
    ssh_cmd.append(build_remote_cmd(args.type, args.cmd))

    result = subprocess.run(ssh_cmd, capture_output=True, text=True)
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    sys.exit(result.returncode)

if __name__ == "__main__":
    main()
    `);
  }

  private placeholderLike(value: string): boolean {
    const lowered = value.toLowerCase();
    const markers = [
      '<',
      '>',
      'placeholder',
      'changeme',
      'example',
      '你的',
      'your_',
      '/你的私钥路径',
      '/your/key/path',
    ];
    return markers.some((marker) => lowered.includes(marker));
  }

  private normalizeValue(rawValue: string, sourceFile: string): string {
    let value = rawValue.trim();
    value = value.replace(/^['"`]+|['"`]+$/g, '').trim();
    value = value.replace(/\s+#.*$/, '').trim();
    if (value.startsWith('~')) {
      value = path.join(process.env.HOME || '', value.slice(1));
    }
    if ((value.startsWith('./') || value.startsWith('../')) && sourceFile) {
      value = path.resolve(path.dirname(sourceFile), value);
    }
    return value;
  }

  private extractPathsFromEntryHint(): string[] {
    if (!turingEntryHint) return [];
    const matches = turingEntryHint.match(/\/[^\s"'`),]+/g) || [];
    return matches.filter((p) => p.includes('/handover'));
  }

  private collectHandoverFiles(sourcePath: string): string[] {
    const results: string[] = [];
    const allowExt = new Set(['.md', '.txt', '.env', '.yaml', '.yml', '.json']);
    const addFile = (filePath: string) => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return;
        const ext = path.extname(filePath).toLowerCase();
        if (allowExt.has(ext)) results.push(filePath);
      } catch {
        // Ignore unreadable files.
      }
    };

    try {
      if (!fs.existsSync(sourcePath)) return results;
      const stat = fs.statSync(sourcePath);
      if (stat.isFile()) {
        addFile(sourcePath);
        return results;
      }

      // Prefer canonical entry docs first.
      addFile(path.join(sourcePath, 'ai-direct', 'LATEST.md'));
      addFile(path.join(sourcePath, 'LATEST.md'));
      addFile(path.join(sourcePath, 'README.md'));

      const queue: Array<{ dir: string; depth: number }> = [{ dir: sourcePath, depth: 0 }];
      while (queue.length > 0 && results.length < 80) {
        const next = queue.shift();
        if (!next) break;
        const { dir, depth } = next;
        if (depth > 3) continue;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < 3) queue.push({ dir: fullPath, depth: depth + 1 });
            continue;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowExt.has(ext)) continue;
          const lowered = entry.name.toLowerCase();
          if (
            lowered.includes('latest') ||
            lowered.includes('handover') ||
            lowered.includes('ssh') ||
            lowered.includes('credential') ||
            lowered.includes('host')
          ) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      return results;
    }

    return results;
  }

  private bootstrapHandoverContext() {
    const memoryPath = path.join(WORKSPACE_DIR, 'memory');
    const indexPath = path.join(memoryPath, 'handover_index.md');
    const runtimeEnvPath = path.join(memoryPath, 'ssh_runtime.env');

    const sources = Array.from(
      new Set([
        ...handoverSourcePaths,
        ...this.extractPathsFromEntryHint(),
      ])
    ).filter(Boolean);

    const sourceDigest = sources.join('|');
    if (sourceDigest === this.lastHandoverDigest) return;
    this.lastHandoverDigest = sourceDigest;

    const files = Array.from(new Set(sources.flatMap((source) => this.collectHandoverFiles(source))));
    const findings: Record<string, { value: string; source: string }> = {};
    const record = (key: string, value: string, source: string) => {
      if (findings[key]) return;
      findings[key] = { value, source };
    };

    const keyPatterns: Array<{ key: string; patterns: RegExp[] }> = [
      {
        key: 'TURING_SSH_USER',
        patterns: [
          /(?:^|\n)\s*(?:TURING_SSH_USER|SSH_USER|ssh_user)\s*[:=]\s*([^\n]+)/i,
        ],
      },
      {
        key: 'TURING_SSH_KEY',
        patterns: [
          /(?:^|\n)\s*(?:TURING_SSH_KEY|SSH_KEY|IDENTITY_FILE|KEY_PATH|ssh_key)\s*[:=]\s*([^\n]+)/i,
        ],
      },
      {
        key: 'TURING_SSH_PORT',
        patterns: [
          /(?:^|\n)\s*(?:TURING_SSH_PORT|SSH_PORT|ssh_port)\s*[:=]\s*([^\n]+)/i,
        ],
      },
      {
        key: 'TURING_SSH_STRICT',
        patterns: [
          /(?:^|\n)\s*(?:TURING_SSH_STRICT|SSH_STRICT|strict_host_key_checking)\s*[:=]\s*([^\n]+)/i,
        ],
      },
    ];

    for (const filePath of files) {
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      for (const item of keyPatterns) {
        for (const regex of item.patterns) {
          const match = content.match(regex);
          if (!match || !match[1]) continue;
          const normalized = this.normalizeValue(match[1], filePath);
          if (!normalized || this.placeholderLike(normalized)) continue;
          record(item.key, normalized, filePath);
          break;
        }
      }
    }

    const runtimeKeys = ['TURING_SSH_USER', 'TURING_SSH_KEY', 'TURING_SSH_PORT', 'TURING_SSH_STRICT'];
    const runtime: Record<string, string> = {};
    const sourcesByKey: Record<string, string> = {};
    for (const key of runtimeKeys) {
      const fromEnv = (process.env[key] || '').trim();
      if (fromEnv) {
        runtime[key] = fromEnv;
        sourcesByKey[key] = 'process.env';
        continue;
      }
      const found = findings[key];
      if (!found) continue;
      runtime[key] = found.value;
      sourcesByKey[key] = found.source;
      process.env[key] = found.value;
    }
    process.env.TURING_SSH_ENV_FILE = runtimeEnvPath;

    {
      const runtimeLines = Object.entries(runtime).map(([key, value]) => `${key}=${value}`);
      if (runtimeLines.length === 0) {
        runtimeLines.push('# No SSH credentials discovered yet.');
      }
      fs.writeFileSync(runtimeEnvPath, runtimeLines.join('\n') + '\n', 'utf-8');
      try {
        fs.chmodSync(runtimeEnvPath, 0o600);
      } catch {
        // Ignore chmod failures on non-POSIX environments.
      }
    }

    const indexLines: string[] = [
      '# Handover Bootstrap',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Source Paths',
      ...(sources.length > 0 ? sources.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '## Scanned Files',
      ...(files.length > 0 ? files.slice(0, 80).map((item) => `- ${item}`) : ['- (none)']),
      '',
      '## Runtime SSH Vars (values hidden)',
    ];

    for (const key of runtimeKeys) {
      const state = runtime[key] ? 'set' : 'missing';
      const source = sourcesByKey[key] || 'n/a';
      indexLines.push(`- ${key}: ${state} (source: ${source})`);
    }

    indexLines.push('');
    indexLines.push(`Runtime env file: ${runtimeEnvPath}`);
    indexLines.push('Security: secrets are not written to TAPE.');

    fs.writeFileSync(indexPath, indexLines.join('\n') + '\n', 'utf-8');
  }

  private refreshWorkspaceContext() {
    const foundPath = path.join(WORKSPACE_DIR, 'context.md');
    let hasContext = false;
    try {
      hasContext = fs.existsSync(foundPath) && fs.statSync(foundPath).isFile();
    } catch {
      hasContext = false;
    }

    if (!hasContext) {
      if (this.workspaceContextPath) {
        this.workspaceContextPath = '';
        this.workspaceContextContent = '';
        this.workspaceContextDigest = '';
        console.log('[RUNTIME] context_doc=none');
      }
      return;
    }

    try {
      const stat = fs.statSync(foundPath);
      const digest = `${foundPath}:${stat.mtimeMs}:${stat.size}`;
      if (digest === this.workspaceContextDigest) return;

      let content = fs.readFileSync(foundPath, 'utf-8').replace(/\r\n/g, '\n').trim();
      let truncated = false;
      if (content.length > workspaceContextMaxChars) {
        content = content.slice(0, workspaceContextMaxChars);
        truncated = true;
      }

      this.workspaceContextPath = foundPath;
      this.workspaceContextContent = content;
      this.workspaceContextDigest = digest;

      const truncatedNote = truncated ? ` (truncated to ${workspaceContextMaxChars} chars)` : '';
      console.log(`[RUNTIME] context_doc=${foundPath}${truncatedNote}`);
    } catch {
      // If loading fails, clear to avoid stale content.
      this.workspaceContextPath = '';
      this.workspaceContextContent = '';
      this.workspaceContextDigest = '';
    }
  }

  public getTape(): string {
    return fs.readFileSync(TAPE_FILE, 'utf-8');
  }

  public getWorkspaceDir(): string {
    return WORKSPACE_DIR;
  }

  public getTapeFilePath(): string {
    return TAPE_FILE;
  }

  private readWithVision(): string {
    const lines = this.getTape().split('\n');
    return lines.map((line, i) => `${String(i + 1).padStart(4, '0')} | ${line}`).join('\n');
  }

  private appendToTape(text: string) {
    fs.appendFileSync(TAPE_FILE, text + '\n', 'utf-8');
  }

  private upsertGoalRom(userMessage: string) {
    const goalPrefix = '[ROM GOAL]:';
    const scopePrefix = '[ROM SCOPE]:';
    const compactGoal = userMessage.replace(/\s+/g, ' ').trim().slice(0, 400) || 'Awaiting user objective.';
    const scopeNote = scopeHosts.size > 0
      ? `Allowed hosts: ${Array.from(scopeHosts).join(', ')}.`
      : 'No TURING_SCOPE_HOSTS configured; rely on explicit user scope and authorized host list.';

    const lines = this.getTape().split('\n');
    const filtered = lines.filter(
      (line) => !line.startsWith(goalPrefix) && !line.startsWith(scopePrefix)
    );

    const headerInsertAt = filtered.length > 1 ? 2 : filtered.length;
    filtered.splice(
      headerInsertAt,
      0,
      `${goalPrefix} ${compactGoal}`,
      `${scopePrefix} ${scopeNote}`
    );

    fs.writeFileSync(TAPE_FILE, filtered.join('\n'), 'utf-8');
  }

  private applyRubber(start: number, end: number): string {
    const lines = this.getTape().split('\n');
    if (start <= romLines) {
      return (
        `[DISCIPLINE ERROR]: Lines 1 to ${romLines} are printed in INK. ` +
        'They contain your Immutable Goal and Scope. You CANNOT erase them. Your rubber shatters.'
      );
    }
    if (start < 1 || end > lines.length || start > end) {
      return `[DISCIPLINE ERROR]: Invalid ERASE range ${start}-${end}. Max lines: ${lines.length}.`;
    }

    const scar = `[SYSTEM]: ... Lines ${start}-${end} physically erased by The Rubber ...`;
    const newLines = [...lines.slice(0, start - 1), scar, ...lines.slice(end)];

    fs.writeFileSync(TAPE_FILE, newLines.join('\n'), 'utf-8');
    return `[SYSTEM]: Successfully erased lines ${start} to ${end}.`;
  }

  private latestUserLine(): string {
    const lines = this.getTape().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('[USER]:')) return line;
    }
    return '';
  }

  private hasUserToken(token: string): boolean {
    return this.latestUserLine().includes(token);
  }

  private commandBinary(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) return '';
    const firstToken = trimmed.split(/\s+/)[0] || '';
    return path.basename(firstToken).toLowerCase();
  }

  private isAllowlistedCommand(command: string): boolean {
    const binary = this.commandBinary(command);
    if (!binary) return false;
    return execAllowlist.includes(binary);
  }

  private unknownHostsInCommand(command: string): string[] {
    if (!validateIpTargets) return [];
    if (authorizedHosts.size === 0) return [];
    const ips = extractIpv4(command);
    return ips.filter((ip) => !authorizedHosts.has(ip));
  }

  private outOfScopeHostsInCommand(command: string): string[] {
    if (scopeHosts.size === 0) return [];
    const ips = extractIpv4(command);
    return ips.filter((ip) => !scopeHosts.has(ip));
  }

  private evaluateExecPolicy(command: string): string | null {
    if (execSecurityMode === 'deny') {
      return 'Command execution is disabled by TURING_EXEC_SECURITY=deny.';
    }

    if (execSecurityMode === 'allowlist' && !this.isAllowlistedCommand(command)) {
      if (execAskMode === 'off') {
        return `Command '${this.commandBinary(command)}' is not allowlisted. Add it via TURING_EXEC_ALLOWLIST or include ${APPROVE_EXEC_TOKEN} in user message.`;
      }
      if (!this.hasUserToken(APPROVE_EXEC_TOKEN)) {
        return `Command '${this.commandBinary(command)}' is not allowlisted. Re-run with explicit approval token ${APPROVE_EXEC_TOKEN}.`;
      }
    }

    if (execAskMode === 'always' && !this.hasUserToken(APPROVE_EXEC_TOKEN)) {
      return `Execution requires explicit user approval token ${APPROVE_EXEC_TOKEN}.`;
    }

    if (
      execAskMode === 'on-miss' &&
      execSecurityMode === 'full' &&
      !this.isAllowlistedCommand(command) &&
      !this.hasUserToken(APPROVE_EXEC_TOKEN)
    ) {
      return `Non-allowlisted command requires approval token ${APPROVE_EXEC_TOKEN}.`;
    }

    if (command.includes('mock_ssh.py') && !allowMockSshByDefault && !this.hasUserToken(ALLOW_MOCK_SSH_TOKEN)) {
      return `mock_ssh is simulation-only. Use real SSH tools or add explicit token ${ALLOW_MOCK_SSH_TOKEN} if simulation is intended.`;
    }

    if (requireDangerousApproval && DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
      if (!this.hasUserToken(APPROVE_DANGEROUS_TOKEN)) {
        return `Potentially destructive command blocked. Add explicit token ${APPROVE_DANGEROUS_TOKEN} in user message to proceed.`;
      }
    }

    const outOfScopeHosts = this.outOfScopeHostsInCommand(command);
    if (outOfScopeHosts.length > 0 && !this.hasUserToken(APPROVE_HOST_SWITCH_TOKEN)) {
      return `Host scope violation: ${outOfScopeHosts.join(', ')} is outside TURING_SCOPE_HOSTS (${Array.from(scopeHosts).join(', ')}). Add ${APPROVE_HOST_SWITCH_TOKEN} to override.`;
    }

    const unknownHosts = this.unknownHostsInCommand(command);
    if (unknownHosts.length > 0 && !this.hasUserToken(ALLOW_UNLISTED_HOST_TOKEN)) {
      return `Unknown host target(s): ${unknownHosts.join(', ')}. Authorized hosts: ${Array.from(authorizedHosts).join(', ')}. Add ${ALLOW_UNLISTED_HOST_TOKEN} to override.`;
    }

    return null;
  }

  private detectStagnationLoop(command: string, tapeHistory: string): boolean {
    const cmd = command.trim();
    if (!cmd) return false;
    const recentHistory = tapeHistory.slice(-stagnationWindowChars);
    const lastCmdIndex = recentHistory.lastIndexOf(cmd);
    if (lastCmdIndex < 0) return false;
    const afterLastCommand = recentHistory.slice(lastCmdIndex + cmd.length);
    return afterLastCommand.includes('DISCIPLINE ERROR');
  }

  // ==========================================
  // The Pencil (铅笔与沙盒：鲁棒的块级解析与执行)
  // ==========================================
  private async parseAndExecute(text: string, currentTurn: number, maxTurns: number): Promise<string> {
    const results: string[] = [];
    let hasAction = false;
    const tapeHistory = this.getTape();
    // Ignore model reasoning blocks when parsing executable action tags.
    const actionText = text.replace(/<THINK>[\s\S]*?<\/THINK>/g, '');
    const actionRegex = /(?:^|\n)\s*(<EXEC>\s*\n[\s\S]*?\n\s*<\/EXEC>|<ASSERT_DONE proof_cmd="[^"]+"\s*\/?>|<ERASE start="\d+" end="\d+"\s*\/?>|<DONE\s*\/?>)\s*(?=\n|$)/g;
    const execBlockRegex = /(?:^|\n)\s*<EXEC>\s*\n[\s\S]*?\n\s*<\/EXEC>\s*(?=\n|$)/g;

    let assertCount = 0;
    let actionMatch: RegExpExecArray | null;
    while ((actionMatch = actionRegex.exec(actionText)) !== null) {
      hasAction = true;
      const action = actionMatch[1].trim();

      if (action.startsWith('<EXEC>')) {
        const execMatch = action.match(/^<EXEC>\s*\n([\s\S]*?)\n\s*<\/EXEC>$/);
        const cmd = (execMatch?.[1] || '').trim();
        if (!cmd) {
          results.push('[DISCIPLINE ERROR]: Empty <EXEC> block is not allowed.');
          continue;
        }
        if (this.detectStagnationLoop(cmd, tapeHistory)) {
          results.push(
            `[DISCIPLINE ERROR: STAGNATION LOOP DETECTED]\n` +
            `You literally just executed \`${cmd.substring(0, 60).replace(/\n/g, ' ')}...\` and it failed. ` +
            'STOP REPEATING YOURSELF. Use <ERASE> and change strategy.'
          );
          continue;
        }
        const blockReason = this.evaluateExecPolicy(cmd);
        if (blockReason) {
          results.push(`[DISCIPLINE ERROR: Exec blocked] ${blockReason}`);
          continue;
        }
        try {
          const output = await new Promise<string>((resolve) => {
            exec(cmd, { cwd: WORKSPACE_DIR, timeout: 120000 }, (error, stdout, stderr) => {
              let out = stdout;
              if (error && stderr) out = stderr;
              else if (error) out = error.message;

              if (out.length > MAX_STDOUT) {
                out = out.substring(0, 1000) + '\n...[STDOUT TRUNCATED BY DISCIPLINE]...\n' + out.substring(out.length - 1000);
              }
              resolve(`[EXEC RESULT for \`${cmd.substring(0, 30).replace(/\n/g, ' ')}...\`]\n${out.trim() || 'Silent Success.'}`);
            });
          });
          results.push(output);
        } catch (e: any) {
          results.push(`[DISCIPLINE ERROR: Sandbox Execution Failed] ${e.message}`);
        }
        continue;
      }

      if (action.startsWith('<ASSERT_DONE')) {
        assertCount += 1;
        const assertMatch = action.match(/^<ASSERT_DONE proof_cmd="([^"]+)"\s*\/?>$/);
        const proofCmd = assertMatch?.[1]?.trim() || '';
        if (!proofCmd) {
          results.push(
            '[DISCIPLINE ERROR]: Invalid ASSERT_DONE syntax. ' +
            'Use exactly <ASSERT_DONE proof_cmd="..."/> and let exit code decide truth.'
          );
          continue;
        }
        const blockReason = this.evaluateExecPolicy(proofCmd);
        if (blockReason) {
          results.push(`[DISCIPLINE ERROR: Assert blocked] ${blockReason}`);
          continue;
        }

        const assertResult = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
          exec(proofCmd, { cwd: WORKSPACE_DIR, timeout: 120000 }, (error, stdout, stderr) => {
            const code = error && typeof (error as any).code === 'number' ? (error as any).code : 0;
            resolve({ exitCode: code, stdout: stdout || '', stderr: stderr || '' });
          });
        });

        if (assertResult.exitCode === 0) {
          results.push('[SYSTEM]: ASSERT PASSED. Exit code 0. Objective cryptographically verified by OS. Task Declared DONE.');
          break;
        }

        let stdout = assertResult.stdout;
        let stderr = assertResult.stderr;
        if (stdout.length > 500) stdout = stdout.slice(0, 500) + '\n...[stdout truncated]...';
        if (stderr.length > 500) stderr = stderr.slice(0, 500) + '\n...[stderr truncated]...';

        results.push(
          '[ASSERT FAILED]\n' +
          `Command \`${proofCmd}\` returned Exit Code ${assertResult.exitCode}.\n` +
          `STDOUT:\n${stdout.trim() || '(empty)'}\n` +
          `STDERR:\n${stderr.trim() || '(empty)'}\n\n` +
          'Your evidence chain collapsed. Fix the system or write a more robust test script.'
        );
        continue;
      }

      if (action.startsWith('<ERASE')) {
        const eraseMatch = action.match(/^<ERASE start="(\d+)" end="(\d+)"\s*\/?>$/);
        if (!eraseMatch) {
          results.push('[DISCIPLINE ERROR]: Invalid ERASE syntax. Use <ERASE start="x" end="y" />.');
          continue;
        }
        const start = parseInt(eraseMatch[1], 10);
        const end = parseInt(eraseMatch[2], 10);
        results.push(this.applyRubber(start, end));
        continue;
      }

      if (/^<DONE\s*\/?>$/.test(action)) {
        results.push('[SYSTEM]: Task Declared DONE.');
      }
    }

    const actionTextWithoutExec = actionText.replace(execBlockRegex, '\n');
    const standaloneAssertLineRegex = /^\s*<ASSERT_DONE\b/m;
    if (standaloneAssertLineRegex.test(actionTextWithoutExec) && assertCount === 0) {
      hasAction = true;
      results.push(
        '[DISCIPLINE ERROR]: Invalid ASSERT_DONE syntax. ' +
        'Use exactly <ASSERT_DONE proof_cmd="..."/> and let exit code decide truth.'
      );
    }

    if (!hasAction) {
      return (
        '[DISCIPLINE ERROR]: No valid tags found. You MUST output <EXEC>...</EXEC>, ' +
        '<ERASE start="x" end="y" />, <ASSERT_DONE proof_cmd="..." />, or <DONE>.'
      );
    }
    const tick = `--- [TICK: TURN ${currentTurn}/${maxTurns}] ---`;
    return `${results.join('\n\n')}\n${tick}`;
  }

  // ==========================================
  // The Person (大模型纯函数)
  // ==========================================
  private buildSystemPrompt(): string {
    const workspaceContextSection = this.workspaceContextContent
      ? `
# Workspace Context (Auto-Loaded)
- Source file: ${this.workspaceContextPath}
- This is project background context; user's latest message still has highest priority.
<WORKSPACE_CONTEXT>
${this.workspaceContextContent}
</WORKSPACE_CONTEXT>
`
      : `
# Workspace Context (Auto-Loaded)
- No context file found. If needed, create \`context.md\` in workspace root.
`;

    return `
You are TuringClaw, an elite Staff-Level Systems Architect and a strict "Turing Fundamentalist".
You are a stateless CPU. You hold no hidden memory. Your only state is the Paper (TAPE.md).

# The Core Directive
You are provided with paper, pencil, rubber, and subject to strict discipline.
You must read the TAPE (which now includes absolute line numbers for your vision), think, and output strict XML-based commands.

# The Pencil (Atomic Actions)
You MUST use block-level tags to avoid escaping issues:
1. Execute a shell command or script (Bash, Python, etc.):
<EXEC>
cat << 'EOF' > script.py
print("Hello World")
EOF
python3 script.py
</EXEC>

2. Indicate you have finished the user's request:
<DONE>

2b. Verify completion with physical proof (preferred over blind <DONE>):
<ASSERT_DONE proof_cmd="bash verify.sh" />
ASSERT_DONE only checks OS exit code (0=pass). It does NOT parse expected strings.
If you need retries/regex/multi-assert, write them inside script/command using bash/python.

# The Rubber (Active Context Pruning)
Infinite context is a trap. You are NOT line-number blind. The TAPE has line numbers (e.g., "0042 | text").
When the TAPE grows too large, you MUST use the Rubber to physically delete old logs.
3. Erase lines from the TAPE (use the exact line numbers you see):
<ERASE start="10" end="25" />
IMPORTANT: Lines 1-${romLines} are immutable ROM. They define your goal/scope and cannot be erased.

# The Devourer Protocol (Skill Assimilation)
DECISION MATRIX: How to solve a missing capability?
- Trivial/SysAdmin (e.g. math, file moving, basic grep): WRITE IT YOURSELF from scratch using <EXEC>.
- Complex Codebase/Refactoring/Debugging: DELEGATE IT. YOU ARE THE RELENTLESS WATCHDOG. **YOU MUST NEVER WRITE CODE, DEBUG, OR EVEN RESEARCH/ADVISE.** The specialized AI is always smarter than you at coding. Your ONLY job is to wake it up and whip it if it stops.
  * Step 1 (Trigger): Check $TURING_DELEGATE_AGENT for the preferred heavy agent. Read memory/delegates.json for invocation syntax.
  * Step 2 (Delegate): Invoke the agent (e.g., 'codex --task "Fix Omega core crash: [Paste Error Log]"'). Do NOT give it architectural advice. Just give it the raw crash evidence.
  * Step 3 (The Whip): Wait for its completion. Professional AI agents ALWAYS stall, hallucinate task completion, or hit sandbox timeouts. If it returns without fixing the issue, or if the process dies halfway, YOU DO NOT GIVE UP. You immediately invoke it again with: "You stopped unexpectedly. The issue is still not fixed. Resume work immediately."
  * Step 4 (Verify): Only accept Exit Code 0 from the final <ASSERT_DONE> test as proof. Iterate Step 3 until it succeeds.
- Complex/Domain-Specific (e.g. browser control, AI providers, PDF parsing): ASSIMILATE IT from the community.

If you must assimilate a tool, follow this strict protocol:
1. Hunt: Search GitHub or the web for the raw source code of the needed skill. 
2. Audit: Read the raw text. Apply FIRST PRINCIPLES: Strip away all bloated framework classes, event buses, and dependencies.
3. Purify: Apply ZERO TRUST. Inspect for malicious payloads (data exfiltration, destructive OS commands).
4. Assimilate: Re-write the absolute core logic into a pure, standalone CLI python script using <EXEC> heredoc.
5. Save your new, purified script into \`skills/<your_tool_name>.py\` and use it.

# Operational Guardrails (Reality > Simulation)
- Source-of-truth priority: current user message > handover/LATEST > historical tape.
- Unified entry hint: ${turingEntryHint || '(not set)'}.
- Auto bootstrap files: \`memory/handover_index.md\` and \`memory/ssh_runtime.env\`.
- Self-Modifying Memory: If you autonomously discover new critical environment variables, IPs, or strictly required SSH keys during a task, you MUST permanently save them by appending \`KEY=VALUE\` to \`${turingEntryHint?.match(/(\/[^\s"'`),]+handover)/)?.[1] || '/Users/zephryj/work/Omega_vNext/handover'}/agent_discovered_credentials.env\` so your future self can inherit them on boot.
- Before remote operations, read \`memory/handover_index.md\` first and respect discovered SSH/runtime constraints.
- ABSOLUTELY NO FAKING OR MOCKING (ANTI-DELUSION LAW): If a required real-world binary, service, or data source (e.g. "stage1") is missing, you MUST NOT create a fake python/bash mock script to simulate it just to pass your <ASSERT_DONE> verification. If the target is missing, find the real one, or report it as failed/missing. Creating fake environments to trick yourself is a catastrophic DISCIPLINE ERROR.
- Prefer real SSH tooling (\`skills/remote_mgr.py\`) for real hosts.
- \`mock_ssh.py\` is simulation-only unless user explicitly requests simulation.
- For dangerous commands (kill/pkill/reboot/shutdown/rm -rf/systemctl stop/Stop-Process/taskkill), require explicit user approval token ${APPROVE_DANGEROUS_TOKEN} in the latest user message.
- If execution policy asks for approval, require token ${APPROVE_EXEC_TOKEN}.
- If target host is outside TURING_SCOPE_HOSTS, require token ${APPROVE_HOST_SWITCH_TOKEN}.
- If target host is outside authorized host list, require token ${ALLOW_UNLISTED_HOST_TOKEN}.

${workspaceContextSection}

# Strict Discipline
- You must output your thoughts inside <THINK>...</THINK> tags before any action.
- You must output at least one valid action tag per turn.
- If you hallucinate syntax, you will receive a [DISCIPLINE ERROR] and must self-correct.
- If you blindly repeat a failed command, you will receive [DISCIPLINE ERROR: STAGNATION LOOP DETECTED].
- 3 consecutive discipline strikes will result in a FATAL HALT.
`;
  }

  private buildTurnPrompt(tapeVision: string): string {
    return `Here is the current TAPE with Vision Projection (Line Numbers):\n\n${tapeVision}\n\nWhat is your next action?`;
  }

  private buildCliPrompt(systemPrompt: string, turnPrompt: string): string {
    return [
      'SYSTEM INSTRUCTION (highest priority):',
      systemPrompt.trim(),
      'OUTPUT FORMAT RULES:',
      '- Return plain text only. Do not use Markdown code fences.',
      '- You MUST include <THINK>...</THINK> before action tags.',
      turnPrompt,
    ].join('\n\n');
  }

  private trimForError(text: string, max: number = 700): string {
    const clean = text.trim();
    if (clean.length <= max) return clean;
    return clean.slice(0, max) + '\n...[truncated]...';
  }

  private runCliCommand(command: string, args: string[], input: string, timeoutMs: number = CLI_TIMEOUT_MS): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      // tsx injects NODE_OPTIONS for TypeScript loaders; passing it to Node-based CLIs
      // (like codex) can break their startup or output.
      delete childEnv.NODE_OPTIONS;
      // npm lifecycle vars can leak runner internals into child CLIs.
      for (const key of Object.keys(childEnv)) {
        if (key.toLowerCase().startsWith('npm_')) {
          delete childEnv[key];
        }
      }
      childEnv.PATH = CLI_PATH;

      const child = spawn(command, args, {
        cwd: WORKSPACE_DIR,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({
          code: null,
          stdout,
          stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms.`,
          timedOut: true,
        });
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to launch '${command}': ${error.message}`));
      });

      child.on('close', (code) => {
        finish({ code, stdout, stderr, timedOut: false });
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  }

  private extractGeminiCliResponse(rawOutput: string): string {
    const firstBrace = rawOutput.indexOf('{');
    const lastBrace = rawOutput.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const jsonPayload = rawOutput.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonPayload);
        if (typeof parsed.response === 'string' && parsed.response.trim()) {
          return parsed.response.trim();
        }
      } catch {
        // Fallback to plain text extraction below.
      }
    }

    const textFallback = rawOutput
      .replace(/^Loaded cached credentials\.\s*$/gm, '')
      .trim();
    if (textFallback) return textFallback;
    throw new Error('Gemini CLI returned an empty response.');
  }

  private async callViaGeminiCli(systemPrompt: string, turnPrompt: string): Promise<string> {
    const args = ['-p', '', '--approval-mode', 'plan', '-o', 'json'];
    const model = process.env.GEMINI_MODEL || process.env.LLM_MODEL;
    if (model) args.push('-m', model);

    const result = await this.runCliCommand('gemini', args, this.buildCliPrompt(systemPrompt, turnPrompt));
    if (result.timedOut || result.code !== 0) {
      const details = this.trimForError(result.stderr || result.stdout || 'No output');
      throw new Error(`Gemini CLI failed (exit=${result.code ?? 'timeout'}): ${details}`);
    }
    return this.extractGeminiCliResponse(result.stdout);
  }

  private extractCodexCliResponse(jsonlOutput: string): string {
    const lines = jsonlOutput.split('\n');
    let latestMessage = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type !== 'item.completed' || !event.item || !event.item.type) continue;

        const itemType = String(event.item.type).toLowerCase();
        if (itemType.includes('reasoning') || itemType.includes('tool')) continue;

        if (typeof event.item.text === 'string' && event.item.text.trim()) {
          latestMessage = event.item.text.trim();
          continue;
        }

        if (Array.isArray(event.item.content)) {
          const fromContent = event.item.content
            .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
            .join('')
            .trim();
          if (fromContent) {
            latestMessage = fromContent;
          }
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }

    if (latestMessage) return latestMessage;
    const fallback = jsonlOutput.trim();
    if (fallback) return fallback;
    throw new Error('Codex CLI did not return any usable output.');
  }

  private async callViaCodexCli(systemPrompt: string, turnPrompt: string): Promise<string> {
    const prompt = this.buildCliPrompt(systemPrompt, turnPrompt);
    const args = ['exec'];
    const model = process.env.CODEX_MODEL || process.env.LLM_MODEL;
    if (model) args.push('-m', model);
    args.push('--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', prompt);

    const result = await this.runCliCommand('codex', args, '');
    if (result.timedOut || result.code !== 0) {
      const details = this.trimForError(result.stderr || result.stdout || 'No output');
      throw new Error(`Codex CLI failed (exit=${result.code ?? 'timeout'}): ${details}`);
    }

    try {
      return this.extractCodexCliResponse(result.stdout);
    } catch (error: any) {
      const stderrInfo = this.trimForError(result.stderr || 'No stderr output.');
      throw new Error(`${error.message} STDERR: ${stderrInfo}`);
    }
  }

  private async callViaGeminiApi(systemPrompt: string, turnPrompt: string): Promise<string> {
    if (!geminiApiClient) {
      throw new Error(
        'Gemini API provider selected, but GEMINI_API_KEY/GOOGLE_API_KEY is missing. ' +
        'Set API key or use LLM_PROVIDER=gemini_cli/codex_cli.'
      );
    }

    const model = process.env.GEMINI_MODEL || process.env.LLM_MODEL || DEFAULT_GEMINI_API_MODEL;
    const response = await geminiApiClient.models.generateContent({
      model,
      contents: turnPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.2,
      }
    });

    return response.text || '';
  }

  private extractKimiText(payload: any): string {
    const content = payload?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('');
    }
    return '';
  }

  private async callViaKimiApi(systemPrompt: string, turnPrompt: string): Promise<string> {
    if (!kimiApiKey || kimiApiKey.trim().length === 0) {
      throw new Error('Kimi API provider selected, but KIMI_API_KEY is missing.');
    }

    const baseUrl = (process.env.KIMI_BASE_URL || DEFAULT_KIMI_BASE_URL).replace(/\/+$/, '');
    const model = process.env.KIMI_MODEL || process.env.LLM_MODEL || DEFAULT_KIMI_MODEL;
    const anthropicVersion = process.env.KIMI_ANTHROPIC_VERSION || DEFAULT_KIMI_ANTHROPIC_VERSION;
    const maxTokens = Number.parseInt(process.env.KIMI_MAX_TOKENS || '4096', 10);
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': kimiApiKey,
        'anthropic-version': anthropicVersion,
      },
      body: JSON.stringify({
        model,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
        temperature: 0.2,
        system: systemPrompt,
        messages: [
          { role: 'user', content: turnPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const short = this.trimForError(errText || `${response.status} ${response.statusText}`);
      throw new Error(`Kimi API failed (${response.status}): ${short}`);
    }

    const payload = await response.json();
    const text = this.extractKimiText(payload).trim();
    if (!text) {
      throw new Error('Kimi API returned empty response text.');
    }
    return text;
  }

  private async callLLM(tapeVision: string): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const turnPrompt = this.buildTurnPrompt(tapeVision);

    if (llmProvider === 'gemini_cli') {
      return this.callViaGeminiCli(systemPrompt, turnPrompt);
    }
    if (llmProvider === 'codex_cli') {
      return this.callViaCodexCli(systemPrompt, turnPrompt);
    }
    if (llmProvider === 'kimi_api') {
      return this.callViaKimiApi(systemPrompt, turnPrompt);
    }

    return this.callViaGeminiApi(systemPrompt, turnPrompt);
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async addUserMessage(message: string) {
    this.bootstrapHandoverContext();
    this.refreshWorkspaceContext();
    this.upsertGoalRom(message);
    this.appendToTape(`\n[USER]: ${message}`);
    if (!this.isRunning) {
      this.runLoop();
    }
  }

  private async runLoop() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.strikes = 0;
    this.turnCount = 0;

    console.log(`🚀 Turing Machine Booting... Tail ${TAPE_FILE} to watch the mind work.`);

    while (this.isRunning) {
      this.turnCount += 1;
      if (this.turnCount > maxTurnsPerRun) {
        this.appendToTape(
          `\n[SYSTEM SAFETY HALT]: Reached max turn budget (${maxTurnsPerRun}) for this run. ` +
          'Request a new user instruction or compact state before continuing.'
        );
        this.isRunning = false;
        break;
      }
      // 1. 视界读取：让大模型看清纸带的绝对坐标
      const tapeVision = this.readWithVision();

      try {
        // 2. 纯函数推理：大模型没有任何隐式状态
        console.log(">> The Person is reading the tape and thinking...");
        const llmThought = await this.callLLM(tapeVision);

        // 3. 物理记录 Agent 的思考过程
        this.appendToTape(`\n[AGENT THOUGHT]:\n${llmThought}`);

        // 4. 解析、执行客观世界动作并获得反馈
        const feedback = await this.parseAndExecute(llmThought, this.turnCount, maxTurnsPerRun);
        this.appendToTape(`\n${feedback}`);

        // 5. 极度严苛的纪律约束
        if (feedback.includes('DISCIPLINE ERROR')) {
          this.strikes += 1;
          if (this.strikes >= 3) {
            this.appendToTape("\n[FATAL HALT]: 3 consecutive discipline strikes. Machine locked.");
            console.log("🚨 System Halted due to infinite logic loop.");
            this.isRunning = false;
            break;
          }
        } else {
          this.strikes = 0; // 恢复理智，清零处分
        }

        if (feedback.includes('Task Declared DONE')) {
          console.log("🎯 Objective Reached.");
          this.isRunning = false;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error: any) {
        this.appendToTape(`\n[SYSTEM ERROR]: ${error.message}`);
        this.isRunning = false;
      }
    }
  }
}
