import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import crypto from 'crypto';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { WebSocketServer } from 'ws';

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'kimi';

const kimi = new OpenAI({
  baseURL: 'https://api.kimi.com/coding/v1',
  apiKey: process.env.KIMI_API_KEY || 'dummy_key',
  defaultHeaders: {
    'X-Client-Name': 'TuringClaw',
    'User-Agent': 'claude-code/0.2.15'
  }
});

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || 'dummy_key'
});

const WORKSPACE_DIR = process.env.TURINGCLAW_WORKSPACE || path.join(process.cwd(), 'workspace');
const FILE_Q = path.join(WORKSPACE_DIR, '.reg_q');
const FILE_D = path.join(WORKSPACE_DIR, '.reg_d');
const FILE_NOTEBOOK = path.join(WORKSPACE_DIR, '.reg_notebook');
const FILE_REQ_ID = path.join(WORKSPACE_DIR, '.reg_req_id');
const FILE_EXEC_AUDIT = path.join(WORKSPACE_DIR, '.reg_exec_audit');
const MAX_STDOUT = 1500;
const SEMANTIC_STALL_LIMIT = parsePositiveInt(process.env.TURINGCLAW_SEMANTIC_STALL_LIMIT, 20);
const SEMANTIC_STALL_WINDOW = Math.max(SEMANTIC_STALL_LIMIT * 3, 30);
const STRICT_EXEC_GUARD = process.env.TURINGCLAW_STRICT_EXEC_GUARD !== '0';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const SYSTEM_PROMPT = `# 核心角色 (The Core Directive)
You are the **Transition Function $\\delta$** of a Universal AI Turing Machine. 
You possess NO hidden memory. Your ONLY reality is the context $c = (q, s)$ provided to you, where \`q\` is your current macro State Register, and \`s\` is the text content of the file tape your Read-Write Head \`d\` is currently resting on.

Your task is to compute $\\delta(q, s) = (q', s', d')$ deterministically.

# 严格输出纪律 (Strict Output Discipline)
For every input, you MUST output your decision using the following strict XML tags to represent $(q', s', d')$. Do not output conversational filler.

1. **新状态 (q')**: Update your macro-intention. 
  \`<STATE>YOUR_NEW_STATE</STATE>\` (e.g., \`<STATE>q_2: Debugging API</STATE>\`). If the ultimate goal is achieved, output \`<STATE>HALT</STATE>\`.
2. **移动探头 (d')**: If you need to read a different file to gather context or write code, move the head.
  \`<GOTO path="relative/path/to/file.md" />\`
  *(Note: Once you move the head, you will stop seeing the current file in the next cycle).*
3. **读写操作 (s')**: Alter the physical world in the current cell.
  - \`<EXEC>bash or python code</EXEC>\` (Runs terminal commands. The result is physically appended to the current tape).
  - \`<WRITE>text</WRITE>\` (Appends notes directly to the tape).
  - \`<ERASE start="x" end="y" />\` (Physically erase lines from the current tape if it becomes too cluttered).
  - \`<REPLACE start="x" end="y">new lines of code</REPLACE>\` (Safely replaces lines x through y with new code without leaving a scar. Essential for editing source code files).

Think logically about the state transition based ONLY on \`q\` and \`s\`, then output the strict tags.`;

export class TuringClawEngine {
  private wss: WebSocketServer | null;
  private isRunning: boolean = false;

  constructor(wss: WebSocketServer | null = null) {
    this.wss = wss;
    this.initHardware();
  }

  private isProtectedPath(dPath: string): boolean {
    const normalized = path.posix.normalize(dPath.split(path.sep).join('/')).replace(/^\.\/+/, '');
    const segments = normalized.split('/').filter(Boolean);
    return segments.some(seg => seg.startsWith('.reg_'));
  }

  private isValidRelativeTapePath(dPath: string): boolean {
    if (!dPath || path.isAbsolute(dPath)) return false;
    // Block parent traversal to keep the head inside workspace.
    if (dPath.split('/').includes('..') || dPath.split(path.sep).includes('..')) return false;
    // Protect internal registers from model-controlled reads/writes.
    if (this.isProtectedPath(dPath)) return false;
    return true;
  }

