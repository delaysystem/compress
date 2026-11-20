# Run report 004 — span resolver + production-tokenizer recount

Date: 2026-11-11. Scope: PLAN.md Step 3 span-ref design (built, not demoted)
plus Step 2b countTokens re-measurement of the research IR samples.

## Files created

- worker/src/spanref.ts (+test, docstore fixture): {doc, span} addressing
  against a versioned store, JSON wire format (unambiguous for ids containing
  '#' etc.), fail-fast validator, KB-version binding. Index-based addressing
  considered and rejected (couples refs to prompt layout, breaks re-reads).
- worker/scripts/recount-ir.ts: recounts data/derived/ir-samples.json
  (AST-extracted from frozen research scripts, zero transcription risk) with
  Gemini countTokens; writes per-model ir-recount-*.json. Free API.

## Measurements (observed)

- Span addressing validated on MultiDoc2Dial validation: 13,422/13,422
  references resolve (hit rate 1.0000). E13 closed with data.
- IR recount, production tokenizer (gemini-3.8-flash AND gemini-3.5-flash-lite,
  identical on all 8 samples — same tokenizer):
  tagged IR 0.72/0.84/0.88/0.54/0.86x (expands, confirms tiktoken verdict);
  minimal IR 1.92/2.42/2.34x (confirms 2-2.5x band).
- Absolute counts run ~15% above cl100k (e.g. 71 vs 61): dollar math must use
  production counts, which it now can.
- Live usage: 32 countTokens calls (free). No generation calls. Values never logged.

## Rule-2 diagnoses

- First cross-model comparison script keyed samples by name; duplicate names
  across v1/v2 files paired v1 rows against v2 rows (3 false "differ" rows).
  Mechanism: dict keyed on non-unique field. Fix: index-aligned pairing;
  re-ran clean: 8/8 identical. Underlying data files were always correct.

## Verification (observed)

- typecheck exit 0; lint exit 0 zero diagnostics; tests 9 files 71/71 pass.
- Pre-commit audit (no commit made): no new literals (JSON braces are syntax,
  not magic values); no error swallowing (fail-fast ResolveResult + throws on
  bad sample files); fixtures carry provenance; no secrets touched beyond the
  established resolver (names/counts in output only).
- Not run: Workers runtime, wrangler dry-run, live generate (unchanged).
