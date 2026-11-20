# Run report 011 — IR pilot v2: grounded results, rescore, gate pins

Date: 2026-11-11. Scope: PLAN.md Step 5 precondition, corrective rerun.
Verdict: model-emitted IR passes the ratio gate with wide margin
(compress p50 4.51x, min 1.82, 0/200 below 1.8x) and shows near-perfect
entity fidelity on pure compression (grounded recall 0.978, numbers
15/15). Grounded joint answer+compress is promising but thin
(0.800 lower bound, n=15) with a timid-punt pattern on chart questions.
Thresholds pinned below; one stratified rerun required before Phase 2.

## Run

- 200 compress + 100 grounded, lite-only, prompts v1, n=300 errors=1
  (one grounded 429 after retries exhausted; within budget).
- Raw summary (old extractor): compress recall 0.615, grounded 0.800.
- Rescore with list-marker exclusion, zero new API calls
  (scripts/rescore-v2.ts; grounding reassembled from corpus by key with
  per-row word-count assert, 86/86 passed): compress recall 0.978.

## Compress arm (pure compression; the clean number)

- Ratio: p10 3.14, p25 3.67, p50 4.51, mean 4.90, min 1.82. Gate p50
  ≥1.8x PASSES; p25 floor 3.67 published. Far above the ~2.2x
  hand-authored reference point: Bitext replies are boilerplate-heavy
  and the model compresses them aggressively AND faithfully.
- Recall 0.978 over 91 measurable (19 refs measurable-only-via-markers
  correctly excluded post-fix). Numbers 15/15 = 1.000. Placeholders
  175/177 verbatim; the 2 misses strip `{{}}` braces but keep the words
  ("Account Category account for wife") — semantic 177/177, a
  synthetic-marker artifact with no production analog (1.1%
  instruction-following noise on markers).
- Zero punts, zero empties, zero errors.

## Grounded arm (production analog; lower bound, thin, dmv-only)

- Recall 0.800 over 15 measurable (86 scored). All 4 misses adjudicated
  different-valid-move, not drops: scope-vs-fees (#10), answer-vs-
  clarifying-question (#1), mail-steps-vs-deadline-warning (#11). No
  observed entity drop where moves align.
- 13 punts: ~6 fragment-artifacts (message was "not" / "No, I don't" /
  conversation over — nothing to answer) + ~7 timid on genuine
  questions with answers verified present in docs, including 2+ chart/
  table questions (county tax charts). Chart-grounding looks
  systematically hard for the lite model — follow-up, not verdict.
- Ratio p50 0.33 is a task artifact (references are short follow-up
  nudges, IRs are full answers; substantive-ref subset still 0.56):
  NOT a compression result. Design lesson recorded.
- Sampling flaw: sorted-domain order never left dmv — all 100 rows
  dmv, ssa/va/studentaid unmeasured. Next run stratifies round-robin.
- Stale-question wart: consecutive agent turns reuse one user message;
  answerable-only subsetting recommended next time.

## Gate pins (PLAN.md Step 5 amendment of run 010, now numeric)

- Compress-arm grounded recall floor ≥0.95 (observed 0.978, n=91).
- Grounded-arm interim floor 0.70, LOW CONFIDENCE (n=15, dmv-only,
  lower-bound metric): requires stratified rerun (round-robin domains,
  answerable-only subset, n≥100 measurable) before any Phase 2 spend.
- Ratio gate PASSES (p50 4.51 ≥ 1.8, p25 floor 3.67, min 1.82).
- Flagship overlap arm still pending (quota); lite-only verdict stands.

## Files

- data/derived/ir-pilot-v2.jsonl (frozen run output) +
  ir-pilot-v2-summary.json (raw, old extractor — superseded for recall)
  + ir-pilot-v2-rescored.json (AUTHORITATIVE: current extractor).
- worker/scripts/rescore-v2.ts (offline rescore; runner untouched).
- Spot-check evidence: 5 miss rows + 4 punts + doc verifications above.

## Gates

- typecheck 0, lint 0, 164 unit + 7 pool (no product-code change since
  run 010's fix; rescore script covered by typecheck+lint).
- Only free Gemini APIs touched; values never logged.
