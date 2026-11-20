# Run report 032 — Staging model: ceilings hold everywhere

Date: 2026-11-14. Scope: model staging-like traffic (no staging
conversations exist locally; staging lives in Cloudflare D1/KV)
and measure the compression ceiling across mixes. Verdict: no mix
reaches 10x mean. Formulaic traffic ceilings 4-6x (short replies,
little fluff per value); cross-turn repeats hit 65% but are short
identifiers where 2-tok refs save nothing (amortized == single-turn
in every cell). Verbosity is what makes bitext's 8.6x possible —
terse agents ceiling lower, not higher.

## Sensitivity (200 convs/cell, book adherence x carry rate)

- adh0.5/carry0.3: 6.0x p50, 12% coverage, 23% repeats.
- adh0.5/carry0.9: 5.9x p50, 13% coverage, 65% repeats.
- adh0.7/carry0.3: 5.1x p50, 4% coverage, 19% repeats.
- adh0.7/carry0.9: 5.0x p50, 3% coverage, 55% repeats.
- adh0.9/carry0.3: 4.2x p50, 0% coverage, 20% repeats.
- adh0.9/carry0.9: 4.3x p50, 0% coverage, 50% repeats.

## Readings

- Adherence inverts: more book moves per reply means more values,
  and values are the floor. Coverage@10x falls 12% -> 0%.
- Repeats don't pay: even at 65% repeat rate the amortized p50
  equals the single-turn p50 to the decimal — repeats are
  1-2 word identifiers, cheaper inline than as refs.
- Generator honest about itself: calibrated reply shape, explicit
  knobs, bitext-derived book; all numbers labeled MODELLED.
  Two generator bugs caught by its own output (terse-by-default
  replies, carry-free pools) and fixed before measuring.

## Standing state

- 10x mean: infeasible under exactness on every content class
  measured (bitext 8.6, synthetic 4-6, grounded-short ~5).
  10x holds per-row-class (8/26 bitext intents) and per-mechanism
  (spans +3.8x relative), never as a mean.
- Scripts: synth-staging.py (knobs --pool/--adh/--carry/--seed),
  synth-ceiling.py (floor + amortized floors). No API spent.
- Gates: untouched (no src changes this round).
