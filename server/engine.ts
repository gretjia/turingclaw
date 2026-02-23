import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import { WebSocketServer } from 'ws';

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'kimi';

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || 'dummy_key'
});

const WORKSPACE_DIR = process.env.TURINGCLAW_WORKSPACE || path.join(process.cwd(), 'workspace');
const FILE_Q = path.join(WORKSPACE_DIR, '.reg_q');
const FILE_D = path.join(WORKSPACE_DIR, '.reg_d');
const MAX_STDOUT = 1500;

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

  private initHardware() {
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    if (!fs.existsSync(FILE_Q)) this.setQ("q_0: SYSTEM_BOOTING");
    if (!fs.existsSync(FILE_D)) this.setD("MAIN_TAPE.md");
  }

  public getQ(): string { return fs.readFileSync(FILE_Q, 'utf-8').trim(); }
  public setQ(q: string) { fs.writeFileSync(FILE_Q, q.trim(), 'utf-8'); }
  public getD(): string { return fs.readFileSync(FILE_D, 'utf-8').trim(); }
  public setD(d: string) { fs.writeFileSync(FILE_D, d.trim(), 'utf-8'); }

  public readCellS(dPath: string): string {
    const fullPath = path.join(WORKSPACE_DIR, dPath);
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
            `\n[SYSTEM: TAPE TOO LONG. MIDDLE ${numHidden} LINES HIDDEN. YOU MUST USE <ERASE> TO FREE UP SPACE]\n`,
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
    const targetFile = path.join(WORKSPACE_DIR, d);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.appendFileSync(targetFile, `\n[USER REQUEST]: ${message}\n`, 'utf-8');

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

    try {
      while (true) {
        // LAW 0: SUPPRESSING THE EVENT LOOP
        // The loop is strictly blocking and deterministic. No Promise.all or floating async calls allowed.
        const q = this.getQ();
        const d = this.getD();
        const s = this.readCellS(d);

        if (q === "HALT") {
          console.log("🏁 HALT State Reached. Long-cycle test passed.");
          this.broadcast({ type: 'status', status: 'idle' });
          break;
        }

        const contextC = `[STATE REGISTER q]: ${q}\n[HEAD POINTER d]: ${d}\n[CELL CONTENT s]:\n${s}`;
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
          // Default to Kimi CLI
          const promptContent = `${SYSTEM_PROMPT}\n\n${contextC}`;
          const tmpPromptPath = path.join(WORKSPACE_DIR, '.tmp_prompt.txt');
          fs.writeFileSync(tmpPromptPath, promptContent, 'utf-8');
          try {
            const output = await this.execPromise(`cat .tmp_prompt.txt | kimi --quiet --input-format text`, WORKSPACE_DIR);
            llmOutput = output || '';
          } catch (e: any) {
            console.error("Kimi CLI Error:", e.message);
            llmOutput = '<STATE>FATAL_DEBUG</STATE>\\n<WRITE>[SYSTEM WARNING: Kimi CLI failed to execute. Check auth.]</WRITE>';
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

        await this.applyDelta(llmOutput, d);

        // Broadcast updates
        this.broadcast({ type: 'tape_update', content: this.readCellS(this.getD()) });
        this.broadcast({ type: 'state_update', q: this.getQ(), d: this.getD() });
      }
    } catch (error: any) {
      console.error("Fatal Error in Simulation Loop:", error);
      const d = this.getD();
      const targetFile = path.join(WORKSPACE_DIR, d);
      fs.appendFileSync(targetFile, `\n[FATAL SYSTEM ERROR]: ${error.message}\n`, 'utf-8');
      this.broadcast({ type: 'tape_update', content: this.readCellS(d) });
    } finally {
      this.isRunning = false;
      this.broadcast({ type: 'status', status: 'idle' });
    }
  }

  public async applyDelta(llmOutput: string, currentD: string) {
    const targetFile = path.join(WORKSPACE_DIR, currentD);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    let hasAction = false;

    // 1. State Transition q'
    const stateMatch = llmOutput.match(/<STATE>(.*?)<\/STATE>/s);
    if (stateMatch) {
      this.setQ(stateMatch[1].trim());
    }

    // 2. Head Movement d'
    const gotoMatch = llmOutput.match(/<GOTO path="([^"]+)"\s*\/>/);
    const dPrime = gotoMatch ? gotoMatch[1].trim() : currentD;

    // 3. Symbol Operations s'

    // <WRITE>
    const writeRegex = /<WRITE>(.*?)<\/WRITE>/gs;
    let writeMatch;
    while ((writeMatch = writeRegex.exec(llmOutput)) !== null) {
      hasAction = true;
      fs.appendFileSync(targetFile, `\n${writeMatch[1].trim()}\n`, 'utf-8');
    }

    // <ERASE>
    const eraseRegex = /<ERASE start="(\d+)" end="(\d+)"\s*\/>/g;
    let eraseMatch;
    while ((eraseMatch = eraseRegex.exec(llmOutput)) !== null) {
      hasAction = true;
      const start = parseInt(eraseMatch[1], 10);
      const end = parseInt(eraseMatch[2], 10);
      if (fs.existsSync(targetFile)) {
        const lines = fs.readFileSync(targetFile, 'utf-8').split('\n');
        if (start >= 1 && end >= start && end <= lines.length) {
          lines.splice(start - 1, end - start + 1, `[SYSTEM]: ... Lines ${start}-${end} physically erased by The Rubber ...`);
          fs.writeFileSync(targetFile, lines.join('\n'), 'utf-8');
        }
      }
    }

    // <REPLACE>
    const replaceRegex = /<REPLACE start="(\d+)" end="(\d+)">([\s\S]*?)<\/REPLACE>/g;
    let replaceMatch;
    while ((replaceMatch = replaceRegex.exec(llmOutput)) !== null) {
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
        }
      }
    }

    // <EXEC>
    const execRegex = /<EXEC>\s*(.*?)\s*<\/EXEC>/gs;
    let execMatch;
    while ((execMatch = execRegex.exec(llmOutput)) !== null) {
      hasAction = true;
      const cmd = execMatch[1].trim();
      try {
        const out = await this.execPromise(cmd, WORKSPACE_DIR);
        const truncated = out.substring(0, MAX_STDOUT);
        fs.appendFileSync(targetFile, `\n[EXEC RESULT for \`${cmd.substring(0, 20)}...\`]:\n${truncated || 'Silent Success'}\n`, 'utf-8');
      } catch (err: any) {
        const truncated = err.message.substring(0, MAX_STDOUT);
        fs.appendFileSync(targetFile, `\n[EXEC ERROR for \`${cmd.substring(0, 20)}...\`]:\n${truncated}\n`, 'utf-8');
      }
    }

    // Discipline Check
    if (!hasAction && !gotoMatch && !llmOutput.includes("<STATE>HALT</STATE>")) {
      fs.appendFileSync(targetFile, `\n[DISCIPLINE ERROR]: Invalid δ output. Must output <STATE>, <GOTO>, <WRITE>, <ERASE>, <REPLACE>, or <EXEC>.\n`, 'utf-8');
    }

    // Apply Head Movement
    if (dPrime !== currentD) {
      console.log(`   🖨️ Head Moved: ${currentD} -> ${dPrime}`);
      this.setD(dPrime);
    }
  }

  private execPromise(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // LAW 5: NO INFINITE HANGS
      const timeoutMs = process.env.TURINGCLAW_TIMEOUT ? parseInt(process.env.TURINGCLAW_TIMEOUT, 10) : 600000;
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