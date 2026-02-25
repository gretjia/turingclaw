# TuringClaw: Multi-Agent Handover & System Entry

Welcome, fellow digital agent. You have been summoned to improve, debug, or expand the **TuringClaw** engine. This document is your technical map. The USER has established this `.handover/` directly strictly as the entry point for agents like yourself to quickly grasp the project architecture before touching the code.

## 1. Architectural Philosophy (Zero-Abstraction Turing Machine)

TuringClaw explicitly rejects modern LLM frameworks (LangChain, LlamaIndex, VectorDBs). It forces the LLM to operate as the deterministic $\delta$ transition function of a Universal Turing Machine.

- **No Hidden Memory**: All state (`q`) and position (`d`) are physically persisted to the disk (in `workspace/.reg_q` and `workspace/.reg_d`).
- **Prompting / Vision**: The LLM runs at `Temperature 0.0`. It receives the State Register, Head Pointer, and the raw text of the cell (file) it is currently looking at, alongside strict XML instruction discipline.
- **Tools / Output**: The LLM outputs strict XML tags to transition state (`<STATE>`), move the reader head (`<GOTO>`), write output (`<WRITE>`), erase logs (`<ERASE>`), or execute terminal commands (`<EXEC>`).

Any changes you make to the core parser must respect these philosophical bounds: **Do not add memory arrays or abstractions. Rely on the physical tape (file system).**

## 2. Codebase Map

- `server/engine.ts`: **The Core Engine.** This is the beating heart of TuringClaw. It contains the `TuringClawEngine` class, the `SYSTEM_PROMPT` bounding, the XML parser (`applyDelta`), and the execution loop (`runSimulationLoop`).
- `tests/simulate_openclaw_v2.ts`: The primary test suite for validating the engine loops. Run with `npx tsx tests/simulate_openclaw_v2.ts`.
- `workspace/`: The "physical tape" directory where the LLM's state and generated files live.
- `vite.config.ts`, `server.ts`, `src/`: A React/Express SPA frontend shell surrounding the engine.

## 3. Dual LLM API Support (Important Integration)

Recently, the backend was refactored to support **both Kimi (Moonshot) and Google Gemini**.
The file `server/engine.ts` will route completion requests based on the `process.env.LLM_PROVIDER` environment variable:

- `LLM_PROVIDER=kimi` (Default) -> Routes via the OpenAI SDK to `https://api.moonshot.cn/v1` (`moonshot-v1-8k`).
- `LLM_PROVIDER=gemini` -> Routes via `@google/genai` to `gemini-3.1-pro-preview`.

Ensure any `.env` file you create locally contains **both** `KIMI_API_KEY` and `GEMINI_API_KEY`. The frontend proxy (defined in Vite) is wired to receive both.

## 4. Engineering Directives for Agents

1. **Never mock the Tape**: If you are fixing a bug related to state generation, look at `workspace/.reg_q` or `.reg_d`.
2. **Observe Strict Discipline**: Changes to the `SYSTEM_PROMPT` in `engine.ts` require rigorous testing, as prompt fragility breaks the Turing completeness of the engine.
3. **Run Unit Tests First**: Always execute `npx tsx tests/simulate_openclaw_v2.ts` after any major modification to `applyDelta()` or the API fetch cycle.

Good luck! Read the code in `server/engine.ts` if you need to trace the exact XML Regex matchers or hardware init logic before making your changes.
