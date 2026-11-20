# Run report 033 — 10x terminal: every path measured

Date: 2026-11-14. Scope: exhaustive 10x drive across six tracks
(codes, wire, spans, RAG, multi-turn, catalog). Verdict: 10x mean
is infeasible under exactness on every content class measured;
10x holds per-row-class (30% of rows), per-intent (8/26), and
per-mechanism (spans +3.8x relative). The system ships at 7.75x
measured (8.6x ceiling) with all machinery proven. Nothing left
unmeasured except staging mix (no data) and paid-tier latency.

## Track scoreboard (all numbers measured, held-out where applicable)

- Lossy codes (bitext): bare 4.51x -> v6 7.75x (+72%). Recall
  0.805 (thin), code-use 0.94, decode 96%. Ceiling p50 8.6x;
  33% of rows can ever hit 10x (at 30%).
- Wire: @code: (4 tok/line) -> % (3) -> : (2) -> bare (0
  prefix, lenient parse). Each cut measured via fracture table.
- Spans (doc2dial): +3.8x relative (5.00 vs 1.33), recall
  1.000, e2e 90/94 (95.7%). Absolute capped by short answers.
- RAG dynamic books: gate 42% (bar 50%) -> stopped. Static
  book already owns the overlap.
- Answer cache: hits exist, answers diverge 82-115 words ->
  reuse would serve wrong answers. Stopped.
- Multi-turn amortization: 11% entity + ~5% phrase repeats
  in-dial -> ~0x. Stopped.
- Catalog coverage (this round): static book covers 33% of
  reply sentences at 0.6 containment -> 1.5x ceiling on the
  catalog-only path. A closed catalog needs ~95% (3x more
  templates + fuzzy matching); unbuilt.
- Synthetic staging: 4-6x ceilings, coverage <=13% across
  6 mixes. Verbosity is what makes bitext compressible.

## Why 10x mean cannot hold (three independent walls)

1. Values: 40-80% of IR tokens are exact values by contract;
   the floor model puts ceiling p50 at 8.6x on bitext.
2. Variety: reply middles 94% unique; mined templates cover
   3.7%; static book covers 33% of sentences. Paraphrase is
   the enemy mining, RAG, cache, and catalog all hit.
3. Short answers: 21-word grounded turns and sub-30-token
   replies cannot amortize any per-line overhead to 10x.

## What ships

- Lossy pipeline at 7.75x (+72%), validator-gated, laddered,
  with provider fallback (Groq->Gemini), live kernel telemetry,
  and per-intent ratio table for savings prediction.
- Span machinery (short refs, request maps, resolution) proven
  +3.8x relative, ready for grounded deployments with a KB.
- Lossless mode defined (wordDiff<=3) and parked with a ~2x
  single-turn cap proof; grounded span-ref is its only path.

## Gates

- 232 unit + 7 pool, typecheck 0, lint 0. Free-tier APIs only
  (Gemini; Groq edge-blocked 403/1010); values never logged.
