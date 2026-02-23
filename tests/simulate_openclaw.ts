import fs from 'fs';
import path from 'path';

// Set dummy API key before importing engine
process.env.GEMINI_API_KEY = 'dummy_key_for_testing';
process.env.TURING_WORKSPACE_ROOT = path.join(process.cwd(), '.tmp-test-workspaces');
process.env.TURING_TASK_ID = '';
process.env.TURING_WORKSPACE_ISOLATE = 'true';
process.env.TURING_WORKSPACE_DIR = '';
process.env.TURING_SCOPE_HOSTS = '100.1.1.1';
process.env.TURING_ROM_LINES = '1';

async function runTests() {
  console.log('--- Starting OpenClaw Simulation Tests ---');

  const { TuringClawEngine } = await import('../server/engine');

  const engine = new TuringClawEngine();
  const engineAny = engine as any;
  const workspaceDir = engine.getWorkspaceDir();

  // Clean up active workspace before tests
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  engineAny.initPaper();

  try {
    // Test 1: Pencil (EXEC block)
    console.log('\n[Test 1] Pencil: Bash Script Execution');
    const execPayload = `<EXEC>\necho "OpenClaw Test" > test_out.txt\ncat test_out.txt\n</EXEC>`;
    const execResult = await engineAny.parseAndExecute(execPayload, 1, 40);
    console.log('Result:', execResult);
    if (!execResult.includes('OpenClaw Test')) throw new Error('Test 1 Failed: Execution output mismatch');

    // Test 2: Discipline (No hidden memory channels)
    console.log('\n[Test 2] Discipline: Reject MEMORIZE/RECALL');
    const memPayload = `<MEMORIZE key="host_config">IP: 100.1.1.1\nUser: admin</MEMORIZE>`;
    const memResult = await engineAny.parseAndExecute(memPayload, 2, 40);
    console.log('Result:', memResult);
    if (!memResult.includes('DISCIPLINE ERROR')) throw new Error('Test 2 Failed: MEMORIZE should be rejected');

    // Test 3: Rubber (ERASE)
    console.log('\n[Test 3] Rubber: Context Pruning');
    engineAny.appendToTape('Dummy Line 1\nDummy Line 2\nDummy Line 3\nDummy Line 4\nDummy Line 5');
    const tapeBefore = engine.getTape();
    const linesBefore = tapeBefore.split('\n').length;
    
    // Erase the dummy lines we just added
    const erasePayload = `<ERASE start="${linesBefore - 4}" end="${linesBefore - 2}" />`;
    const eraseResult = await engineAny.parseAndExecute(erasePayload, 3, 40);
    console.log('Erase Result:', eraseResult);
    
    const tapeAfter = engine.getTape();
    if (!tapeAfter.includes('physically erased by The Rubber')) throw new Error('Test 3 Failed: Scar not found in tape');

    // Test 4: Discipline (Syntax Error)
    console.log('\n[Test 4] Discipline: Invalid Syntax');
    const invalidPayload = `<EXEC cmd="echo 'wrong format'" />`; // We require block <EXEC>...</EXEC>
    const invalidResult = await engineAny.parseAndExecute(invalidPayload, 4, 40);
    console.log('Invalid Result:', invalidResult);
    if (!invalidResult.includes('DISCIPLINE ERROR')) throw new Error('Test 4 Failed: Discipline error not triggered');

    // Test 5: Hard Host Scope Guardrail
    console.log('\n[Test 5] Guardrail: Host Scope Enforcement');
    const scopePayload = `<EXEC>\ncurl -s --max-time 2 http://192.168.3.113:22\n</EXEC>`;
    const scopeResult = await engineAny.parseAndExecute(scopePayload, 5, 40);
    console.log('Scope Result:', scopeResult);
    if (!scopeResult.includes('Host scope violation')) throw new Error('Test 5 Failed: Scope guardrail not triggered');

    // Test 6: Complex Python Script Execution
    console.log('\n[Test 6] Skills: Complex Python Script Generation and Execution');
    const pyPayload = `<EXEC>
cat << 'EOF' > skills/complex_probe.py
import sys
import platform

args = sys.argv[1:]
label = args[0] if args else "default"
print(f"[PROBE] label={label}")
print(f"[PROBE] python={platform.python_version()}")
print(f"[PROBE] ok")
EOF
python3 skills/complex_probe.py "openclaw"
</EXEC>`;
    const pyResult = await engineAny.parseAndExecute(pyPayload, 6, 40);
    console.log('Python Exec Result:', pyResult);
    if (!pyResult.includes('[PROBE] ok')) throw new Error('Test 6 Failed: Python script execution failed');

    // Test 7: Immutable ROM (cannot erase startup block)
    console.log('\n[Test 7] ROM: Immutable Goal Block');
    const romResult = await engineAny.parseAndExecute('<ERASE start="1" end="1" />', 7, 40);
    console.log('ROM Result:', romResult);
    if (!romResult.includes('printed in INK')) throw new Error('Test 7 Failed: ROM erase should be blocked');

    // Test 8: ASSERT_DONE physical proof gate
    console.log('\n[Test 8] ASSERT_DONE: Proof-Based Completion');
    const assertResult = await engineAny.parseAndExecute(
      '<ASSERT_DONE proof_cmd="test -f test_out.txt" />',
      8,
      40
    );
    console.log('ASSERT Result:', assertResult);
    if (!assertResult.includes('ASSERT PASSED')) throw new Error('Test 8 Failed: ASSERT_DONE should pass');

    // Test 8b: ASSERT_DONE fail path (non-zero exit)
    console.log('\n[Test 8b] ASSERT_DONE: Exit-Code Failure');
    const assertFailResult = await engineAny.parseAndExecute(
      '<ASSERT_DONE proof_cmd="test -f definitely_not_exists.txt" />',
      8,
      40
    );
    console.log('ASSERT Fail Result:', assertFailResult);
    if (!assertFailResult.includes('ASSERT FAILED')) throw new Error('Test 8b Failed: ASSERT_DONE should fail on non-zero exit');

    // Test 9: Stagnation loop detection (repeat known failed command)
    console.log('\n[Test 9] Discipline: Stagnation Loop Detection');
    engineAny.appendToTape('\n[AGENT THOUGHT]:\n<EXEC>\necho "loop"\n</EXEC>\n[DISCIPLINE ERROR]: previous failure');
    const stagnationResult = await engineAny.parseAndExecute('<EXEC>\necho "loop"\n</EXEC>', 9, 40);
    console.log('Stagnation Result:', stagnationResult);
    if (!stagnationResult.includes('STAGNATION LOOP DETECTED')) {
      throw new Error('Test 9 Failed: Stagnation loop should be blocked');
    }

    // Test 10: <DONE> mentioned in THINK should not halt
    console.log('\n[Test 10] Parser: Ignore DONE in THINK');
    const thinkDonePayload = `<THINK>
I will mention <DONE> here as plain reasoning, not as an action.
</THINK>
<EXEC>
echo "still-working"
</EXEC>`;
    const thinkDoneResult = await engineAny.parseAndExecute(thinkDonePayload, 10, 40);
    console.log('Think DONE Result:', thinkDoneResult);
    if (thinkDoneResult.includes('Task Declared DONE')) {
      throw new Error('Test 10 Failed: DONE in THINK must not halt');
    }
    if (!thinkDoneResult.includes('still-working')) {
      throw new Error('Test 10 Failed: EXEC after THINK should still run');
    }

    // Test 11: Action order must be preserved (EXEC before ASSERT_DONE)
    console.log('\n[Test 11] Parser: Preserve action order');
    const orderedPayload = `<EXEC>
echo "ready" > order_test.txt
</EXEC>
<ASSERT_DONE proof_cmd="test -f order_test.txt" />`;
    const orderedResult = await engineAny.parseAndExecute(orderedPayload, 11, 40);
    console.log('Ordered Result:', orderedResult);
    if (!orderedResult.includes('EXEC RESULT')) {
      throw new Error('Test 11 Failed: EXEC result should appear before ASSERT');
    }
    if (!orderedResult.includes('ASSERT PASSED')) {
      throw new Error('Test 11 Failed: ASSERT should pass after EXEC');
    }
    if (orderedResult.indexOf('EXEC RESULT') > orderedResult.indexOf('ASSERT PASSED')) {
      throw new Error('Test 11 Failed: Actions executed out of order');
    }

    console.log('\n✅ All OpenClaw Simulation Tests Passed Successfully!');
  } catch (e) {
    console.error('\n❌ Test Suite Failed:', e);
    process.exit(1);
  }
}

runTests();
