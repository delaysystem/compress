# Run report 002 — mining core + dict codec + Bitext pilot (Step 1, datasets-only)

Date: 2026-11-11. Scope: PLAN.md Step 1 mining on public data (no staging logs;
owner ruled out email-gated sets, so MSDialog is dropped). No live API calls.

## Files created/changed

- worker/src/mining.ts (+test): exact template mining with entity-slot masking,
  ranking, coverage curves, exact-duplicate grouping.
- worker/src/dict.ts (+test): versioned dictionary codec (decode + validation;
  deliberately no runtime encoder — code assignment is offline mining's job).
- worker/scripts/mine-bitext.ts: offline pilot runner (csv-parse for
  multiline-quoted CSV; stdlib has none — dependency reason recorded).
- worker/src/entities.ts: added `placeholder` entity class (top extraction
  priority) + span start/end on Entity.
- data/derived/bitext-mining.json + dict-v0.json (generated, gitignored).
- PLAN.md/CONTEXT.md: MSDialog dropped; FEDI/MultiDoc2Dial named for real-text
  mining instead. tsconfig: scripts/ included, allowImportingTsExtensions.

## Real Bitext results (26,872 responses, 2.82M words)

- 134 templates at minSupport 50; top-100 coverage 0.034 (word units).
- Per-turn savings top-100: 3.61 words → uncached dict budget ≈ 14 words at
  k=1 (4/7/2 at k=3/2/5). Directional floor, not the prize: Bitext's 12
  register variants deliberately diversify phrasing, and the naive splitter
  fragments numbered lists (documented method limit). Staging logs decide.
- Whole-response exact duplicates: 2 groups, ~0 coverage (no cache evidence
  on this corpus — expected; cache case rests on staging repeat-rate).
- dict-v0: 134 entries, slot/template consistency proof passes (NONE mismatch).

## Rule-2 diagnoses (observed failures, mechanism fixes)

1. Runner crash ERR_MODULE_NOT_FOUND for src/config.js: node type-stripping
   resolves `.js` literally without rewriting to `.ts`. Fix: `.ts` extensions
   everywhere + allowImportingTsExtensions (vitest/esbuild-compatible).
2. 10 dict slot/template mismatches: Bitext's literal `{{...}}` markers are not
   entities, so they leaked into skeletons and collided with `{slot}` syntax
   (the decode leftover-check caught it, as designed). Fix: placeholder entity
   class at top extraction priority + regression tests.
3. Break-even math used corpus-total savings against per-request dict cost
   (wrong units → absurd budgets). Fix: per-turn savings; budgets now honest.
4. Lint trio: useLiteralKeys + organizeImports (fixed by hand) + one format
   join (formatter). Lesson enforced: capture gate exit codes, never tail text.

## Verification (observed)

- `npm install -D csv-parse`: +3 packages.
- typecheck exit 0; lint exit 0 zero diagnostics; tests 6 files 49/49 pass.
- Pre-commit audit (no commit made): pinned values keep origins; new numerics
  named (CODE_WORDS/assumption, MIN_FIXED_WORDS/definitional,
  PRICE_RATIO_PROXY/research-book); no error swallowing; no secrets touched.
- Not run: Workers runtime, wrangler dry-run, live Gemini, countTokens
  re-measurement (needs key in env; values never logged when it happens).

## Open follow-ups

Span resolver; streaming-delta reassembly; Gemini client + live pilot;
Step 1 on staging logs (owner pointer); CI; full SGD re-clone if needed.
