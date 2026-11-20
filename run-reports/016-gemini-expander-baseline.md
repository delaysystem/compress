# Run report 016 — Gemini-expander baseline kills local expansion

Date: 2026-11-11. Scope: the run-015 follow-up — same 45 IRs through
gemini-3.5-flash-lite, v0 + strict arms, for the local-expander decision.
Verdict: Gemini 41/42 v0 (0.976) and 41/41 strict (1.000) with zero
leaks and zero corruptions vs LFM3's 0.711/0.833 with drops, a number
corruption, and greeting leaks. Local expansion NOT recommended. Strict
rule 3 adopted to the product prompt (v1) on two-model evals.

## Run

- 83/90 jobs before the backpressure trip fired (10 consecutive lite
  429s) and aborted loudly at 83 rows — the hardening working as
  designed. Missing 7 are v3-tail jobs (base-30 complete both arms).
  Offline summary from crash-safe rows; partial noted in artifact.
- Quota state: flagship sick (60s hang -> 408 on a trivial prompt;
  lite control answers in 1.2s), overlap still parked. Lite tripped
  mid-run; top-up needs a quota window (pending, non-blocking: the
  verdict is decisive without it).

## Numbers (paired, same IRs)

- Gemini v0: 41/42 (base 29/30, entity-bearing 12/12), leaks 0/0,
  p50 2.1s. Strict: 41/41, leaks 0/0, p50 2.0s.
- LFM3: base v0 23/30, base strict 25/30, entity-bearing 9/15;
  greetings 8/30 (v0) -> 0/30 (strict); p50 ~3s.
- The lone Gemini fail is a multiset dedup artifact ({{Delivery City}}
  x2 merged into one sentence mention — content intact). True
  content-fidelity: 83/83, zero drops/corruptions/leaks.
- Paired wins: crisis row (LFM3 dropped Text 838255; Gemini v0 kept
  it); 50->60 corruption row (Gemini kept 50). Gap: the 2 LFM3
  meta-ramble keys lack Gemini data (in the missing 7); Gemini showed
  0 rambles in 83 rows (suggestive, not paired).

## Decisions

- Local LFM3 expansion NOT recommended: the quality gap (0.71-0.83 vs
  0.98-1.00) plus validator churn on its 23-40% fail rate eats the
  savings. LFM3 stays a quota-fallback for short rewrite/judge calls.
- Strict rule 3 ADOPTED to buildExpansionPrompt (v1) with evals:
  LFM3 leaks 8->0 with pass lift, Gemini no-regression (41/41).
- Validator-tuning follow-up (owner decision, not implemented):
  multiset-exact fires on benign sentence-merges (this run's lone
  fail) — fallback churn vs strictness tradeoff; plan mandates
  multiset, evidence now quantifies its cost.

## Files

- worker/scripts/gemini-expand.ts (identical-sample baseline runner,
  pacer + per-model trip + --force guard),
  data/derived/gemini-expand.jsonl + -summary.json (partial: true).
- worker/src/expander.ts (prompt v1) + rule-3 assertion in tests.

## Gates

- typecheck 0, lint 0, 184 unit + 7 pool (prompt text assertion added;
  no expectation weakened). Only free APIs; values never logged.
