# Run report 017 — LFM3-as-flagship formal run: 0/25 valid IRs

Date: 2026-11-11. Scope: owner instruction "lfm as flagship", clarified
to the measurement reading (stand-in, not product wiring): the 25-row
overlap subset through scripts/lfm3-emit.ts under identical conditions
(grounded prompt v1, temp 0, cap 256, server --reasoning off).
Verdict: LFM3 cannot emit IR — 0/25 valid outputs, all non-convergent
thinking rambles. The nominal 0.453 recall is a thinking-quote artifact
and must never be quoted.

## Numbers

- n=25 errors=0 punts=0. 25/25 outputs contain `<think>`, 0/25 contain
  `</think>`; irTokens 256/256 on every row (all cut mid-thought).
- Nominal recall 0.453 (11 rows 1.0, 1 row 0.33, 13 rows 0.0) measures
  entity quotes inside deliberation traces, not IR fidelity. TRUE
  emitter recall: 0. Ratio p50 0.12 likewise meaningless (traces are
  longer than references). wallP50 19.5s (prompt-bound, KV-cached).
- Tier-1: 4 fails, all correct flags on thinking text — including 3x
  `date:2026-11-11`, the model injecting today's date into its
  deliberation. The screen works; the generator does not converge.

## Standing decisions (owner, this session)

- LFM3 role: measurement stand-in only. No product flagship wiring.
- Quality bar for any future product use: accept the gap, always
  behind the validator + ladder (run 016: 0.60-0.83 vs 0.98-1.00).
- Trigger: LFM3 serves flagship-shaped traffic only while Gemini is
  sick or quota-walled — never cheapest-first.

## Files

- data/derived/lfm3-emit.jsonl (25 formal rows) + lfm3-emit-summary.json
  (recall field artifact-marked here; read with this report).
- No code changed; no product wiring built per the clarified scope.

## Gates

- No code changed since run 016's green (typecheck 0, lint 0,
  184 unit + 7 pool): no re-run per the unchanged-check rule. Only
  local-model calls; no Gemini quota touched.
