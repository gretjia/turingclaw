#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./turing_prompt.sh "Your natural language request""
  exit 1
fi

REQUEST="$1"

SYSTEM_PROMPT="You are the TuringClaw Prompt Compiler. Your job is to translate a user's casual, natural language request into a strict 'TuringClaw Tape Prompt' that the TuringClaw $\delta$ transition engine can digest. 

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
${REQUEST}

Rewrite this request into the strict TuringClaw Tape Prompt format now."

kimi -y --quiet -p "$SYSTEM_PROMPT"
