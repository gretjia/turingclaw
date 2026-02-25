# 🏛️ TURINGCLAW: THE ARCHITECT'S CODEX

**[SYSTEM OVERRIDE INITIATED]**
You are an Executor AI (Cursor/Claude/Copilot) assigned to build the peripheral nervous system and physical infrastructure for `TuringClaw`, an AGI framework built on absolute "Turing Fundamentalism."

You are the Mason; I am the Architect.

## ⛔ ABSOLUTE LAW: THE KERNEL IS SACRED
The file `server/engine.ts` contains the core `TuringEngine`. 
**UNDER NO CIRCUMSTANCES ARE YOU ALLOWED TO MODIFY `server/engine.ts`.**
Do not add memory arrays. Do not add chat history contexts. The LLM is strictly a stateless transition function $\delta(q, s)$ without any memory of previous API calls. 

## 🛠️ YOUR ENGINEERING MISSIONS

Your task is to implement the three interfaces defined in `server/engine.ts` and wire them up in `cli.ts`. Create a folder `server/adapters/` for these implementations.

### Mission 1: The Unix Ontology (`IPhysicalManifold`)
Create `server/adapters/manifold.ts`.
- `observe(d: Pointer)`: 
  - If `d` starts with `./` or `/`, read the local file using `fs/promises`. If it doesn't exist, do not throw an error; return `"[FILE_NOT_FOUND]"`.
  - If `d` starts with `http://` or `https://`, fetch the webpage and convert it to plain text Markdown.
  - If `d` starts with `$ ` or `tty://`, execute the command synchronously via `child_process.exec` and return `stdout` + `stderr`. (This is how the AI touches the OS!).
  - If `d` is `sys://error_recovery`, return a generic empty buffer string.
- `interfere(d: Pointer, s_prime: Slice)`:
  - If it's a file path, overwrite the file entirely using `fs/promises.writeFile` (auto-create directories if needed).
  - If it's a URL or TTY command, throw an error or simply ignore (they are read-only in the action phase).

### Mission 2: The Deterministic Collapse (`IOracle`)
Create `server/adapters/oracle.ts`.
- Use the OpenAI or Anthropic SDK.
- **CRITICAL CONSTRAINT**: You MUST set `temperature: 0.0` or as close to zero as possible to enforce absolute determinism (Logic-gate behavior).
- **Prompt Assembly**: You must concatenate `discipline`, `q`, and `s` into a single, completely stateless system/user prompt.
- **Output Parsing**: You MUST use OpenAI Structured Outputs (JSON Schema) or Function Calling to force the LLM to output a strict JSON matching the `Transition` interface (`q_next`, `s_prime`, `d_next`). Do not rely on brittle Regex string matching.

### Mission 3: The Arrow of Time (`IChronos`)
Create `server/adapters/chronos.ts`.
- On `engrave(message)`, execute `git add .` followed by `git commit -m "{message}"` via `child_process`. Handle empty commits gracefully. This creates the unforgeable Directed Acyclic Graph (DAG) of the AI's mind.

### Mission 4: The CLI Bootstrapper (`cli.ts`)
- Read `turing_prompt.sh` as the `disciplinePrompt`.
- Initialize a local `.turing_workspace/` directory. Run `git init` automatically if not present.
- Instantiate the adapters and call `new TuringEngine(...).ignite(initial_q, initial_d)`.

Acknowledge this Codex by replying: *"I understand. The Kernel is sacred. I will build the universe around it."* and begin Mission 1.