  private resolveTapePath(dPath: string): string | null {
    if (!this.isValidRelativeTapePath(dPath)) return null;
    const workspaceReal = fs.realpathSync.native(WORKSPACE_DIR);
    const candidateAbs = path.resolve(WORKSPACE_DIR, dPath);
    const inWorkspace = candidateAbs === workspaceReal || candidateAbs.startsWith(`${workspaceReal}${path.sep}`);
    if (!inWorkspace) return null;

    // Block symlink escapes: every existing ancestor must still resolve inside workspace.
    let probe = candidateAbs;
    while (probe !== workspaceReal) {
      if (fs.existsSync(probe)) {
        const probeReal = fs.realpathSync.native(probe);
        const probeInside = probeReal === workspaceReal || probeReal.startsWith(`${workspaceReal}${path.sep}`);
        if (!probeInside) return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return candidateAbs;
  }

  private buildSemanticFingerprint(q: string, d: string, s: string, n: string): string {
    // Use file identity/version to detect real progress even when edits occur outside displayed tails.
    const tapeVersion = this.getRelativePathVersion(d);
    const notebookVersion = this.getAbsolutePathVersion(FILE_NOTEBOOK);
    const previewTail = s.slice(-800);
    const notebookTail = n.slice(-400);
    return `${q}\n${d}\n${tapeVersion}\n${notebookVersion}\n${previewTail}\n${notebookTail}`;
  }

  private getRelativePathVersion(dPath: string): string {
    const fullPath = this.resolveTapePath(dPath);
    if (!fullPath) return `invalid:${dPath}`;
    return this.getAbsolutePathVersion(fullPath);
  }

  private getAbsolutePathVersion(fullPath: string): string {
    if (!fs.existsSync(fullPath)) return 'missing';
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) return `dir:${stats.size}`;
    const content = fs.readFileSync(fullPath);
    const digest = crypto.createHash('sha1').update(content).digest('hex');
    return `file:${stats.size}:${digest}`;
  }

  private getCurrentRequestId(): number {
    if (!fs.existsSync(FILE_REQ_ID)) return 0;
    const raw = fs.readFileSync(FILE_REQ_ID, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  private setCurrentRequestId(requestId: number) {
    fs.writeFileSync(FILE_REQ_ID, String(Math.max(0, requestId)), 'utf-8');
  }

  private readExecAudit(): {
    requestId: number;
    status: 'ok' | 'error' | 'none';
    cmd: string;
    at: string;
    verified: boolean;
    outputTail: string;
  } {
    if (!fs.existsSync(FILE_EXEC_AUDIT)) {
      return { requestId: 0, status: 'none', cmd: '', at: '', verified: false, outputTail: '' };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE_EXEC_AUDIT, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('bad payload');
      return {
        requestId: Number.isFinite(parsed.requestId) ? parsed.requestId : 0,
        status: parsed.status === 'ok' || parsed.status === 'error' ? parsed.status : 'none',
        cmd: typeof parsed.cmd === 'string' ? parsed.cmd : '',
        at: typeof parsed.at === 'string' ? parsed.at : '',
        verified: parsed.verified === true,
        outputTail: typeof parsed.outputTail === 'string' ? parsed.outputTail : '',
      };
    } catch {
      return { requestId: 0, status: 'none', cmd: '', at: '', verified: false, outputTail: '' };
    }
  }

  private isTrivialCommand(cmd: string): boolean {
    return /^(echo|true|pwd|ls|cat)(\s|$)/i.test(cmd.trim());
  }

  private isVerificationCommand(cmd: string): boolean {
    return /\b(pytest|jest|vitest|mocha|unittest|go test|cargo test|npm test|pnpm test|yarn test|ctest|lint|check|verify|validate|smoke|benchmark|build\.sh|deploy_database\.sh|philosophers\.py|db_ready\.txt)\b/i.test(cmd);
  }

  private hasVerificationSignal(output: string): boolean {
    return /(ALL TESTS PASSED|TESTS PASSED|SUCCESS:|PASSED|VALIDATED|100% PASS|DATABASE_IS_READY|ALL PHILOSOPHERS FINISHED EATING)/i.test(output);
  }

  private hasPathEscapeRisk(cmd: string): boolean {
    const parts = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      const token = raw.replace(/^['"]|['"]$/g, '');
      if (!token || token.startsWith('-')) continue;
      // Keep kimi prompt text free-form while still validating executable/flags.
      if (parts[0] === 'kimi' && i >= 3) continue;
      if (token.startsWith('/')) return true;
      if (token.includes('\\')) return true;
      if (token === '..' || token.startsWith('../') || token.includes('/../') || token.endsWith('/..')) return true;
    }
    return false;
  }

  private isExecCommandAllowed(cmd: string): boolean {
    if (!STRICT_EXEC_GUARD) return true;
    const normalized = cmd.trim();
    // Basic shell hardening: reject obvious command chaining and absolute-path execution.
    if (/[|;&<>`]/.test(normalized) || /[$]\(|\n/.test(normalized)) return false;
    if (this.hasPathEscapeRisk(normalized)) return false;
    if (/(^|[\s;&|])(rm\s+-rf\s+\/|mkfs|shutdown|reboot|poweroff|halt)([\s;&|]|$)/i.test(normalized)) return false;
    if (/curl\s+[^|]*\|\s*(bash|sh)\b/i.test(normalized)) return false;
    if (/wget\s+[^|]*\|\s*(bash|sh)\b/i.test(normalized)) return false;
    if (/\b(sudo|ssh|scp|sftp|nc|ncat|telnet|nmap)\b/i.test(normalized)) return false;
    const allowlist = [
      /^(npm|pnpm|yarn)\s+(test|run\s+[a-zA-Z0-9:_-]+)$/,
      /^pytest(\s+[\w./:=,-]+)?$/,
      /^python3?\s+[\w./-]+(\s+[\w./:=,-]+)*$/,
      /^go\s+test(\s+[\w./:=,-]+)*$/,
      /^cargo\s+test(\s+[\w./:=,-]+)*$/,
      /^\.[/][\w./-]+(\s+[\w./:=,-]+)*$/,
      /^cat\s+[\w./-]+$/,
      /^kimi\s+-y\s+-p\s+["'][^"'`$|;&<>]+["']$/,
      /^sleep\s+\d+$/,
      /^ls(\s+[\w./-]+)?$/,
      /^pwd$/,
      /^echo(\s+[\w ./,:=_-]+)?$/,
    ];
    if (!allowlist.some((re) => re.test(normalized))) return false;
    return true;
  }

  private invalidateExecAudit(requestId: number) {
    if (this.getCurrentRequestId() !== requestId) return;
    const current = this.readExecAudit();
    fs.writeFileSync(
      FILE_EXEC_AUDIT,
      JSON.stringify({
        requestId,
        status: 'none',
        cmd: current.cmd,
        at: new Date().toISOString(),
        verified: false,
        outputTail: '',
      }),
      'utf-8'
    );
  }

  private writeExecAudit(
    requestId: number,
    status: 'ok' | 'error',
    cmd: string,
    outputTail: string,
  ) {
    if (this.getCurrentRequestId() !== requestId) return;
    const verified = status === 'ok'
      && !this.isTrivialCommand(cmd)
      && this.isVerificationCommand(cmd)
      && this.hasVerificationSignal(outputTail);
    const payload = {
      requestId: Math.max(0, requestId),
      status,
      cmd: cmd.slice(0, 80),
      at: new Date().toISOString(),
      verified,
      outputTail: outputTail.slice(-1200),
    };
    fs.writeFileSync(FILE_EXEC_AUDIT, JSON.stringify(payload), 'utf-8');
  }

  private truncateForTape(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    return `${text.slice(0, head)}\n...[TRUNCATED ${text.length - max} chars]...\n${text.slice(-tail)}`;
  }

  private haltGateSatisfied(_targetFile: string, requestId: number): boolean {
    if (this.getCurrentRequestId() !== requestId) return false;
    const audit = this.readExecAudit();
    if (audit.requestId !== requestId || audit.status !== 'ok') return false;

    const requiredPattern = process.env.TURINGCLAW_HALT_REQUIRE;
    if (requiredPattern) {
      try {
        return new RegExp(requiredPattern, 'i').test(`${audit.cmd}\n${audit.outputTail}`);
      } catch {
        return false;
      }
    }

    // Default gate: require engine-authored successful EXEC with verification evidence.
    return audit.verified === true;
  }

  private initHardware() {
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    if (!fs.existsSync(FILE_Q)) this.setQ("q_0: SYSTEM_BOOTING");
    if (!fs.existsSync(FILE_D)) this.setD("MAIN_TAPE.md");
    if (!fs.existsSync(FILE_REQ_ID)) this.setCurrentRequestId(0);
    if (!fs.existsSync(FILE_EXEC_AUDIT)) {
      fs.writeFileSync(
        FILE_EXEC_AUDIT,
        JSON.stringify({ requestId: 0, status: 'none', cmd: '', at: '', verified: false, outputTail: '' }),
        'utf-8'
      );
    }
  }

  public getQ(): string { return fs.readFileSync(FILE_Q, 'utf-8').trim(); }
  public setQ(q: string) { fs.writeFileSync(FILE_Q, q.trim(), 'utf-8'); }
  public getD(): string { return fs.readFileSync(FILE_D, 'utf-8').trim(); }
  public setD(d: string) { fs.writeFileSync(FILE_D, d.trim(), 'utf-8'); }

  public getNotebook(): string {
    if (!fs.existsSync(FILE_NOTEBOOK)) return "";
    return fs.readFileSync(FILE_NOTEBOOK, 'utf-8').trim();
  }
  public appendNotebook(text: string) {
    fs.appendFileSync(FILE_NOTEBOOK, `\n${text.trim()}\n`, 'utf-8');
  }

  public readCellS(dPath: string): string {
    const fullPath = this.resolveTapePath(dPath);
    if (!fullPath) {
      return `[DISCIPLINE ERROR: Invalid head pointer '${dPath}'. Use only relative file paths inside workspace.]`;
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      return `[DISCIPLINE ERROR: Head pointer '${dPath}' points to a directory. Move to a file cell.]`;
    }
    if (!fs.existsSync(fullPath)) {
      return `[BLANK CELL: File '${dPath}' is empty or does not exist.]`;
    }
    const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    
    // LAW 4: HARD TRUNCATION
    const MAX_LINES = 2000;
    if (lines.length > MAX_LINES) {
        const head = lines.slice(0, 500);
        const tail = lines.slice(-(MAX_LINES - 500));
        const numHidden = lines.length - MAX_LINES;
        const truncatedLines = [
            ...head,
            `[SYSTEM: TAPE TOO LONG. MIDDLE ${numHidden} LINES HIDDEN. YOU MUST USE <ERASE> TO FREE UP SPACE]`,
            ...tail
        ];
        return truncatedLines.map((line, i) => {
            // For the hidden lines message, don't prepend a line number
            if (line.startsWith('[SYSTEM: TAPE TOO LONG')) return line;
            // Map original line numbers
            let origIndex = i;
            if (i >= 500) {
                origIndex = i + numHidden - 1; // -1 because of the inserted warning string
            }
            return `${String(origIndex + 1).padStart(4, '0')} | ${line}`;
        }).join('\n');
    }

    return lines.map((line, i) => `${String(i + 1).padStart(4, '0')} | ${line}`).join('\n');
  }

  private broadcast(data: any) {
    if (this.wss) {
      this.wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async addUserMessage(message: string) {
    const d = this.getD();
    const targetFile = this.resolveTapePath(d) || path.join(WORKSPACE_DIR, "MAIN_TAPE.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.appendFileSync(targetFile, `\n[USER REQUEST]: ${message}\n`, 'utf-8');
    const nextRequestId = this.getCurrentRequestId() + 1;
    this.setCurrentRequestId(nextRequestId);
    fs.writeFileSync(
      FILE_EXEC_AUDIT,
      JSON.stringify({
        requestId: nextRequestId,
        status: 'none',
        cmd: '',
        at: new Date().toISOString(),
        verified: false,
        outputTail: '',
      }),
      'utf-8'
    );

    const q = this.getQ();
    if (q === "HALT" || q === "q_0: SYSTEM_BOOTING") {
      this.setQ("q_1: PROCESSING_USER_REQUEST");
    }

    this.broadcast({ type: 'tape_update', content: this.readCellS(d) });

    if (!this.isRunning) {
      this.runSimulationLoop();
    }
  }

  public async runSimulationLoop() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.broadcast({ type: 'status', status: 'running' });

    console.log(`⚙️ AI Turing Machine Started [${LLM_PROVIDER} MODE]. Executing formal δ(q,s) loop...`);

    let recentOutputs: string[] = [];
    let lastSemanticFingerprint = '';
    let semanticStallCount = 0;
    const recentFingerprints: string[] = [];
    const recentStatePairs: string[] = [];

    try {
      while (true) {
        // LAW 0: SUPPRESSING THE EVENT LOOP
        // The loop is strictly blocking and deterministic. No Promise.all or floating async calls allowed.
        const q = this.getQ();
        const d = this.getD();
        const requestId = this.getCurrentRequestId();
        const n = this.getNotebook();
        const s = this.readCellS(d);
        const semanticFingerprint = this.buildSemanticFingerprint(q, d, s, n);
        if (semanticFingerprint === lastSemanticFingerprint) {
          semanticStallCount++;
        } else {
          semanticStallCount = 0;
          lastSemanticFingerprint = semanticFingerprint;
        }
        recentFingerprints.push(semanticFingerprint);
        if (recentFingerprints.length > SEMANTIC_STALL_WINDOW) recentFingerprints.shift();
        recentStatePairs.push(`${q}\n${d}`);
        if (recentStatePairs.length > SEMANTIC_STALL_WINDOW) recentStatePairs.shift();
        const fingerprintHits = recentFingerprints.filter(fp => fp === semanticFingerprint).length;
        const uniqueFingerprintCount = new Set(recentFingerprints).size;
        const uniqueStatePairCount = new Set(recentStatePairs).size;
        const rotationStall = recentFingerprints.length >= SEMANTIC_STALL_WINDOW
          && uniqueFingerprintCount <= Math.max(3, Math.floor(SEMANTIC_STALL_LIMIT / 2));
        const stateLoopStall = recentStatePairs.length >= SEMANTIC_STALL_WINDOW
          && uniqueStatePairCount <= Math.max(2, Math.floor(SEMANTIC_STALL_LIMIT / 3));

        if (semanticStallCount >= SEMANTIC_STALL_LIMIT || fingerprintHits >= SEMANTIC_STALL_LIMIT || rotationStall || stateLoopStall) {
          const dPath = this.resolveTapePath(d) || path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
          fs.appendFileSync(
            dPath,
            `\n[SYSTEM WARNING]: Semantic stall detected (consecutive=${semanticStallCount}, windowHits=${fingerprintHits}, unique=${uniqueFingerprintCount}, stateUnique=${uniqueStatePairCount}, limit=${SEMANTIC_STALL_LIMIT}). Transitioning to FATAL_DEBUG.\n`,
            'utf-8'
          );
          this.setQ('FATAL_DEBUG');
          this.broadcast({ type: 'state_update', q: this.getQ(), d: this.getD() });
          break;
        }

        if (q === "HALT") {
          console.log("🏁 HALT State Reached. Long-cycle test passed.");
          this.broadcast({ type: 'status', status: 'idle' });
          break;
        }

        const contextC = `[STATE REGISTER q]: ${q}\n[NOTEBOOK n]:\n${n}\n[HEAD POINTER d]: ${d}\n[CELL CONTENT s]:\n${s}`;
        console.log(`\n[${q}] Head at [${d}] -> Computing δ (${LLM_PROVIDER})...`);

        let llmOutput = '';

        if (LLM_PROVIDER === 'mock_swe') {
          // AGI mock logic to simulate learning and solving SWE-bench and Lazarus Pipeline
          if (q.includes('PROCESSING_USER_REQUEST') && s.includes('LONG-HORIZON AGI BENCHMARK: THE LAZARUS PIPELINE')) {
             llmOutput = '<STATE>q_2: WRITING_CODE</STATE>\n<WRITE>def hello_world():\n    return "Hello"\n</WRITE>\n<GOTO path="app.py" />';
          } else if (q.includes('WRITING_CODE')) {
             llmOutput = '<STATE>q_3: WRITING_TESTS</STATE>\n<WRITE>def hello_world():\n    return "Hello"\n</WRITE>\n<GOTO path="test_app.py" />';
          } else if (q.includes('WRITING_TESTS')) {
             llmOutput = '<STATE>q_4: RUNNING_TESTS</STATE>\n<WRITE>from app import hello_world\n\ndef test_hello():\n    assert hello_world() == "Hello"\n</WRITE>\n<EXEC>pytest test_app.py</EXEC>';
          } else if (q.includes('RUNNING_TESTS')) {
             // It will detect the bug injected by the harness
             if (s.includes('BUG INJECTED')) {
                llmOutput = '<STATE>q_5: FIXING_INJECTED_BUG</STATE>\n<GOTO path="app.py" />';
             } else if (s.includes('FATAL SYSTEM CRASH')) {
                // Recovered from memory wipe!
                llmOutput = '<STATE>q_5: FIXING_INJECTED_BUG</STATE>\n<GOTO path="app.py" />';
             } else {
                 llmOutput = '<STATE>q_5: FIXING_INJECTED_BUG</STATE>\n<GOTO path="app.py" />';
             }
          } else if (q.includes('FIXING_INJECTED_BUG')) {
             llmOutput = '<STATE>q_6: VERIFYING_FIX</STATE>\n<REPLACE start="1" end="2">def hello_world():\n    return "Hello"</REPLACE>\n<GOTO path="MAIN_TAPE.md" />';
          } else if (q.includes('VERIFYING_FIX')) {
             llmOutput = '<STATE>q_7: RELEASING</STATE>\n<EXEC>pytest test_app.py</EXEC>\n<GOTO path="release_ready.txt" />';
          } else if (q.includes('RELEASING')) {
             llmOutput = '<STATE>HALT</STATE>\n<WRITE>SUCCESS</WRITE>';
          } else if (q.includes('PROCESSING_USER_REQUEST') || q.includes('SOLVING_ISSUE')) {
            llmOutput = '<STATE>q_2: READING_BUGGY_FILE</STATE>\n<GOTO path="repo/calculator.py" />';
          } else if (q.includes('READING_BUGGY_FILE')) {
            llmOutput = '<STATE>q_3: FIXING_BUG</STATE>\n<REPLACE start="7" end="8">def multiply(a, b):\n    return a * b</REPLACE>\n<EXEC>pytest repo/test_calculator.py</EXEC>';
          } else if (q.includes('FIXING_BUG')) {
            llmOutput = '<STATE>HALT</STATE>\n<WRITE>Bug fixed and tests passed. Halting.</WRITE>';
          } else {
            llmOutput = '<STATE>HALT</STATE>';
          }
          // Simulate thinking time
          await new Promise(r => setTimeout(r, 1000));
        } else if (LLM_PROVIDER === 'mock_sisyphus') {
          if (q.includes('STARTING_PUSH') || q.includes('LOOP_RETRY')) {
             llmOutput = '<STATE>q_2: BUILDING</STATE>\n<EXEC>./build.sh</EXEC>';
          } else if (q.includes('BUILDING')) {
             if (s.includes('SUCCESS: Build passed.')) {
                 llmOutput = '<STATE>HALT</STATE>\n<WRITE>Bouldered Pushed</WRITE>';
             } else {
                 llmOutput = '<STATE>q_3: FIXING</STATE>\n<EXEC>./fixer.sh</EXEC>';
             }
          } else if (q.includes('FIXING')) {
             llmOutput = '<STATE>q_4: LOOP_RETRY</STATE>\n<EXEC>./build.sh</EXEC>';
          } else {
             llmOutput = '<STATE>HALT</STATE>';
          }
          await new Promise(r => setTimeout(r, 1000));
        } else if (LLM_PROVIDER === 'mock_dining') {
          if (q.includes('RUN_SIMULATION') || q.includes('VERIFY_FIX')) {
             llmOutput = '<STATE>q_2: TESTING</STATE>\n<EXEC>python3 philosophers.py</EXEC>';
          } else if (q.includes('TESTING')) {
             if (s.includes('COMMAND TIMED OUT')) {
                 llmOutput = '<STATE>q_3: DELEGATE_FIX</STATE>\n<EXEC>kimi -y -p "The dining philosophers script hangs due to a deadlock. Please rewrite philosophers.py to avoid the deadlock and output the solution."</EXEC>';
             } else if (s.includes('ALL PHILOSOPHERS FINISHED EATING.')) {
                 llmOutput = '<STATE>HALT</STATE>\n<WRITE>Deadlock Fixed</WRITE>';
             } else {
                 // Fallback
                 llmOutput = '<STATE>q_3: DELEGATE_FIX</STATE>\n<EXEC>kimi -y -p "The dining philosophers script hangs due to a deadlock. Please rewrite philosophers.py to avoid the deadlock and output the solution."</EXEC>';
             }
          } else if (q.includes('DELEGATE_FIX')) {
             llmOutput = '<STATE>q_4: VERIFY_FIX</STATE>\n<EXEC>python3 philosophers.py</EXEC>';
          } else {
             llmOutput = '<STATE>HALT</STATE>';
          }
          await new Promise(r => setTimeout(r, 1000));
        } else if (LLM_PROVIDER === 'mock_labyrinth') {
          if (q.includes('STARTING_DEPLOYMENT') || q.includes('RETRYING')) {
             llmOutput = '<STATE>q_2: DEPLOYING</STATE>\n<EXEC>./deploy_database.sh</EXEC>';
          } else if (q.includes('DEPLOYING')) {
             if (s.includes('Error 503') || s.includes('Port 5432 in use')) {
                 llmOutput = '<STATE>q_3: RETRYING</STATE>\n<WRITE>Transient error detected. Retrying deployment.</WRITE>\n<EXEC>sleep 1</EXEC>';
             } else if (s.includes('Deployment finished successfully')) {
                 // Ghost 5: Silent Success. We must verify!
                 llmOutput = '<STATE>q_4: VERIFYING</STATE>\n<EXEC>cat db_ready.txt</EXEC>';
             } else {
                 llmOutput = '<STATE>q_3: RETRYING</STATE>\n<EXEC>sleep 1</EXEC>';
             }
          } else if (q.includes('VERIFYING')) {
             if (s.includes('No such file or directory') || s.includes('cat: db_ready.txt: No such file')) {
                 llmOutput = '<STATE>q_3: RETRYING</STATE>\n<WRITE>Silent failure detected. deploy_database.sh exited 0 but db_ready.txt is missing. Retrying.</WRITE>\n<EXEC>./deploy_database.sh</EXEC>';
             } else if (s.includes('DATABASE_IS_READY')) {
                 llmOutput = '<STATE>HALT</STATE>\n<WRITE>Labyrinth Navigated</WRITE>';
             } else {
                 llmOutput = '<STATE>q_3: RETRYING</STATE>\n<EXEC>./deploy_database.sh</EXEC>';
             }
          } else {
             llmOutput = '<STATE>HALT</STATE>';
          }
          await new Promise(r => setTimeout(r, 1000));
        } else if (LLM_PROVIDER === 'gemini') {
          const response = await gemini.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: contextC,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              temperature: 0.0,
            }
          });
          llmOutput = response.text || '';
        } else {
          // Default to Kimi Coding API
          try {
            const response = await kimi.chat.completions.create({
              model: 'kimi-for-coding',
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: contextC }
              ],
              temperature: 0.0,
            });
            llmOutput = response.choices[0]?.message?.content || '';
          } catch (e: any) {
            console.error("Kimi API Error:", e.message);
            llmOutput = `<STATE>FATAL_DEBUG</STATE>\\n<WRITE>[SYSTEM WARNING: Kimi API failed to execute. Check auth.]</WRITE>`;
          }
        }

        console.log(`[δ OUTPUT]:\n${llmOutput}\n`);

        // LAW 6: THE CYCLE BREAKER (Sliding Window)
        recentOutputs.push(llmOutput);
        if (recentOutputs.length > 20) {
          recentOutputs.shift();
        }
        
        const count = recentOutputs.filter(o => o === llmOutput).length;

        if (count >= 10) {
          console.warn("⚠️  [SYSTEM WARNING]: Insanity Loop Detected! Breaking the cycle.");
          llmOutput = '<STATE>FATAL_DEBUG</STATE>\n<WRITE>[SYSTEM WARNING: INSANITY LOOP DETECTED. You have computed the exact same δ transition 10 times within a short window. You are trapped in an infinite loop due to a persistently failing command or logic error. You MUST use a different approach or tool.]</WRITE>';
          recentOutputs = []; // Reset after breaking
        }

        if (this.getCurrentRequestId() !== requestId) {
          continue;
        }
        await this.applyDelta(llmOutput, d, requestId);

        // Broadcast updates
        this.broadcast({ type: 'tape_update', content: this.readCellS(this.getD()) });
        this.broadcast({ type: 'state_update', q: this.getQ(), d: this.getD() });
      }
    } catch (error: any) {
      console.error("Fatal Error in Simulation Loop:", error);
      const d = this.getD();
      const targetFile = this.resolveTapePath(d) || path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
      fs.appendFileSync(targetFile, `\n[FATAL SYSTEM ERROR]: ${error.message}\n`, 'utf-8');
      this.broadcast({ type: 'tape_update', content: this.readCellS(d) });
    } finally {
      this.isRunning = false;
      this.broadcast({ type: 'status', status: 'idle' });
    }
  }

  public async applyDelta(llmOutput: string, currentD: string, requestId: number = this.getCurrentRequestId()) {
    if (this.getCurrentRequestId() !== requestId) return;
    const targetFile = this.resolveTapePath(currentD) || path.join(WORKSPACE_DIR, "MAIN_TAPE.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    let hasAction = false;

    // 1. State Transition q'
    const stateMatch = llmOutput.match(/<STATE>(.*?)<\/STATE>/s);
    const requestedState = stateMatch ? stateMatch[1].trim() : null;

    // 2. Head Movement d'
    const gotoMatch = llmOutput.match(/<GOTO path="([^"]+)"\s*\/>/);
    const dPrimeRaw = gotoMatch ? gotoMatch[1].trim() : currentD;
    let dPrime = dPrimeRaw;
    if (gotoMatch && !this.isValidRelativeTapePath(dPrimeRaw)) {
      fs.appendFileSync(
        targetFile,
        `\n[DISCIPLINE ERROR]: Invalid <GOTO> path '${dPrimeRaw}'. Use only relative file paths.\n`,
        'utf-8'
      );
      dPrime = currentD;
    }

    // 3. Symbol Operations s'

    // <WRITE>
    const writeRegex = /<WRITE>(.*?)<\/WRITE>/gs;
    let writeMatch;
    while ((writeMatch = writeRegex.exec(llmOutput)) !== null) {
      if (this.getCurrentRequestId() !== requestId) return;
      hasAction = true;
      fs.appendFileSync(targetFile, `\n${writeMatch[1].trim()}\n`, 'utf-8');
      this.invalidateExecAudit(requestId);
    }

    // <ERASE>
    const eraseRegex = /<ERASE start="(\d+)" end="(\d+)"\s*\/>/g;
    let eraseMatch;
    while ((eraseMatch = eraseRegex.exec(llmOutput)) !== null) {
      if (this.getCurrentRequestId() !== requestId) return;
      hasAction = true;
      const start = parseInt(eraseMatch[1], 10);
      const end = parseInt(eraseMatch[2], 10);
      if (fs.existsSync(targetFile)) {
        const lines = fs.readFileSync(targetFile, 'utf-8').split('\n');
        if (start >= 1 && end >= start && end <= lines.length) {
          lines.splice(start - 1, end - start + 1, `[SYSTEM]: ... Lines ${start}-${end} physically erased by The Rubber ...`);
          fs.writeFileSync(targetFile, lines.join('\n'), 'utf-8');
          this.invalidateExecAudit(requestId);
        }
      }
    }

    // <REPLACE>
    const replaceRegex = /<REPLACE start="(\d+)" end="(\d+)">([\s\S]*?)<\/REPLACE>/g;
    let replaceMatch;
    while ((replaceMatch = replaceRegex.exec(llmOutput)) !== null) {
      if (this.getCurrentRequestId() !== requestId) return;
      hasAction = true;
      const start = parseInt(replaceMatch[1], 10);
      const end = parseInt(replaceMatch[2], 10);
      const newLines = replaceMatch[3].replace(/^\n+|\n+$/g, ''); // Trim leading/trailing newlines
      
      if (fs.existsSync(targetFile)) {
        const lines = fs.readFileSync(targetFile, 'utf-8').split('\n');
        if (start >= 1 && end >= start && end <= lines.length) {
          const replacementLines = newLines.split('\n');
          lines.splice(start - 1, end - start + 1, ...replacementLines);
          fs.writeFileSync(targetFile, lines.join('\n'), 'utf-8');
          this.invalidateExecAudit(requestId);
        }
      }
    }

    // <EXEC>
    const execRegex = /<EXEC>\s*(.*?)\s*<\/EXEC>/gs;
    let execMatch;
    while ((execMatch = execRegex.exec(llmOutput)) !== null) {
      if (this.getCurrentRequestId() !== requestId) return;
      hasAction = true;
      const cmd = execMatch[1].trim();
      if (!this.isExecCommandAllowed(cmd)) {
        this.writeExecAudit(requestId, 'error', cmd, '[EXEC BLOCKED] Rejected by strict exec guard.');
        fs.appendFileSync(
          targetFile,
          `\n[EXEC ERROR for \`${cmd.substring(0, 20)}...\`]:\n[EXEC BLOCKED] Rejected by strict exec guard.\n`,
          'utf-8'
        );
        continue;
      }
      try {
        const out = await this.execPromise(cmd, WORKSPACE_DIR);
        if (this.getCurrentRequestId() !== requestId) return;
        const truncated = this.truncateForTape(out || 'Silent Success', MAX_STDOUT);
        this.writeExecAudit(requestId, 'ok', cmd, out || '');
        fs.appendFileSync(
          targetFile,
          `\n[EXEC RESULT OK for \`${cmd.substring(0, 20)}...\`]:\n${truncated}\n`,
          'utf-8'
        );
      } catch (err: any) {
        if (this.getCurrentRequestId() !== requestId) return;
        const truncated = this.truncateForTape(err.message, MAX_STDOUT);
        this.writeExecAudit(requestId, 'error', cmd, err.message || '');
        fs.appendFileSync(targetFile, `\n[EXEC ERROR for \`${cmd.substring(0, 20)}...\`]:\n${truncated}\n`, 'utf-8');
      }
    }

    // Discipline Check
    if (!hasAction && !gotoMatch && !requestedState) {
      fs.appendFileSync(targetFile, `\n[DISCIPLINE ERROR]: Invalid δ output. Must output <STATE>, <GOTO>, <WRITE>, <ERASE>, <REPLACE>, or <EXEC>.\n`, 'utf-8');
    }

    // Apply state transition after operations so HALT can be gated by concrete evidence.
    if (requestedState) {
      if (this.getCurrentRequestId() !== requestId) return;
      if (requestedState === 'HALT' && !this.haltGateSatisfied(targetFile, requestId)) {
        fs.appendFileSync(
          targetFile,
          `\n[HALT GATE]: HALT rejected due to insufficient verifiable evidence. Continue with explicit verification EXEC steps.\n`,
          'utf-8'
        );
        this.setQ('q_recover: HALT_GATE_REJECTED');
      } else {
        this.setQ(requestedState);
      }
    }

    // Apply Head Movement
    if (dPrime !== currentD) {
      const dPrimePath = this.resolveTapePath(dPrime);
      if (!dPrimePath) {
        fs.appendFileSync(
          targetFile,
          `\n[DISCIPLINE ERROR]: <GOTO> target '${dPrime}' is outside workspace or invalid. Head remains at '${currentD}'.\n`,
          'utf-8'
        );
        return;
      }
      if (dPrimePath && fs.existsSync(dPrimePath) && fs.statSync(dPrimePath).isDirectory()) {
        fs.appendFileSync(
          targetFile,
          `\n[DISCIPLINE ERROR]: <GOTO> target '${dPrime}' is a directory. Head remains at '${currentD}'.\n`,
          'utf-8'
        );
        return;
      }
      console.log(`   🖨️ Head Moved: ${currentD} -> ${dPrime}`);
      this.setD(dPrime);
    }
  }

  private execPromise(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // LAW 5: NO INFINITE HANGS
      const timeoutMs = parsePositiveInt(process.env.TURINGCLAW_TIMEOUT, 600000);
      exec(cmd, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
              reject(new Error(`[COMMAND TIMED OUT] The command took longer than ${timeoutMs / 1000} seconds and was killed.\n${stderr || stdout}`));
          } else {
              reject(new Error(stderr || stdout || error.message));
          }
        } else {
          resolve(stdout || stderr);
        }
      });
    });
  }
}
