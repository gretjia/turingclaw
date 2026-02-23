#!/usr/bin/env node
import { TuringClawEngine } from './server/engine.js';
import readline from 'readline';

const engine = new TuringClawEngine();

// If we are in YOLO/Autonomous mode, we should just start the simulation loop
// based on the current state registers without waiting for user input.
const q = engine.getQ();
if (q !== 'q_0: SYSTEM_BOOTING' && q !== 'HALT') {
  console.log("⚡ Auto-resuming from state:", q);
  engine.runSimulationLoop().catch(console.error);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("==========================================");
console.log("  TuringClaw CLI (The True Turing Kernel) ");
console.log("==========================================");
console.log("Type your command and press Enter. Type 'exit' to quit.");
console.log("Note: You can tail workspace/TAPE.md in another terminal to watch the mind work.\n");

function promptUser() {
  if (engine.getIsRunning()) {
    setTimeout(promptUser, 1000);
    return;
  }

  if (engine.getQ() === 'HALT' || engine.getQ() === 'FATAL_DEBUG') {
     console.log("\n[CLI] HALT or FATAL_DEBUG state detected. Exiting autonomous mode.");
     rl.close();
     process.exit(0);
  }

  rl.question('TuringClaw> ', async (input) => {
    if (input.toLowerCase() === 'exit') {
      rl.close();
      process.exit(0);
    }

    if (input.trim() === '') {
      promptUser();
      return;
    }

    await engine.addUserMessage(input);
    promptUser();
  });
}

promptUser();