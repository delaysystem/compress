# Run report 012 — IR pilot v3: stratified grounded rerun passes floor

Date: 2026-11-11. Scope: run 011's required rerun (stratified domains,
answerable-only, n≥100 measurable target).
Verdict: grounded recall 0.763 over 92 measurable PASSES the 0.70 interim
floor (now confirmed permanent). Adjudication shows true fidelity higher
(artifacts dominate misses) BUT evidences one safety-relevant failure
mode — ungrounded phone-number emission — that adds a grounding-
entailment requirement to the plan before any Phase 2 spend.

## Run

- 100 samples, round-robin 25 × dmv/ssa/studentaid/va (yields 146/165/
  48/130 measurable; studentaid thin but filled, no silent shrink).
  Answerable-only filter: question-form + ≥1 measurable entity via the
  real groundedRecall denominator. Lite-only: flagship quota flapped
  (smoke 4/4 OK, then 429 wall wedged the first launch at 11 rows/hour
  burning 21-min backoff budgets per overlap sample; killed cleanly,
  relaunched --skip-flagship, overlap reproducible later by key).
- n=100 errors=1 (503 high-demand, environmental) punts=7 (down from
  13: filter killed fragment-artifacts). Scored with current extractor
  (marker fix in place): summary authoritative, no rescore needed.
- lite: recall 0.763, recallN=92 (all rows measurable by construction).
  Ratio p50 0.56 remains a task artifact, not a result (established v2).

## Adjudication (10/24 miss rows + 7/7 punts + 4 grounding greps)

- Metric/corpus artifacts (5): "healt0h" typo-zero (model fixed the
  typo, got penalized); date year-split on corpus "1 , 1912" spacing
  (model reproduced dates exactly); "$ 17,500" vs "$17,500" currency-
  spacing split (amount reproduced exactly); "[ 2 ]" citation marker
  (annotation noise, correctly dropped). Follow-up: whitespace-
  tolerant year/currency attachment in DATE_RE/NUMBER_RE (measurement
  accuracy; validator unaffected in practice).
- Different-valid-move (3): passport-focused answer vs exhaustive doc
  list (also exposes N-560 prefix loss in NUMBER_RE — identifier
  coverage follow-up); formula stated, illustrative example
  generalized; scope-vs-fees repeats v2.
- Real drops (2 + 1 partial): "100% accuracy" disclaimer dropped
  (minor); "recorded before age 5" condition dropped (material);
  VA Form 22-1995 dropped while 22-5495 kept (context-ambiguous —
  history suggests dependent flow; minor/partial).
- SERIOUS: ungrounded phone numbers on "Where can i get more
  information?" — IR emitted 877-327-0022 / 800-983-0937 /
  844-698-2311, all ABSENT from its grounding (verified), while
  dropping the grounded 877-424-3838. Training-data recitation or
  hallucination — indistinguishable and equally non-compliant. The
  expansion validator CANNOT catch this (it checks IR↔output, never
  grounding): Phase 2 now requires a grounding-entailment check on
  sampled turns (PLAN.md gate added). List-expansion answers are the
  risk pattern.
- Punts: all 7 on genuine questions (filter worked; 1 borderline
  conversational); 2 answers verified present in docs (inspection
  fine $50/100, Direct Express hotline) — timid, same signature as
  v2. Chart-question pattern not re-isolated (broader timidity).

## Gate changes (PLAN.md Step 5)

- Grounded floor 0.70 CONFIRMED permanent (observed 0.763 lower bound,
  n=92, artifacts inflate misses). Compress floor ≥0.95 unchanged.
- NEW precondition: grounding-entailment sampling before Phase 2
  (evidenced ungrounded emission above).
- Overlap arm still pending (flagship quota); lite-only verdict stands.

## Runner findings (follow-ups, v3 frozen during campaign)

- No fetch timeout in GeminiClient (hung-request risk); no
  consecutive-backpressure fail-fast (dead quota crawls instead of
  failing loudly). Both recorded for the next campaign.

## Files

- data/derived/ir-pilot-v3.jsonl + ir-pilot-v3-summary.json
  (AUTHORITATIVE). worker/scripts/ir-pilot-v3.ts (new; v1/v2 frozen).

## Gates

- typecheck 0, lint 0, 164 unit + 7 pool (no product-code change;
  runner covered by typecheck+lint). Only free APIs; values never logged.
