#!/usr/bin/env node
import { TuringClawEngine } from './server/engine.js';
import readline from 'readline';

const engine = new TuringClawEngine();

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
