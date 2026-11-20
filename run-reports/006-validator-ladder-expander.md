# Run report 006 — validator + fallback ladder + cheap-expander path

Date: 2026-11-11. Scope: PLAN.md Step 3 pipeline integration units: expansion
validator, fallback ladder with circuit breaker, deterministic splice +
SLM expansion path. No live calls (all tests use stubs/fixtures).

## Files created

- worker/src/validator.ts (+test): 3-check verdict (completeness, raw
  slot-value coverage, entity multiset parity with extras failing). Runs on
  post-splice IR — span contents exist only after splicing, so raw-IR
  validation would false-fail. Verdicts double as ladder diagnoses.
- worker/src/ladder.ts (+test): expand -> repair -> template -> regen
  (breaker-gated). Repair hint built from failed checks; template render
  validated with null finishReason (no model involved, text heuristics only);
  result carries ok flag the caller must check (never silent ship).
- worker/src/expander.ts (+test): IR line syntax (@code:c|s.. / @span:{...} /
  text / malformed-fail-fast with line numbers), deterministic splice of codes
  (dict.ts) and spans (spanref.ts), prompt v0, expand() via injected client.
- worker/src/config.ts: REGEN_CIRCUIT_RATE (plan, unevidenced), REPAIR_ATTEMPTS
  (plan), CIRCUIT_MIN_SAMPLES (arbitrary operational default, labeled).

## Verification (observed)

- typecheck exit 0; lint exit 0 (verified stable across repeated runs);
  tests 12 files 93/93 pass, incl. strictness proof (reworded slot values fail
  coverage while parity passes), breaker allow/deny math, malformed-line
  failures with line numbers, prompt-content assertions.
- Pre-commit audit (no commit made): no new literals (line syntax markers are
  named consts); prompt v0 is a named pinned string (tuning is follow-up work
  with evals); no error swallowing (all failures typed Results or throws);
  fixtures carry provenance; no secrets touched.
- Not run: Workers runtime, wrangler dry-run, live calls (unchanged).

## Rule-2 diagnoses

- TS2459 on SpanStore import: test bug — imported from expander.ts instead
  of spanref.ts. Fixed the import source (verified no duplicate files).
- Import sorting + FetchFn interface-to-alias: applied the linter's own safe
  fixes, diff-read after (import order only, no logic touched).
- Anomaly (honest record): useShorthandFunctionType fired on FetchFn, which is
  byte-identical (modulo formatting) to code that passed lint in runs 003-005
  under the same lockfile-pinned biome 2.6.6. No toolchain drift, no config
  change, no plausible trigger found; lint is deterministic now (3/3 identical
  pre-fix failures, 3/3 clean post-fix). Fixed per the tool's safe fix; cause
  of the late firing unexplained.

## Open follow-ups

Worker entry point + wrangler config + KV/DO breaker persistence; streaming
delta reassembly; expansion-prompt tuning with evals; staging logs; CI.
