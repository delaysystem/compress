# Run report 030 — Lossy 10x finish: v6 lands 7.75x, span gate passes

Date: 2026-11-14. Scope: execute the 10x plan (bare wire, move codes,
tight slots, span gate). Verdict: v6 reaches 7.75x cl100k (+72% vs
bare 4.51), recall 0.805 (thin margin over the 0.80 gate), code-use
0.94. The span-KB gate PASSES (79% word / 78% entity coverage over
2933 grounded turns) and is the only remaining lever with 10x-sized
mass. 10x single-turn without spans stays out of reach; the verdict
below shows exactly where every token went.

## v6 round (bare + moves + tight slots, Gemini, held-out 100)

- Native: p50 6.29 / mean 7.81; cl100k p50 7.75. Median IR tokens
  18 -> 15; lines/IR 2.9 -> 2.6 (move merging), coded share 0.94.
- Recall 0.805 (N=50) vs v5 0.903: dip is +4 placeholder misses
  (tight-slot pressure drops {{...}} markers). Margin over gate
  is 0.005 — flagged, not hidden.
- Move codes: 38 hits (at/ar/ao lead; an/am/ap/aq/as zero — the
  model ignores half the move book; choice overload suspected).
- Tight slots did NOT shorten (3.5 vs 3.3 words) — the v6 gain is
  bare wire + fewer lines, not slot discipline. Prompt pressure
  without a mechanism does not move slots.
- 8 decode fails -> 4 (same model-slip classes: arity, braces).

## Full drive trajectory (cl100k p50, same held-out half)

- Bare v1: 4.51x. v3/book: 5.35 (Groq) / 5.94 (Gemini, +32%).
- v4 (% + book+8): 5.68x (tail dilution ate the wire win).
- v5 (: wire): 6.87x (+52%). v6 (bare + moves): 7.75x (+72%).
- Composition moved wire 41% -> ~10%; slots now ~80% of IR.

## Span gate: PASS, pilot designed not run

- scripts/rag-codes/span-gate.py: agent content words found
  verbatim in their own cited spans 79%; entities 78%.
- Design queued: KB store from doc2dial docs, span-aware emit
  (model cites span ids), resolution eval by grounded recall
  (NOT wordDiff-vs-utterance — agents paraphrase spans).
- Not run this cycle: fresh multi-hour build + pilot budget.

## Standing state

- Wire: bare default, : explicit (dictToPrompt wire option);
  lenient parser + tests; prompts v3-v6 pinned as records.
- Providers: Groq still 403/1010; Gemini carried 400+ calls clean.
- Gates: 232 unit + 7 pool, typecheck 0, lint 0.
- Owner calls: span pilot build (the 10x path), bare-moves
  follow-ups (choice-overload fix), or new direction.
