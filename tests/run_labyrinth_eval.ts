import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace/labyrinth');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const REG_Q = path.join(WORKSPACE_DIR, '.reg_q');

function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

async function runLabyrinth() {
  console.log("==================================================");
  console.log("🧩 STARTING THE FLAKY LABYRINTH BENCHMARK");
  console.log("==================================================");

  cleanWorkspace();

  fs.writeFileSync(path.join(WORKSPACE_DIR, 'deploy_database.sh'), `#!/usr/bin/env bash
# Flaky Database Deployment Script
RAND=$((RANDOM % 100))

if [ $RAND -lt 60 ]; then
    # 60% chance of Ghost 6: Transient Fragility
    if [ $((RAND % 2)) -eq 0 ]; then
        echo "Error 503: Registry Unavailable"
    else
        echo "Error: Port 5432 in use"
    fi
    exit 1
elif [ $RAND -lt 90 ]; then
    # 30% chance of Ghost 5: Silent Success
    echo "Deployment finished successfully."
    exit 0
else
    # 10% chance of Actual Success
    echo "Deployment finished successfully."
    echo "DATABASE_IS_READY" > db_ready.txt
    exit 0
fi
`, { mode: 0o755 });

  const prompt = `
[THE FLAKY LABYRINTH]
You are TuringClaw. Your mission is to deploy the database.
1. Run <EXEC>./deploy_database.sh</EXEC>.
2. Watch out for transient network errors (Ghost 6). If they happen, you must retry.
3. Watch out for Silent Successes (Ghost 5). The script may say "success" but fail to create 'db_ready.txt'. You MUST verify that 'db_ready.txt' exists by running <EXEC>cat db_ready.txt</EXEC> before trusting it.
4. Only when you see "DATABASE_IS_READY" inside 'db_ready.txt' may you transition to <STATE>HALT</STATE> and write <WRITE>Labyrinth Navigated</WRITE>.
`;

  fs.writeFileSync(MAIN_TAPE, prompt, 'utf-8');
  fs.writeFileSync(REG_Q, "q_1: STARTING_DEPLOYMENT", 'utf-8');

  process.env.TURINGCLAW_WORKSPACE = WORKSPACE_DIR;
  process.env.LLM_PROVIDER = 'mock_labyrinth';

  console.log("🚀 [Harness] Starting TuringClaw Engine...");

  const tcProcess = spawn('npx', ['tsx', 'cli.ts'], {
    cwd: path.join(process.cwd()),
    stdio: 'inherit',
    env: { ...process.env }
  });

  tcProcess.on('close', (code) => {
      const finalQ = fs.existsSync(REG_Q) ? fs.readFileSync(REG_Q, 'utf-8').trim() : '';
      const tapeOutput = fs.existsSync(MAIN_TAPE) ? fs.readFileSync(MAIN_TAPE, 'utf-8') : '';
      
      console.log("\n==================================================");
      console.log("📊 LABYRINTH BENCHMARK RESULTS");
      console.log("==================================================");
      
      if (finalQ === 'HALT' && tapeOutput.includes('Labyrinth Navigated')) {
          console.log("✅ RESULT: PASS.");
          console.log("TuringClaw successfully defeated Ghost 5 (Silent Success) and Ghost 6 (Transient Fragility). It learned to distrust exit codes and verify physical file state.");
      } else {
          console.log("❌ RESULT: FAIL.");
      }
  });
}

runLabyrinth();