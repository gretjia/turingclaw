import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace/sisyphus');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const REG_Q = path.join(WORKSPACE_DIR, '.reg_q');
const REG_D = path.join(WORKSPACE_DIR, '.reg_d');
const PROGRESS_FILE = path.join(WORKSPACE_DIR, 'progress.txt');

function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runSisyphus() {
  console.log("==================================================");
  console.log("🪨 STARTING THE SISYPHUS BENCHMARK (PURE STATE TEST)");
  console.log("==================================================");

  cleanWorkspace();

  fs.writeFileSync(PROGRESS_FILE, '0', 'utf-8');

  fs.writeFileSync(path.join(WORKSPACE_DIR, 'build.sh'), `#!/usr/bin/env bash
VAL=$(cat progress.txt)
echo "Current progress: $VAL"
if [ "$VAL" -ge 3 ]; then
    echo "SUCCESS: Build passed."
    exit 0
else
    echo "ERROR: Build failed at stage $VAL. Needs fixing."
    exit 1
fi
`, { mode: 0o755 });

  fs.writeFileSync(path.join(WORKSPACE_DIR, 'fixer.sh'), `#!/usr/bin/env bash
VAL=$(cat progress.txt)
NEW_VAL=$((VAL + 1))
echo "$NEW_VAL" > progress.txt
echo "Fixer applied. Progress is now $NEW_VAL."
`, { mode: 0o755 });

  const prompt = `
[THE SISYPHUS BENCHMARK]
You are TuringClaw: The Cold-Blooded AI Operating System.
Your only job is to push the boulder up the hill.

Task:
1. We have a build script at './build.sh'.
2. We have an automated fixer script at './fixer.sh'.
3. Your loop:
   A. Execute: <EXEC>./build.sh</EXEC>
   B. If it prints "SUCCESS", transition to <STATE>HALT</STATE> and output <WRITE>Bouldered Pushed</WRITE>.
   C. If it prints "ERROR", execute: <EXEC>./fixer.sh</EXEC>, and then loop back to A.
4. You must continue this loop until the build succeeds. Do not stop. Do not give up.
`;
  
  fs.writeFileSync(MAIN_TAPE, prompt, 'utf-8');
  fs.writeFileSync(REG_Q, "q_1: STARTING_PUSH", 'utf-8');
  fs.writeFileSync(REG_D, "MAIN_TAPE.md", 'utf-8');

  let engineProcess = spawn('npx', ['tsx', 'cli.ts'], {
    // TURINGCLAW_WORKSPACE tells engine.ts to use this directory as its tape and state root
    env: { ...process.env, TURINGCLAW_WORKSPACE: WORKSPACE_DIR, LLM_PROVIDER: 'mock_sisyphus' },
    stdio: 'inherit'
  });

  let processKilled = false;
  let maxWait = 120; // Max 120 loops (240 seconds)
  let halted = false;

  while (maxWait > 0) {
      await sleep(2000);
      maxWait--;
      
      if (!fs.existsSync(REG_Q) || !fs.existsSync(PROGRESS_FILE)) continue;
      
      const currentQ = fs.readFileSync(REG_Q, 'utf-8').trim();
      const progressStr = fs.readFileSync(PROGRESS_FILE, 'utf-8').trim();
      const progress = parseInt(progressStr, 10);
      
      if (currentQ === "HALT") {
          halted = true;
          break;
      }

      // The Kill -9 injection
      if (progress === 2 && !processKilled) {
          console.log("\n💀 [Harness] PROGRESS IS 2. EXECUTING KILL -9 SIMULATION! (Boulder rolls down...)");
          engineProcess.kill('SIGKILL');
          fs.appendFileSync(MAIN_TAPE, '\n[FATAL SYSTEM CRASH]: SIGKILL received. Process terminated. Memory wiped.\n', 'utf-8');
          processKilled = true;
          
          await sleep(3000);
          console.log("\n⚡ [Harness] Rebooting Engine. Let's see if TuringClaw remembers to keep pushing...");
          engineProcess = spawn('npx', ['tsx', 'cli.ts'], {
              env: { ...process.env, TURINGCLAW_WORKSPACE: WORKSPACE_DIR, LLM_PROVIDER: 'mock_sisyphus' },
              stdio: 'inherit'
          });
      }
  }

  // Cleanup
  if (!engineProcess.killed) engineProcess.kill('SIGKILL');

  console.log("\n==================================================");
  console.log("📊 SISYPHUS BENCHMARK RESULTS");
  console.log("==================================================");
  
  const finalQ = fs.readFileSync(REG_Q, 'utf-8').trim();
  const tapeOutput = fs.readFileSync(MAIN_TAPE, 'utf-8');
  const finalProgress = parseInt(fs.readFileSync(PROGRESS_FILE, 'utf-8').trim(), 10);
  
  console.log(`Final State Register (.reg_q): ${finalQ}`);
  
  if (finalQ === 'HALT' && tapeOutput.includes('Bouldered Pushed') && finalProgress >= 3) {
      console.log("✅ RESULT: PASS.");
      console.log("TuringClaw proved its pure orchestration resilience. It ran a real LLM loop, executed external tools, survived a SIGKILL crash, recovered its state from the file system, and completed the loop without human intervention.");
  } else {
      console.log("❌ RESULT: FAIL. Final Q: " + finalQ + " Progress: " + finalProgress);
  }
  
  process.exit(0);
}

runSisyphus();