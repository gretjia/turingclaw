#!/usr/bin/env node
import { TuringClawEngine } from './server/engine.js';
import readline from 'readline';

const engine = new TuringClawEngine();
const MULTILINE_START = ':multi';
const MULTILINE_END = ':end';
const MULTILINE_CANCEL = ':cancel';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("==========================================");
console.log("  TuringClaw CLI (The True Turing Kernel) ");
console.log("==========================================");
console.log("Type your command and press Enter. Type 'exit' to quit.");
console.log(`Need multiline input? Type '${MULTILINE_START}' then finish with '${MULTILINE_END}' (or '${MULTILINE_CANCEL}' to abort).`);
console.log(`Workspace: ${engine.getWorkspaceDir()}`);
console.log(`Tape: ${engine.getTapeFilePath()}`);
console.log(`Note: You can run 'tail -f ${engine.getTapeFilePath()}' in another terminal to watch the mind work.\n`);

function collectMultilineInput(lines: string[] = []) {
  const prompt = lines.length === 0 ? '...multi> ' : '...      > ';
  rl.question(prompt, async (line) => {
    const normalized = line.trim().toLowerCase();
    if (normalized === MULTILINE_CANCEL) {
      console.log('[CLI] Multiline input canceled.');
      promptUser();
      return;
    }
    if (normalized === MULTILINE_END) {
      const payload = lines.join('\n').trim();
      if (!payload) {
        console.log('[CLI] Empty multiline payload ignored.');
        promptUser();
        return;
      }
      await engine.addUserMessage(payload);
      promptUser();
      return;
    }
    lines.push(line);
    collectMultilineInput(lines);
  });
}

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

    if (input.trim().toLowerCase() === MULTILINE_START) {
      collectMultilineInput();
      return;
    }

    await engine.addUserMessage(input);
    promptUser();
  });
}

function boot() {
  rl.question('Select default Heavy Coding Agent to delegate to (e.g. codex, cursor, gemini) [codex]: ', (answer) => {
    const agent = answer.trim() || 'codex';
    process.env.TURING_DELEGATE_AGENT = agent;
    console.log(`[BOOT] Immutable Delegation Configured: ${agent}\n`);
    promptUser();
  });
}

boot();
