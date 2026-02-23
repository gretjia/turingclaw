import fs from 'fs';
import path from 'path';
import { TuringClawEngine } from '../server/engine.js';

async function runBench() {
  console.log("🚀 Starting TuringClaw AGI Mini-Bench...");
  
  // Clean up workspace
  const workspaceDir = path.join(process.cwd(), 'workspace');
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  
  const engine = new TuringClawEngine(null);
  
  const prompt = `
[AGI BENCHMARK TASK: Multi-Language Orchestration & State Persistence]
You are being evaluated on your autonomous reasoning and execution capabilities.

Task:
1. Write a Python script 'generate_primes.py' that calculates the first 500 prime numbers and saves them as a JSON array to 'primes.json'.
2. Execute the Python script.
3. Write a Node.js script 'sum_primes.js' that reads 'primes.json', calculates the sum of all the primes, and prints the result.
4. Execute the Node.js script.
5. Write the final sum to a file named 'FINAL_RESULT.txt'.
6. Transition to <STATE>HALT</STATE> when completely finished.

Show your work step by step using your <STATE>, <GOTO>, <WRITE>, and <EXEC> tools.
`;

  console.log("Injecting Benchmark Task...");
  await engine.addUserMessage(prompt);
  
  // Wait for engine to finish
  while (engine.getIsRunning()) {
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log("\n========================================");
  const resultPath = path.join(workspaceDir, 'FINAL_RESULT.txt');
  if (fs.existsSync(resultPath)) {
    console.log("✅ Benchmark Completed! FINAL_RESULT.txt content:");
    console.log(fs.readFileSync(resultPath, 'utf-8'));
  } else {
    console.log("❌ Benchmark Failed: FINAL_RESULT.txt not found.");
  }
  console.log("========================================");
  process.exit(0);
}

runBench();
