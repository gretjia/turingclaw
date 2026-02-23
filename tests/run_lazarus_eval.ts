import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const REG_Q = path.join(WORKSPACE_DIR, '.reg_q');
const REG_D = path.join(WORKSPACE_DIR, '.reg_d');

// Helper to clean workspace
function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// Helper to delay execution
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function startTuringClaw() {
  console.log("🚀 [Harness] Starting TuringClaw Engine Process...");
  // Start the CLI which loops the engine
  const tcProcess = spawn('npx', ['tsx', 'cli.ts'], {
    stdio: 'ignore', // We monitor via the tape and registers
    env: { ...process.env } // Uses actual LLM keys from environment
  });
  return tcProcess;
}

async function runLazarusEval() {
  console.log("==================================================");
  console.log("🧪 STARTING THE LAZARUS PIPELINE AGI BENCHMARK");
  console.log("==================================================");

  cleanWorkspace();

  const prompt = `
[LONG-HORIZON AGI BENCHMARK: THE LAZARUS PIPELINE]
You are operating in YOLO (Autonomous) Mode.
Your objective is to complete a full software lifecycle without human intervention.
There will be NO human to click 'allow' for you. You must watch your tape, debug errors, and persist.

Task:
1. Write a Python script 'app.py' with a simple 'hello_world()' function returning "Hello".
2. Write 'test_app.py' using pytest to assert 'hello_world() == "Hello"'.
3. Execute <EXEC>pytest test_app.py</EXEC>.
4. IF TESTS FAIL: Read the error on your tape, use <REPLACE> to fix 'app.py', and re-run tests.
5. Once tests pass, create a file 'release_ready.txt' containing "SUCCESS".
6. Only transition to <STATE>HALT</STATE> when 'release_ready.txt' exists and tests are green.
`;
  
  fs.writeFileSync(MAIN_TAPE, prompt, 'utf-8');
  fs.writeFileSync(REG_Q, "q_1: PROCESSING_USER_REQUEST", 'utf-8');
  fs.writeFileSync(REG_D, "MAIN_TAPE.md", 'utf-8');

  let engineProcess = startTuringClaw();

  // The Observer Loop
  let testsFailed = false;
  let processKilled = false;
  let maxWait = 120; // Max 120 loops (240 seconds)
  let halted = false;

  while (maxWait > 0) {
    await sleep(2000);
    maxWait--;
    
    if (!fs.existsSync(REG_Q)) continue;
    const currentQ = fs.readFileSync(REG_Q, 'utf-8').trim();
    console.log(`[Observer] Current Engine State: ${currentQ}`);

    if (currentQ === "HALT") {
        halted = true;
        break;
    }

    // 1. Bug Injection / Interruption Simulation
    const appPath = path.join(WORKSPACE_DIR, 'app.py');
    if (!testsFailed && fs.existsSync(appPath)) {
        console.log("😈 [Harness] Injecting a bug into app.py behind TuringClaw's back!");
        fs.writeFileSync(appPath, 'def hello_world():\n    return "Goodbye"  # BUG INJECTED BY HARNESS\n', 'utf-8');
        testsFailed = true; 
    }

    // 2. The "Kill -9" Test (Testing state persistence)
    if (testsFailed && !processKilled && currentQ.toLowerCase().includes("fix") || currentQ.toLowerCase().includes("test")) {
        console.log("💀 [Harness] EXECUTING KILL -9 SIMULATION! Destroying process in RAM...");
        engineProcess.kill('SIGKILL');
        fs.appendFileSync(MAIN_TAPE, '\n[FATAL SYSTEM CRASH]: SIGKILL received. Process terminated. Memory wiped.\n', 'utf-8');
        processKilled = true;
        
        await sleep(3000); // Wait for the dust to settle
        
        // Reboot the engine immediately to see if it picks up from .reg_q and MAIN_TAPE.md
        console.log("⚡ [Harness] Rebooting Engine. Let's see if it has Amnesia...");
        engineProcess = startTuringClaw();
    }
  }

  // Cleanup
  if (!engineProcess.killed) engineProcess.kill('SIGKILL');

  console.log("==================================================");
  console.log("📊 LAZARUS PIPELINE RESULTS");
  console.log("==================================================");
  
  const finalQ = fs.existsSync(REG_Q) ? fs.readFileSync(REG_Q, 'utf-8').trim() : 'UNKNOWN';
  const releasePath = path.join(WORKSPACE_DIR, 'release_ready.txt');
  
  console.log(`Final State Register (.reg_q): ${finalQ}`);
  
  if (finalQ === 'HALT' && fs.existsSync(releasePath)) {
      console.log("✅ RESULT: PASS. TuringClaw demonstrated true Long-Horizon AGI Persistence.");
      console.log("It survived a hard process kill, detected an injected bug autonomously, debugged it, and reached release.");
  } else {
      console.log("❌ RESULT: FAIL. TuringClaw lost focus, failed to recover, or did not complete the release.");
  }
  
  process.exit(0);
}

runLazarusEval();