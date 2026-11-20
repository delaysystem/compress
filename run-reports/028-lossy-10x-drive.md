# Run report 028 — Lossy 10x drive lands 6.87x; lossless parked; Groq blocked

Date: 2026-11-14. Scope: wire the dictionary into emission and drive
lossy ratio to 10x. Verdict: 6.87x cl100k (+52% vs bare 4.51x),
recall 0.903, 99% code-use. Every sized lever was built, measured,
and banked; the remaining gap is exact-value slots (52% of IR
tokens), which no wire format can compress. ~8x is the realistic
ceiling (bare codes + move-codes, both sized below); 10x needs
lossy slots and is rejected. Lossless parked with a measured ~2x
single-turn cap; Groq edge-blocked (403/1010), Gemini fallback
validated and carrying all pilots.

## Trajectory (held-out rows[100:200], cl100k p50 vs bare 4.51x)

- v3 + ir-v0 (29 codes) on Groq: 5.35x (+19%), recall 0.892.
- v3 + ir-v0 on Gemini: 5.94x (+32% same-model), recall 0.937.
  Same-model isolation: the book alone adds roughly a third.
- v4 + ir-v1 (37 codes, % wire): 5.68x. REGRESSED vs v3/Gemini:
  % fractures to 3 tok/line (not ~1 projected) and tail codes
  dilute (marginal lines where overhead >= saving).
- v5 + ir-v1 (: wire): 6.87x (+52%), recall 0.903 (N=50),
  code-use 0.99, 8 model-side decode slips (arity/braces).

## What each lever measured

- Codebook (29 IR-native canonicals from line-shape clusters;
  free-phrase mining yields ~0% even in-intent): +19-32%.
- Wire prefix: fracture table in cl100k — @code: 4 tok/line,
  %/!/^/~ 3, :/#/@ 2, bare 0. : is the best safe shape.
- Book growth 29->37: ~zero net (tailDilution, per-code P&L).
- Per-code P&L (new diagnostic): half the book net-negative vs
  its own canonicals (short templates lose to overhead); top
  code `a` (refund eligibility) carries half of all gains.
- Slot hygiene prompt rules: decode slips 8->6->8 across runs
  (model-side: trailing pipes, {} literals, slot-name fillers).

## Bugs fixed en route (all covered or noted)

- LEFTOVER_RE rejected {{...}} inside slots (47 false decode
  fails) -> single-brace-only regex + 2 regression tests.
- percentile takes fractions: p50 call passed 50, returned max.
- Compress recall passed '' grounding (recall null everywhere);
  v2 parity is grounding == reference.
- emit-dict appended without truncating on fresh runs (dup keys);
  siblings already truncated.
- Summary averaged null recall as zero; now recallN-gated.
- tiktoken added via pnpm (npm fails in this env) for the
  shared-tokenizer recount.

## Infra added

- --provider groq|gemini on emit-dict (GenClient structural
  surface, resume chains providers with zero lost rows, per-row
  provider provenance). Validated: full 100-row Gemini pilot.
- rescore-emit-dict: --dict + --translate-prefix (wire migration
  for @code:-era rows), cl100k dict-vs-bare recount.
- dictToPrompt renderer + tests; v3/v4/v5 pinned prompts (v3/v4
  retained as historical records).
- Evidence preserved per round: emit-dict-groq/-gemini/-v4 files.

## Lossless: parked with proof

- Modes renamed per owner: lossy = text transforms thru phases;
  lossless = final within 3 words of native output. wordDiff +
  LOSSLESS_WORD_BUDGET=3 implemented with 5 tests; thinking
  tokens now count in all ratios (no-op for non-reasoning runs).
- Cap proof: reply middles 94% unique, mined full-reply templates
  cover 3.7%, in-reply value repeats 0.7% -> single-turn
  stateless lossless caps ~1.5-2x. Viable path is grounded
  span-ref (KB holds content, wire carries pointers); owner
  parked it there.

## Provider status

- Groq: 403 error 1010 (Cloudflare edge block, persists across
  retries) — not quota. All pilots shifted to Gemini per the
  standing fallback directive.
- Gemini 3.5 Flash Lite: healthy (300+ calls, zero 429s),
  model id confirmed live.

## Terminal gap analysis (10x)

- IR composition: slots 52% (exact, incompressible), wire 41%->
  ~25% (after :), uncoded ~8%. Sized remainder: bare codes
  +~0.5x (parse risk), multi-fact move-codes +0.5-1x (unbuilt,
  compliance risk). Stacked ceiling ~8x.
- 10x single-turn lossy requires compressing exact values and
  is not pursued. Next levers only on owner word.

## Gates

- typecheck 0, lint 0, 228 unit + 7 pool. Free APIs only
  (Gemini); values never logged.
