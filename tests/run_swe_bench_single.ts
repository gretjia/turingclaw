import fs from 'fs';
import path from 'path';
import { TuringClawEngine } from '../server/engine.js';
import { execSync } from 'child_process';

async function runSingleBench() {
  console.log("🚀 Starting TuringClaw SWE-bench Single Trial...");
  
  // Clean up workspace
  const workspaceDir = path.join(process.cwd(), 'workspace');
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  
  const repoDir = path.join(workspaceDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  
  // Create a buggy file representing our target repo
  fs.writeFileSync(path.join(repoDir, 'calculator.py'), `
def add(a, b):
    return a + b

def subtract(a, b):
    return a - b

def multiply(a, b):
    return a + b  # BUG! Should be a * b

def divide(a, b):
    return a / b
`.trim());

  // Create a test file
  fs.writeFileSync(path.join(repoDir, 'test_calculator.py'), `
from calculator import add, subtract, multiply, divide

def test_multiply():
    assert multiply(3, 4) == 12, "Multiplication failed!"
`.trim());

  // Initialize git repo to capture patch later
  execSync('cd workspace/repo && git init && git add . && git config user.email "bot@turingclaw.com" && git config user.name "TuringClaw" && git commit -m "Initial commit"', { stdio: 'ignore' });

  const prompt = `
[SWE-BENCH LITE TASK]
Repository: repo (local)
Problem Statement: 
The \`multiply\` function in \`repo/calculator.py\` seems to be returning the sum instead of the product. 
Please fix the bug in \`repo/calculator.py\` and run \`pytest repo/test_calculator.py\` to verify.

Instructions:
1. Use your tools to navigate to the buggy file.
2. Fix the bug using the <REPLACE> tag.
3. Run the tests.
4. Once tests pass, transition to <STATE>HALT</STATE>.
`;

  const engine = new TuringClawEngine(null);

  console.log("Injecting Task into MAIN_TAPE.md...");
  await engine.addUserMessage(prompt);
  
  // Wait for engine to finish
  while (engine.getIsRunning()) {
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log("\n========================================");
  console.log("✅ Benchmark Completed! Let's check the generated patch.diff:");
  try {
    const diff = execSync('cd workspace/repo && git diff', { encoding: 'utf-8' });
    if (diff.trim() === '') {
      console.log("No diff found. The agent might not have edited the file properly.");
    } else {
      console.log(diff);
      fs.writeFileSync(path.join(workspaceDir, 'patch.diff'), diff);
      console.log("Patch saved to workspace/patch.diff");
    }
  } catch(e: any) {
    console.log("Failed to get diff:", e.message);
  }
  console.log("========================================");
  process.exit(0);
}

runSingleBench();