# Run report 010 — IR-emission pilot v1: invalid design, evidence, v2 corrective

Date: 2026-11-11. Scope: PLAN.md Step 5 precondition, first attempt.
Verdict: v1 measured the wrong thing; its numbers must not be quoted as
results. The harness is proven; v2 (grounded, two-arm) launched on the fix.

## What v1 did

- 200 Bitext instructions -> minimal IR via pinned prompt v0, lite-only
  (flagship arm parked: 429 quota wall, 21 backpressure trips survived by
  classified retries + global pacers). n=200 errors=0, crash-safe JSONL.
- Reported: lite p50 ratio 12.67, mean 15.88, set-recall 0.225; number
  recall 0.007, placeholder recall 0.203. Artifacts frozen as the
  invalid-design record: worker/scripts/ir-pilot.ts,
  data/derived/ir-pilot.jsonl + ir-pilot-summary.json.

## Why v1 is invalid (evidence, not suspicion)

- Design flaw: the model answered from the question ALONE (no grounding),
  so "recall vs reference" measured from-scratch answer overlap, not
  compression fidelity, and "ratio" measured terse-answering, not
  compression. The runner header called this an approximation; spot-checks
  proved it a corruption.
- Hallucinations from ungrounded answering: IR invented `legal@company.com`
  + street address (idx 7450) and invoice `#85632` (idx 15158) where the
  reference held only `{{placeholders}}`. A grounded compressor cannot do
  this; an ungrounded answerer must.
- Content-dropping, not compression: reference asks the user for tracking/
  order numbers -> IR "Check delivery time" (idx 13244); 5-step guide ->
  "viewable at account settings" (idx 6854). The 12.67x ratio is dominated
  by dropping the answer. Ratio-alone is gameable: PLAN.md Step 5 gate
  amended (recall floor required; threshold pinned from v2 data).
- Measurement artifact (separate, real): 300/302 number "misses" are
  ordered-list markers (1-7 only); ZERO real-number drops observed. Model
  correctly drops numerals; fluent expansion re-adds them. Consequence:
  list-marker numerals must be excluded from entity extraction (validator
  would false-fail re-numbered lists). PENDING implementation (recorded
  here; lands before v2 analysis so v2 can be rescored offline).

## v2 corrective (launched)

- Two arms: compress (Bitext reference -> IR, pure compression, prompt
  ir-emit-v1.md = v0 + placeholder-exactness rule) and grounded
  (MultiDoc2Dial history + referenced doc spans -> IR, production analog,
  prompt ir-grounded-v1.md with licensed punt `insufficient grounding`).
- Metric fix: grounded recall over reference-meets-grounding measurable
  entities (src/ireval.ts groundedRecall/scoreGroundedSample; recallByClass
  takes optional grounding). Punts counted, never scored.
- Smoke (2/arm, same samples before/after): compress recall 1.000 with
  `{{markers}}` preserved exactly; grounded punt 1 -> 0 after licensing
  paraphrase/combine in rule 3 (pre-measurement revision, documented;
  smoke rows discarded). Grounded ratio reads low (~0.5) when references
  are short follow-up questions vs full-answer IRs: ratio sensitivity
  split moves to analysis (rows carry reference + tokens; no runner
  change). Grounded recall is a lower bound (model may take a different
  valid conversational move); spot-check adjudicates.
- Full run: 200 compress + 100 grounded, lite-only (--skip-flagship),
  ~600 calls. v1 files untouched.

## Files created/changed

- worker/prompts/ir-emit-v1.md, ir-grounded-v1.md (pinned; rule-3
  revision pre-full-run).
- worker/src/ireval.ts: groundedRecall, scoreGroundedSample, recallByClass
  ground param. worker/scripts/ir-pilot-v2.ts (new; v1 frozen).
- worker/test/ireval.test.ts: 6 new cases (intersection scoring,
  ungrounded exclusion, null edge, reduction equivalence, class totals).
- Per durable-test-collateral: focused suite first (15/15), then broad.

## Gates

- typecheck 0, lint 0 (duplicate-describe + format findings fixed via
  safe fixes), 158 unit + 7 pool tests green at v2 launch.
- Only free Gemini APIs touched; values never logged.
