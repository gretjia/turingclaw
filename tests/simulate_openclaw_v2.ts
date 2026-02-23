import fs from 'fs';
import path from 'path';

// Set dummy API keys before importing engine
process.env.KIMI_API_KEY = 'dummy_key_for_testing';
process.env.GEMINI_API_KEY = 'dummy_key_for_testing';

import { TuringClawEngine } from '../server/engine';

// Mock WebSocket Server
const mockWss = {
  clients: [],
  on: () => { },
} as any;

async function runTests() {
  console.log('--- Starting TuringClaw V2.0 Simulation Tests ---');

  // Clean up workspace before tests
  const workspaceDir = path.join(process.cwd(), 'workspace');
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  const engine = new TuringClawEngine(mockWss);

  try {
    // Test 1: Hardware Initialization
    console.log('\n[Test 1] Hardware Registers Initialization');
    if (engine.getQ() !== 'q_0: SYSTEM_BOOTING') throw new Error('Test 1 Failed: Initial Q state mismatch');
    if (engine.getD() !== 'MAIN_TAPE.md') throw new Error('Test 1 Failed: Initial D state mismatch');
    console.log('Registers initialized correctly.');

    // Test 2: State Transition & Head Movement
    console.log('\n[Test 2] State Transition (q\') and Head Movement (d\')');
    const statePayload = `<STATE>q_1: TESTING_GOTO</STATE>\n<GOTO path="docs/req.md" />\n<WRITE>Initial requirements</WRITE>`;
    await engine.applyDelta(statePayload, engine.getD());

    if (engine.getQ() !== 'q_1: TESTING_GOTO') throw new Error('Test 2 Failed: State Q not updated');
    if (engine.getD() !== 'docs/req.md') throw new Error('Test 2 Failed: Head D not moved');
    console.log('State and Head updated correctly.');

    // Test 3: Write and Read Cell
    console.log('\n[Test 3] Write and Read Cell (s\')');
    const cellContent = engine.readCellS('MAIN_TAPE.md'); // Action was applied to currentD (MAIN_TAPE.md)
    if (!cellContent.includes('Initial requirements')) throw new Error('Test 3 Failed: Content not written to cell');
    console.log('Cell content verified.');

    // Test 4: Rubber (ERASE)
    console.log('\n[Test 4] Rubber: Context Pruning with Scar Tissue');
    const erasePayload = `<WRITE>Dummy 1</WRITE>\n<WRITE>Dummy 2</WRITE>\n<WRITE>Dummy 3</WRITE>`;
    await engine.applyDelta(erasePayload, engine.getD());

    // We know the file has some lines now. Let's erase lines 2 to 3.
    const eraseAction = `<ERASE start="2" end="3" />`;
    await engine.applyDelta(eraseAction, engine.getD());

    const tapeAfter = engine.readCellS(engine.getD());
    if (!tapeAfter.includes('physically erased by The Rubber')) throw new Error('Test 4 Failed: Scar not found in tape');
    console.log('Rubber erased lines and left scar tissue.');

    // Test 5: Discipline (Syntax Error)
    console.log('\n[Test 5] Discipline: Invalid Syntax');
    const invalidPayload = `I am just talking without tags.`;
    await engine.applyDelta(invalidPayload, engine.getD());

    const disciplineTape = engine.readCellS(engine.getD());
    if (!disciplineTape.includes('DISCIPLINE ERROR')) throw new Error('Test 5 Failed: Discipline error not triggered');
    console.log('Discipline enforced.');

    // Test 6: Execution (EXEC)
    console.log('\n[Test 6] Execution: Sandbox Pencil');
    const execPayload = `<EXEC>echo "Hello V2"</EXEC>`;
    await engine.applyDelta(execPayload, engine.getD());

    const execTape = engine.readCellS(engine.getD());
    if (!execTape.includes('Hello V2')) throw new Error('Test 6 Failed: EXEC output not found');
    console.log('EXEC sandbox working.');

    console.log('\n✅ All TuringClaw V2.0 Simulation Tests Passed Successfully!');
  } catch (e) {
    console.error('\n❌ Test Suite Failed:', e);
    process.exit(1);
  }
}

runTests();
