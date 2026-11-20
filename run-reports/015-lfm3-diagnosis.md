# Run report 015 — LFM3 diagnosis: dead emitter, viable-with-caveats SLM

Date: 2026-11-11. Scope: owner instruction to diagnose LFM3-1.7B-GSQ
(Q6_K_RCO, local llama.cpp) as big LLM, SLM, or anything, squeezed.
Verdict: emitter NON-VIABLE (non-convergent deliberation, 8 failed
squeezes); SLM expander VIABLE WITH VALIDATOR (0.767 base / 0.600
entity-bearing, validator caught every failure, strict prompt kills
greeting leaks 8 -> 0). Local free expander at ~3s/turn is a credible
Phase-2 option pending a Gemini-expander baseline.

## Emitter: not viable (negative result, heavily evidenced)

- Symptom: empty IRs (finish=length, all tokens to thinking).
- 8 probes, one variable each: max_tokens 256 -> 1024 -> 2048
  (reasoning balloons to fill every cap, never concludes);
  --reasoning-budget 128 (thinking continues in-band with literal
  <think>); --reasoning off (still emits <think>); 150-word grounding
  (still rambles); no-think instruction (ignored); raw /completion
  (degenerate template echo loop); 2-shot IR examples (still
  deliberates); pure-compress task (same pathology as grounded QA).
- Only JSON-schema forcing yields output (finish=stop, 93 tokens) but
  content is verbatim sentence copying (zero compression).
- Mechanism: compression/format-transformation triggers non-convergent
  meta-deliberation in this 1.7B; fluent rewrite does not (see SLM).
  Comprehension is intact (thinking finds the right facts) but never
  converges to output. scripts/lfm3-emit.ts + its 2 empty rows are the
  kept negative record. No further emitter squeeze recommended on
  this model.

## SLM expander: viable with validator (measured)

- N=30 v0 prompt: passRate 0.767 (23/30), all 7 fails marker-family
  (brace-strip/paraphrase/mangled-brace/bold/meta-preamble), p50 3.2s,
  zero rambles. BUT the 30 IRs contained zero real entities — the
  production question was untested.
- N=15 entity-bearing v3 IRs (--v3): passRate 0.600 (9/15).
  Adjudication: 1 URL-trailing-dot artifact (FIXED this run, see
  below); 1 crisis-number drop (Text 838255 — material); 1 program-name
  drop (Post-9/11); 1 NUMBER CORRUPTION (age 50 -> 60 by bracket
  contamination — material, validator correctly failed); 2 meta-ramble
  truncations (~4% deliberation leak: model recites the rules instead
  of expanding; completeness check catches, ladder handles).
- Real-entity verdict: LFM3 preserves most entities but drops/corrupts
  at a rate that REQUIRES the validator in the loop — which caught
  6/6 substantive failures. The screen works; the model is usable
  behind it, not standalone.
- Wrapper coupling: greeting leaks 8/30, signoff 2/30 on v0.

## Squeeze results

- Strict rule-3 variant (diagnosis-only, product prompt untouched):
  greetings 8/30 -> 0/30, signoffs 2 -> 1, pass 0.767 -> 0.833.
  RECOMMEND product adoption after a Gemini-side check (variant was
  validated on LFM3 only; expander header requires evals for tuning).
- Emitter squeezes: all 8 failed (above). Stopped per discipline.

## Extractor fix (this run)

- URL canonicalization strips trailing sentence punctuation
  (...gov. == ...gov): production validator bug (any sentence-final
  URL failed parity). +3 tests. Interior punctuation and emails
  unaffected (tested).

## Operating point + follow-ups

- Server: --reasoning off (fastest for the working SLM path; no flag
  cures emitter deliberation). LFM3 stays the quota-fallback for
  shortrewrite/judge-shaped calls, never grounded QA.
- Follow-ups: Gemini-expander baseline on the same 45 IRs (comparison
  required before any Phase-2 local-expander decision); strict-prompt
  Gemini-side check; meta-ramble retry is already ladder-covered.

## Files

- scripts/lfm3-emit.ts, scripts/lfm3-expand.ts (--v3/--strict),
  data/derived/lfm3-{emit,expand,expand-v3,expand-strict}.*.
- v1/v2 runners and outputs untouched throughout.

## Gates

- typecheck 0, lint 0, 184 unit (181 + 3 URL) + 7 pool. Local model
  for all LFM3 calls; only free Gemini APIs otherwise; values never
  logged.
