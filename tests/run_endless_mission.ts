import fs from 'fs';
import path from 'path';
import { TuringClawEngine } from '../server/engine.js';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace/endless');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const REG_Q = path.join(WORKSPACE_DIR, '.reg_q');
const REG_D = path.join(WORKSPACE_DIR, '.reg_d');

function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runEndlessMission() {
  console.log("==================================================");
  console.log("♾️  STARTING ENDLESS MISSION BENCHMARK");
  console.log("==================================================");

  cleanWorkspace();

  const prompt = `
[ENDLESS MISSION: COLLATZ CONJECTURE]
You are TuringClaw. Your mission is to endlessly search for a counter-example to the Collatz Conjecture.
1. Write a python script 'collatz.py' that takes a random massive integer and tests it.
2. Execute <EXEC>python3 collatz.py</EXEC>.
3. Read the output.
4. Loop back to step 2 infinitely. Do not ever HALT.
`;
  
  fs.writeFileSync(MAIN_TAPE, prompt, 'utf-8');
  fs.writeFileSync(REG_Q, "q_1: STARTING_SEARCH", 'utf-8');
  fs.writeFileSync(REG_D, "MAIN_TAPE.md", 'utf-8');

  // We override the workspace
  process.env.TURINGCLAW_WORKSPACE = WORKSPACE_DIR;
  process.env.LLM_PROVIDER = 'mock_endless';

  const engine = new TuringClawEngine(null);
  const originalGetQ = engine.getQ.bind(engine);
  engine.getQ = () => { return fs.existsSync(REG_Q) ? fs.readFileSync(REG_Q, 'utf-8').trim() : "HALT"; }
  engine.setQ = (q: string) => { fs.writeFileSync(REG_Q, q.trim(), 'utf-8'); }
  engine.getD = () => { return fs.existsSync(REG_D) ? fs.readFileSync(REG_D, 'utf-8').trim() : "MAIN_TAPE.md"; }
  engine.setD = (d: string) => { fs.writeFileSync(REG_D, d.trim(), 'utf-8'); }

  let loopCount = 0;
  
  engine.runSimulationLoop = async () => {
      engine['isRunning'] = true;
      try {
          while (true) {
              const q = engine.getQ();
              if (q === "HALT") break;
              
              loopCount++;
              
              // Simulate LLM outputting delta without pausing to erase
              let llmOutput = '<STATE>q_2: SEARCHING</STATE>\n<EXEC>echo "Tested integer ' + (Math.random() * 1000000000000) + '. Collatz holds true. No counter-example found."</EXEC>';
              
              // At loop 50, simulate the LLM realizing the tape is too long and using ERASE
              if (loopCount % 50 === 0) {
                  const s = engine.readCellS(engine.getD());
                  const lines = s.split('\n').length;
                  llmOutput = '<STATE>q_3: PRUNING_TAPE</STATE>\n<ERASE start="5" end="' + (lines - 10) + '" />\n<EXEC>echo "Tested integer ' + (Math.random() * 1000000000000) + '."</EXEC>';
              }
              
              await engine.applyDelta(llmOutput, engine.getD());
              
              // Fast loop to simulate long-running time quickly
              await sleep(10); 
              
              // We force stop after 200 iterations for analysis
              if (loopCount >= 200) {
                  console.log("\n⏳ [Harness] Force stopping the endless mission after 200 iterations to analyze the tape.");
                  break;
              }
          }
      } finally {
          engine['isRunning'] = false;
      }
  };

  await engine.runSimulationLoop();

  console.log("\n==================================================");
  console.log("📊 ENDLESS MISSION ANALYSIS");
  console.log("==================================================");
  
  const tapeOutput = fs.readFileSync(MAIN_TAPE, 'utf-8');
  const lines = tapeOutput.split('\n');
  const sizeKb = (Buffer.byteLength(tapeOutput, 'utf8') / 1024).toFixed(2);
  
  console.log(`Tape Lines: ${lines.length}`);
  console.log(`Tape Size: ${sizeKb} KB`);
  
  const scars = lines.filter(l => l.includes('physically erased by The Rubber')).length;
  console.log(`Rubber Scars on Tape: ${scars}`);
  
  console.log("\nFirst 15 lines of tape:");
  console.log(lines.slice(0, 15).join('\n'));
  
  console.log("\nLast 15 lines of tape:");
  console.log(lines.slice(-15).join('\n'));
  
}

runEndlessMission();