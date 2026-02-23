import fs from 'fs';
import path from 'path';

async function runBench() {
  console.log("🚀 Starting TuringClaw AGI Mini-Bench via API...");
  
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

  try {
    const res = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt })
    });
    
    if (!res.ok) {
      throw new Error(`Failed to start benchmark: ${await res.text()}`);
    }
    console.log("✅ Benchmark Task Injected. Waiting for completion...");

    // Poll for FINAL_RESULT.txt
    let attempts = 0;
    while (attempts < 60) {
      await new Promise(r => setTimeout(r, 5000));
      const fileRes = await fetch('http://localhost:3000/api/workspace/file?filename=FINAL_RESULT.txt');
      if (fileRes.ok) {
        console.log("\n========================================");
        console.log("✅ Benchmark Completed! FINAL_RESULT.txt content:");
        console.log(await fileRes.text());
        console.log("========================================");
        process.exit(0);
      }
      
      // Check if HALT state reached
      const tapeRes = await fetch('http://localhost:3000/api/workspace/file?filename=MAIN_TAPE.md');
      if (tapeRes.ok) {
        const tapeContent = await tapeRes.text();
        if (tapeContent.includes('FATAL SYSTEM ERROR')) {
          console.log("❌ Benchmark Failed: Fatal Error encountered.");
          process.exit(1);
        }
      }
      
      process.stdout.write(".");
      attempts++;
    }
    
    console.log("\n❌ Benchmark Timeout (5 minutes).");
    process.exit(1);
  } catch (e) {
    console.error("Error:", e);
  }
}

runBench();
