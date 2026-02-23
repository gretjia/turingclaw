import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import { WebSocketServer } from 'ws';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'dummy_key' });

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');
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

    console.log("⚙️ AI Turing Machine Started. Executing formal δ(q,s) loop...");

    try {
      while (true) {
        const q = this.getQ();
        const d = this.getD();
        const s = this.readCellS(d);

        if (q === "HALT") {
          console.log("🏁 HALT State Reached. Long-cycle test passed.");
          this.broadcast({ type: 'status', status: 'idle' });
          break;
        }

        const contextC = `[STATE REGISTER q]: ${q}\n[HEAD POINTER d]: ${d}\n[CELL CONTENT s]:\n${s}`;
        console.log(`\n[${q}] Head at [${d}] -> Computing δ...`);

        // Call Gemini with Temperature 0 for Deterministic Collapse
        const response = await ai.models.generateContent({
          model: 'gemini-3.1-pro-preview',
          contents: contextC,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.0,
          }
        });

        const llmOutput = response.text || '';
        console.log(`[δ OUTPUT]:\n${llmOutput}\n`);

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
      fs.appendFileSync(targetFile, `\n[DISCIPLINE ERROR]: Invalid δ output. Must output <STATE>, <GOTO>, <WRITE>, <ERASE>, or <EXEC>.\n`, 'utf-8');
    }

    // Apply Head Movement
    if (dPrime !== currentD) {
      console.log(`   🖨️ Head Moved: ${currentD} -> ${dPrime}`);
      this.setD(dPrime);
    }
  }

  private execPromise(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
        } else {
          resolve(stdout || stderr);
        }
      });
    });
  }
}
