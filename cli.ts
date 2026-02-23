#!/usr/bin/env node
import { TuringClawEngine } from './server/engine.js';
import readline from 'readline';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

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

async function compilePrompt(input: string): Promise<string> {
  const SYSTEM_PROMPT = `You are the TuringClaw Prompt Compiler. Your job is to translate a user's casual, natural language request into a strict 'TuringClaw Tape Prompt' that the TuringClaw $\\delta$ transition engine can digest. 

The output MUST follow this exact anatomy:

**A. The Role / Mission**
(Define the persona and the ultimate goal clearly).

**B. The Environment (The Context)**
(List the assumed starting files, test scripts, or directories they have access to).

**C. The Rules of Engagement (The Physics)**
(Use numbered bullet points. Tell the agent exactly what tools or scripts it is allowed to trust. Tell it to use <GOTO>, <REPLACE>, <WRITE>, and <EXEC> XML tags. Crucially, tell it how to physically verify its own work by running a test script or command).

**D. The <STATE>HALT</STATE> Condition**
(Define the EXACT, unambiguous condition for when the agent should stop and output <STATE>HALT</STATE>. For example: 'When test_server.sh outputs ALL TESTS PASSED...').

Do NOT include conversational filler. Just output the compiled prompt.

Here is the user's request:
${input}`;

  try {
    console.log("⚙️  [Prompt Compiler]: Translating human intent into TuringClaw state machine physics...");
    const { stdout } = await execPromise(`kimi -y --quiet -p ${JSON.stringify(SYSTEM_PROMPT)}`);
    console.log("✅  [Prompt Compiler]: Translation successful.\n");
    return stdout.trim();
  } catch (err: any) {
    console.error("❌  [Prompt Compiler Failed]:", err.message);
    return input; // Fallback to raw input
  }
}

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

    const compiledInput = await compilePrompt(input);
    await engine.addUserMessage(compiledInput);
    promptUser();
  });
}

promptUser();