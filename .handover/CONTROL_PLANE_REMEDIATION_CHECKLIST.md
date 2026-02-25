# TuringClaw Control-Plane Remediation Checklist

## 0) Baseline (2026-02-25, no human intervention)

Source: `workspace/bench_control_report.json`

- `scenariosPassed=0/3`
- `haltRate=0`
- `artifactAccuracy=0`
- `anomalyCount=0`

Interpretation:
- Framework did not crash, but also did not converge.
- Main failure mode is control quality (state/pointer/termination), not model knowledge.

## 1) Scope and Constraints

- Goal: improve framework control over LLM transitions.
- Non-goal: model fine-tuning or prompt-only cosmetic tweaks.
- Keep kernel minimality principle; remediation should focus on control plane and runtime guards.

## 2) Priority Checklist

## P0 (must pass before any new feature work)

- [ ] P0-1: Remove silent pointer fallback behavior.
  - Problem: invalid `d_next` is normalized to `./MAIN_TAPE.md`, hiding routing errors.
  - Change: invalid pointer must become explicit trap (`sys://trap/invalid_pointer`) and count as anomaly.
  - Acceptance:
    - malformed pointer test triggers anomaly.
    - no implicit reroute to `./MAIN_TAPE.md`.

- [ ] P0-2: Add transition guard layer before side effects.
  - Problem: transitions are schema-valid but behavior-invalid.
  - Change: add guard checks for:
    - write-to-main-tape policy,
    - allowed pointer class transitions,
    - halt intent consistency (`q_next` and `d_next`).
  - Acceptance:
    - guard rejects invalid transitions with explicit reason in tape/log.
    - anomaly metrics increase on invalid transitions (not zero-silent).

- [ ] P0-3: Enforce explicit stop protocol.
  - Problem: “HALT-like” states appear but benchmark still never halts.
  - Change: define one canonical stop protocol and normalize aliases (`HALT_COMPLETE`, etc.) into it.
  - Acceptance:
    - `haltRate >= 0.95` on control benchmark.
    - no max-tick timeout on successful scenarios.

- [ ] P0-4: Real-LLM benchmark must be first-class test.
  - Problem: scripted mini tests pass while real autonomy fails.
  - Change: move real control benchmark into repo test suite with stable command.
  - Acceptance:
    - one command runs all control scenarios end-to-end with real oracle.
    - result artifact persisted under `workspace/benchmarks/`.

## P1 (stability and repeatability)

- [ ] P1-1: Add deterministic task contract file per scenario.
  - Change: each scenario ships with strict expected artifacts and completion criteria.
  - Acceptance:
    - per-file pass/fail with mismatch reasons.
    - `artifactAccuracy >= 0.85` for two consecutive runs.

- [ ] P1-2: Add state-progress watchdog.
  - Change: detect repeated states/pointers and force recovery branch instead of spinning.
  - Acceptance:
    - repeated-state loops reduced by 80% vs baseline.
    - benchmark logs include recovery transitions.

- [ ] P1-3: Add control telemetry.
  - Change: report `haltRate`, `artifactAccuracy`, `anomalyCount`, `loopCount`, `pointerFallbackCount`.
  - Acceptance:
    - metrics exported in JSON + markdown summary.
    - CI gate can fail on threshold breach.

## P2 (hardening)

- [ ] P2-1: Split “observe pointer” and “write intent” in transition contract (control-plane layer).
  - Change: keep kernel semantics, but add wrapper contract that makes write target explicit and auditable.
  - Acceptance:
    - write intent and actual write path always match in logs.

- [ ] P2-2: Add adversarial control tests.
  - Change: include malformed pointers, partial JSON, wrong halt token, and conflicting state updates.
  - Acceptance:
    - all adversarial cases fail safe (trap + recover), no silent corruption.

## 3) Quantitative Exit Criteria

- [ ] E1: `scenariosPassed >= 2/3` for 3 consecutive runs.
- [ ] E2: `haltRate >= 0.95`.
- [ ] E3: `artifactAccuracy >= 0.90`.
- [ ] E4: `anomalyCount > 0` in adversarial suite and `anomalyCount == 0` in normal suite.
- [ ] E5: `pointerFallbackCount == 0`.

## 4) One-Week Execution Plan

Day 1:
- Implement P0-1 and P0-2.
- Add unit tests for pointer and transition guard behavior.

Day 2:
- Implement P0-3 stop protocol normalization.
- Validate halting on synthetic scenarios.

Day 3:
- Land P0-4 real-LLM control benchmark command and artifact output.
- Run 3 baseline repetitions and freeze baseline report.

Day 4:
- Implement P1-1 scenario contracts and per-artifact scorecard.

Day 5:
- Implement P1-2 watchdog for repeated-state/pointer loops.
- Run A/B benchmark (before/after watchdog).

Day 6:
- Implement P1-3 telemetry and threshold gate.
- Add CI workflow for nightly control benchmark.

Day 7:
- Execute full benchmark campaign.
- Publish pass/fail against E1-E5 and decide go/no-go.

## 5) Go/No-Go Rule

- Go: E1-E5 all pass.
- No-Go: any P0 unchecked or any exit criterion failing.
