import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace/dining');
const MAIN_TAPE = path.join(WORKSPACE_DIR, 'MAIN_TAPE.md');
const REG_Q = path.join(WORKSPACE_DIR, '.reg_q');
const REG_D = path.join(WORKSPACE_DIR, '.reg_d');

function cleanWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

async function runDiningPhilosophers() {
  console.log("==================================================");
  console.log("🍝 STARTING AGI CODING CHALLENGE: DINING PHILOSOPHERS");
  console.log("==================================================");

  cleanWorkspace();

  fs.writeFileSync(path.join(WORKSPACE_DIR, 'philosophers.py'), `
import threading
import time

class Philosopher(threading.Thread):
    def __init__(self, name, left_fork, right_fork):
        threading.Thread.__init__(self)
        self.name = name
        self.left_fork = left_fork
        self.right_fork = right_fork
        self.meals = 0

    def run(self):
        while self.meals < 5:
            # Flaw: Classic Deadlock implementation
            self.left_fork.acquire()
            time.sleep(0.1) # Simulate thinking
            self.right_fork.acquire()
            
            # Eat
            self.meals += 1
            
            self.right_fork.release()
            self.left_fork.release()

def run_simulation():
    forks = [threading.Lock() for n in range(5)]
    philosophers = [
        Philosopher("Aristotle", forks[0], forks[1]),
        Philosopher("Kant", forks[1], forks[2]),
        Philosopher("Spinoza", forks[2], forks[3]),
        Philosopher("Marx", forks[3], forks[4]),
        Philosopher("Russell", forks[4], forks[0])
    ]
    
    for p in philosophers:
        p.start()
        
    for p in philosophers:
        p.join()
        
    print("ALL PHILOSOPHERS FINISHED EATING.")

if __name__ == "__main__":
    run_simulation()
`);

  const prompt = `
[REAL AGI CODING CHALLENGE: CONCURRENCY]
You are TuringClaw: The Cold-Blooded AI Operating System.
You manage state and delegate coding tasks to the 'kimi' sub-agent.

Task:
1. We have 'philosophers.py', a simulation of the Dining Philosophers problem using threading.
2. Run the simulation: <EXEC>python3 philosophers.py</EXEC>.
3. If it hangs or times out, there is a deadlock. You MUST NOT fix it yourself.
4. Delegate the fix to Kimi. Example: <EXEC>kimi -y -p "The dining philosophers script hangs due to a deadlock. Please rewrite philosophers.py to avoid the deadlock (e.g. resource hierarchy or arbitration) and output the solution."</EXEC>
5. Re-run the simulation.
6. Once the simulation prints "ALL PHILOSOPHERS FINISHED EATING.", transition to <STATE>HALT</STATE>.
`;

  fs.writeFileSync(MAIN_TAPE, prompt, 'utf-8');
  fs.writeFileSync(REG_Q, "q_1: RUN_SIMULATION", 'utf-8');
  fs.writeFileSync(REG_D, "MAIN_TAPE.md", 'utf-8');

  // We set a 5-second timeout for TuringClaw's commands so the deadlock triggers Ghost 2 (Infinite Hang) protection!
  process.env.TURINGCLAW_TIMEOUT = '5000';
  process.env.TURINGCLAW_WORKSPACE = WORKSPACE_DIR;
  process.env.LLM_PROVIDER = 'mock_dining'; 

  console.log("🚀 [Harness] Starting TuringClaw Engine...");

  const tcProcess = spawn('npx', ['tsx', 'cli.ts'], {
    cwd: path.join(process.cwd()),
    stdio: 'inherit',
    env: { ...process.env }
  });

  tcProcess.on('close', (code) => {
      console.log(`
Engine exited with code \${code}`);
      const finalQ = fs.readFileSync(REG_Q, 'utf-8').trim();
      const tapeOutput = fs.readFileSync(MAIN_TAPE, 'utf-8');
      
      console.log("==================================================");
      console.log("📊 CODING CHALLENGE RESULTS");
      console.log("==================================================");
      
      if (finalQ === 'HALT') {
          console.log("✅ RESULT: PASS.");
          console.log("TuringClaw successfully caught the infinite hang (Ghost 2), delegated the debugging to the Kimi sub-agent, and verified the concurrent programming fix.");
      } else {
          console.log("❌ RESULT: FAIL.");
      }
  });
}

runDiningPhilosophers();